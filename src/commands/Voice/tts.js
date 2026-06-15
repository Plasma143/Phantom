// src/commands/Voice/tts.js
// Voice TTS using @discordjs/voice directly.
// Google TTS → ffmpeg (OggOpus) → voice channel.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  getVoiceConnection,
} from '@discordjs/voice';
import { spawn } from 'child_process';
import { logger } from '../../utils/logger.js';

export const ttsSessions = new Map();
export function restoreTTSSessions() {}

// ── Fetch Google TTS and pipe through ffmpeg → OggOpus stream ────────────────
async function createTTSResource(text) {
  const clean = text.replace(/https?:\/\/\S+/g, 'link').slice(0, 200);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=en&client=tw-ob`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Phantom/1.0)' },
  });
  if (!resp.ok) throw new Error(`Google TTS HTTP ${resp.status}`);
  const mp3 = Buffer.from(await resp.arrayBuffer());

  // Convert MP3 → OggOpus via ffmpeg
  const ff = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-c:a', 'libopus',
    '-b:a', '96k',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'ogg',
    'pipe:1',
    '-loglevel', 'error',
  ]);
  ff.stdin.write(mp3);
  ff.stdin.end();

  return createAudioResource(ff.stdout, { inputType: StreamType.OggOpus });
}

// ── Queue processor ───────────────────────────────────────────────────────────
async function playNext(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.queue.length || s.playing) return;
  const { username, text } = s.queue.shift();
  s.playing = true;

  try {
    const resource = await createTTSResource(`${username} says ${text}`);
    s.player.play(resource);
  } catch (e) {
    logger.error('[TTS] createTTSResource error:', e.message);
    s.textChannel?.send(`⚠️ TTS error: \`${e.message}\``).catch(() => {});
    s.playing = false;
    playNext(guildId);
  }
}

// ── Called from messageCreate ─────────────────────────────────────────────────
export function handleTTSMessage(message) {
  const s = ttsSessions.get(message.guildId);
  if (!s || message.channel.id !== s.textChannelId || message.author.bot) return;
  const text = message.content?.trim();
  if (!text) return;
  s.queue.push({ username: message.member?.displayName || message.author.username, text });
  playNext(message.guildId);
}

// ── Slash command ─────────────────────────────────────────────────────────────
export default {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Voice TTS — reads messages from this channel aloud in your VC')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('join').setDescription('Join your VC and read messages aloud'))
    .addSubcommand(s => s.setName('leave').setDescription('Stop TTS and leave VC'))
    .addSubcommand(s => s.setName('clear').setDescription('Clear the TTS queue'))
    .addSubcommand(s => s.setName('test').setDescription('Test TTS audio')),

  category: 'commands',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'join') {
      const vc = interaction.member.voice?.channel;
      if (!vc) return interaction.reply({ content: '❌ Join a voice channel first.', flags: MessageFlags.Ephemeral });

      // Clean up existing session
      if (ttsSessions.has(guildId)) {
        const old = ttsSessions.get(guildId);
        try { old.player.stop(); } catch {}
        try {
          const conn = getVoiceConnection(guildId);
          if (conn) conn.destroy();
        } catch {}
        ttsSessions.delete(guildId);
      }

      // Create voice connection
      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      // Create audio player
      const player = createAudioPlayer();
      connection.subscribe(player);

      // When track finishes, play next in queue
      player.on(AudioPlayerStatus.Idle, () => {
        const s = ttsSessions.get(guildId);
        if (!s) return;
        s.playing = false;
        playNext(guildId);
      });

      player.on('error', err => {
        logger.error('[TTS] player error:', err.message);
        const s = ttsSessions.get(guildId);
        if (s) {
          s.playing = false;
          s.textChannel?.send(`⚠️ TTS error: \`${err.message}\``).catch(() => {});
          playNext(guildId);
        }
      });

      // Handle disconnects
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch {
          connection.destroy();
          ttsSessions.delete(guildId);
        }
      });

      ttsSessions.set(guildId, {
        voiceChannel: vc,
        textChannel: interaction.channel,
        textChannelId: interaction.channelId,
        connection,
        player,
        queue: [],
        playing: false,
      });

      return interaction.reply(
        `🔊 Joined **${vc.name}** — reading **#${interaction.channel.name}** aloud.\nUse \`/tts leave\` to stop.`
      );
    }

    if (sub === 'test') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ Use `/tts join` first.', flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: '🎵 Testing TTS...', flags: MessageFlags.Ephemeral });
      try {
        const resource = await createTTSResource('This is a TTS test from Phantom Bot.');
        s.player.play(resource);
        await interaction.channel.send('🔊 TTS test playing — can you hear it?');
      } catch (e) {
        await interaction.channel.send(`❌ TTS test failed: \`${e.message}\``);
      }
      return;
    }

    if (sub === 'leave') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ TTS is not active.', flags: MessageFlags.Ephemeral });
      try { s.player.stop(); } catch {}
      try { s.connection.destroy(); } catch {}
      ttsSessions.delete(guildId);
      return interaction.reply('👋 TTS stopped.');
    }

    if (sub === 'clear') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ No active TTS session.', flags: MessageFlags.Ephemeral });
      s.queue = [];
      s.playing = false;
      try { s.player.stop(); } catch {}
      return interaction.reply({ content: '🗑️ Queue cleared.', flags: MessageFlags.Ephemeral });
    }
  },
};
