// src/commands/Voice/tts.js
// Voice TTS using discord-player (same audio pipeline as music — proven to work).
// Messages typed in the linked text channel are spoken aloud in order.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { useMainPlayer, QueryType } from 'discord-player';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

export const ttsSessions = new Map();
export function restoreTTSSessions() {}

// ── Generate OggOpus file via Google TTS → ffmpeg ────────────────────────────
async function generateOggFile(text) {
  const clean = text.replace(/https?:\/\/\S+/g, 'link').slice(0, 300);
  const id    = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const mp3   = join('/tmp', `phantom_tts_${id}.mp3`);
  const ogg   = join('/tmp', `phantom_tts_${id}.ogg`);

  const url  = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=en&client=tw-ob`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Phantom/1.0)' } });
  if (!resp.ok) throw new Error(`Google TTS HTTP ${resp.status}`);
  writeFileSync(mp3, Buffer.from(await resp.arrayBuffer()));

  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', mp3,
      '-c:a', 'libopus', '-b:a', '96k',
      '-ar', '48000', '-ac', '2',
      '-f', 'ogg', ogg,
      '-loglevel', 'error',
    ]);
    ff.on('close', code => { try { unlinkSync(mp3); } catch {} code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
    ff.on('error', err  => { try { unlinkSync(mp3); } catch {} reject(err); });
  });

  return ogg;
}

// ── Generate test tone via ffmpeg lavfi sine ──────────────────────────────────
async function generateTestTone() {
  const ogg = join('/tmp', `phantom_test_${Date.now()}.ogg`);
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:a', 'libopus', '-b:a', '96k',
      '-ar', '48000', '-ac', '2',
      '-f', 'ogg', ogg,
      '-loglevel', 'error',
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg test exit ${code}`)));
    ff.on('error', reject);
  });
  return ogg;
}

// ── Play a local ogg file through discord-player ──────────────────────────────
async function playLocalFile(voiceChannel, filePath, textChannel) {
  const player = useMainPlayer();
  await player.play(voiceChannel, filePath, {
    nodeOptions: {
      metadata: { channel: textChannel, isTTS: true },
      selfDeaf: false,
      volume: 90,
      leaveOnEmpty: false,
      leaveOnEnd: false,
      leaveOnStop: false,
    },
    requestedBy: voiceChannel.guild.members.me,
    audioPlayerOptions: { behaviors: {} },
  });
}

// ── Queue processing ──────────────────────────────────────────────────────────
async function playNext(guildId) {
  const s = ttsSessions.get(guildId);
  if (!s || !s.queue.length || s.playing) return;
  const { username, text } = s.queue.shift();
  s.playing = true;
  let oggFile = null;
  try {
    oggFile = await generateOggFile(`${username} says ${text}`);
    await playLocalFile(s.voiceChannel, oggFile, s.textChannel);

    // Wait for track to finish then play next
    const player = useMainPlayer();
    const queue  = player.nodes.get(guildId);
    if (queue) {
      queue.node.once('finish', () => {
        s.playing = false;
        try { if (oggFile && existsSync(oggFile)) unlinkSync(oggFile); } catch {}
        playNext(guildId);
      });
    } else {
      s.playing = false;
      try { if (oggFile && existsSync(oggFile)) unlinkSync(oggFile); } catch {}
    }
  } catch (e) {
    logger.error('[TTS] error:', e.message);
    s.textChannel?.send(`⚠️ TTS error: \`${e.message}\``).catch(() => {});
    s.playing = false;
    try { if (oggFile && existsSync(oggFile)) unlinkSync(oggFile); } catch {}
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
    .addSubcommand(s => s.setName('test').setDescription('Play a test tone to verify audio pipeline')),

  category: 'commands',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'join') {
      const vc = interaction.member.voice?.channel;
      if (!vc) return interaction.reply({ content: '❌ Join a voice channel first.', flags: MessageFlags.Ephemeral });

      if (ttsSessions.has(guildId)) ttsSessions.delete(guildId);

      ttsSessions.set(guildId, {
        voiceChannel: vc,
        textChannel: interaction.channel,
        textChannelId: interaction.channelId,
        queue: [],
        playing: false,
      });

      return interaction.reply(
        `🔊 Joined **${vc.name}** — reading **#${interaction.channel.name}** aloud.\nUse \`/tts leave\` to stop.`
      );
    }

    if (sub === 'test') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ Use `/tts join` first.', flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: '🎵 Generating test tone...', flags: MessageFlags.Ephemeral });
      let testFile = null;
      try {
        testFile = await generateTestTone();
        await playLocalFile(s.voiceChannel, testFile, s.textChannel);
        await interaction.channel.send('🔊 Test tone playing — did you hear a beep?');
      } catch (e) {
        await interaction.channel.send(`❌ Test failed: \`${e.message}\``);
        try { if (testFile && existsSync(testFile)) unlinkSync(testFile); } catch {}
      }
      return;
    }

    if (sub === 'leave') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ Not active.', flags: MessageFlags.Ephemeral });
      try {
        const player = useMainPlayer();
        const queue  = player.nodes.get(guildId);
        if (queue) queue.delete();
      } catch {}
      ttsSessions.delete(guildId);
      return interaction.reply('👋 TTS stopped.');
    }

    if (sub === 'clear') {
      const s = ttsSessions.get(guildId);
      if (!s) return interaction.reply({ content: '❌ No session.', flags: MessageFlags.Ephemeral });
      s.queue = [];
      try {
        const player = useMainPlayer();
        const queue  = player.nodes.get(guildId);
        if (queue) queue.node.stop();
      } catch {}
      s.playing = false;
      return interaction.reply({ content: '🗑️ Cleared.', flags: MessageFlags.Ephemeral });
    }
  },
};
