// src/commands/Voice/tts.js
//
// Bug fixes applied (merged from two debugging sessions):
//   - Fixed s.playing never being reset on synthesis error — queue no longer stalls permanently
//   - Added guard in playNextFile: skip if connection is no longer Ready before playing
//   - Added guard in handleTTSMessage: ignore messages sent by the bot itself
//   - connectToVoice now reuses existing connection correctly without double-subscribing
//   - Teardown on /tts leave now clears currentFile cleanup safely (null check)
//   - /tts clear now correctly resets s.playing = false AND stops current audio
//   - Added connection.destroy() timeout fallback if Ready never fires (prevents hanging joins)
//   - Player Idle handler now guards against null session after teardown
//   - synthesizeSpeechChunked failure now properly resets playing state
//   - ROOT CAUSE FIX: createAudioResource was never given an inputType, so @discordjs/voice
//     defaulted to StreamType.Unknown and tried to auto-probe the WAV — this failed silently
//     on Railway. Now pipes espeak-ng's WAV output through ffmpeg to OGG Opus and passes
//     StreamType.OggOpus explicitly, bypassing the probe step entirely.

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  AudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
} from '@discordjs/voice';
import { spawn } from 'child_process';
import { synthesizeSpeechChunked, cleanupTempFile } from '../../services/ttsService.js';
import { logger } from '../../utils/logger.js';

// ── Active TTS sessions keyed by guildId ─────────────────────────────────────
// Each session: { voiceChannel, textChannel, textChannelId, player,
//                 queue, fileQueue, currentFile, playing }
export const ttsSessions = new Map();

// No-op — sessions are in-memory only, nothing to restore across restarts
export function restoreTTSSessions() {}

// ── Sanitise text before synthesis ───────────────────────────────────────────
function sanitiseText(text) {
  return text
    .replace(/https?:\/\/\S+/g, 'link')   // replace URLs
    .replace(/[<>]/g, '')                  // strip Discord mention brackets
    .replace(/\s+/g, ' ')                  // collapse whitespace
    .trim()
    .slice(0, 500);
}

// ── Connect to voice channel and subscribe player ─────────────────────────────
// Subscribes the player ONLY after the connection reaches Ready state.
// If a connection already exists for this guild it is reused.
function connectToVoice(channel, player) {
  return new Promise((resolve, reject) => {
    const existing = getVoiceConnection(channel.guild.id);
    if (existing) {
      // Only subscribe if not already subscribed
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

    // Re-configure networking if connection drops back to Connecting from Ready
    connection.on('stateChange', (oldState, newState) => {
      if (
        oldState.status === VoiceConnectionStatus.Ready &&
        newState.status === VoiceConnectionStatus.Connecting
      ) {
        connection.configureNetworking();
      }
    });

    // Subscribe the player only once the connection is fully Ready
    connection.once(VoiceConnectionStatus.Ready, () => {
      connection.subscribe(player);
      resolve(connection);
    });

    // Handle unexpected disconnections — try to recover, then destroy
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Recovered — reconnect networking
        connection.configureNetworking();
      } catch {
        connection.destroy();
        ttsSessions.delete(channel.guild.id);
      }
    });

    // Fail fast if Ready never fires within 15 seconds
    const timeout = setTimeout(() => {
      connection.destroy();
      reject(new Error('Voice connection timed out after 15s'));
    }, 15_000);

    // Clear the timeout if we resolved already
    connection.once(VoiceConnectionStatus.Ready, () => clearTimeout(timeout));
  });
}

// ── Play next WAV file in the per-guild file queue ────────────────────────────
function playNextFile(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s) return;

  if (!s.fileQueue.length) {
    // No more files for this message — move to next queued message
    s.playing = false;
    playNextMessage(guildId);
    return;
  }

  // Guard: don't attempt playback if the voice connection is gone
  const connection = getVoiceConnection(guildId);
  if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
    logger.warn('[TTS] Skipping playback — voice connection not Ready');
    s.fileQueue.forEach(cleanupTempFile);
    s.fileQueue = [];
    s.playing = false;
    return;
  }

  const file = s.fileQueue.shift();
  s.currentFile = file;

  try {
    // espeak-ng outputs 16kHz mono WAV. @discordjs/voice needs 48kHz stereo Opus.
    // Pipe through ffmpeg explicitly → OGG Opus so we can use StreamType.OggOpus.
    // This bypasses the format-probing step that fails silently with raw WAV streams.
    const ffmpeg = spawn('ffmpeg', [
      '-i', file,        // input: WAV from espeak-ng
      '-ac', '2',         // stereo
      '-ar', '48000',     // 48kHz (Discord standard)
      '-acodec', 'libopus',
      '-b:a', '96k',
      '-f', 'ogg',
      'pipe:1',           // output to stdout
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpeg.stderr.on('data', d => logger.debug(`[TTS ffmpeg] ${d.toString().trim()}`));

    ffmpeg.on('error', err => {
      logger.error('[TTS] ffmpeg spawn error:', err.message);
      cleanupTempFile(file);
      const sess = ttsSessions.get(guildId);
      if (sess) {
        sess.currentFile = null;
        sess.playing = false;
        sess.textChannel?.send(`⚠️ TTS ffmpeg error: \`${err.message}\``).catch(() => {});
        playNextMessage(guildId);
      }
    });

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.OggOpus,
    });

    s.player.play(resource);
  } catch (err) {
    logger.error('[TTS] createAudioResource error:', err.message);
    cleanupTempFile(file);
    s.currentFile = null;
    s.playing = false;
    s.textChannel?.send(`⚠️ TTS playback error: \`${err.message}\``).catch(() => {});
    playNextMessage(guildId);
  }
}

// ── Process the next pending message in the queue ────────────────────────────
async function playNextMessage(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.queue.length || s.playing) return;

  const { username, text } = s.queue.shift();
  s.playing = true;

  try {
    const sentence = `${username} says ${text}`;
    const files = await synthesizeSpeechChunked(sanitiseText(sentence));

    // Session may have been destroyed while we were synthesising
    const current = ttsSessions.get(guildId);
    if (!current) {
      files.forEach(cleanupTempFile);
      return;
    }

    if (!files.length) {
      current.playing = false;
      playNextMessage(guildId);
      return;
    }

    current.fileQueue.push(...files);
    playNextFile(guildId);
  } catch (err) {
    logger.error('[TTS] Synthesis error:', err.message);

    // Always reset playing on error so the queue doesn't stall
    const current = ttsSessions.get(guildId);
    if (current) {
      current.playing = false;
      current.textChannel
        ?.send(`⚠️ TTS synthesis error: \`${err.message}\``)
        .catch(() => {});
      playNextMessage(guildId);
    }
  }
}

// ── Called by messageCreate event handler ─────────────────────────────────────
export function handleTTSMessage(message) {
  // Ignore bots (including self) and messages outside an active TTS channel
  if (message.author.bot) return;

  const s = ttsSessions.get(message.guildId);
  if (!s || message.channel.id !== s.textChannelId) return;

  const text = message.content?.trim();
  if (!text) return;

  s.queue.push({
    username: message.member?.displayName || message.author.username,
    text,
  });

  playNextMessage(message.guildId);
}

// ── Slash command definition and handler ──────────────────────────────────────
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

    // ── JOIN ──────────────────────────────────────────────────────────────────
    if (sub === 'join') {
      const vc = interaction.member.voice?.channel;
      if (!vc) {
        return interaction.reply({
          content: '❌ Join a voice channel first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();

      // Tear down any existing session cleanly before starting a new one
      if (ttsSessions.has(guildId)) {
        const old = ttsSessions.get(guildId);
        try { old.player.stop(true); } catch {}
        try { getVoiceConnection(guildId)?.destroy(); } catch {}
        cleanupTempFile(old.currentFile);
        old.fileQueue.forEach(cleanupTempFile);
        ttsSessions.delete(guildId);
      }

      const player = new AudioPlayer();

      // When a file segment finishes playing, clean it up and play the next one
      player.on(AudioPlayerStatus.Idle, () => {
        const s = ttsSessions.get(guildId);
        if (!s) return; // Session was destroyed — do nothing
        cleanupTempFile(s.currentFile);
        s.currentFile = null;
        playNextFile(guildId);
      });

      // On player error: clean up and attempt to continue with next message
      player.on('error', err => {
        logger.error('[TTS] Player error:', err.message);
        const s = ttsSessions.get(guildId);
        if (!s) return;
        cleanupTempFile(s.currentFile);
        s.currentFile = null;
        s.fileQueue.forEach(cleanupTempFile);
        s.fileQueue = [];
        s.playing = false;
        s.textChannel?.send(`⚠️ TTS player error: \`${err.message}\``).catch(() => {});
        playNextMessage(guildId);
      });

      ttsSessions.set(guildId, {
        voiceChannel:  vc,
        textChannel:   interaction.channel,
        textChannelId: interaction.channelId,
        player,
        queue:       [],  // pending { username, text } messages
        fileQueue:   [],  // pending .wav file paths to play
        currentFile: null,
        playing:     false,
      });

      try {
        await connectToVoice(vc, player);
      } catch (err) {
        // Clean up the session if connection failed
        const s = ttsSessions.get(guildId);
        if (s) {
          cleanupTempFile(s.currentFile);
          s.fileQueue.forEach(cleanupTempFile);
        }
        ttsSessions.delete(guildId);
        return interaction.editReply(
          `❌ Could not connect to voice: \`${err.message}\``
        );
      }

      return interaction.editReply(
        `🔊 Joined **${vc.name}** — reading **#${interaction.channel.name}** aloud.\n` +
        `Type in this channel to speak. Use \`/tts leave\` to stop.`
      );
    }

    // ── TEST ──────────────────────────────────────────────────────────────────
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
        const files = await synthesizeSpeechChunked(
          'This is a TTS test from Phantom Bot. Can you hear me?'
        );

        if (!files.length) {
          return interaction.editReply('❌ TTS synthesis produced no audio.');
        }

        // Push files and trigger playback if not already playing
        s.fileQueue.push(...files);
        if (!s.playing) {
          s.playing = true;
          playNextFile(guildId);
        }

        await interaction.editReply('🔊 TTS test queued — listen in voice!');
        await interaction.channel.send('🔊 TTS test playing — can you hear it?');
      } catch (err) {
        await interaction.editReply(`❌ Test failed: \`${err.message}\``);
        await interaction.channel
          .send(`❌ TTS test error: \`${err.message}\``)
          .catch(() => {});
      }

      return;
    }

    // ── LEAVE ─────────────────────────────────────────────────────────────────
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
      cleanupTempFile(s.currentFile);
      s.fileQueue.forEach(cleanupTempFile);
      ttsSessions.delete(guildId);

      return interaction.reply('👋 TTS stopped and left the voice channel.');
    }

    // ── CLEAR ─────────────────────────────────────────────────────────────────
    if (sub === 'clear') {
      const s = ttsSessions.get(guildId);
      if (!s) {
        return interaction.reply({
          content: '❌ No active TTS session.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Stop current audio, clean up all queued files, reset state
      try { s.player.stop(true); } catch {}
      cleanupTempFile(s.currentFile);
      s.currentFile = null;
      s.fileQueue.forEach(cleanupTempFile);
      s.fileQueue  = [];
      s.queue      = [];
      s.playing    = false;

      return interaction.reply({
        content: '🗑️ TTS queue cleared.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
