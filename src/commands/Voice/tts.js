// src/commands/Voice/tts.js
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer,
  createAudioResource, AudioPlayerStatus, VoiceConnectionStatus,
  StreamType, generateDependencyReport,
} from '@discordjs/voice';
import { spawn } from 'child_process';
import { createReadStream, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

export const ttsSessions = new Map();
export function restoreTTSSessions() {}

// ── Generate OggOpus file: Google TTS MP3 → ffmpeg → .ogg ────────────────────
async function generateOggFile(text) {
  const clean = text.replace(/https?:\/\/\S+/g, 'link').slice(0, 300);
  const id    = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const mp3   = join('/tmp', `phantom_tts_${id}.mp3`);
  const ogg   = join('/tmp', `phantom_tts_${id}.ogg`);

  // Fetch MP3 from Google Translate TTS
  const url  = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=en&client=tw-ob`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Phantom/1.0)' } });
  if (!resp.ok) throw new Error(`Google TTS HTTP ${resp.status}`);
  writeFileSync(mp3, Buffer.from(await resp.arrayBuffer()));

  // Convert MP3 → Ogg/Opus using system ffmpeg (libopus confirmed available)
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', mp3,
      '-c:a', 'libopus',
      '-b:a', '96k',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'ogg',
      ogg,
      '-loglevel', 'error',
    ]);
    ff.stderr.on('data', d => logger.debug('[TTS ffmpeg]', d.toString().trim()));
    ff.on('close', code => {
      try { unlinkSync(mp3); } catch {}
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    ff.on('error', err => { try { unlinkSync(mp3); } catch {} reject(err); });
  });

  return ogg;
}

// ── Play next queued item ─────────────────────────────────────────────────────
async function playNext(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.queue.length || s.playing) return;
  const { username, text } = s.queue.shift();
  s.playing = true;
  let oggFile = null;
  try {
    oggFile = await generateOggFile(`${username} says ${text}`);

    // Use StreamType.OggOpus — sends Opus packets directly to Discord, no re-encoding
    const resource = createAudioResource(createReadStream(oggFile), {
      inputType: StreamType.OggOpus,
    });

    s.player.play(resource);

    s.player.once(AudioPlayerStatus.Idle, () => {
      s.playing = false;
      try { if (oggFile && existsSync(oggFile)) unlinkSync(oggFile); } catch {}
      playNext(guildId);
    });

    s.player.once('error', e => {
      logger.error('[TTS] player error:', e.message);
      s.textChannel?.send(`⚠️ TTS playback error: \`${e.message}\``).catch(() => {});
      s.playing = false;
      try { if (oggFile && existsSync(oggFile)) unlinkSync(oggFile); } catch {}
      playNext(guildId);
    });

  } catch (e) {
    logger.error('[TTS] generation error:', e.message);
    s.textChannel?.send(`⚠️ TTS error: \`${e.message}\``).catch(() => {});
    s.playing = false;
    try { if (oggFile && existsSync(oggFile)) unlinkSync(oggFile); } catch {}
    playNext(guildId);
  }
}

// ── Called from messageCreate ─────────────────────────────────────────────────
export function handleTTSMessage(message) {
  const s = ttsSessions.get(message.guildId);
  if (!s || message.channel.id !== s.textChannelId || message.author.bot) return;
  const text = message.content?.trim();
  if (!text) return;
  s.textChannel = message.channel;
  s.queue.push({ username: message.member?.displayName || message.author.username, text });
  playNext(message.guildId);
}

export default {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Voice TTS — reads messages from this channel aloud in your VC')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('join').setDescription('Join your VC and read messages aloud'))
    .addSubcommand(s => s.setName('leave').setDescription('Stop TTS and leave VC'))
    .addSubcommand(s => s.setName('clear').setDescription('Clear the TTS queue'))
    .addSubcommand(s => s.setName('debug').setDescription('Show voice dependency report')),

  category: 'commands',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'debug') {
      const report  = generateDependencyReport();
      return interaction.reply(
        `**TTS Dependency Report:**\n\`\`\`\n${report}\n\`\`\``
      );
    }

    if (sub === 'join') {
      const vc = interaction.member.voice?.channel;
      if (!vc) return interaction.reply({ content: '❌ Join a voice channel first.', flags: MessageFlags.Ephemeral });

      if (ttsSessions.has(guildId)) {
        ttsSessions.get(guildId).connection?.destroy();
        ttsSessions.delete(guildId);
      }

      let connection = getVoiceConnection(guildId);
      if (!connection || connection.joinConfig?.channelId !== vc.id) {
        connection = joinVoiceChannel({
          channelId: vc.id, guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: false,
        });
      }

      const player = createAudioPlayer();
      connection.subscribe(player);
      player.on('error', e => logger.error('[TTS] player error:', e.message));
      connection.on(VoiceConnectionStatus.Disconnected, () => ttsSessions.delete(guildId));

      ttsSessions.set(guildId, {
        connection, player,
        queue: [], playing: false,
        textChannelId: interaction.channelId,
        textChannel: interaction.channel,
      });

      return interaction.reply(
        `🔊 Joined **${vc.name}** — reading **#${interaction.channel.name}** aloud.\nUse \`/tts leave\` to stop.`
      );
    }

    if (sub === 'leave') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ Not active.', flags: MessageFlags.Ephemeral });
      s.queue = []; s.connection.destroy(); ttsSessions.delete(guildId);
      return interaction.reply('👋 TTS stopped.');
    }

    if (sub === 'clear') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ No session.', flags: MessageFlags.Ephemeral });
      s.queue = []; s.player.stop();
      return interaction.reply({ content: '🗑️ Cleared.', flags: MessageFlags.Ephemeral });
    }
  },
};
