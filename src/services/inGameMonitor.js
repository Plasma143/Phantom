import { logger } from '../utils/logger.js';
import { db } from '../utils/database.js';
import { getConfigValue } from '../services/guildConfig.js';
import { EmbedBuilder } from 'discord.js';

const timers = new Map();
const lastCount = new Map();
const lastMessageId = new Map();

export function startInGameMonitor(client) {
  logger.info('[INGAME] In-game monitor service started');
  setTimeout(() => scanAll(client), 5000);
  setInterval(() => scanAll(client), 10 * 60 * 1000);
}

async function scanAll(client) {
  let keys = [];
  try { keys = await db.list('guild:'); } catch { return; }

  for (const key of keys) {
    const guildId = key.replace('guild:', '').replace(':config', '');
    if (!guildId || guildId.includes(':')) continue;
    try {
      const cfg = await getConfigValue(client, guildId, 'inGameMonitor', {});
      if (!cfg.enabled || !cfg.universeId || !cfg.channelId) {
        if (timers.has(guildId)) { clearInterval(timers.get(guildId)); timers.delete(guildId); }
        continue;
      }
      if (!timers.has(guildId)) {
        const intervalMs = (cfg.intervalMins || 5) * 60 * 1000;
        const timer = setInterval(() => poll(client, guildId), intervalMs);
        timers.set(guildId, timer);
        await poll(client, guildId);
      }
    } catch (err) { logger.error(`[INGAME] Error scanning guild ${guildId}:`, err); }
  }
}

async function poll(client, guildId) {
  try {
    const cfg = await getConfigValue(client, guildId, 'inGameMonitor', {});
    if (!cfg.enabled || !cfg.universeId || !cfg.channelId) return;

    const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${cfg.universeId}`);
    if (!res.ok) return;
    const data = await res.json();
    const game = data?.data?.[0];
    if (!game) return;

    const playerCount = game.playing ?? 0;
    const visitCount = game.visits ?? 0;
    const gameName = game.name ?? 'Unknown';

    if (lastCount.get(guildId) === playerCount) return;
    lastCount.set(guildId, playerCount);

    const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle(`🎮 ${gameName}`)
      .setColor(playerCount > 0 ? 0x57f287 : 0x5e6272)
      .addFields(
        { name: '👥 Players Online', value: `**${playerCount.toLocaleString()}**`, inline: true },
        { name: '🔢 Total Visits', value: `${visitCount.toLocaleString()}`, inline: true },
      )
      .setFooter({ text: `Universe ID: ${cfg.universeId}` })
      .setTimestamp();

    const lastId = lastMessageId.get(guildId);
    if (lastId) {
      try { const msg = await channel.messages.fetch(lastId); await msg.edit({ embeds: [embed] }); return; } catch {}
    }
    const sent = await channel.send({ embeds: [embed] });
    lastMessageId.set(guildId, sent.id);
  } catch (err) { logger.error(`[INGAME] Poll failed for guild ${guildId}:`, err); }
}
