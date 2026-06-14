// src/commands/Utility/tts.js
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus,
} from '@discordjs/voice';
import { spawn, execSync } from 'child_process';
import { Readable, PassThrough } from 'stream';
import { logger } from '../../utils/logger.js';

export const ttsSessions = new Map();

// Detect which TTS engine is available
function getTTSEngine() {
  for (const cmd of ['espeak-ng', 'espeak', 'festival']) {
    try { execSync(`which ${cmd}`); return cmd; } catch {}
  }
  return null;
}

// Create a readable audio stream from text
async function createSpeech(text) {
  const clean = text.replace(/https?:\/\/\S+/g, 'link').slice(0, 300);
  const engine = getTTSEngine();
  logger.info(`[TTS] Using engine: ${engine || 'google'} for: "${clean.slice(0,50)}"`);

  if (engine === 'espeak-ng' || engine === 'espeak') {
    const pass = new PassThrough();
    const proc = spawn(engine, ['-v', 'en', '-s', '145', '--stdout', clean]);
    proc.stdout.pipe(pass);
    proc.stderr.on('data', d => logger.debug(`[TTS] ${engine}:`, d.toString().trim()));
    proc.on('error', e => { logger.error('[TTS] engine error:', e.message); pass.destroy(e); });
    return { stream: pass, type: StreamType.Arbitrary };
  }

  // Google Translate TTS fallback (returns MP3)
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=en&client=tw-ob`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Google TTS failed: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return { stream: Readable.from(buf), type: StreamType.Arbitrary };
}

async function playNext(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.queue.length || s.playing) return;
  const { username, text } = s.queue.shift();
  s.playing = true;
  try {
    const { stream, type } = await createSpeech(`${username} says ${text}`);
    const resource = createAudioResource(stream, { inputType: type });
    s.player.play(resource);
    s.player.once(AudioPlayerStatus.Idle, () => { s.playing = false; playNext(guildId); });
    resource.playStream?.on('error', e => {
      logger.error('[TTS] stream error:', e.message);
      s.playing = false; playNext(guildId);
    });
  } catch (e) {
    logger.error('[TTS] playNext error:', e.message);
    s.playing = false; playNext(guildId);
  }
}

export function handleTTSMessage(message) {
  const s = ttsSessions.get(message.guildId);
  if (!s || message.channel.id !== s.textChannelId || message.author.bot) return;
  const text = message.content?.trim();
  if (!text) return;
  logger.info(`[TTS] Queuing: "${text.slice(0,50)}" from ${message.author.username}`);
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
        ttsSessions.get(guildId).connection?.destroy();
        ttsSessions.delete(guildId);
      }

      // Reuse existing connection (e.g. from discord-player) or create new one
      let connection = getVoiceConnection(guildId);
      if (!connection || connection.joinConfig?.channelId !== vc.id) {
        connection = joinVoiceChannel({
          channelId: vc.id, guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: false,
        });
      }
      const player = createAudioPlayer();
      connection.subscribe(player);
      player.on('error', e => logger.error('[TTS] player error:', e.message));
      connection.on(VoiceConnectionStatus.Disconnected, () => ttsSessions.delete(guildId));

      const engine = getTTSEngine();
      logger.info(`[TTS] Session started. Engine: ${engine || 'google'}`);

      ttsSessions.set(guildId, {
        connection, player, queue: [], playing: false,
        textChannelId: interaction.channelId,
      });

      return interaction.reply(
        `🔊 Joined **${vc.name}** — reading **#${interaction.channel.name}** aloud. Use \`/tts leave\` to stop.`
      );
    }

    if (sub === 'leave') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ Not active.', flags: MessageFlags.Ephemeral });
      s.queue = []; s.connection.destroy(); ttsSessions.delete(guildId);
      return interaction.reply('👋 TTS stopped.');
    }

    if (sub === 'clear') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ No session.', flags: MessageFlags.Ephemeral });
      s.queue = []; s.player.stop();
      return interaction.reply({ content: '🗑️ Cleared.', flags: MessageFlags.Ephemeral });
    }
  },
};
