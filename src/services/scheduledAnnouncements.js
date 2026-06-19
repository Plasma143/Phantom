import { logger } from '../utils/logger.js';
import { db } from '../utils/database.js';
import { getConfigValue, updateGuildConfig } from '../utils/helpers.js';
import { EmbedBuilder } from 'discord.js';

const CHECK_INTERVAL_MS = 60 * 1000; // check every minute

export function startScheduledAnnouncements(client) {
  logger.info('[SCHEDULED] Announcements service started (checks every minute)');

  setInterval(async () => {
    try {
      await checkAndSend(client);
    } catch (err) {
      logger.error('[SCHEDULED] Error in scheduled announcements check:', err);
    }
  }, CHECK_INTERVAL_MS);
}

async function checkAndSend(client) {
  const now = Date.now();

  // List all scheduledAnnouncements keys across guilds
  let keys = [];
  try {
    keys = await db.list('guild:');
  } catch {
    return;
  }

  for (const key of keys) {
    try {
      const guildId = key.replace('guild:', '');
      const anns = await getConfigValue({ db }, guildId, 'scheduledAnnouncements', []);
      if (!Array.isArray(anns) || anns.length === 0) continue;

      const remaining = [];
      let changed = false;

      for (const ann of anns) {
        if (!ann.sendAt || ann.sendAt > now) {
          remaining.push(ann);
          continue;
        }

        // Time to send
        changed = true;
        try {
          const channel = await client.channels.fetch(ann.channelId).catch(() => null);
          if (!channel) {
            logger.warn(`[SCHEDULED] Channel ${ann.channelId} not found for guild ${guildId}, skipping`);
            continue;
          }

          if (ann.title || ann.body) {
            const embed = new EmbedBuilder()
              .setColor(0x5865F2)
              .setTimestamp();

            if (ann.title) embed.setTitle(ann.title);
            if (ann.body) embed.setDescription(ann.body);
            embed.setFooter({ text: 'Scheduled announcement' });

            await channel.send({ embeds: [embed] });
            logger.info(`[SCHEDULED] Sent announcement "${ann.title||'(untitled)'}" in guild ${guildId} channel ${ann.channelId}`);
          }
        } catch (err) {
          logger.error(`[SCHEDULED] Failed to send announcement for guild ${guildId}:`, err);
        }
      }

      if (changed) {
        await updateGuildConfig({ db }, guildId, { scheduledAnnouncements: remaining });
      }
    } catch (err) {
      logger.error(`[SCHEDULED] Error processing key ${key}:`, err);
    }
  }
}
