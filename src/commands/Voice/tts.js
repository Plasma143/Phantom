// src/commands/Voice/tts.js

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

export const ttsSessions = new Map();

export function restoreTTSSessions() {}

function sanitiseText(text) {
  return text
    .replace(/https?:\/\/\S+/g, 'link')   
    .replace(/[<>]/g, '')                  
    .replace(/\s+/g, ' ')                  
    .trim()
    .slice(0, 500);
}

function connectToVoice(channel, player) {
  return new Promise((resolve, reject) => {
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

    const joinStartedAt = Date.now();

    // Use named functions so we can clean them up later and prevent leaks
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

    // Clean up event listeners on resolution or failure
    const cleanupListeners = () => {
      connection.off('stateChange', handleStateChange);
    };

    connection.once(VoiceConnectionStatus.Ready, () => {
      cleanupListeners();
      connection.subscribe(player);
      resolve(connection);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        connection.configureNetworking();
      } catch {
        cleanupListeners();
        connection.destroy();
        ttsSessions.delete(channel.guild.id);
      }
    });

    const timeout = setTimeout(() => {
      cleanupListeners();
      connection.destroy();
      reject(new Error('Voice connection timed out after 30s'));
    }, 30_000);

    connection.once(VoiceConnectionStatus.Ready, () => clearTimeout(timeout));
  });
}

function playNextFile(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s) return;

  if (!s.fileQueue.length) {
    s.playing = false;
    playNextMessage(guildId);
    return;
  }

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
    const ffmpeg = spawn('ffmpeg', [
      '-i', file,        
      '-ac', '2',         
      '-ar', '48000',     
      '-acodec', 'libopus',
      '-b:a', '96k',
      '-f', 'ogg',
      'pipe:1',           
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

async function playNextMessage(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.queue.length || s.playing) return;

  const { username, text } = s.queue.shift();
  s.playing = true;

  try {
    const sentence = `${username} says ${text}`;
    const files = await synthesizeSpeechChunked(sanitiseText(sentence));

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
    logger.error('[TTS] Speech compilation failed:', err);
    const current = ttsSessions.get(guildId);
    if (current) {
      current.playing = false;
      playNextMessage(guildId);
    }
  }
}

// ── SLASH COMMAND REGISTRATION & EXECUTION ───────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName('tts')
  .setDescription('Speak text in your current voice channel')
  .addStringOption(option =>
    option.setName('message')
      .setDescription('The message to speak')
      .setRequired(true)
  );

export async function execute(interaction) {
  // CRITICAL FIX: Instantly acknowledge interaction so it does not time out [1]
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

    // Auto-advance queue when current audio fragment completes
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
      logger.error(`[TTS Player Error] ${error.message}`);
      const activeSession = ttsSessions.get(guildId);
      if (activeSession) {
        activeSession.playing = false;
        playNextMessage(guildId);
      }
    });

    ttsSessions.set(guildId, session);
  }

  const messageText = interaction.options.getString('message', true);
  session.queue.push({ username: member.displayName, text: messageText });

  try {
    await connectToVoice(voiceChannel, session.player);
    interaction.editReply('📣 Added your message to the TTS playback queue.');
    playNextMessage(guildId);
  } catch (error) {
    logger.error(`[TTS Command Failure] ${error.message}`);
    interaction.editReply(`❌ Failed to connect to voice channel: ${error.message}`);
    ttsSessions.delete(guildId);
  }
}
