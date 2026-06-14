// utils/roblox.js
// Helper functions for talking to Roblox's APIs.
//
// Most of these are public read endpoints — no API key needed. The three
// at the bottom (getGroupRoles, getGroupMembership, updateGroupMemberRank)
// use Roblox's Open Cloud API and require an apiKey parameter — each server
// stores its own key in the DB (set via the dashboard) so multiple servers
// can bind different groups without sharing credentials.

import { logger } from './logger.js';

const USERS_API = 'https://users.roblox.com/v1';
const GROUPS_API = 'https://groups.roblox.com/v2';
const GROUPS_API_V1 = 'https://groups.roblox.com/v1';
const OPEN_CLOUD_API = 'https://apis.roblox.com/cloud/v2';

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
 * Returns null if the group doesn't exist. Public endpoint, no key needed.
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

// ---- Open Cloud: rank management (apiKey passed in, stored per-guild) ----

/**
 * Get every role in a group via Open Cloud — { id, rank, displayName, ... },
 * sorted by rank (handles pagination internally). Returns null on error
 * (e.g. missing/invalid API key).
 */
export async function getGroupRoles(groupId, apiKey) {
  let roles = [];
  let pageToken = '';

  try {
    do {
      const url = `${OPEN_CLOUD_API}/groups/${groupId}/roles?maxPageSize=20${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const res = await fetch(url, { headers: { 'x-api-key': apiKey } });

      if (!res.ok) {
        logger.error(`Open Cloud roles lookup failed: ${res.status}`);
        return null;
      }

      const data = await res.json();
      roles = roles.concat(data.groupRoles ?? []);
      pageToken = data.nextPageToken ?? '';
    } while (pageToken);

    return roles.sort((a, b) => a.rank - b.rank);
  } catch (err) {
    logger.error('Roblox API error (getGroupRoles):', err);
    return null;
  }
}

/**
 * Get a Roblox user's current membership record in a group via Open Cloud
 * (includes the `path` and `role` needed to update it). Returns null if
 * they're not a member, or on error.
 */
export async function getGroupMembership(groupId, robloxUserId, apiKey) {
  const filter = encodeURIComponent(`user=='users/${robloxUserId}'`);
  const url = `${OPEN_CLOUD_API}/groups/${groupId}/memberships?filter=${filter}`;

  try {
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    if (!res.ok) {
      logger.error(`Open Cloud membership lookup failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.groupMemberships?.[0] ?? null; // { path, user, role, ... }
  } catch (err) {
    logger.error('Roblox API error (getGroupMembership):', err);
    return null;
  }
}

/**
 * Change a Roblox user's rank in a group via Open Cloud's "Update Group
 * Membership" endpoint. `targetRank` is the rank number (0-255), not a
 * role ID — this looks up the matching role for you.
 *
 * Returns { success: true } or { success: false, error: '...' }.
 */
export async function updateGroupMemberRank(groupId, robloxUserId, targetRank, apiKey) {

  try {
    const [membership, roles] = await Promise.all([
      getGroupMembership(groupId, robloxUserId, apiKey),
      getGroupRoles(groupId, apiKey),
    ]);

    if (!membership) {
      return { success: false, error: 'User is not a member of this group.' };
    }
    if (!roles) {
      return { success: false, error: 'Could not load group roles from Roblox.' };
    }

    const targetRole = roles.find((r) => r.rank === targetRank);
    if (!targetRole) {
      return { success: false, error: `No role found for rank ${targetRank}.` };
    }

    const res = await fetch(`${OPEN_CLOUD_API}/${membership.path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        path: membership.path,
        role: `groups/${groupId}/roles/${targetRole.id}`,
        user: `users/${robloxUserId}`,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error(`Open Cloud rank update failed: ${res.status} ${text}`);
      return { success: false, error: `Roblox rejected the update (HTTP ${res.status}).` };
    }

    return { success: true };
  } catch (err) {
    logger.error('Roblox API error (updateGroupMemberRank):', err);
    return { success: false, error: 'Unexpected error contacting Roblox.' };
  }
}

/**
 * Get all pending join requests for a group (up to 20 per page).
 * Returns { joinRequests: [...], nextPageToken } or throws on error.
 */
export async function getGroupJoinRequests(groupId, apiKey, pageToken = null) {
  const url = new URL(`${OPEN_CLOUD_API}/groups/${groupId}/join-requests`);
  url.searchParams.set('maxPageSize', '20');
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': apiKey },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get join requests: ${res.status} ${text}`);
  }

  const data = await res.json();
  // Roblox returns { joinRequests: [{ user: 'users/123', ... }], nextPageToken }
  return data;
}

/**
 * Accept a pending join request for a specific Roblox user.
 * Returns true on success, throws on error.
 */
export async function acceptGroupJoinRequest(groupId, robloxUserId, apiKey) {
  const res = await fetch(`${OPEN_CLOUD_API}/groups/${groupId}/join-requests/${robloxUserId}:accept`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to accept join request: ${res.status} ${text}`);
  }

  return true;
}

/**
 * Decline a pending join request for a specific Roblox user.
 * Returns true on success, throws on error.
 */
export async function declineGroupJoinRequest(groupId, robloxUserId, apiKey) {
  const res = await fetch(`${OPEN_CLOUD_API}/groups/${groupId}/join-requests/${robloxUserId}:decline`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to decline join request: ${res.status} ${text}`);
  }

  return true;
}
