// src/commands/Voice/tts.js
//
// Architecture translated from moonstar-x/discord-tts-bot:
//   - AudioPlayer created separately and subscribed ONLY after VoiceConnectionStatus.Ready
//   - Google Cloud TTS API synthesises audio to a temp MP3 file
//   - ffmpeg reads the local file (no network block during playback)
//   - Queue processed serially: one segment at a time, next plays on Idle
//   - stateChange handler re-configures networking on reconnect (from reference bot)

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  AudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { createReadStream } from 'fs';
import { synthesizeSpeechChunked, cleanupTempFile } from '../../services/ttsService.js';
import { logger } from '../../utils/logger.js';

export const ttsSessions = new Map();
export function restoreTTSSessions() {}

// ── Sanitise and synthesise text → array of temp MP3 file paths ──────────────
async function downloadTTS(text) {
  const clean = text
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 500); // Google Cloud TTS handles longer text natively

  return synthesizeSpeechChunked(clean);
}

// ── Clean up a temp file ──────────────────────────────────────────────────────
function cleanup(file) {
  cleanupTempFile(file);
}

// ── Connect and subscribe player ONLY after Ready (ref bot pattern) ──────────
function connectToVoice(channel, player) {
  return new Promise((resolve, reject) => {
    // Reuse existing connection if one exists
    const existing = getVoiceConnection(channel.guild.id);
    if (existing) {
      existing.subscribe(player);
      return resolve(existing);
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    // Re-configure networking on reconnect (direct from reference bot)
    connection.on('stateChange', (oldState, newState) => {
      if (
        oldState.status === VoiceConnectionStatus.Ready &&
        newState.status === VoiceConnectionStatus.Connecting
      ) {
        connection.configureNetworking();
      }
    });

    // Subscribe player ONLY once connection is Ready (critical — ref bot pattern)
    connection.on(VoiceConnectionStatus.Ready, () => {
      connection.subscribe(player);
      resolve(connection);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        connection.destroy();
        ttsSessions.delete(channel.guild.id);
      }
    });

    setTimeout(() => reject(new Error('Voice connection timed out after 15s')), 15_000);
  });
}

// ── Play next file segment in queue ──────────────────────────────────────────
function playNextFile(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.fileQueue.length) {
    if (s) {
      s.playing = false;
      playNextMessage(guildId);
    }
    return;
  }

  const file = s.fileQueue.shift();
  try {
    // Pass local file stream — ffmpeg reads local disk, no network request
    const resource = createAudioResource(createReadStream(file));
    s.currentFile = file;
    s.player.play(resource);
  } catch (e) {
    cleanup(file);
    logger.error('[TTS] createAudioResource error:', e.message);
    s.textChannel?.send(`⚠️ TTS error: \`${e.message}\``).catch(() => {});
    s.playing = false;
    playNextMessage(guildId);
  }
}

// ── Process next message in queue ────────────────────────────────────────────
async function playNextMessage(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.queue.length || s.playing) return;

  const { username, text } = s.queue.shift();
  s.playing = true;

  try {
    const sentence = `${username} says ${text}`;
    const files = await downloadTTS(sentence);
    s.fileQueue.push(...files);
    playNextFile(guildId);
  } catch (e) {
    logger.error('[TTS] download error:', e.message);
    s.textChannel?.send(`⚠️ TTS error: \`${e.message}\``).catch(() => {});
    s.playing = false;
    playNextMessage(guildId);
  }
}

// ── Called from messageCreate.js ──────────────────────────────────────────────
export function handleTTSMessage(message) {
  const s = ttsSessions.get(message.guildId);
  if (!s || message.channel.id !== s.textChannelId || message.author.bot) return;
  const text = message.content?.trim();
  if (!text) return;
  s.queue.push({
    username: message.member?.displayName || message.author.username,
    text,
  });
  playNextMessage(message.guildId);
}

// ── Slash command ─────────────────────────────────────────────────────────────
export default {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Voice TTS — reads messages from this channel aloud in your VC')
    .setDMPermission(false)
    .addSubcommand(s =>
      s.setName('join').setDescription('Join your VC and start reading messages aloud')
    )
    .addSubcommand(s => s.setName('leave').setDescription('Stop TTS and leave VC'))
    .addSubcommand(s => s.setName('clear').setDescription('Clear the TTS queue'))
    .addSubcommand(s => s.setName('test').setDescription('Test TTS audio')),

  category: 'commands',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // ── JOIN ────────────────────────────────────────────────────────────────
    if (sub === 'join') {
      const vc = interaction.member.voice?.channel;
      if (!vc) {
        return interaction.reply({
          content: '❌ Join a voice channel first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Tear down any existing session
      if (ttsSessions.has(guildId)) {
        const old = ttsSessions.get(guildId);
        try { old.player.stop(true); } catch {}
        try { getVoiceConnection(guildId)?.destroy(); } catch {}
        old.fileQueue.forEach(cleanup);
        ttsSessions.delete(guildId);
      }

      const player = new AudioPlayer();

      // When a file segment finishes, play the next one
      player.on(AudioPlayerStatus.Idle, () => {
        const s = ttsSessions.get(guildId);
        if (!s) return;
        cleanup(s.currentFile);
        s.currentFile = null;
        playNextFile(guildId);
      });

      player.on('error', err => {
        logger.error('[TTS] player error:', err.message);
        const s = ttsSessions.get(guildId);
        if (!s) return;
        cleanup(s.currentFile);
        s.currentFile = null;
        s.fileQueue.forEach(cleanup);
        s.fileQueue = [];
        s.playing = false;
        s.textChannel?.send(`⚠️ TTS player error: \`${err.message}\``).catch(() => {});
        playNextMessage(guildId);
      });

      ttsSessions.set(guildId, {
        voiceChannel: vc,
        textChannel: interaction.channel,
        textChannelId: interaction.channelId,
        player,
        queue: [],       // pending {username, text} messages
        fileQueue: [],   // pending .mp3 file paths to play
        currentFile: null,
        playing: false,
      });

      try {
        await connectToVoice(vc, player);
      } catch (e) {
        ttsSessions.delete(guildId);
        return interaction.reply({
          content: `❌ Could not connect to voice: \`${e.message}\``,
          flags: MessageFlags.Ephemeral,
        });
      }

      return interaction.reply(
        `🔊 Joined **${vc.name}** — reading **#${interaction.channel.name}** aloud.\nType in this channel to speak. Use \`/tts leave\` to stop.`
      );
    }

    // ── TEST ────────────────────────────────────────────────────────────────
    if (sub === 'test') {
      const s = ttsSessions.get(guildId);
      if (!s) {
        return interaction.reply({
          content: '❌ Use `/tts join` first.',
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const files = await downloadTTS('This is a TTS test from Phantom Bot. Can you hear me?');
        s.fileQueue.push(...files);
        if (!s.playing) playNextFile(guildId);
        await interaction.editReply('🔊 TTS test queued — listen in voice!');
        await interaction.channel.send('🔊 TTS test playing — can you hear it?');
      } catch (e) {
        await interaction.editReply(`❌ Test failed: \`${e.message}\``);
        await interaction.channel.send(`❌ TTS test error: \`${e.message}\``);
      }
      return;
    }

    // ── LEAVE ───────────────────────────────────────────────────────────────
    if (sub === 'leave') {
      const s = ttsSessions.get(guildId);
      if (!s) {
        return interaction.reply({
          content: '❌ TTS is not active.',
          flags: MessageFlags.Ephemeral,
        });
      }
      try { s.player.stop(true); } catch {}
      try { getVoiceConnection(guildId)?.destroy(); } catch {}
      cleanup(s.currentFile);
      s.fileQueue.forEach(cleanup);
      ttsSessions.delete(guildId);
      return interaction.reply('👋 TTS stopped.');
    }

    // ── CLEAR ───────────────────────────────────────────────────────────────
    if (sub === 'clear') {
      const s = ttsSessions.get(guildId);
      if (!s) {
        return interaction.reply({
          content: '❌ No active TTS session.',
          flags: MessageFlags.Ephemeral,
        });
      }
      s.queue = [];
      s.fileQueue.forEach(cleanup);
      s.fileQueue = [];
      s.playing = false;
      try { s.player.stop(true); } catch {}
      return interaction.reply({
        content: '🗑️ Queue cleared.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
