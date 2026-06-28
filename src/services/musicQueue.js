// src/services/musicQueue.js
// Royalty-free music queue using Jamendo API (100% legal, CC licensed).
import {
  createAudioPlayer, createAudioResource,
  AudioPlayerStatus, getVoiceConnection, StreamType,
} from '@discordjs/voice';
import { EmbedBuilder } from 'discord.js';
import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';

const CLIENT_ID = process.env.JAMENDO_CLIENT_ID || 'ced252a1';

// guildId → { queue, current, player, textChannel, volume, loop, shuffle }
export const musicQueues = new Map();

// ── Jamendo search ────────────────────────────────────────────────────────────
export async function searchJamendo(query, limit = 5) {
  const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${CLIENT_ID}&format=json&limit=${limit}&search=${encodeURIComponent(query)}&audioformat=mp32&imagesize=200&include=musicinfo`;
  const res = await fetch(url);
  const data = await res.json();
  return (data.results || []).filter(t => t.audio);
}

export function formatTrack(t) {
  return {
    id:         t.id,
    title:      t.name,
    artist:     t.artist_name,
    album:      t.album_name  || 'Unknown Album',
    duration:   t.duration    || 0,
    url:        t.audio,
    image:      t.image       || null,
    jamendoUrl: `https://www.jamendo.com/track/${t.id}`,
  };
}

export function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// ── Playback ──────────────────────────────────────────────────────────────────
export async function playNext(guildId) {
  const q = musicQueues.get(guildId);
  if (!q) return;

  let track;
  if (q.loop && q.current) {
    track = q.current;
  } else if (q.queue.length) {
    track = q.shuffle
      ? q.queue.splice(Math.floor(Math.random() * q.queue.length), 1)[0]
      : q.queue.shift();
  } else {
    q.current = null;
    if (q.textChannel) {
      q.textChannel.send({
        embeds: [new EmbedBuilder().setColor(0x7c3aed).setDescription('✅ Queue finished — use `/play` to add more tracks!')]
      }).catch(() => {});
    }
    return;
  }

  q.current = track;

  const connection = getVoiceConnection(guildId);
  if (!connection) return;

  try {
    const ffmpeg = spawn('ffmpeg', [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', track.url,
      '-vn',
      '-ac', '2',
      '-ar', '48000',
      '-acodec', 'libopus',
      '-b:a', '128k',
      '-f', 'ogg',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg logs
    ffmpeg.on('error', err => logger.debug('[Music] ffmpeg error:', err.message));

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
    q.player.play(resource);
    connection.subscribe(q.player);

    if (q.textChannel) {
      const embed = new EmbedBuilder()
        .setTitle('🎵 Now Playing')
        .setDescription(`**[${track.title}](${track.jamendoUrl})**\nby ${track.artist}`)
        .setColor(0x7c3aed)
        .addFields(
          { name: 'Duration', value: formatDuration(track.duration), inline: true },
          { name: 'Album',    value: track.album,                    inline: true },
          { name: 'License',  value: '✅ Royalty-free (CC)',         inline: true },
        )
        .setFooter({ text: `${q.queue.length} track(s) in queue` });
      if (track.image) embed.setThumbnail(track.image);
      q.textChannel.send({ embeds: [embed] }).catch(() => {});
    }

    logger.info(`[Music] Playing "${track.title}" by ${track.artist} in guild ${guildId}`);
  } catch (err) {
    logger.error('[Music] Playback error:', err.message);
    q.current = null;
    setTimeout(() => playNext(guildId), 1000);
  }
}

// ── Queue creation ────────────────────────────────────────────────────────────
export function createGuildQueue(guildId, textChannel) {
  const player = createAudioPlayer();

  player.on(AudioPlayerStatus.Idle, () => {
    const q = musicQueues.get(guildId);
    if (!q) return;
    if (q.queue.length || q.loop) {
      playNext(guildId);
    } else {
      q.current = null;
      if (q.textChannel) {
        q.textChannel.send({
          embeds: [new EmbedBuilder().setColor(0x7c3aed).setDescription('✅ Queue finished — use `/play` to add more tracks!')]
        }).catch(() => {});
      }
    }
  });

  player.on('error', err => {
    logger.error('[Music] Player error:', err.message);
    setTimeout(() => playNext(guildId), 1000);
  });

  const q = { queue: [], current: null, player, textChannel, volume: 1, loop: false, shuffle: false };
  musicQueues.set(guildId, q);
  return q;
}

export function destroyGuildQueue(guildId) {
  const q = musicQueues.get(guildId);
  if (!q) return;
  try { q.player.stop(true); } catch {}
  try { getVoiceConnection(guildId)?.destroy(); } catch {}
  musicQueues.delete(guildId);
}
