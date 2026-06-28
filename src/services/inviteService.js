// src/services/inviteService.js
// Caches guild invite usage counts and calculates per-invite rewards.
import { logger } from '../utils/logger.js';

// guildId → Map(inviteCode → uses)
export const inviteCache = new Map();

export async function cacheGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, new Map(invites.map(i => [i.code, i.uses])));
    logger.debug(`[Invites] Cached ${invites.size} invite(s) for ${guild.name}`);
  } catch (err) {
    logger.debug(`[Invites] Could not cache for ${guild.name}: ${err.message}`);
  }
}

// Base rewards per invite
export const BASE_COINS = 50;
export const BASE_XP   = 25;

export function getInviteRewards(tier) {
  const mult = { premium: 1.5, enterprise: 2 }[tier] || 1;
  return {
    coins: Math.round(BASE_COINS * mult),
    xp:    Math.round(BASE_XP   * mult),
    mult,
  };
}
