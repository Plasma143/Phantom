// src/events/guildBanAdd.js
import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { postAuditLog } from '../services/phantomAudit.js';
import { getFromDb } from '../utils/database.js';

export default {
  name: Events.GuildBanAdd,
  once: false,

  async execute(ban) {
    try {
      const { guild, user, reason } = ban;
      const client = ban.client ?? guild.client;

      // Fetch full ban info to get the reason if available
      const fullBan = await guild.bans.fetch(user.id).catch(() => ban);

      await postAuditLog(client, guild, 'discord', {
        color: 0xED4245,
        title: '🔨 Member Banned',
        thumbnail: user.displayAvatarURL({ size: 64 }),
        fields: [
          { name: 'User', value: `${user.tag}`, inline: true },
          { name: 'ID', value: user.id, inline: true },
          { name: 'Reason', value: fullBan.reason || reason || 'No reason provided', inline: false },
        ],
        footer: `ID: ${user.id}`,
      });

      // ── Alliance ban sync ─────────────────────────────────────────────
      try {
        const alliances = await getFromDb(`alliances:${guild.id}`, []);
        const syncable  = alliances.filter(a => a.syncBans);
        for (const alliance of syncable) {
          const partnerGuild = client.guilds.cache.get(alliance.partnerGuildId);
          if (!partnerGuild) continue;
          await partnerGuild.members.ban(user.id, {
            reason: `Alliance ban sync from ${guild.name}: ${fullBan.reason || reason || 'No reason provided'}`,
          }).catch(() => {});
          logger.info(`[Alliance] Ban-synced ${user.tag} to ${alliance.partnerGuildName}`);
        }
      } catch (err) {
        logger.debug('[Alliance] Ban sync error:', err.message);
      }

    } catch (err) {
      logger.error('guildBanAdd error:', err.message);
    }
  },
};
