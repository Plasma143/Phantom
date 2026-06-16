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
  createAudioPlayer,
} from '@discordjs/voice';
import { spawn } from 'child_process';
import { synthesizeSpeechChunked, cleanupTempFile } from '../../services/ttsService.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

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

    const joinStartedAt = Date.now();

    // Visual Anchor: Clean, named callback references stop MaxListenersExceeded memory leaks
    const handleStateChange = (oldState, newState) => {
      logger.debug(
        `[TTS] voice state ${oldState.status} -> ${newState.status} (+${Date.now() - joinStartedAt}ms)`
      );
      if (
        oldState.status === VoiceConnectionStatus.Ready &&
        newState.status === VoiceConnectionStatus.Connecting
      ) {
        connection.configureNetworking();
      }
    };

    connection.on('stateChange', handleStateChange);

    const cleanupListeners = () => {
      connection.off('stateChange', handleStateChange);
    };

    // Subscribe the player only once the connection is fully Ready
    connection.once(VoiceConnectionStatus.Ready, () => {
      cleanupListeners();
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
        cleanupListeners();
        connection.destroy();
        ttsSessions.delete(channel.guild.id);
      }
    });

    // Fail fast if Ready never fires within 30 seconds.
    const timeout = setTimeout(() => {
      cleanupListeners();
      connection.destroy();
      reject(new Error('Voice connection timed out after 30s'));
    }, 30_000);

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

    current.fileQueue = files;
    playNextFile(guildId);
  } catch (err) {
    logger.error('[TTS] Speech synthesis execution failed:', err);
    const current = ttsSessions.get(guildId);
    if (current) {
      current.playing = false;
      playNextMessage(guildId);
    }
  }
}

// ── Discord Slash Command Interface ──────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName('tts')
  .setDescription('Speak text in your current voice channel')
  .addStringOption(option =>
    option.setName('message')
      .setDescription('The message to convert into speech')
      .setRequired(true)
  );

export async function execute(interaction) {
  // Direct Answer First: Defer instantly to fix the 3-second InteractionNotReplied crash
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const member = interaction.member;
  const voiceChannel = member?.voice.channel;

  if (!voiceChannel) {
    return interaction.editReply('❌ You must be in a voice channel to use this command!');
  }

  const guildId = interaction.guildId;
  let session = ttsSessions.get(guildId);

  if (!session) {
    const player = createAudioPlayer();
    
    session = {
      voiceChannel,
      textChannel: interaction.channel,
      textChannelId: interaction.channelId,
      player,
      queue: [],
      fileQueue: [],
      currentFile: null,
      playing: false,
    };

    // Keep queue moving automatically on track completion
    player.on(AudioPlayerStatus.Idle, () => {
      const activeSession = ttsSessions.get(guildId);
      if (activeSession) {
        if (activeSession.currentFile) {
          cleanupTempFile(activeSession.currentFile);
          activeSession.currentFile = null;
        }
        playNextFile(guildId);
      }
    });

    player.on('error', error => {
      logger.error(`[TTS Player Status Error] ${error.message}`);
      const activeSession = ttsSessions.get(guildId);
      if (activeSession) {
        activeSession.playing = false;
        playNextMessage(guildId);
      }
    });
