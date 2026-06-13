// src/utils/robloxDb.js
// Stores the link between a Discord user and their Roblox account.
// Reuses the bot's existing PostgreSQL connection (pgDb) instead of
// creating a new one — no extra dependencies needed.

import { pgDb } from './postgresDatabase.js';
import { logger } from './logger.js';

function linkKey(discordId) {
  return `roblox_link:${discordId}`;
}

export async function saveRobloxLink(discordId, robloxId, robloxUsername) {
  try {
    return await pgDb.set(linkKey(discordId), {
      robloxId,
      robloxUsername,
      verifiedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('robloxDb saveRobloxLink error:', error);
    return false;
  }
}

export async function getRobloxLink(discordId) {
  try {
    const data = await pgDb.get(linkKey(discordId));
    if (!data) return null;
    return { roblox_id: data.robloxId, roblox_username: data.robloxUsername };
  } catch (error) {
    logger.error('robloxDb getRobloxLink error:', error);
    return null;
  }
}

export async function removeRobloxLink(discordId) {
  try {
    return await pgDb.delete(linkKey(discordId));
  } catch (error) {
    logger.error('robloxDb removeRobloxLink error:', error);
    return false;
  }
}
