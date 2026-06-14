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
import { getRobloxGroupInfo, getRobloxUserByUsername, getGroupRoles, getGroupMembership, updateGroupMemberRank } from '../utils/roblox.js';

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://r2-d2-production.up.railway.app';
const REDIRECT_URI = `${PUBLIC_URL}/dashboard/auth/callback`;

const CLIENT_ID = process.env.DASHBOARD_CLIENT_ID;
const CLIENT_SECRET = process.env.DASHBOARD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_TOKEN;

const PERM_ADMINISTRATOR = 0x8n;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.join(__dirname, '../commands');

export const dashboardAuthRouter = Router();

// Parse form submissions (built into Express — no new dependency).
// Scoped to this router only, so it doesn't affect anything else.
dashboardAuthRouter.use(express.urlencoded({ extended: true }));
dashboardAuthRouter.use(express.json());

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

// Dashboard access (viewing and editing a server's settings) is
// restricted to Discord Administrators and the server owner — not just
// anyone with "Manage Server".
function canManage(guild) {
  if (guild.owner) return true;
  const perms = BigInt(guild.permissions || 0);
  return (perms & PERM_ADMINISTRATOR) === PERM_ADMINISTRATOR;
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
    if (!access) return;

    const { guild, user } = access;

    const [rolesRes, channelsRes, roblox, auditLogs] = await Promise.all([
      fetch(`https://discord.com/api/guilds/${guildId}/roles`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      }),
      fetch(`https://discord.com/api/guilds/${guildId}/channels`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      }),
      getConfigValue({ db }, guildId, 'roblox', {}),
      getConfigValue({ db }, guildId, 'auditLogs', {}),
    ]);

    const allRoles = rolesRes.ok ? await rolesRes.json() : [];
    const roleMap = new Map(allRoles.map((r) => [r.id, r.name]));
    const roleName = (id) => (id ? roleMap.get(id) || `Unknown role (${id})` : null);

    const assignableRoles = allRoles
      .filter((r) => r.id !== guildId)
      .sort((a, b) => b.position - a.position);

    const roleOptions = (selectedId) =>
      assignableRoles
        .map((r) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${r.name}</option>`)
        .join('');

    const allChannels = channelsRes.ok ? await channelsRes.json() : [];
    const textChannels = allChannels
      .filter((c) => c.type === 0)
      .sort((a, b) => a.position - b.position);

    const channelOptions = (selectedId) =>
      textChannels
        .map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>#${c.name}</option>`)
        .join('');

    let groupLine = '<em style="color:#888;">Not set</em>';
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
                  <button type="submit" style="background:none; border:none; color:#ed4245; font-size:13px; cursor:pointer;">Remove</button>
                </form>
              </li>
            `,
          )
          .join('')
      : '<li style="color:#888;"><em>None set</em></li>';

    let banner = '';
    if (req.query.success) {
      banner = `<div style="background:#1a3a2a; color:#57f287; padding:12px 16px; border-radius:8px; margin-bottom:20px; border:1px solid #2d5a3d; font-size:14px;">✅ ${req.query.success}</div>`;
    } else if (req.query.error) {
      banner = `<div style="background:#3a1a1a; color:#ed4245; padding:12px 16px; border-radius:8px; margin-bottom:20px; border:1px solid #5a2d2d; font-size:14px;">❌ ${req.query.error}</div>`;
    }

    const tabStyle = `padding:10px 20px; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; transition:all 0.15s; white-space:nowrap;`;
    const activeTabStyle = `${tabStyle} background:#5865F2; color:#fff;`;
    const inactiveTabStyle = `${tabStyle} background:transparent; color:#949ba4;`;

    const body = `
      <div style="margin-bottom:20px; text-align:left; max-width:600px; margin-left:auto; margin-right:auto;">
        <a href="/dashboard" style="color:#5865F2; text-decoration:none; font-size:14px;">← Back to servers</a>
      </div>

      <img src="${guildIconUrl(guild)}" width="56" style="border-radius:50%; margin-bottom:10px;" />
      <h2 style="margin:0 0 4px; font-size:22px;">${guild.name}</h2>
      <p style="color:#949ba4; font-size:14px; margin:0 0 24px;">Server Settings</p>

      ${banner}

      <div style="max-width:600px; margin:0 auto; text-align:left;">

        <!-- Tab Bar -->
        <div style="display:flex; gap:4px; background:#111214; padding:4px; border-radius:10px; margin-bottom:20px; overflow-x:auto;">
          <button id="btn-group-setup" style="${activeTabStyle}" onclick="showTab('group-setup', this)">⚙️ Group Setup</button>
          <button id="btn-rank-management" style="${inactiveTabStyle}" onclick="showTab('rank-management', this)">👑 Rank Management</button>
          <button id="btn-audit-logs" style="${inactiveTabStyle}" onclick="showTab('audit-logs', this)">📋 Audit Logs</button>
        </div>

        <!-- Tab: Group Setup -->
        <div id="tab-group-setup" style="background:#1e2124; border-radius:12px; padding:24px;">

          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">Roblox Group</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">${groupLine}</p>
          <form method="POST" action="/dashboard/server/${guildId}/group" style="display:flex; gap:8px; margin-bottom:24px;">
            <input type="text" name="groupId" value="${roblox.groupId || ''}" placeholder="Roblox Group ID" style="flex:1; ${fieldStyle}" />
            <button type="submit" style="${buttonStyle}">Save</button>
          </form>

          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">Verified Role</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Given to everyone once they link their Roblox account.</p>
          <form method="POST" action="/dashboard/server/${guildId}/verified-role" style="margin-bottom:24px;">
            <select name="roleId" onchange="this.form.submit()" style="width:100%; ${fieldStyle}">
              <option value="" ${!roblox.verifiedRole ? 'selected' : ''}>— None —</option>
              ${roleOptions(roblox.verifiedRole)}
            </select>
          </form>

          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">Rank Roles</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Maps a Roblox group rank number to a Discord role.</p>
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

        <!-- Tab: Rank Management -->
        <div id="tab-rank-management" style="display:none; background:#1e2124; border-radius:12px; padding:24px;">

          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">Open Cloud API Key</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">
            Required to change Roblox group ranks from this dashboard.
            Create one at <a href="https://create.roblox.com/dashboard/credentials" target="_blank" style="color:#5865F2;">create.roblox.com</a>
            with <strong>group:write</strong> permission.
          </p>
          <form method="POST" action="/dashboard/server/${guildId}/open-cloud-key" style="display:flex; gap:8px; margin-bottom:28px;">
            <input type="password" name="openCloudKey" placeholder="${roblox.openCloudKey ? 'Key saved — paste a new one to replace' : 'Paste Open Cloud API key'}" style="flex:1; ${fieldStyle}" />
            <button type="submit" style="${buttonStyle}">Save</button>
          </form>

          ${roblox.groupId && roblox.openCloudKey ? `
          <hr style="border:none; border-top:1px solid #2b2d31; margin:0 0 24px;" />
          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">Rank a Member</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 14px;">Look up a Roblox user and change their rank in the group.</p>
          <div style="display:flex; gap:8px; margin-bottom:16px;">
            <input type="text" id="rankUsername" placeholder="Roblox username" style="flex:1; ${fieldStyle}" onkeydown="if(event.key==='Enter') lookupMember()" />
            <button onclick="lookupMember()" style="${buttonStyle}">Look Up</button>
          </div>
          <div id="rankResult" style="display:none; background:#111214; border-radius:10px; padding:16px; margin-bottom:8px; border:1px solid #2b2d31;">
            <p id="rankResultName" style="color:#fff; margin:0 0 2px; font-weight:700;"></p>
            <p id="rankResultCurrent" style="color:#949ba4; margin:0 0 14px; font-size:13px;"></p>
            <div style="display:flex; gap:8px; align-items:center;">
              <select id="rankSelect" style="flex:1; ${fieldStyle}"></select>
              <button onclick="changeRank()" style="${buttonStyle}">Change Rank</button>
            </div>
            <p id="rankMsg" style="margin:10px 0 0; font-size:13px;"></p>
          </div>
          <script>
            var currentRobloxId = null;
            async function lookupMember() {
              var username = document.getElementById('rankUsername').value.trim();
              if (!username) return;
              var resultDiv = document.getElementById('rankResult');
              var msg = document.getElementById('rankMsg');
              msg.textContent = '';
              resultDiv.style.display = 'none';
              try {
                var res = await fetch('/dashboard/server/${guildId}/rank-lookup', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ username: username })
                });
                var data = await res.json();
                if (!data.success) { alert(data.error || 'Could not find that user.'); return; }
                currentRobloxId = data.robloxId;
                document.getElementById('rankResultName').textContent = data.robloxUsername;
                document.getElementById('rankResultCurrent').textContent = 'Current rank: ' + data.currentRankName + ' (' + data.currentRank + ')';
                var select = document.getElementById('rankSelect');
                select.innerHTML = data.roles
                  .filter(function(r) { return r.rank !== 255; })
                  .map(function(r) { return '<option value="' + r.rank + '"' + (r.rank === data.currentRank ? ' selected' : '') + '>' + r.displayName + ' (' + r.rank + ')</option>'; })
                  .join('');
                resultDiv.style.display = 'block';
              } catch(e) { alert('Error looking up user.'); }
            }
            async function changeRank() {
              var targetRank = Number(document.getElementById('rankSelect').value);
              var msg = document.getElementById('rankMsg');
              msg.style.color = '#949ba4';
              msg.textContent = 'Changing rank...';
              try {
                var res = await fetch('/dashboard/server/${guildId}/rank-change', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ robloxId: currentRobloxId, targetRank: targetRank })
                });
                var data = await res.json();
                if (data.success) {
                  msg.style.color = '#57f287';
                  msg.textContent = '✅ Rank changed successfully!';
                  var sel = document.getElementById('rankSelect');
                  document.getElementById('rankResultCurrent').textContent = 'Current rank: ' + sel.options[sel.selectedIndex].text;
                } else {
                  msg.style.color = '#ed4245';
                  msg.textContent = '❌ ' + (data.error || 'Something went wrong.');
                }
              } catch(e) {
                msg.style.color = '#ed4245';
                msg.textContent = '❌ Error contacting server.';
              }
            }
          </script>
          ` : roblox.groupId ? `
          <p style="color:#949ba4; font-size:14px; padding:16px; background:#111214; border-radius:8px; border:1px solid #2b2d31;">
            Save an Open Cloud API key above to enable rank changes.
          </p>
          ` : `
          <p style="color:#949ba4; font-size:14px; padding:16px; background:#111214; border-radius:8px; border:1px solid #2b2d31;">
            Set a Roblox Group ID in the <strong style="color:#fff;">Group Setup</strong> tab first.
          </p>
          `}

        </div>

        <!-- Tab: Audit Logs -->
        <div id="tab-audit-logs" style="display:none; background:#1e2124; border-radius:12px; padding:24px;">

          <p style="color:#949ba4; font-size:13px; margin:0 0 24px; line-height:1.6;">
            Configure which channels receive automatic log messages. Each log type posts to its own channel so they stay separate.
          </p>

          <form method="POST" action="/dashboard/server/${guildId}/audit-logs">

            <div style="background:#111214; border:1px solid #2b2d31; border-radius:10px; padding:16px; margin-bottom:24px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
              <div>
                <p style="color:#fff; font-weight:700; margin:0 0 4px; font-size:14px;">🤖 Auto-Create Log Channels</p>
                <p style="color:#949ba4; font-size:13px; margin:0;">Creates a <strong style="color:#fff;">📋 Phantom Logs</strong> category with <strong style="color:#fff;">#discord-logs</strong>, <strong style="color:#fff;">#roblox-logs</strong>, and <strong style="color:#fff;">#dashboard-logs</strong> — and saves them automatically.</p>
              </div>
              <a href="/dashboard/server/${guildId}/create-log-channels" style="display:inline-block; padding:10px 18px; background:#5865F2; color:#fff; border-radius:8px; text-decoration:none; font-size:14px; font-weight:600; white-space:nowrap;">Create Channels</a>
            </div>

            <p style="font-weight:700; margin:0 0 4px; font-size:15px;">🔔 Discord Events</p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Logs joins, leaves, kicks, bans, and role changes in your server.</p>
            <select name="discordChannelId" style="width:100%; ${fieldStyle} margin-bottom:24px;">
              <option value="">— Disabled —</option>
              ${channelOptions(auditLogs.discordChannelId)}
            </select>

            <p style="font-weight:700; margin:0 0 4px; font-size:15px;">👑 Roblox Rank Changes</p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Logs every rank change made through the dashboard, including who changed it and when.</p>
            <select name="robloxChannelId" style="width:100%; ${fieldStyle} margin-bottom:24px;">
              <option value="">— Disabled —</option>
              ${channelOptions(auditLogs.robloxChannelId)}
            </select>

            <p style="font-weight:700; margin:0 0 4px; font-size:15px;">🖥️ Dashboard Actions</p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Logs settings changes made on this dashboard — group binding, role updates, key changes.</p>
            <select name="dashboardChannelId" style="width:100%; ${fieldStyle} margin-bottom:24px;">
              <option value="">— Disabled —</option>
              ${channelOptions(auditLogs.dashboardChannelId)}
            </select>

            <button type="submit" style="${buttonStyle}">Save Log Channels</button>
          </form>

        </div>

      </div>

      <script>
        function showTab(name, btn) {
          ['group-setup','rank-management','audit-logs'].forEach(function(t) {
            document.getElementById('tab-' + t).style.display = 'none';
            document.getElementById('btn-' + t).style.background = 'transparent';
            document.getElementById('btn-' + t).style.color = '#949ba4';
          });
          document.getElementById('tab-' + name).style.display = 'block';
          btn.style.background = '#5865F2';
          btn.style.color = '#fff';
          window.location.hash = name;
        }
        window.addEventListener('load', function() {
          var hash = window.location.hash.slice(1);
          var valid = ['group-setup','rank-management','audit-logs'];
          if (hash && valid.indexOf(hash) !== -1) {
            var btn = document.getElementById('btn-' + hash);
            if (btn) showTab(hash, btn);
          }
        });
      </script>
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

// ---- Rank management handlers ----

dashboardAuthRouter.post('/dashboard/server/:guildId/open-cloud-key', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const openCloudKey = (req.body.openCloudKey || '').trim();
  if (!openCloudKey) {
    return res.redirect(`/dashboard/server/${guildId}?error=API+key+cannot+be+empty`);
  }

  const current = await getConfigValue({ db }, guildId, 'roblox', {});
  await updateGuildConfig({ db }, guildId, { roblox: { ...current, openCloudKey } });

  res.redirect(`/dashboard/server/${guildId}?success=Open+Cloud+key+saved#rank-management`);
});

dashboardAuthRouter.post('/dashboard/server/:guildId/audit-logs', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const discordChannelId = req.body.discordChannelId || null;
  const robloxChannelId = req.body.robloxChannelId || null;
  const dashboardChannelId = req.body.dashboardChannelId || null;

  await updateGuildConfig({ db }, guildId, {
    auditLogs: { discordChannelId, robloxChannelId, dashboardChannelId },
  });

  res.redirect(`/dashboard/server/${guildId}?success=Audit+log+channels+saved#audit-logs`);
});

// Auto-create the three audit log channels under a "Phantom Logs" category.
dashboardAuthRouter.get('/dashboard/server/:guildId/create-log-channels', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  try {
    const base = 'https://discord.com/api';
    const headers = {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // 1. Create the category
    const categoryRes = await fetch(`${base}/guilds/${guildId}/channels`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '📋 Phantom Logs', type: 4 }),
    });

    if (!categoryRes.ok) {
      const err = await categoryRes.text();
      logger.error('Failed to create log category:', err);
      return res.redirect(`/dashboard/server/${guildId}?error=Could+not+create+channels+%E2%80%94+check+bot+permissions#audit-logs`);
    }

    const category = await categoryRes.json();

    // 2. Create the three text channels under it
    const channelDefs = [
      { key: 'discordChannelId', name: 'discord-logs', topic: 'Discord server events — joins, leaves, kicks, bans, role changes.' },
      { key: 'robloxChannelId', name: 'roblox-logs', topic: 'Roblox group rank changes made via the Phantom dashboard.' },
      { key: 'dashboardChannelId', name: 'dashboard-logs', topic: 'Admin actions taken on the Phantom dashboard — settings changes, key updates.' },
    ];

    const savedIds = {};

    for (const def of channelDefs) {
      const chRes = await fetch(`${base}/guilds/${guildId}/channels`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: def.name,
          type: 0,
          parent_id: category.id,
          topic: def.topic,
        }),
      });

      if (chRes.ok) {
        const ch = await chRes.json();
        savedIds[def.key] = ch.id;
      } else {
        const err = await chRes.text();
        logger.error(`Failed to create #${def.name}:`, err);
      }
    }

    // 3. Save whatever we managed to create
    const current = await getConfigValue({ db }, guildId, 'auditLogs', {});
    await updateGuildConfig({ db }, guildId, {
      auditLogs: { ...current, ...savedIds },
    });

    res.redirect(`/dashboard/server/${guildId}?success=Log+channels+created+successfully#audit-logs`);
  } catch (err) {
    logger.error('create-log-channels error:', err);
    res.redirect(`/dashboard/server/${guildId}?error=Something+went+wrong+creating+channels#audit-logs`);
  }
});
});

dashboardAuthRouter.post('/dashboard/server/:guildId/rank-lookup', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return res.json({ success: false, error: 'Not authorized.' });

  const { username } = req.body;
  if (!username) return res.json({ success: false, error: 'Username required.' });

  try {
    const roblox = await getConfigValue({ db }, guildId, 'roblox', {});
    if (!roblox.groupId || !roblox.openCloudKey) {
      return res.json({ success: false, error: 'Group ID and Open Cloud key must be configured first.' });
    }

    const robloxUser = await getRobloxUserByUsername(username);
    if (!robloxUser) {
      return res.json({ success: false, error: `No Roblox user found named "${username}".` });
    }

    const [membership, roles] = await Promise.all([
      getGroupMembership(roblox.groupId, robloxUser.id, roblox.openCloudKey),
      getGroupRoles(roblox.groupId, roblox.openCloudKey),
    ]);

    if (!membership) {
      return res.json({ success: false, error: `${robloxUser.name} is not a member of this group.` });
    }
    if (!roles) {
      return res.json({ success: false, error: 'Could not load group roles — check your API key.' });
    }

    // membership.role is "groups/{groupId}/roles/{roleId}" — extract the role ID
    const currentRoleId = membership.role?.split('/').pop();
    const currentRole = roles.find((r) => String(r.id) === String(currentRoleId));

    return res.json({
      success: true,
      robloxId: robloxUser.id,
      robloxUsername: robloxUser.name,
      currentRank: currentRole?.rank ?? 0,
      currentRankName: currentRole?.displayName ?? 'Unknown',
      roles,
    });
  } catch (err) {
    logger.error('Rank lookup error:', err);
    return res.json({ success: false, error: 'Unexpected error during lookup.' });
  }
});

dashboardAuthRouter.post('/dashboard/server/:guildId/rank-change', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return res.json({ success: false, error: 'Not authorized.' });

  const { robloxId, targetRank } = req.body;

  if (!robloxId || targetRank === undefined) {
    return res.json({ success: false, error: 'Missing robloxId or targetRank.' });
  }
  if (Number(targetRank) === 255) {
    return res.json({ success: false, error: 'Cannot assign the Owner rank (255).' });
  }

  try {
    const roblox = await getConfigValue({ db }, guildId, 'roblox', {});
    if (!roblox.groupId || !roblox.openCloudKey) {
      return res.json({ success: false, error: 'Group not configured.' });
    }

    const result = await updateGroupMemberRank(
      roblox.groupId,
      robloxId,
      Number(targetRank),
      roblox.openCloudKey,
    );
    return res.json(result);
  } catch (err) {
    logger.error('Rank change error:', err);
    return res.json({ success: false, error: 'Unexpected error during rank change.' });
  }
});
