// src/commands/Utility/tts.js
// Voice TTS — bot joins a VC and automatically reads messages
// from the linked text channel aloud, in order they were sent.
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
import { Readable } from 'stream';
import { logger } from '../../utils/logger.js';

// Active sessions per guild: guildId → { connection, player, queue, textChannelId, playing }
export const ttsSessions = new Map();

// ── Audio generation: espeak → ffmpeg (PCM 48kHz stereo) ─────────────────────
async function generateSpeech(text) {
  return new Promise((resolve, reject) => {
    const espeak = spawn('espeak', [
      '-v', 'en',
      '-s', '150',
      '-p', '50',
      '--stdout',
      text.slice(0, 400),
    ]);
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-ar', '48000',
      '-ac', '2',
      '-f', 's16le',
      '-loglevel', 'quiet',
      'pipe:1',
    ]);
    espeak.stdout.pipe(ffmpeg.stdin);
    espeak.stderr.on('data', () => {});
    ffmpeg.stderr.on('data', () => {});
    const chunks = [];
    ffmpeg.stdout.on('data', c => chunks.push(c));
    ffmpeg.stdout.on('end', () => resolve(Buffer.concat(chunks)));
    ffmpeg.on('error', reject);
    espeak.on('error', reject);
  });
}

// ── Play next queued item ─────────────────────────────────────────────────────
async function playNext(guildId) {
  const session = ttsSessions.get(guildId);
  if (!session || !session.queue.length || session.playing) return;
  session.playing = true;
  const { username, text } = session.queue.shift();
  try {
    const speech  = await generateSpeech(`${username} says: ${text}`);
    const stream  = Readable.from(speech);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    session.player.play(resource);
    session.player.once(AudioPlayerStatus.Idle, () => {
      session.playing = false;
      playNext(guildId);
    });
  } catch (e) {
    logger.warn('[TTS] Speech error:', e.message);
    session.playing = false;
    playNext(guildId);
  }
}

// ── Called from messageCreate when a message is sent in the linked channel ────
export function handleTTSMessage(message) {
  const session = ttsSessions.get(message.guildId);
  if (!session) return;
  if (message.channel.id !== session.textChannelId) return;
  if (message.author.bot) return;
  if (!message.content.trim()) return;

  session.queue.push({
    username: message.member?.displayName || message.author.username,
    text: message.content.slice(0, 400),
  });
  playNext(message.guildId);
}

export default {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Voice TTS — reads text channel messages aloud in VC')
    .setDMPermission(false)

    .addSubcommand(s => s
      .setName('join')
      .setDescription('Join your VC and start reading messages from this channel aloud'))

    .addSubcommand(s => s
      .setName('leave')
      .setDescription('Stop TTS and leave the voice channel'))

    .addSubcommand(s => s
      .setName('clear')
      .setDescription('Clear the TTS queue')),

  category: 'commands',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // ── JOIN ──
    if (sub === 'join') {
      const vc = interaction.member.voice?.channel;
      if (!vc) {
        return interaction.reply({ content: '❌ Join a voice channel first.', flags: MessageFlags.Ephemeral });
      }

      // Destroy any existing session
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
      connection.on(VoiceConnectionStatus.Disconnected, () => ttsSessions.delete(guildId));

      ttsSessions.set(guildId, {
        connection,
        player,
        queue: [],
        playing: false,
        textChannelId: interaction.channelId,
        vcName: vc.name,
        channelName: interaction.channel.name,
      });

      return interaction.reply({
        content: `🔊 Joined **${vc.name}** — now reading messages from **#${interaction.channel.name}** aloud.\nUse \`/tts leave\` to stop.`,
      });
    }

    // ── LEAVE ──
    if (sub === 'leave') {
      const session = ttsSessions.get(guildId);
      if (!session) return interaction.reply({ content: '❌ Not in a voice channel.', flags: MessageFlags.Ephemeral });
      session.queue = [];
      session.connection.destroy();
      ttsSessions.delete(guildId);
      return interaction.reply({ content: '👋 TTS stopped and left the voice channel.' });
    }

    // ── CLEAR ──
    if (sub === 'clear') {
      const session = ttsSessions.get(guildId);
      if (!session) return interaction.reply({ content: '❌ No active TTS session.', flags: MessageFlags.Ephemeral });
      session.queue = [];
      session.player.stop();
      return interaction.reply({ content: '🗑️ Queue cleared.', flags: MessageFlags.Ephemeral });
    }
  },
};
