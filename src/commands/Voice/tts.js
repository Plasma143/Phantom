// src/commands/Voice/tts.js
// Voice TTS — reads text channel messages aloud in VC.
// Translated from moonstar-x/discord-tts-bot approach:
// - Uses google-tts-api for URL generation
// - Passes URL directly to createAudioResource (no inputType — ffmpeg handles it)
// - Subscribes player only after voice connection reaches Ready state
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
import googleTTS from 'google-tts-api';
import { logger } from '../../utils/logger.js';

export const ttsSessions = new Map();
export function restoreTTSSessions() {}

// ── Connect to voice channel and subscribe player ─────────────────────────────
function connectToChannel(channel, player) {
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

    // Handle reconnects
    connection.on('stateChange', (oldState, newState) => {
      if (
        oldState.status === VoiceConnectionStatus.Ready &&
        newState.status === VoiceConnectionStatus.Connecting
      ) {
        connection.configureNetworking();
      }
    });

    // Subscribe player ONLY after connection is Ready
    connection.once(VoiceConnectionStatus.Ready, () => {
      connection.subscribe(player);
      resolve(connection);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        connection.destroy();
        ttsSessions.delete(channel.guild.id);
      }
    });

    setTimeout(() => reject(new Error('Voice connection timed out')), 15000);
  });
}

// ── Queue processor ───────────────────────────────────────────────────────────
async function playNext(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.queue.length || s.playing) return;
  const { username, text } = s.queue.shift();
  s.playing = true;

  try {
    const sentence = `${username} says ${text}`.slice(0, 200);
    const urls = googleTTS.getAllAudioUrls(sentence, {
      lang: 'en',
      slow: false,
      splitPunct: ',.?!',
    });

    // Queue all URL segments
    for (const { url } of urls) {
      s.urlQueue.push(url);
    }

    playNextUrl(guildId);
  } catch (e) {
    logger.error('[TTS] error generating URLs:', e.message);
    s.textChannel?.send(`⚠️ TTS error: \`${e.message}\``).catch(() => {});
    s.playing = false;
    playNext(guildId);
  }
}

function playNextUrl(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s) return;

  if (!s.urlQueue.length) {
    s.playing = false;
    playNext(guildId);
    return;
  }

  const url = s.urlQueue.shift();
  // Pass URL directly — @discordjs/voice + ffmpeg handles download + transcode
  const resource = createAudioResource(url);
  s.player.play(resource);
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
    .addSubcommand(s => s.setName('join').setDescription('Join your VC and start reading messages aloud'))
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
        try { old.player.stop(true); } catch {}
        try { getVoiceConnection(guildId)?.destroy(); } catch {}
        ttsSessions.delete(guildId);
      }

      const player = new AudioPlayer();

      // When a URL segment finishes, play the next one
      player.on(AudioPlayerStatus.Idle, () => {
        const s = ttsSessions.get(guildId);
        if (!s) return;
        playNextUrl(guildId);
      });

      player.on('error', err => {
        logger.error('[TTS] player error:', err.message);
        const s = ttsSessions.get(guildId);
        if (s) {
          s.urlQueue = [];
          s.playing = false;
          playNext(guildId);
        }
      });

      ttsSessions.set(guildId, {
        voiceChannel: vc,
        textChannel: interaction.channel,
        textChannelId: interaction.channelId,
        player,
        queue: [],
        urlQueue: [],
        playing: false,
      });

      try {
        await connectToChannel(vc, player);
      } catch (e) {
        ttsSessions.delete(guildId);
        return interaction.reply({ content: `❌ Could not connect: \`${e.message}\``, flags: MessageFlags.Ephemeral });
      }

      return interaction.reply(
        `🔊 Joined **${vc.name}** — reading **#${interaction.channel.name}** aloud.\nUse \`/tts leave\` to stop.`
      );
    }

    if (sub === 'test') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ Use `/tts join` first.', flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: '🎵 Testing TTS...', flags: MessageFlags.Ephemeral });
      try {
        const urls = googleTTS.getAllAudioUrls('This is a TTS test from Phantom Bot. Can you hear me?', {
          lang: 'en', slow: false, splitPunct: ',.?!',
        });
        for (const { url } of urls) s.urlQueue.push(url);
        playNextUrl(guildId);
        await interaction.channel.send('🔊 TTS test playing — can you hear it?');
      } catch (e) {
        await interaction.channel.send(`❌ TTS test failed: \`${e.message}\``);
      }
      return;
    }

    if (sub === 'leave') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ TTS is not active.', flags: MessageFlags.Ephemeral });
      try { s.player.stop(true); } catch {}
      try { getVoiceConnection(guildId)?.destroy(); } catch {}
      ttsSessions.delete(guildId);
      return interaction.reply('👋 TTS stopped.');
    }

    if (sub === 'clear') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ No active TTS session.', flags: MessageFlags.Ephemeral });
      s.queue = [];
      s.urlQueue = [];
      s.playing = false;
      try { s.player.stop(true); } catch {}
      return interaction.reply({ content: '🗑️ Queue cleared.', flags: MessageFlags.Ephemeral });
    }
  },
};
