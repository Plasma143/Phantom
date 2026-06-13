// utils/roblox.js
// Helper functions for talking to Roblox's public web APIs.
// No API key needed for any of these — they're public read endpoints.

import { logger } from './logger.js';

const USERS_API = 'https://users.roblox.com/v1';
const GROUPS_API = 'https://groups.roblox.com/v2';
const GROUPS_API_V1 = 'https://groups.roblox.com/v1';

/**
 * Look up a Roblox user by their username.
 * Returns { id, name, displayName } or null if no user was found.
 */
export async function getRobloxUserByUsername(username) {
  try {
    const res = await fetch(`${USERS_API}/usernames/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: true,
      }),
    });

    if (!res.ok) {
      logger.error(`Roblox username lookup failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.data?.[0] ?? null;
  } catch (err) {
    logger.error('Roblox API error (getRobloxUserByUsername):', err);
    return null;
  }
}

/**
 * Get a Roblox user's public profile, including their bio ("description").
 */
export async function getRobloxUserInfo(userId) {
  try {
    const res = await fetch(`${USERS_API}/users/${userId}`);
    if (!res.ok) {
      logger.error(`Roblox user info lookup failed: ${res.status}`);
      return null;
    }
    return await res.json(); // includes .id, .name, .displayName, .description
  } catch (err) {
    logger.error('Roblox API error (getRobloxUserInfo):', err);
    return null;
  }
}

/**
 * Get every group a user belongs to, along with their role/rank in each.
 * Returns an array of { group: { id, name }, role: { id, name, rank } }.
 */
export async function getRobloxUserGroupRoles(userId) {
  try {
    const res = await fetch(`${GROUPS_API}/users/${userId}/groups/roles`);
    if (!res.ok) {
      logger.error(`Roblox group roles lookup failed: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.data ?? [];
  } catch (err) {
    logger.error('Roblox API error (getRobloxUserGroupRoles):', err);
    return [];
  }
}

/**
 * Get a user's rank (0-255) in one specific group.
 * Returns 0 if they're not in the group at all.
 */
export async function getRobloxRankInGroup(userId, groupId) {
  const roles = await getRobloxUserGroupRoles(userId);
  const match = roles.find((r) => r.group.id === Number(groupId));
  return match ? match.role.rank : 0;
}

/**
 * Generate a short random code for the "put this in your bio" check.
 */
export function generateVerificationCode() {
  return `verify-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Check whether a user's Roblox bio currently contains the given code.
 */
export async function bioContainsCode(userId, code) {
  const info = await getRobloxUserInfo(userId);
  return typeof info?.description === 'string' && info.description.includes(code);
}

/**
 * Get basic info about a Roblox group (name, description, member count, etc.)
 * Returns null if the group doesn't exist.
 */
export async function getRobloxGroupInfo(groupId) {
  try {
    const res = await fetch(`${GROUPS_API_V1}/groups/${groupId}`);
    if (!res.ok) return null;
    return await res.json(); // { id, name, description, owner, memberCount, ... }
  } catch (err) {
    logger.error('Roblox API error (getRobloxGroupInfo):', err);
    return null;
  }
}
