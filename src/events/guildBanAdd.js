// src/events/guildBanAdd.js
import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { postAuditLog } from '../services/phantomAudit.js';

export default {
  name: Events.GuildBanAdd,
  once: false,

  async execute(ban) {
    try {
      const { guild, user, reason } = ban;

      // Fetch full ban info to get the reason if available
      const fullBan = await guild.bans.fetch(user.id).catch(() => ban);

      await postAuditLog(ban.client ?? guild.client, guild, 'discord', {
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
    } catch (err) {
      logger.error('guildBanAdd audit error:', err.message);
    }
  },
};
