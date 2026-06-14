// src/commands/Utility/tts.js
// Voice channel TTS — bot joins VC and speaks text using espeak + ffmpeg.
// Commands: /tts join, /tts say [text], /tts leave, /tts clear
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  getVoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { logger } from '../../utils/logger.js';

// Active TTS players per guild: guildId → { player, queue, connection }
const sessions = new Map();

// ── Generate TTS audio buffer via espeak → ffmpeg ────────────────────────────
function generateSpeech(text) {
  return new Promise((resolve, reject) => {
    const espeak = spawn('espeak', [
      '-v', 'en',
      '-s', '150',   // speed (words per minute)
      '-p', '50',    // pitch
      '--stdout',
      text.slice(0, 500), // cap length
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

    const chunks = [];
    ffmpeg.stdout.on('data', c => chunks.push(c));
    ffmpeg.stdout.on('end', () => resolve(Buffer.concat(chunks)));
    ffmpeg.stderr.on('data', () => {});
    ffmpeg.on('error', reject);
    espeak.on('error', reject);
  });
}

// ── Play next item in guild queue ─────────────────────────────────────────────
async function playNext(guildId) {
  const session = sessions.get(guildId);
  if (!session || !session.queue.length) return;

  const text = session.queue.shift();
  try {
    const buffer = await generateSpeech(text);
    const stream  = Readable.from(buffer);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });

    session.player.play(resource);
    session.player.once(AudioPlayerStatus.Idle, () => playNext(guildId));
  } catch (e) {
    logger.warn('[TTS] Speech generation failed:', e.message);
    playNext(guildId); // skip to next
  }
}

// ── Add to queue or start playing ─────────────────────────────────────────────
function enqueue(guildId, text) {
  const session = sessions.get(guildId);
  if (!session) return;
  session.queue.push(text);
  if (session.player.state.status === AudioPlayerStatus.Idle) {
    playNext(guildId);
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Text-to-speech in voice channels')
    .setDMPermission(false)

    .addSubcommand(s => s
      .setName('join')
      .setDescription('Bot joins your voice channel and listens for /tts say'))

    .addSubcommand(s => s
      .setName('say')
      .setDescription('Speak text aloud in the voice channel')
      .addStringOption(o => o
        .setName('text')
        .setDescription('Text to speak (max 500 characters)')
        .setRequired(true)
        .setMaxLength(500)))

    .addSubcommand(s => s
      .setName('leave')
      .setDescription('Bot leaves the voice channel and clears the queue'))

    .addSubcommand(s => s
      .setName('clear')
      .setDescription('Clear the TTS queue without leaving')),

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
      if (vc.type !== ChannelType.GuildVoice && vc.type !== ChannelType.GuildStageVoice) {
        return interaction.reply({ content: '❌ Must be a voice channel.', flags: MessageFlags.Ephemeral });
      }

      // Destroy existing session if switching channels
      if (sessions.has(guildId)) {
        const existing = sessions.get(guildId);
        existing.connection.destroy();
        sessions.delete(guildId);
      }

      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      const player = createAudioPlayer();
      connection.subscribe(player);

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        sessions.delete(guildId);
      });

      sessions.set(guildId, { connection, player, queue: [], channelId: vc.id });

      return interaction.reply({
        content: `🔊 Joined **${vc.name}**. Use \`/tts say\` to speak.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── SAY ──
    if (sub === 'say') {
      const text = interaction.options.getString('text');

      if (!sessions.has(guildId)) {
        // Auto-join if user is in a VC
        const vc = interaction.member.voice?.channel;
        if (!vc) {
          return interaction.reply({ content: '❌ Use `/tts join` first or join a voice channel.', flags: MessageFlags.Ephemeral });
        }

        const connection = joinVoiceChannel({
          channelId: vc.id,
          guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: false,
        });
        const player = createAudioPlayer();
        connection.subscribe(player);
        connection.on(VoiceConnectionStatus.Disconnected, () => sessions.delete(guildId));
        sessions.set(guildId, { connection, player, queue: [], channelId: vc.id });
      }

      enqueue(guildId, text);

      return interaction.reply({
        content: `🔊 Queued: *"${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"*`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── CLEAR ──
    if (sub === 'clear') {
      const session = sessions.get(guildId);
      if (!session) return interaction.reply({ content: '❌ No active TTS session.', flags: MessageFlags.Ephemeral });
      session.queue = [];
      session.player.stop();
      return interaction.reply({ content: '🗑️ Queue cleared.', flags: MessageFlags.Ephemeral });
    }

    // ── LEAVE ──
    if (sub === 'leave') {
      const session = sessions.get(guildId);
      if (!session) return interaction.reply({ content: '❌ Not in a voice channel.', flags: MessageFlags.Ephemeral });
      session.queue = [];
      session.connection.destroy();
      sessions.delete(guildId);
      return interaction.reply({ content: '👋 Left the voice channel.', flags: MessageFlags.Ephemeral });
    }
  },
};
