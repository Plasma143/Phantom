// src/commands/Utility/tts.js
// Voice TTS — reads text channel messages aloud in VC.
// Primary: espeak-ng (Ubuntu 24) → ffmpeg → OggOpus
// Fallback: Google Translate TTS → ffmpeg → OggOpus
import {
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { spawn } from 'child_process';
import { PassThrough, Readable } from 'stream';
import { logger } from '../../utils/logger.js';

export const ttsSessions = new Map();

// ── Try espeak-ng first, fallback to Google TTS ───────────────────────────────
async function getSpeechBuffer(text) {
  const clean = text.replace(/https?:\/\/\S+/g, 'link').slice(0, 300);

  // Method 1: espeak-ng (Ubuntu 24)
  try {
    return await new Promise((resolve, reject) => {
      const espeak = spawn('espeak-ng', [
        '-v', 'en', '-s', '145', '-p', '50',
        '--stdout', clean,
      ]);
      const ffmpeg = spawn('ffmpeg', [
        '-f', 'wav', '-i', 'pipe:0',
        '-ar', '48000', '-ac', '2',
        '-c:a', 'libopus', '-b:a', '64k',
        '-f', 'ogg', '-loglevel', 'error', 'pipe:1',
      ]);
      espeak.stdout.pipe(ffmpeg.stdin);
      espeak.stderr.on('data', () => {});
      ffmpeg.stderr.on('data', () => {});
      const chunks = [];
      ffmpeg.stdout.on('data', c => chunks.push(c));
      ffmpeg.stdout.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 100) return reject(new Error('Empty output'));
        resolve(buf);
      });
      ffmpeg.on('error', reject);
      espeak.on('error', reject);
    });
  } catch (e) {
    logger.debug('[TTS] espeak-ng failed, trying Google TTS:', e.message);
  }

  // Method 2: Google Translate TTS → MP3 → ffmpeg → OggOpus
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=en&client=tw-ob`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Phantom/1.0)' },
  });
  if (!resp.ok) throw new Error(`Google TTS ${resp.status}`);

  const mp3 = Buffer.from(await resp.arrayBuffer());
  return await new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'mp3', '-i', 'pipe:0',
      '-ar', '48000', '-ac', '2',
      '-c:a', 'libopus', '-b:a', '64k',
      '-f', 'ogg', '-loglevel', 'error', 'pipe:1',
    ]);
    ffmpeg.stdin.write(mp3);
    ffmpeg.stdin.end();
    ffmpeg.stderr.on('data', () => {});
    const chunks = [];
    ffmpeg.stdout.on('data', c => chunks.push(c));
    ffmpeg.stdout.on('end', () => resolve(Buffer.concat(chunks)));
    ffmpeg.on('error', reject);
  });
}

// ── Queue player ──────────────────────────────────────────────────────────────
async function playNext(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.queue.length || s.playing) return;
  const { username, text } = s.queue.shift();
  s.playing = true;
  try {
    const buf = await getSpeechBuffer(`${username} says ${text}`);
    const resource = createAudioResource(Readable.from(buf), { inputType: StreamType.OggOpus });
    s.player.play(resource);
    s.player.once(AudioPlayerStatus.Idle, () => { s.playing = false; playNext(guildId); });
    resource.playStream?.on('error', () => { s.playing = false; playNext(guildId); });
  } catch (e) {
    logger.error('[TTS] playNext failed:', e.message);
    s.playing = false;
    playNext(guildId);
  }
}

export function handleTTSMessage(message) {
  const s = ttsSessions.get(message.guildId);
  if (!s || message.channel.id !== s.textChannelId || message.author.bot) return;
  const text = message.content?.trim();
  if (!text) return;
  s.queue.push({ username: message.member?.displayName || message.author.username, text });
  playNext(message.guildId);
}

export default {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Voice TTS — reads messages from this channel aloud in VC')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('join').setDescription('Join your VC and read messages aloud'))
    .addSubcommand(s => s.setName('leave').setDescription('Stop TTS and leave VC'))
    .addSubcommand(s => s.setName('clear').setDescription('Clear the TTS queue')),

  category: 'commands',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'join') {
      const vc = interaction.member.voice?.channel;
      if (!vc) return interaction.reply({ content: '❌ Join a voice channel first.', flags: MessageFlags.Ephemeral });

      if (ttsSessions.has(guildId)) {
        ttsSessions.get(guildId).connection.destroy();
        ttsSessions.delete(guildId);
      }

      const connection = joinVoiceChannel({
        channelId: vc.id, guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });
      const player = createAudioPlayer();
      connection.subscribe(player);
      player.on('error', e => logger.error('[TTS] player error:', e.message));
      connection.on(VoiceConnectionStatus.Disconnected, () => ttsSessions.delete(guildId));

      ttsSessions.set(guildId, { connection, player, queue: [], playing: false, textChannelId: interaction.channelId });

      return interaction.reply(`🔊 Joined **${vc.name}** — reading **#${interaction.channel.name}** aloud. Use \`/tts leave\` to stop.`);
    }

    if (sub === 'leave') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ Not active.', flags: MessageFlags.Ephemeral });
      s.queue = []; s.connection.destroy(); ttsSessions.delete(guildId);
      return interaction.reply('👋 TTS stopped.');
    }

    if (sub === 'clear') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ No active session.', flags: MessageFlags.Ephemeral });
      s.queue = []; s.player.stop();
      return interaction.reply({ content: '🗑️ Cleared.', flags: MessageFlags.Ephemeral });
    }
  },
};
