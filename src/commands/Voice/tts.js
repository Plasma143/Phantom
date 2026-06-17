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

import { SlashCommandBuilder, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder } from 'discord.js';
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
import { cleanupTempFile } from '../../services/ttsService.js';
import { synthesizeSpeechEdgeChunked } from '../../services/edgeTtsService.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getVoiceChoicesForTier, isVoiceAllowedForTier, resolveVoiceForGuild, DEFAULT_VOICE } from '../../utils/voiceCatalog.js';
import { getSubscription, getTier, isOwner } from '../../web/stripePayments.js';
import { getGuildConfig, setGuildConfig } from '../../services/guildConfig.js';

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
      debug: true,
    });

    // DIAGNOSTIC: surface the actual networking failure reason (UDP/IP-discovery
    // errors, etc.) instead of only seeing state names with no explanation.
    connection.on('error', (error) => {
      logger.error(`[TTS] voice connection error: ${error?.message}`, error);
    });
    connection.on('debug', (message) => {
      logger.debug(`[TTS][NW] ${message}`);
    });

    const joinStartedAt = Date.now();
    const instrumentedNetworking = new WeakSet();

    // DIAGNOSTIC (layer 2): the outer 'connecting -> connecting' self-transition
    // we keep seeing is the INNER networking state machine moving between
    // sub-stages (OpeningWs=0, Identifying=1, UdpHandshaking=2, SelectingProtocol=3,
    // Ready=4) without it ever surfacing as a 'debug' or 'error' event on the
    // connection itself. And 'connecting -> signalling' happens when that inner
    // voice websocket closes with any code other than 4014 — silently, with no
    // event we were previously listening to. Both require grabbing
    // connection.state.networking directly and listening on IT.
    const instrumentNetworking = (networking) => {
      if (!networking || instrumentedNetworking.has(networking)) return;
      instrumentedNetworking.add(networking);
      networking.on('stateChange', (oldNw, newNw) => {
        logger.debug(`[TTS][NW-STATE] ${oldNw.code} -> ${newNw.code} (+${Date.now() - joinStartedAt}ms)`);
      });
      networking.on('close', (code) => {
        logger.debug(`[TTS][NW-CLOSE] websocket closed with code=${code} (+${Date.now() - joinStartedAt}ms)`);
      });
    };

    // Single named listener (avoids stacking duplicate listeners): logs every
    // state transition with a timestamp, and re-configures networking if the
    // connection drops back to Connecting from Ready.
    const handleStateChange = (oldState, newState) => {
      logger.debug(
        `[TTS] voice state ${oldState.status} -> ${newState.status} (+${Date.now() - joinStartedAt}ms)`
      );
      if (newState.networking) instrumentNetworking(newState.networking);
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
    // (Was 15s — bumped up since discord-player imposes no such limit and
    // music works fine on this same droplet, suggesting 15s may simply be
    // too tight for this network path's handshake.)
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
    const files = await synthesizeSpeechEdgeChunked(sanitiseText(sentence), s.voiceId);

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
    .addSubcommand(s => s.setName('test').setDescription('Test TTS audio'))
    .addSubcommand(s => s.setName('voice').setDescription('Choose the TTS voice for this server')),

  category: 'commands',

  async execute(interaction, guildConfig) {
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

      const deferred = await InteractionHelper.safeDefer(interaction);
      if (!deferred) {
        logger.warn(`[TTS] Could not defer join interaction for guild ${guildId}, aborting join`);
        return;
      }

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

      // Resolve once per join — falls back safely to the default voice if
      // this guild has no saved choice, or a tier downgrade left an
      // invalid one sitting in the config.
      const subscription = await getSubscription(guildId);
      const tier = isOwner(interaction.user.id) ? 'enterprise' : getTier(subscription);
      const voiceId = resolveVoiceForGuild({ tier, savedVoiceId: guildConfig?.ttsVoice });

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
        voiceId,
        queue:       [],  // pending { username, text } messages
        fileQueue:   [],  // pending audio file paths to play
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
        `🔊 Joined **${vc.name}** — reading **#${interaction.channel.name}** aloud using **${voiceId}**.\n` +
        `Type in this channel to speak. Use \`/tts leave\` to stop.` +
        (tier !== 'free' ? ' Use `/tts voice` to pick a different one.' : '')
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

      const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferred) {
        logger.warn(`[TTS] Could not defer test interaction for guild ${guildId}, aborting test`);
        return;
      }

      try {
        const files = await synthesizeSpeechEdgeChunked(
          'This is a TTS test from Phantom Bot. Can you hear me?',
          s.voiceId
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

    // ── VOICE ─────────────────────────────────────────────────────────────────
    if (sub === 'voice') {
      const subscription = await getSubscription(guildId);
      const tier = isOwner(interaction.user.id) ? 'enterprise' : getTier(subscription);
      const choices = getVoiceChoicesForTier(tier);

      if (choices.length === 0) {
        return interaction.reply({
          content: `Voice selection is a Premium feature. This server currently uses the default voice (**${DEFAULT_VOICE}**). Upgrade to unlock more options.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId('tts_voice_select')
        .setPlaceholder('Choose a voice')
        .addOptions(choices.map(v => ({ label: v.label, value: v.id })));

      const row = new ActionRowBuilder().addComponents(menu);

      return interaction.reply({
        content: `Pick a voice (${choices.length} available on your **${tier}** plan):`,
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

// ── Select-menu handler for /tts voice — called from interactionCreate.js ────
export async function handleVoiceSelectMenu(interaction, client) {
  const guildId = interaction.guild.id;
  const chosenVoice = interaction.values[0];

  const subscription = await getSubscription(guildId);
  const tier = isOwner(interaction.user.id) ? 'enterprise' : getTier(subscription);

  if (!isVoiceAllowedForTier(chosenVoice, tier)) {
    return interaction.update({
      content: 'That voice is no longer available on your current plan.',
      components: [],
    });
  }

  const currentConfig = await getGuildConfig(client, guildId);
  await setGuildConfig(client, guildId, { ...currentConfig, ttsVoice: chosenVoice });

  // If a session is already active in this guild, switch it over immediately
  // rather than waiting for the next /tts leave + join.
  const activeSession = ttsSessions.get(guildId);
  if (activeSession) activeSession.voiceId = chosenVoice;

  await interaction.update({
    content: `TTS voice set to **${chosenVoice}**.`,
    components: [],
  });
}
