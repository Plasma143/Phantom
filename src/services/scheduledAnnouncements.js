import { logger } from '../utils/logger.js';
import { db } from '../utils/database.js';
import { getConfigValue, updateGuildConfig } from '../services/guildConfig.js';
import { EmbedBuilder } from 'discord.js';

const CHECK_INTERVAL_MS = 60 * 1000;

export function startScheduledAnnouncements(client) {
  logger.info('[SCHEDULED] Announcements service started (checks every minute)');
  setInterval(async () => {
    try { await checkAndSend(client); }
    catch (err) { logger.error('[SCHEDULED] Error in check:', err); }
  }, CHECK_INTERVAL_MS);
}

async function checkAndSend(client) {
  const now = Date.now();
  let keys = [];
  try { keys = await db.list('guild:'); } catch { return; }

  for (const key of keys) {
    try {
      const guildId = key.replace('guild:', '').replace(':config', '');
      if (!guildId || guildId.includes(':')) continue;
      const anns = await getConfigValue(client, guildId, 'scheduledAnnouncements', []);
      if (!Array.isArray(anns) || anns.length === 0) continue;

      const remaining = [];
      let changed = false;

      for (const ann of anns) {
        if (!ann.sendAt || ann.sendAt > now) { remaining.push(ann); continue; }
        changed = true;
        try {
          const channel = await client.channels.fetch(ann.channelId).catch(() => null);
          if (!channel) continue;
          if (ann.title || ann.body) {
            const embed = new EmbedBuilder().setColor(0x5865F2).setTimestamp();
            if (ann.title) embed.setTitle(ann.title);
            if (ann.body) embed.setDescription(ann.body);
            embed.setFooter({ text: 'Scheduled announcement' });
            await channel.send({ embeds: [embed] });
            logger.info(`[SCHEDULED] Sent "${ann.title||'(untitled)'}" in guild ${guildId}`);
          }
        } catch (err) { logger.error(`[SCHEDULED] Failed to send for guild ${guildId}:`, err); }
      }

      if (changed) await updateGuildConfig(client, guildId, { scheduledAnnouncements: remaining });
    } catch (err) { logger.error(`[SCHEDULED] Error for key ${key}:`, err); }
  }
}
