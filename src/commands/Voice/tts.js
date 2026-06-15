// src/commands/Voice/tts.js
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer,
  createAudioResource, AudioPlayerStatus, VoiceConnectionStatus,
  generateDependencyReport,
} from '@discordjs/voice';
import { spawn, execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

export const ttsSessions = new Map();

// ── Check what TTS engine is available ───────────────────────────────────────
function getEngine() {
  for (const cmd of ['espeak-ng', 'espeak']) {
    try { execSync(`which ${cmd} 2>/dev/null`); return cmd; } catch {}
  }
  return null;
}

// ── Generate audio to a temp WAV file ────────────────────────────────────────
async function generateToFile(text) {
  const clean = text.replace(/https?:\/\/\S+/g, 'link').slice(0, 300);
  const tmp = join('/tmp', `phantom_tts_${Date.now()}.wav`);
  const engine = getEngine();

  if (engine) {
    // espeak-ng / espeak: write directly to WAV file
    await new Promise((resolve, reject) => {
      const proc = spawn(engine, ['-v', 'en', '-s', '145', '-w', tmp, clean]);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`${engine} exit ${code}`)));
      proc.on('error', reject);
    });
    return tmp;
  }

  // Fallback: Google Translate TTS → download MP3 → convert to WAV via ffmpeg
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=en&client=tw-ob`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Google TTS ${resp.status}`);
  const mp3 = Buffer.from(await resp.arrayBuffer());

  const mp3tmp = tmp.replace('.wav', '.mp3');
  writeFileSync(mp3tmp, mp3);

  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-i', mp3tmp, '-ar', '48000', '-ac', '2', tmp, '-loglevel', 'error']);
    ff.on('close', code => {
      try { unlinkSync(mp3tmp); } catch {}
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`));
    });
    ff.on('error', reject);
  });

  return tmp;
}

// ── Queue player ──────────────────────────────────────────────────────────────
async function playNext(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.queue.length || s.playing) return;
  const { username, text } = s.queue.shift();
  s.playing = true;
  let tmpFile = null;
  try {
    tmpFile = await generateToFile(`${username} says ${text}`);
    const resource = createAudioResource(tmpFile);
    s.player.play(resource);
    s.player.once(AudioPlayerStatus.Idle, () => {
      s.playing = false;
      try { if (tmpFile && existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
      playNext(guildId);
    });
    s.player.once('error', e => {
      logger.error('[TTS] player error:', e.message);
      s.playing = false;
      try { if (tmpFile && existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
      playNext(guildId);
    });
  } catch (e) {
    logger.error('[TTS] generation error:', e.message);
    s.playing = false;
    try { if (tmpFile && existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
    playNext(guildId);
  }
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

export default {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Voice TTS — reads messages from this channel aloud in your VC')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('join').setDescription('Join your VC and read messages aloud'))
    .addSubcommand(s => s.setName('leave').setDescription('Stop TTS and leave VC'))
    .addSubcommand(s => s.setName('clear').setDescription('Clear the TTS queue'))
    .addSubcommand(s => s.setName('debug').setDescription('Show voice dependency report')),

  category: 'commands',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'debug') {
      const report = generateDependencyReport();
      const engine = getEngine() || 'none (will use Google TTS)';
      return interaction.reply({
        content: `\`\`\`\n${report}\nTTS Engine: ${engine}\n\`\`\``,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'join') {
      const vc = interaction.member.voice?.channel;
      if (!vc) return interaction.reply({ content: '❌ Join a voice channel first.', flags: MessageFlags.Ephemeral });

      if (ttsSessions.has(guildId)) {
        ttsSessions.get(guildId).connection?.destroy();
        ttsSessions.delete(guildId);
      }

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
      player.on('error', e => logger.error('[TTS] player:', e.message));
      connection.on(VoiceConnectionStatus.Disconnected, () => ttsSessions.delete(guildId));

      ttsSessions.set(guildId, {
        connection, player, queue: [], playing: false,
        textChannelId: interaction.channelId,
      });

      const engine = getEngine() || 'Google TTS';
      return interaction.reply(
        `🔊 Joined **${vc.name}** — reading **#${interaction.channel.name}** aloud via ${engine}.\nUse \`/tts leave\` to stop.`
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
