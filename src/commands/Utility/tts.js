// src/commands/Utility/tts.js
// Voice TTS — reads text channel messages aloud in VC.
// Uses espeak → ffmpeg (OggOpus output) — no npm Opus encoder needed.
import {
  SlashCommandBuilder,
  MessageFlags,
  ChannelType,
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
import { PassThrough } from 'stream';
import { logger } from '../../utils/logger.js';

// Active sessions per guild
export const ttsSessions = new Map();

// ── Generate OggOpus stream: espeak text → ffmpeg → OggOpus ──────────────────
function createSpeechStream(text) {
  const clean = text.replace(/[^\w\s.,!?'-]/g, ' ').slice(0, 400);

  const espeak = spawn('espeak', [
    '-v', 'en',
    '-s', '145',
    '-p', '50',
    '--stdout',
    clean,
  ]);

  const ffmpeg = spawn('ffmpeg', [
    '-f', 'wav',
    '-i', 'pipe:0',
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'libopus',
    '-b:a', '64k',
    '-f', 'ogg',
    '-loglevel', 'error',
    'pipe:1',
  ]);

  const output = new PassThrough();

  espeak.stdout.pipe(ffmpeg.stdin);

  espeak.stderr.on('data', d => logger.debug('[TTS espeak]', d.toString().trim()));
  ffmpeg.stderr.on('data', d => logger.debug('[TTS ffmpeg]', d.toString().trim()));

  ffmpeg.stdout.pipe(output);

  ffmpeg.on('error', err => {
    logger.error('[TTS] ffmpeg error:', err.message);
    output.destroy(err);
  });
  espeak.on('error', err => {
    logger.error('[TTS] espeak error:', err.message);
    ffmpeg.stdin.destroy();
    output.destroy(err);
  });

  return output;
}

// ── Play next in queue ────────────────────────────────────────────────────────
function playNext(guildId) {
  const session = ttsSessions.get(guildId);
  if (!session || !session.queue.length || session.playing) return;

  const { username, text } = session.queue.shift();
  session.playing = true;

  try {
    const stream   = createSpeechStream(`${username} says ${text}`);
    const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });

    session.player.play(resource);

    session.player.once(AudioPlayerStatus.Idle, () => {
      session.playing = false;
      playNext(guildId);
    });

    resource.playStream.on('error', err => {
      logger.error('[TTS] stream error:', err.message);
      session.playing = false;
      playNext(guildId);
    });
  } catch (err) {
    logger.error('[TTS] playNext error:', err.message);
    session.playing = false;
    playNext(guildId);
  }
}

// ── Called from messageCreate ─────────────────────────────────────────────────
export function handleTTSMessage(message) {
  const session = ttsSessions.get(message.guildId);
  if (!session) return;
  if (message.channel.id !== session.textChannelId) return;
  if (message.author.bot) return;
  const text = message.content?.trim();
  if (!text) return;

  session.queue.push({
    username: message.member?.displayName || message.author.username,
    text,
  });
  playNext(message.guildId);
}

export default {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Voice TTS — reads messages from this channel aloud in your VC')
    .setDMPermission(false)
    .addSubcommand(s => s
      .setName('join')
      .setDescription('Join your VC and start reading messages from this channel aloud'))
    .addSubcommand(s => s
      .setName('leave')
      .setDescription('Stop TTS and leave the voice channel'))
    .addSubcommand(s => s
      .setName('clear')
      .setDescription('Clear the TTS queue without leaving')),

  category: 'commands',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'join') {
      const vc = interaction.member.voice?.channel;
      if (!vc) return interaction.reply({ content: '❌ Join a voice channel first.', flags: MessageFlags.Ephemeral });

      if (ttsSessions.has(guildId)) {
        ttsSessions.get(guildId).connection.destroy();
        ttsSessions.delete(guildId);
      }

      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      const player = createAudioPlayer();
      connection.subscribe(player);

      player.on('error', err => logger.error('[TTS] Player error:', err.message));
      connection.on(VoiceConnectionStatus.Disconnected, () => ttsSessions.delete(guildId));

      ttsSessions.set(guildId, {
        connection, player,
        queue: [], playing: false,
        textChannelId: interaction.channelId,
      });

      return interaction.reply(
        `🔊 Joined **${vc.name}** — reading messages from **#${interaction.channel.name}** aloud.\nUse \`/tts leave\` to stop.`
      );
    }

    if (sub === 'leave') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ Not in a voice channel.', flags: MessageFlags.Ephemeral });
      s.queue = [];
      s.connection.destroy();
      ttsSessions.delete(guildId);
      return interaction.reply('👋 TTS stopped.');
    }

    if (sub === 'clear') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ No active TTS session.', flags: MessageFlags.Ephemeral });
      s.queue = [];
      s.player.stop();
      return interaction.reply({ content: '🗑️ Queue cleared.', flags: MessageFlags.Ephemeral });
    }
  },
};
