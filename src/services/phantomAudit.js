// src/services/phantomAudit.js
//
// Central service for posting to the three Phantom audit log channels:
//   discord   → auditLogs.discordChannelId   (joins, leaves, bans, role changes)
//   roblox    → auditLogs.robloxChannelId    (rank changes from dashboard or auto-rank)
//   dashboard → auditLogs.dashboardChannelId (settings saves on the dashboard)
//
// Usage:
//   import { postAuditLog } from '../services/phantomAudit.js';
//   await postAuditLog(client, guild, 'discord', { color, title, description, fields, thumbnail });

import { EmbedBuilder } from 'discord.js';
import { getConfigValue } from './guildConfig.js';
import { logger } from '../utils/logger.js';

const CHANNEL_KEY = {
  discord:   'discordChannelId',
  roblox:    'robloxChannelId',
  dashboard: 'dashboardChannelId',
};

/**
 * Post an embed to one of the three Phantom audit channels.
 *
 * @param {import('discord.js').Client} client  - Discord client (or { db } for dashboard callers)
 * @param {import('discord.js').Guild}  guild   - The guild the event happened in
 * @param {'discord'|'roblox'|'dashboard'} channel - Which channel to post to
 * @param {{ color?, title?, description?, fields?, thumbnail?, footer? }} embedData
 */
export async function postAuditLog(client, guild, channel, embedData) {
  try {
    const key = CHANNEL_KEY[channel];
    if (!key) return;

    const auditLogs = await getConfigValue(client, guild.id, 'auditLogs', {});
    const channelId = auditLogs[key];
    if (!channelId) return;

    const logChannel =
      guild.channels.cache.get(channelId) ||
      (await guild.channels.fetch(channelId).catch(() => null));

    if (!logChannel?.isTextBased?.()) return;

    const embed = new EmbedBuilder()
      .setColor(embedData.color ?? 0x5865F2)
      .setTimestamp();

    if (embedData.title)                embed.setTitle(embedData.title);
    if (embedData.description)          embed.setDescription(embedData.description);
    if (embedData.thumbnail)            embed.setThumbnail(embedData.thumbnail);
    if (embedData.fields?.length)       embed.addFields(embedData.fields);
    if (embedData.footer)               embed.setFooter({ text: embedData.footer });

    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    logger.error('phantomAudit error:', err.message);
  }
}

// ── Convenience helpers for common events ─────────────────────────────────────

/** Format milliseconds into "X days" / "X months" etc. */
export function timeAgo(ms) {
  const days = Math.floor(ms / 86_400_000);
  if (days < 1)   return 'Today';
  if (days < 7)   return `${days}d ago`;
  if (days < 30)  return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
