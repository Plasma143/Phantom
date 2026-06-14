import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { db } from '../utils/database.js';

const SUPPORT_GUILD_ID = process.env.PHANTOM_SUPPORT_GUILD_ID || '';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(oldMember, newMember) {
    try {
      if (!newMember.guild) return;

      // ── Boost tracking for the Phantom support server ──────────────────────
      if (SUPPORT_GUILD_ID && newMember.guild.id === SUPPORT_GUILD_ID) {
        const wasBoosting = !!oldMember.premiumSinceTimestamp;
        const isBoosting  = !!newMember.premiumSinceTimestamp;

        if (!wasBoosting && isBoosting) {
          // Member just started boosting — work out how many boosts they applied
          try {
            const freshGuild  = await newMember.guild.fetch();
            const prevCount   = (await db.get(`support:boost_count`)) ?? freshGuild.premiumSubscriptionCount ?? 0;
            const newCount    = freshGuild.premiumSubscriptionCount ?? 0;
            const delta       = newCount - prevCount;
            const userBoosts  = delta >= 2 ? 2 : 1;

            await db.set(`user_boosts:${newMember.user.id}`, userBoosts);
            await db.set(`support:boost_count`, newCount);

            logger.info(`[BoostTrack] ${newMember.user.tag} boosted support server x${userBoosts}`);
          } catch (e) {
            logger.warn(`[BoostTrack] Error tracking new boost for ${newMember.user.tag}:`, e.message);
          }

        } else if (wasBoosting && !isBoosting) {
          // Member stopped boosting — remove their discount
          try {
            await db.delete(`user_boosts:${newMember.user.id}`);
            const freshGuild = await newMember.guild.fetch();
            await db.set(`support:boost_count`, freshGuild.premiumSubscriptionCount ?? 0);
            logger.info(`[BoostTrack] ${newMember.user.tag} removed boost from support server`);
          } catch (e) {
            logger.warn(`[BoostTrack] Error cleaning up boost for ${newMember.user.tag}:`, e.message);
          }
        }
        return; // Don't log nickname changes for the support server
      }
      // ───────────────────────────────────────────────────────────────────────

      const fields = [];

      
      fields.push({
        name: '👤 Member',
        value: `${newMember.user.tag} (${newMember.user.id})`,
        inline: true
      });

      
      if (oldMember.nickname !== newMember.nickname) {
        fields.push({
          name: '🏷️ Old Nickname',
          value: oldMember.nickname || '*(no nickname)*',
          inline: true
        });

        fields.push({
          name: '🏷️ New Nickname',
          value: newMember.nickname || '*(no nickname)*',
          inline: true
        });

        await logEvent({
          client: newMember.client,
          guildId: newMember.guild.id,
          eventType: EVENT_TYPES.MEMBER_NAME_CHANGE,
          data: {
            description: `Member nickname changed: ${newMember.user.tag}`,
            userId: newMember.user.id,
            fields
          }
        });

        return;
      }

    } catch (error) {
      logger.error('Error in guildMemberUpdate event:', error);
    }
  }
};
