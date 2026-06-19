import { logger } from '../utils/logger.js';
import { db } from '../utils/database.js';
import { getConfigValue } from '../services/guildConfig.js';
import { EmbedBuilder } from 'discord.js';

const CHECK_INTERVAL_MS = 3 * 60 * 1000;
const seenOnline = new Map();

export function startJoinNotify(client) {
  logger.info('[JOINNOTIFY] Join notification service started');
  setInterval(() => checkAll(client), CHECK_INTERVAL_MS);
}

async function checkAll(client) {
  let keys = [];
  try { keys = await db.list('guild:'); } catch { return; }

  for (const key of keys) {
    const guildId = key.replace('guild:', '').replace(':config', '');
    if (!guildId || guildId.includes(':')) continue;
    try {
      const cfg = await getConfigValue(client, guildId, 'joinNotify', {});
      if (!cfg.channelId || !Array.isArray(cfg.watchList) || cfg.watchList.length === 0) continue;
      for (const username of cfg.watchList) {
        try { await checkUser(client, guildId, cfg, username); } catch {}
      }
    } catch (err) { logger.error(`[JOINNOTIFY] Error checking guild ${guildId}:`, err); }
  }
}

async function checkUser(client, guildId, cfg, username) {
  const idRes = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  if (!idRes.ok) return;
  const idData = await idRes.json();
  const user = idData?.data?.[0];
  if (!user) return;

  const presRes = await fetch('https://presence.roblox.com/v1/presence/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds: [user.id] }),
  });
  if (!presRes.ok) return;
  const presData = await presRes.json();
  const pres = presData?.userPresences?.[0];
  if (!pres) return;

  const stateKey = `${guildId}:${user.id}`;
  if (pres.userPresenceType === 2) {
    if (!seenOnline.has(stateKey)) {
      seenOnline.set(stateKey, Date.now());
      const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
      if (!channel) return;
      const embed = new EmbedBuilder()
        .setTitle('🔔 Watched Player Joined Game')
        .setColor(0xffd166)
        .addFields(
          { name: '👤 Player', value: `[${user.name}](https://www.roblox.com/users/${user.id}/profile)`, inline: true },
          { name: '🎮 Game', value: pres.lastLocation || 'Unknown', inline: true },
        )
        .setTimestamp();
      await channel.send({ embeds: [embed] }).catch(() => {});
      logger.info(`[JOINNOTIFY] ${user.name} joined a game — alerted guild ${guildId}`);
    }
  } else {
    seenOnline.delete(stateKey);
  }
}
