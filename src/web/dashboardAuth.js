// src/web/dashboardAuth.js
//
// Web dashboard — "Login with Discord" flow + server picker + settings page
// + a public commands/help page.
//   /dashboard/login         -> redirects to Discord's OAuth consent screen
//   /dashboard/auth/callback -> exchanges the code, fetches the user, sets a cookie
//   /dashboard/logout         -> clears the session cookie
//   /dashboard                -> shows the servers you can manage with R2-D2
//   /dashboard/server/:id     -> view + edit that server's Roblox setup
//   /dashboard/commands       -> public list of all slash commands
//
// The save logic here mirrors /robloxsetup's group, verifiedrole, and
// rankrole subcommands — same validation, same updateGuildConfig calls.

import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { logger } from '../utils/logger.js';
import { getConfigValue, updateGuildConfig } from '../services/guildConfig.js';
import { db } from '../utils/database.js';
import { getRobloxGroupInfo } from '../utils/roblox.js';

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://r2-d2-production.up.railway.app';
const REDIRECT_URI = `${PUBLIC_URL}/dashboard/auth/callback`;

const CLIENT_ID = process.env.DASHBOARD_CLIENT_ID;
const CLIENT_SECRET = process.env.DASHBOARD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_TOKEN;

const PERM_ADMINISTRATOR = 0x8n;
const PERM_MANAGE_GUILD = 0x20n;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.join(__dirname, '../commands');

export const dashboardAuthRouter = Router();

// Parse form submissions (built into Express — no new dependency).
// Scoped to this router only, so it doesn't affect anything else.
dashboardAuthRouter.use(express.urlencoded({ extended: true }));

// Quietly avoid a 404 in the browser console for favicon requests.
dashboardAuthRouter.get('/favicon.ico', (req, res) => res.status(204).end());

// ---- Tiny manual cookie helpers (avoids adding cookie-parser as a dependency) ----

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

// ---- Command metadata (for /dashboard/commands) ----

let cachedCommands = null;

async function findCommandFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  let files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(await findCommandFiles(fullPath));
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function loadCommandList() {
  if (cachedCommands) return cachedCommands;

  const commands = [];
  const files = await findCommandFiles(COMMANDS_DIR);

  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(file).href);
      const data = mod.default?.data;
      if (!data || typeof data.toJSON !== 'function') continue;

      const json = data.toJSON();
      const subcommands = (json.options || [])
        .filter((opt) => opt.type === 1) // SUB_COMMAND
        .map((opt) => ({ name: opt.name, description: opt.description }));

      commands.push({
        name: json.name,
        description: json.description,
        adminOnly: Boolean(json.default_member_permissions),
        subcommands,
      });
    } catch (error) {
      logger.warn(`Could not load command metadata from ${file}: ${error.message}`);
    }
  }

  commands.sort((a, b) => a.name.localeCompare(b.name));
  cachedCommands = commands;
  return commands;
}

function renderCommand(cmd) {
  const adminBadge = cmd.adminOnly
    ? `<span style="background:#444; color:#aaa; font-size:11px; padding:2px 6px; border-radius:4px; margin-left:8px; vertical-align:middle;">Admin</span>`
    : '';

  const subcommandsHtml = cmd.subcommands.length
    ? `
      <ul style="margin:8px 0 0; padding-left:20px; color:#ccc; font-size:14px;">
        ${cmd.subcommands
          .map((sub) => `<li><code>/${cmd.name} ${sub.name}</code> — ${sub.description}</li>`)
          .join('')}
      </ul>
    `
    : '';

  return `
    <div style="background:#2b2d31; padding:16px; border-radius:8px; margin-bottom:12px;">
      <div><code style="font-size:15px; font-weight:bold;">/${cmd.name}</code>${adminBadge}</div>
      <p style="color:#aaa; margin:6px 0 0; font-size:14px;">${cmd.description}</p>
      ${subcommandsHtml}
    </div>
  `;
}

// ---- Page shell ----

function renderPage(bodyHtml, user = null) {
  const navUser = user
    ? `
      <div style="display:flex; align-items:center; gap:10px;">
        <img src="${avatarUrl(user)}" width="28" height="28" style="border-radius:50%;" />
        <span style="font-size:14px;">${user.username}</span>
        <a href="/dashboard/logout" style="color:#aaa; font-size:13px; text-decoration:none; border:1px solid #444; padding:4px 10px; border-radius:6px;">Logout</a>
      </div>
    `
    : '';

  return `
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>R2-D2 Dashboard</title>
        <style>
          * { box-sizing: border-box; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
          a { transition: opacity 0.15s; }
          a:hover { opacity: 0.75; }
          button { transition: opacity 0.15s, transform 0.05s; cursor: pointer; }
          button:hover { opacity: 0.9; }
          button:active { transform: scale(0.98); }
          select, input { transition: border-color 0.15s; }
          select:hover, input:hover, select:focus, input:focus { border-color: #5865F2; outline: none; }
        </style>
      </head>
      <body style="margin:0; background:#1e1f22; color:#fff; font-size:16px;">
        <div style="background:#2b2d31; padding:14px 24px; display:flex; flex-wrap:wrap; gap:20px; justify-content:space-between; align-items:center; border-bottom:1px solid #1e1f22;">
          <div style="display:flex; align-items:center; gap:20px;">
            <a href="/dashboard" style="color:#fff; text-decoration:none; font-weight:bold; font-size:18px;">R2-D2 Dashboard</a>
            <a href="/dashboard/commands" style="color:#aaa; text-decoration:none; font-size:14px;">Commands</a>
          </div>
          ${navUser}
        </div>
        <div style="padding:40px 20px; text-align:center;">
          ${bodyHtml}
        </div>
      </body>
    </html>
  `;
}

function loginPrompt(message) {
  return renderPage(`
    <p>${message}</p>
    <a href="/dashboard/login" style="display:inline-block; padding:12px 24px; background:#5865F2; color:#fff; border-radius:8px; text-decoration:none; font-weight:bold;">Login with Discord</a>
  `);
}

function avatarUrl(user) {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : 'https://cdn.discordapp.com/embed/avatars/0.png';
}

function canManage(guild) {
  if (guild.owner) return true;
  const perms = BigInt(guild.permissions || 0);
  return (perms & PERM_ADMINISTRATOR) === PERM_ADMINISTRATOR || (perms & PERM_MANAGE_GUILD) === PERM_MANAGE_GUILD;
}

function guildIconUrl(guild) {
  return guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
    : 'https://cdn.discordapp.com/embed/avatars/0.png';
}

// Checks the logged-in user can manage `guildId`. On failure, sends an
// appropriate response itself and returns null — callers should just
// `return` if they get null back.
async function requireGuildAccess(req, res, guildId) {
  const token = getCookie(req, 'dashboard_token');

  if (!token) {
    res.send(loginPrompt("Log in with Discord to manage your server's settings."));
    return null;
  }

  const [userRes, userGuildsRes] = await Promise.all([
    fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);

  if (!userRes.ok || !userGuildsRes.ok) {
    clearCookie(res, 'dashboard_token');
    res.send(loginPrompt('Your session expired — please log in again.'));
    return null;
  }

  const user = await userRes.json();
  const userGuilds = await userGuildsRes.json();
  const guild = userGuilds.find((g) => g.id === guildId);

  if (!guild || !canManage(guild)) {
    res.status(403).send(
      renderPage(
        `
        <p>You don't have permission to manage this server.</p>
        <a href="/dashboard" style="color:#5865F2;">← Back to servers</a>
      `,
        user,
      ),
    );
    return null;
  }

  return { token, user, guild };
}

// Shared input styling for form fields.
const fieldStyle = 'padding:8px; border-radius:6px; background:#1e1f22; color:#fff; border:1px solid #444;';
const buttonStyle = 'padding:8px 16px; background:#5865F2; color:#fff; border:none; border-radius:6px; font-weight:bold;';

// ---- Routes ----

// Step 1: send the user to Discord's consent screen.
dashboardAuthRouter.get('/dashboard/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'oauth_state', state, 600); // 10 minutes to complete login

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    state,
  });

  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// Step 2: Discord redirects back here with a code (and our state).
dashboardAuthRouter.get('/dashboard/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const expectedState = getCookie(req, 'oauth_state');
  clearCookie(res, 'oauth_state');

  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  if (!state || !expectedState || state !== expectedState) {
    return res.status(400).send('Login session expired or invalid — please try logging in again.');
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      logger.error('Dashboard token exchange failed:', text);
      return res.status(500).send('Login failed — could not exchange code for token.');
    }

    const tokenData = await tokenRes.json();

    setCookie(res, 'dashboard_token', tokenData.access_token, tokenData.expires_in);

    res.redirect('/dashboard');
  } catch (error) {
    logger.error('Dashboard OAuth callback error:', error);
    res.status(500).send('Something went wrong during login.');
  }
});

// Log out — clears the session cookie.
dashboardAuthRouter.get('/dashboard/logout', (req, res) => {
  clearCookie(res, 'dashboard_token');
  res.redirect('/dashboard');
});

// Public: list every slash command R2-D2 offers.
dashboardAuthRouter.get('/dashboard/commands', async (req, res) => {
  // Best-effort login lookup, just to keep the nav consistent. Not required.
  let user = null;
  const token = getCookie(req, 'dashboard_token');
  if (token) {
    try {
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (userRes.ok) user = await userRes.json();
    } catch {
      // ignore — this page doesn't require being logged in
    }
  }

  try {
    const commands = await loadCommandList();

    const list = commands.length
      ? commands.map(renderCommand).join('')
      : '<p style="color:#888;"><em>No commands found.</em></p>';

    const body = `
      <h2 style="margin-top:0;">Commands</h2>
      <p style="color:#aaa; margin-bottom:24px;">Here's everything R2-D2 can do. Commands marked <span style="background:#444; color:#aaa; font-size:11px; padding:2px 6px; border-radius:4px;">Admin</span> require server management permissions.</p>

      <div style="max-width:640px; margin:0 auto 24px; text-align:left; background:#2b2d31; padding:16px; border-radius:8px;">
        <p style="margin:0;"><strong>Setting up Roblox verification?</strong> Server admins can configure this from the <a href="/dashboard" style="color:#5865F2;">dashboard</a>.</p>
      </div>

      <div style="max-width:640px; margin:0 auto; text-align:left;">${list}</div>
    `;

    res.send(renderPage(body, user));
  } catch (error) {
    logger.error('Commands page error:', error);
    res.status(500).send('Something went wrong.');
  }
});

// Step 3: show the servers this user can manage with R2-D2.
dashboardAuthRouter.get('/dashboard', async (req, res) => {
  const token = getCookie(req, 'dashboard_token');

  if (!token) {
    return res.send(loginPrompt("Log in with Discord to manage your server's settings."));
  }

  try {
    const [userRes, userGuildsRes, botGuildsRes] = await Promise.all([
      fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      }),
    ]);

    if (!userRes.ok || !userGuildsRes.ok) {
      clearCookie(res, 'dashboard_token');
      return res.send(loginPrompt('Your session expired — please log in again.'));
    }

    const user = await userRes.json();
    const userGuilds = await userGuildsRes.json();
    const botGuilds = botGuildsRes.ok ? await botGuildsRes.json() : [];
    const botGuildIds = new Set(botGuilds.map((g) => g.id));

    const manageable = userGuilds.filter((g) => botGuildIds.has(g.id) && canManage(g));

    let body;
    if (manageable.length === 0) {
      body = `<p style="margin-top:12px; color:#aaa;">No servers found where you have <strong>Manage Server</strong> permission and R2-D2 is present.</p>`;
    } else {
      const items = manageable
        .map(
          (g) => `
            <a href="/dashboard/server/${g.id}" style="display:flex; align-items:center; gap:14px; padding:14px 18px; background:#2b2d31; border-radius:10px; text-decoration:none; color:#fff; margin-bottom:10px; font-weight:600;">
              <img src="${guildIconUrl(g)}" width="40" height="40" style="border-radius:50%;" />
              <span>${g.name}</span>
            </a>
          `,
        )
        .join('');

      body = `
        <h2 style="margin-top:0;">Your Servers</h2>
        <p style="color:#aaa; margin-bottom:20px;">Choose a server to manage:</p>
        <div style="max-width:420px; margin:0 auto; text-align:left;">${items}</div>
      `;
    }

    res.send(renderPage(body, user));
  } catch (error) {
    logger.error('Dashboard error:', error);
    res.status(500).send('Something went wrong.');
  }
});

// Step 4: view + edit one server's Roblox setup.
dashboardAuthRouter.get('/dashboard/server/:guildId', async (req, res) => {
  const { guildId } = req.params;

  try {
    const access = await requireGuildAccess(req, res, guildId);
    if (!access) return; // requireGuildAccess already sent a response

    const { guild, user } = access;

    const [rolesRes, roblox] = await Promise.all([
      fetch(`https://discord.com/api/guilds/${guildId}/roles`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      }),
      getConfigValue({ db }, guildId, 'roblox', {}),
    ]);

    const allRoles = rolesRes.ok ? await rolesRes.json() : [];
    const roleMap = new Map(allRoles.map((r) => [r.id, r.name]));
    const roleName = (id) => (id ? roleMap.get(id) || `Unknown role (${id})` : null);

    // Roles people can actually pick — everyone's @everyone role has the
    // same id as the guild itself, so exclude that one.
    const assignableRoles = allRoles
      .filter((r) => r.id !== guildId)
      .sort((a, b) => b.position - a.position);

    const roleOptions = (selectedId) =>
      assignableRoles
        .map((r) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${r.name}</option>`)
        .join('');

    let groupLine = '<em>Not set</em>';
    if (roblox.groupId) {
      const group = await getRobloxGroupInfo(roblox.groupId);
      groupLine = group
        ? `Currently: <strong>${group.name}</strong> (ID: ${roblox.groupId})`
        : `Currently: Group ID ${roblox.groupId} (couldn't load name)`;
    }

    const rankRoleEntries = Object.entries(roblox.rankRoles || {});
    const rankRolesHtml = rankRoleEntries.length
      ? rankRoleEntries
          .map(
            ([rank, roleId]) => `
              <li style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <span>Rank ${rank} → ${roleName(roleId)}</span>
                <form method="POST" action="/dashboard/server/${guildId}/rank-roles/remove" style="margin:0;">
                  <input type="hidden" name="rank" value="${rank}" />
                  <button type="submit" style="background:none; border:none; color:#ed4245; font-size:13px;">Remove</button>
                </form>
              </li>
            `,
          )
          .join('')
      : '<li style="color:#888;"><em>None set</em></li>';

    let banner = '';
    if (req.query.success) {
      banner = `<p style="background:#2b3d2f; color:#3ba55c; padding:10px; border-radius:6px; max-width:480px; margin:0 auto 16px;">✅ ${req.query.success}</p>`;
    } else if (req.query.error) {
      banner = `<p style="background:#3d2b2b; color:#ed4245; padding:10px; border-radius:6px; max-width:480px; margin:0 auto 16px;">❌ ${req.query.error}</p>`;
    }

    const body = `
      <p style="margin-bottom:20px;"><a href="/dashboard" style="color:#5865F2; text-decoration:none;">← Back to servers</a></p>
      <img src="${guildIconUrl(guild)}" width="64" style="border-radius:50%; margin-bottom:12px;" />
      <h2 style="margin-top:0;">${guild.name}</h2>
      ${banner}

      <div style="max-width:480px; margin:0 auto; text-align:left; background:#2b2d31; padding:24px; border-radius:10px;">

        <p style="font-weight:bold; margin-bottom:4px;">Roblox Group</p>
        <p style="color:#aaa; font-size:14px; margin-top:0;">${groupLine}</p>
        <form method="POST" action="/dashboard/server/${guildId}/group" style="display:flex; gap:8px;">
          <input type="text" name="groupId" value="${roblox.groupId || ''}" placeholder="Roblox Group ID" style="flex:1; ${fieldStyle}" />
          <button type="submit" style="${buttonStyle}">Save</button>
        </form>

        <p style="font-weight:bold; margin-top:24px; margin-bottom:4px;">Verified Role</p>
        <p style="color:#aaa; font-size:14px; margin-top:0;">Given to everyone once they link their Roblox account.</p>
        <form method="POST" action="/dashboard/server/${guildId}/verified-role">
          <select name="roleId" onchange="this.form.submit()" style="width:100%; ${fieldStyle}">
            <option value="" ${!roblox.verifiedRole ? 'selected' : ''}>— None —</option>
            ${roleOptions(roblox.verifiedRole)}
          </select>
        </form>

        <p style="font-weight:bold; margin-top:24px; margin-bottom:4px;">Rank Roles</p>
        <p style="color:#aaa; font-size:14px; margin-top:0;">Maps a Roblox group rank to a Discord role.</p>
        <ul style="list-style:none; padding:0; margin:0 0 12px;">${rankRolesHtml}</ul>

        <form method="POST" action="/dashboard/server/${guildId}/rank-roles" style="display:flex; gap:8px;">
          <input type="number" name="rank" min="0" max="255" placeholder="Rank #" style="width:80px; ${fieldStyle}" required />
          <select name="roleId" style="flex:1; ${fieldStyle}" required>
            <option value="" disabled selected>Select a role</option>
            ${roleOptions(null)}
          </select>
          <button type="submit" style="${buttonStyle}">Add</button>
        </form>

      </div>
    `;

    res.send(renderPage(body, user));
  } catch (error) {
    logger.error('Dashboard server page error:', error);
    res.status(500).send('Something went wrong.');
  }
});

// ---- Save handlers (mirror /robloxsetup's group, verifiedrole, rankrole) ----

dashboardAuthRouter.post('/dashboard/server/:guildId/group', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const groupId = (req.body.groupId || '').trim();

  if (!/^\d+$/.test(groupId)) {
    return res.redirect(`/dashboard/server/${guildId}?error=Group+ID+must+be+a+number`);
  }

  const group = await getRobloxGroupInfo(groupId);
  if (!group) {
    return res.redirect(`/dashboard/server/${guildId}?error=Roblox+group+not+found`);
  }

  const current = await getConfigValue({ db }, guildId, 'roblox', {});
  await updateGuildConfig({ db }, guildId, { roblox: { ...current, enabled: true, groupId } });

  res.redirect(`/dashboard/server/${guildId}?success=Group+updated`);
});

dashboardAuthRouter.post('/dashboard/server/:guildId/verified-role', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const roleId = req.body.roleId || null;

  const current = await getConfigValue({ db }, guildId, 'roblox', {});
  await updateGuildConfig({ db }, guildId, { roblox: { ...current, verifiedRole: roleId } });

  res.redirect(`/dashboard/server/${guildId}?success=Verified+role+updated`);
});

dashboardAuthRouter.post('/dashboard/server/:guildId/rank-roles', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const rank = Number(req.body.rank);
  const roleId = req.body.roleId;

  if (!Number.isInteger(rank) || rank < 0 || rank > 255 || !roleId) {
    return res.redirect(`/dashboard/server/${guildId}?error=Invalid+rank+or+role`);
  }

  const current = await getConfigValue({ db }, guildId, 'roblox', {});
  const rankRoles = { ...(current.rankRoles || {}), [rank]: roleId };

  await updateGuildConfig({ db }, guildId, { roblox: { ...current, rankRoles } });

  res.redirect(`/dashboard/server/${guildId}?success=Rank+role+added`);
});

dashboardAuthRouter.post('/dashboard/server/:guildId/rank-roles/remove', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const { rank } = req.body;

  const current = await getConfigValue({ db }, guildId, 'roblox', {});
  const rankRoles = { ...(current.rankRoles || {}) };
  delete rankRoles[rank];

  await updateGuildConfig({ db }, guildId, { roblox: { ...current, rankRoles } });

  res.redirect(`/dashboard/server/${guildId}?success=Rank+role+removed`);
});
