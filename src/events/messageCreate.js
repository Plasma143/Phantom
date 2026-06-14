import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling.js';
import { addXp } from '../services/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { getConfigValue } from '../services/guildConfig.js';
import { getRobloxUserByUsername, getGroupRoles, updateGroupMemberRank } from '../utils/roblox.js';
import { parsePromotionLog, applyFormat, DEFAULT_LOG_FORMAT } from '../services/promotionParser.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (message.author.bot || !message.guild) return;

      await handleLeveling(message, client);
      await handleAutoRank(message, client);
    } catch (error) {
      logger.error('Error in messageCreate event:', error);
    }
  }
};

// ---- Auto-rank: watches configured channels for promotion logs ----

async function handleAutoRank(message, client) {
  try {
    const autoRank = await getConfigValue(client, message.guild.id, 'autoRank', {});

    // Quick exits — don't waste API calls if not configured
    if (!autoRank.enabled) return;
    if (!autoRank.watchChannelId) return;
    if (message.channel.id !== autoRank.watchChannelId) return;

    const roblox = await getConfigValue(client, message.guild.id, 'roblox', {});
    if (!roblox.groupId || !roblox.openCloudKey) return;

    // Build message content — handle both plain text and embeds
    let content = message.content || '';
    if (message.embeds?.length) {
      const embed = message.embeds[0];
      const parts = [];
      if (embed.title)       parts.push(embed.title);
      if (embed.description) parts.push(embed.description);
      for (const field of embed.fields || []) {
        parts.push(`${field.name}: ${field.value}`);
      }
      content = [content, ...parts].filter(Boolean).join('\n');
    }

    if (!content.trim()) return;

    // Parse with free pattern matching — no API needed
    const parsed = parsePromotionLog(content, autoRank.customFormat || null);

    // Not a promotion log — stay silent (don't react to every message)
    if (parsed.error || !parsed.username || !parsed.newRank) {
      logger.debug(`[autoRank] Not a promotion log in ${message.guild.name}: ${parsed.error || 'missing fields'}`);
      return;
    }

    // Look up the Roblox user
    const robloxUser = await getRobloxUserByUsername(parsed.username);
    if (!robloxUser) {
      logger.warn(`[autoRank] User not found on Roblox: ${parsed.username}`);
      await message.react('❓').catch(() => {});
      return;
    }

    // Get group roles and match
    const roles = await getGroupRoles(roblox.groupId, roblox.openCloudKey);
    if (!roles) return;

    let targetRole =
      roles.find((r) => r.displayName.toLowerCase() === parsed.newRank.toLowerCase()) ||
      roles.find((r) => r.displayName.toLowerCase().includes(parsed.newRank.toLowerCase()));

    if (!targetRole || targetRole.rank === 255) {
      logger.warn(`[autoRank] No matching rank for "${parsed.newRank}" in ${message.guild.name}`);
      await message.react('❓').catch(() => {});
      return;
    }

    // Apply the rank
    const result = await updateGroupMemberRank(roblox.groupId, robloxUser.id, targetRole.rank, roblox.openCloudKey);

    if (!result.success) {
      logger.error(`[autoRank] Rank apply failed: ${result.error}`);
      await message.react('❌').catch(() => {});
      return;
    }

    // React to confirm on the original message
    await message.react('✅').catch(() => {});

    // Post confirmation to log channel using custom or default format
    if (autoRank.logChannelId) {
      const logChannel = message.guild.channels.cache.get(autoRank.logChannelId);
      if (logChannel) {
        const format = autoRank.customFormat || DEFAULT_LOG_FORMAT;
        const logText = applyFormat(format, {
          username:  robloxUser.name,
          newRank:   targetRole.displayName,
          reason:    parsed.reason,
          ranker:    parsed.ranker || message.author.username,
        });
        await logChannel.send(logText).catch((err) =>
          logger.warn('[autoRank] Could not post to log channel:', err.message),
        );
      }
    }

    logger.info(`[autoRank] ${robloxUser.name} → ${targetRole.displayName} in ${message.guild.name}`);
  } catch (err) {
    logger.error('handleAutoRank error:', err);
  }
}








async function handleLeveling(message, client) {
  try {
    const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
    const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
    if (!canProcess) {
      return;
    }

    const levelingConfig = await getLevelingConfig(client, message.guild.id);
    
    if (!levelingConfig?.enabled) {
      return;
    }

    
    if (levelingConfig.ignoredChannels?.includes(message.channel.id)) {
      return;
    }

    
    if (levelingConfig.ignoredRoles?.length > 0) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => {
        return null;
      });
      if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) {
        return;
      }
    }

    
    if (levelingConfig.blacklistedUsers?.includes(message.author.id)) {
      return;
    }

    
    if (!message.content || message.content.trim().length === 0) {
      return;
    }

    const userData = await getUserLevelData(client, message.guild.id, message.author.id);
    
    
    const cooldownTime = levelingConfig.xpCooldown || 60;
    const now = Date.now();
    const timeSinceLastMessage = now - (userData.lastMessage || 0);
    
    
    if (timeSinceLastMessage < cooldownTime * 1000) {
      return;
    }

    
    const minXP = levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15;
    const maxXP = levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25;

    
    const safeMinXP = Math.max(1, minXP);
    const safeMaxXP = Math.max(safeMinXP, maxXP);

    
    const xpToGive = Math.floor(Math.random() * (safeMaxXP - safeMinXP + 1)) + safeMinXP;

    
    let finalXP = xpToGive;
    if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {
      finalXP = Math.floor(finalXP * levelingConfig.xpMultiplier);
    }

    
    const result = await addXp(client, message.guild, message.member, finalXP);
    
    if (result.success && result.leveledUp) {
      logger.info(
        `${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`
      );
    }
  } catch (error) {
    logger.error('Error handling leveling for message:', error);
  }
}
