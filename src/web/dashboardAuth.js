// src/web/dashboardAuth.js
//
// Web dashboard — "Login with Discord" flow + server picker + settings page
// + a public commands/help page.
//   /dashboard/login         -> redirects to Discord's OAuth consent screen
//   /dashboard/auth/callback -> exchanges the code, fetches the user, sets a cookie
//   /dashboard/logout         -> clears the session cookie
//   /dashboard                -> shows the servers you can manage with Phantom
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
import { pgDb } from '../utils/postgresDatabase.js';
import { getRobloxGroupInfo, getRobloxUserByUsername, getGroupRoles, getGroupMembership, updateGroupMemberRank, getGroupJoinRequests, acceptGroupJoinRequest, declineGroupJoinRequest } from '../utils/roblox.js';
import { getSubscription, getTier, getBoostDiscount, isOwner } from './stripePayments.js';

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://phantom1.up.railway.app';
const REDIRECT_URI = `${PUBLIC_URL}/dashboard/auth/callback`;

const CLIENT_ID = process.env.DASHBOARD_CLIENT_ID;
const CLIENT_SECRET = process.env.DASHBOARD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_TOKEN;

const PERM_ADMINISTRATOR = 0x8n;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.join(__dirname, '../commands');

export const dashboardAuthRouter = Router();

// Post a plain embed to any channel using the bot token (for audit logs from dashboard routes)
async function sendBotEmbed(channelId, { color = 0x5865F2, title, fields = [] }) {
  return fetch(`https://discord.com/api/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        color,
        title,
        fields,
        timestamp: new Date().toISOString(),
      }],
    }),
  });
}

// Parse form submissions (built into Express — no new dependency).
// Scoped to this router only, so it doesn't affect anything else.
dashboardAuthRouter.use(express.urlencoded({ extended: true }));
dashboardAuthRouter.use(express.json());

// Quietly avoid a 404 in the browser console for favicon requests.
dashboardAuthRouter.get('/favicon.ico', (req, res) => res.status(204).end());

// ── Public legal pages (required for Discord App Verification) ────────────────

const LEGAL_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#1a1a2e; color:#dbdee1; margin:0; padding:0; }
  .container { max-width:800px; margin:0 auto; padding:48px 24px; }
  h1 { color:#fff; font-size:28px; margin:0 0 6px; }
  h2 { color:#fff; font-size:18px; margin:32px 0 8px; border-bottom:1px solid #2b2d31; padding-bottom:8px; }
  p, li { color:#b5bac1; line-height:1.7; font-size:15px; }
  ul { padding-left:20px; }
  a { color:#5865F2; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .badge { display:inline-flex; align-items:center; gap:8px; background:#5865F2; color:#fff; padding:8px 16px; border-radius:8px; font-weight:700; font-size:14px; margin-bottom:32px; text-decoration:none; }
  .footer { margin-top:48px; padding-top:24px; border-top:1px solid #2b2d31; color:#5e6272; font-size:13px; }
`;

dashboardAuthRouter.get('/terms', (req, res) => {
  const updated = 'June 15, 2026';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms of Service — Phantom</title><style>${LEGAL_STYLE}</style></head><body><div class="container">
  <a class="badge" href="/dashboard">🤖 Phantom Dashboard</a>
  <h1>Terms of Service</h1>
  <p style="color:#949ba4;font-size:14px;">Last updated: ${updated}</p>

  <h2>1. Acceptance of Terms</h2>
  <p>By inviting Phantom ("the Bot") to your Discord server or using any of its features, you ("the User") agree to be bound by these Terms of Service. If you do not agree, you must remove the Bot from your server immediately.</p>

  <h2>2. Description of Service</h2>
  <p>Phantom is a Discord bot that provides Roblox group management, member verification, moderation tools, music playback, leveling, and dashboard features. The Bot is provided by its developer ("the Developer") and is subject to change, suspension, or termination at any time.</p>

  <h2>3. Permitted Use</h2>
  <p>You may use the Bot for lawful purposes only. You agree not to:</p>
  <ul>
    <li>Use the Bot to harass, abuse, or harm others</li>
    <li>Attempt to exploit, reverse-engineer, or abuse the Bot's systems</li>
    <li>Use the Bot in violation of Discord's <a href="https://discord.com/terms">Terms of Service</a></li>
    <li>Use the Bot to distribute spam, malware, or illegal content</li>
    <li>Circumvent or attempt to bypass subscription tiers or payment systems</li>
  </ul>

  <h2>4. Subscriptions and Payments</h2>
  <p>Certain features of Phantom require a paid subscription (Premium or Enterprise tier). Subscriptions are billed monthly. You may cancel at any time. Refunds are not guaranteed but may be issued at the Developer's discretion. Prices may change with reasonable notice.</p>

  <h2>5. Data Collection</h2>
  <p>The Bot collects and stores limited data necessary to operate its features, including Discord user IDs, server IDs, linked Roblox account information, and usage settings. See our <a href="/privacy">Privacy Policy</a> for full details.</p>

  <h2>6. Availability and Uptime</h2>
  <p>The Developer makes no guarantee of continuous availability. The Bot may experience downtime for maintenance, updates, or unforeseen technical issues. No refunds will be issued for periods of unavailability.</p>

  <h2>7. Termination</h2>
  <p>The Developer reserves the right to terminate or restrict your access to the Bot at any time, for any reason, including violation of these Terms. You may remove the Bot from your server at any time.</p>

  <h2>8. Disclaimer of Warranties</h2>
  <p>The Bot is provided "as is" without warranties of any kind, express or implied. The Developer is not liable for any damages arising from the use or inability to use the Bot.</p>

  <h2>9. Changes to Terms</h2>
  <p>These Terms may be updated at any time. Continued use of the Bot after changes are posted constitutes acceptance of the new Terms.</p>

  <h2>10. Contact</h2>
  <p>For questions about these Terms, join the <a href="https://discord.gg/phantom">Phantom support server</a> or contact the Developer through Discord.</p>

  <div class="footer">© 2026 Phantom Bot. All rights reserved.</div>
</div></body></html>`);
});

dashboardAuthRouter.get('/privacy', (req, res) => {
  const updated = 'June 15, 2026';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — Phantom</title><style>${LEGAL_STYLE}</style></head><body><div class="container">
  <a class="badge" href="/dashboard">🤖 Phantom Dashboard</a>
  <h1>Privacy Policy</h1>
  <p style="color:#949ba4;font-size:14px;">Last updated: ${updated}</p>

  <h2>1. Overview</h2>
  <p>Phantom ("the Bot") is committed to protecting your privacy. This Privacy Policy explains what data we collect, how we use it, and how you can request its removal.</p>

  <h2>2. Data We Collect</h2>
  <p>We collect the minimum data required to operate the Bot's features:</p>
  <ul>
    <li><strong>Discord User IDs</strong> — to identify users across sessions and link accounts</li>
    <li><strong>Discord Server IDs</strong> — to store per-server configuration</li>
    <li><strong>Discord Usernames and Nicknames</strong> — displayed in dashboards and logs</li>
    <li><strong>Roblox User IDs and Usernames</strong> — when you voluntarily link your Roblox account</li>
    <li><strong>Message Content</strong> — only in channels configured for auto-rank detection; not stored permanently</li>
    <li><strong>Server Configuration</strong> — role IDs, channel IDs, and feature settings chosen by server administrators</li>
    <li><strong>Billing Information</strong> — handled entirely by Stripe; we do not store card details</li>
  </ul>

  <h2>3. How We Use Your Data</h2>
  <ul>
    <li>Providing and personalising the Bot's features (rank syncing, verification, moderation, etc.)</li>
    <li>Displaying linked Roblox accounts and group ranks in the dashboard</li>
    <li>Sending audit logs and notifications to configured channels</li>
    <li>Processing subscription payments via Stripe</li>
    <li>Improving the Bot's reliability and performance</li>
  </ul>

  <h2>4. Data Storage</h2>
  <p>Data is stored in a secure PostgreSQL database hosted on Railway. Data is retained for as long as you use the Bot. Server configuration data is removed within 30 days of the Bot being removed from a server.</p>

  <h2>5. Data Sharing</h2>
  <p>We do not sell, rent, or share your data with third parties except:</p>
  <ul>
    <li><strong>Stripe</strong> — for payment processing (subject to <a href="https://stripe.com/privacy">Stripe's Privacy Policy</a>)</li>
    <li><strong>Roblox</strong> — when the Bot makes API calls on your behalf (subject to <a href="https://en.help.roblox.com/hc/en-us/articles/115004630823">Roblox's Privacy Policy</a>)</li>
    <li><strong>Discord</strong> — the Bot operates within Discord's platform (subject to <a href="https://discord.com/privacy">Discord's Privacy Policy</a>)</li>
  </ul>

  <h2>6. Data Removal</h2>
  <p>You can request deletion of your personal data at any time by:</p>
  <ul>
    <li>Using <code>/wipedata</code> in Discord to remove your linked account data</li>
    <li>Contacting us through the support server</li>
  </ul>
  <p>Server administrators can remove all data for their server by removing the Bot and contacting the Developer.</p>

  <h2>7. Children's Privacy</h2>
  <p>The Bot is not directed at children under 13. We do not knowingly collect data from children under 13. If you believe a child has provided data, please contact us immediately.</p>

  <h2>8. Your Rights</h2>
  <p>Depending on your location, you may have the right to access, correct, or delete your personal data. Contact us through the support server to exercise these rights.</p>

  <h2>9. Changes to This Policy</h2>
  <p>This Privacy Policy may be updated at any time. We will notify users of significant changes through the support server.</p>

  <h2>10. Contact</h2>
  <p>For privacy concerns, join the <a href="https://discord.gg/phantom">Phantom support server</a> or contact the Developer through Discord.</p>

  <div class="footer">© 2026 Phantom Bot. All rights reserved.</div>
</div></body></html>`);
});

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
        <title>Phantom Dashboard</title>
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
            <a href="/dashboard" style="color:#fff; text-decoration:none; font-weight:bold; font-size:18px;">Phantom Dashboard</a>
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
// ---- Session cache (avoids hitting Discord API on every request) ----
const sessionCache = new Map(); // token → { user, guilds, expiresAt, staleUntil }
const SESSION_CACHE_TTL   = 10 * 60 * 1000; // 10 min fresh
const SESSION_CACHE_STALE = 60 * 60 * 1000; // 60 min stale (used if Discord API fails)

async function getSessionData(token) {
  const cached = sessionCache.get(token);

  // Fresh cache hit — return immediately
  if (cached && cached.expiresAt > Date.now()) {
    return { user: cached.user, guilds: cached.guilds };
  }

  try {
    const [userRes, userGuildsRes] = await Promise.all([
      fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token}` } }),
      fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${token}` } }),
    ]);

    // Token explicitly invalid (401) — must log out
    if (userRes.status === 401 || userGuildsRes.status === 401) {
      sessionCache.delete(token);
      return null;
    }

    // Rate limited or temporary Discord error — use stale cache if available
    if (!userRes.ok || !userGuildsRes.ok) {
      if (cached && cached.staleUntil > Date.now()) {
        return { user: cached.user, guilds: cached.guilds };
      }
      return null;
    }

    const user = await userRes.json();
    const guilds = await userGuildsRes.json();
    sessionCache.set(token, {
      user,
      guilds,
      expiresAt:  Date.now() + SESSION_CACHE_TTL,
      staleUntil: Date.now() + SESSION_CACHE_STALE,
    });
    return { user, guilds };
  } catch {
    // Network error — use stale cache if available
    if (cached && cached.staleUntil > Date.now()) {
      return { user: cached.user, guilds: cached.guilds };
    }
    return null;
  }
}

async function requireGuildAccess(req, res, guildId) {
  const token = getCookie(req, 'dashboard_token');

  if (!token) {
    res.send(loginPrompt("Log in with Discord to manage your server's settings."));
    return null;
  }

  const data = await getSessionData(token);

  if (!data) {
    clearCookie(res, 'dashboard_token');
    res.send(loginPrompt('Your session expired — please log in again.'));
    return null;
  }

  const { user, guilds: userGuilds } = data;
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

// Public: list every slash command Phantom offers.
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
      <p style="color:#aaa; margin-bottom:24px;">Here's everything Phantom can do. Commands marked <span style="background:#444; color:#aaa; font-size:11px; padding:2px 6px; border-radius:4px;">Admin</span> require server management permissions.</p>

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

// Step 3: show the servers this user can manage with Phantom.
dashboardAuthRouter.get('/dashboard', async (req, res) => {
  const token = getCookie(req, 'dashboard_token');

  if (!token) {
    return res.send(loginPrompt("Log in with Discord to manage your server's settings."));
  }

  try {
    const sessionData = await getSessionData(token);

    if (!sessionData) {
      clearCookie(res, 'dashboard_token');
      return res.send(loginPrompt('Your session expired — please log in again.'));
    }

    const { user, guilds: userGuilds } = sessionData;
    const botGuildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    const botGuilds = botGuildsRes.ok ? await botGuildsRes.json() : [];
    const botGuildIds = new Set(botGuilds.map((g) => g.id));

    const manageable = userGuilds.filter((g) => botGuildIds.has(g.id) && canManage(g));

    let body;
    if (manageable.length === 0) {
      body = `<p style="margin-top:12px; color:#aaa;">No servers found where you have <strong>Manage Server</strong> permission and Phantom is present.</p>`;
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

    const [rolesRes, channelsRes, membersRes, roblox, auditLogs, verification, autoRank, enterprise, securityRaw, subscription, boostDiscount] = await Promise.all([
      fetch(`https://discord.com/api/guilds/${guildId}/roles`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } }),
      fetch(`https://discord.com/api/guilds/${guildId}/channels`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } }),
      fetch(`https://discord.com/api/guilds/${guildId}/members?limit=1000`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } }),
      getConfigValue({ db }, guildId, 'roblox', {}),
      getConfigValue({ db }, guildId, 'auditLogs', {}),
      getConfigValue({ db }, guildId, 'verification', {}),
      getConfigValue({ db }, guildId, 'autoRank', {}),
      getConfigValue({ db }, guildId, 'enterprise', {}),
      pgDb.get(`security:${guildId}`),
      getSubscription(guildId),
      getBoostDiscount(user.id),
    ]);

    const allRoles = rolesRes.ok ? await rolesRes.json() : [];
    const roleMap = new Map(allRoles.map((r) => [r.id, r.name]));
    const roleName = (id) => (id ? roleMap.get(id) || `Unknown role (${id})` : null);
    const assignableRoles = allRoles.filter((r) => r.id !== guildId).sort((a, b) => b.position - a.position);
    const roleOptions = (selectedId) => assignableRoles.map((r) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${r.name}</option>`).join('');

    const allChannels = channelsRes.ok ? await channelsRes.json() : [];
    const textChannels = allChannels.filter((c) => c.type === 0).sort((a, b) => a.position - b.position);
    const channelOptions = (selectedId) => textChannels.map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>#${c.name}</option>`).join('');

    const guildMembers = membersRes.ok ? await membersRes.json() : [];
    const guildMemberMap = new Map(guildMembers.map((m) => [m.user.id, m]));
    const allLinkedKeys = await pgDb.list('roblox_link:');
    const linkedMembers = (await Promise.all(
      allLinkedKeys
        .map((k) => k.replace('roblox_link:', ''))
        .filter((id) => guildMemberMap.has(id))
        .map(async (discordId) => {
          const link = await pgDb.get(`roblox_link:${discordId}`);
          if (!link) return null;
          const m = guildMemberMap.get(discordId);
          const topRole = (m.roles || [])
            .map((rid) => ({ id: rid, name: roleMap.get(rid) || '', pos: (allRoles.find(r => r.id === rid) || {}).position || 0 }))
            .filter((r) => r.name && r.id !== guildId)
            .sort((a, b) => b.pos - a.pos)[0];
          return {
            discordId,
            discordName: m.nick || m.user.username,
            avatar: m.user.avatar
              ? `https://cdn.discordapp.com/avatars/${discordId}/${m.user.avatar}.png?size=32`
              : 'https://cdn.discordapp.com/embed/avatars/0.png',
            robloxId: String(link.robloxId || ''),
            robloxUsername: link.robloxUsername,
            discordRole: topRole ? topRole.name : null,
          };
        })
    )).filter(Boolean);

    // Pre-load Roblox group roles for bulk ranking dropdown (enterprise)
    let robloxRolesForMembers = [];
    if (roblox.groupId && roblox.openCloudKey) {
      try { robloxRolesForMembers = await getGroupRoles(roblox.groupId, roblox.openCloudKey); } catch {}
    }

    const docKeys = await pgDb.list(`doc:${guildId}:`);
    const docs = (await Promise.all(docKeys.map((k) => pgDb.get(k)))).filter(Boolean);

    let groupLine = '<em style="color:#888;">Not set</em>';
    if (roblox.groupId) {
      const group = await getRobloxGroupInfo(roblox.groupId);
      groupLine = group
        ? `Currently: <strong>${group.name}</strong> (ID: ${roblox.groupId})`
        : `Currently: Group ID ${roblox.groupId} (couldn't load name)`;
    }

    const rankRoleEntries = Object.entries(roblox.rankRoles || {});
    const rankRolesHtml = rankRoleEntries.length
      ? rankRoleEntries.map(([rank, roleId]) => `
          <li style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span>Rank ${rank} &rarr; ${roleName(roleId)}</span>
            <form method="POST" action="/dashboard/server/${guildId}/rank-roles/remove" style="margin:0;">
              <input type="hidden" name="rank" value="${rank}" />
              <button type="submit" style="background:none; border:none; color:#ed4245; font-size:13px; cursor:pointer;">Remove</button>
            </form>
          </li>`).join('')
      : '<li style="color:#888;"><em>None set</em></li>';

    const tier = isOwner(user.id) ? 'enterprise' : getTier(subscription);
    const isPremium = tier === 'premium' || tier === 'enterprise';
    const isEnterprise = tier === 'enterprise';
    const security = { minAccountAgeDays: 0, newAccountAction: 'none', newAccountRoleId: null, newAccountLogChannel: null, raidProtection: false, raidThreshold: 10, raidWindowSeconds: 30, raidAction: 'lockdown', lockdownActive: false, ...(securityRaw || {}) };
    const joinRequestConfig = await getConfigValue({ db }, guildId, 'joinRequests', {});
    const ticketSettings = await getConfigValue({ db }, guildId, 'ticketSettings', {});

    // Upgrade banner for free servers
    const boostBadge = boostDiscount
      ? `<span style="background:#f59e0b; color:#000; font-size:11px; font-weight:700; padding:2px 7px; border-radius:99px; margin-left:8px;">⚡ ${boostDiscount.percent}% OFF</span>`
      : '';
    const premiumLabel  = `Premium${ boostDiscount ? ` <s style="opacity:.55">$7</s> $${(7 * (1 - boostDiscount.percent / 100)).toFixed(2)}` : ' $7'}/mo`;
    const enterpriseLabel = `Enterprise${ boostDiscount ? ` <s style="opacity:.55">$15</s> $${(15 * (1 - boostDiscount.percent / 100)).toFixed(2)}` : ' $15'}/mo`;
    const boostNote = boostDiscount
      ? `<p style="color:#f59e0b; font-size:11px; margin:6px 0 0;">⚡ ${boostDiscount.label}</p>`
      : '';
    const upgradeBanner = !isPremium ? `
      <div style="background:linear-gradient(135deg,#2d1b69,#1a0840); border:1px solid #5b21b6; border-radius:10px; padding:14px 18px; margin-bottom:20px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
        <div>
          <p style="color:#c084fc; font-weight:700; font-size:14px; margin:0 0 3px;">⚡ Unlock Phantom Premium${boostBadge}</p>
          <p style="color:#a78bfa; font-size:12px; margin:0;">Auto-Rank, live member ranks, audit logs, documents and more — from $7/month.</p>
          ${boostNote}
        </div>
        <div style="display:flex; gap:8px; flex-shrink:0;">
          <a href="/upgrade/${guildId}?plan=premium" style="display:inline-block; padding:8px 14px; background:#7c3aed; color:#fff; border-radius:8px; text-decoration:none; font-size:13px; font-weight:600;">${premiumLabel}</a>
          <a href="/upgrade/${guildId}?plan=enterprise" style="display:inline-block; padding:8px 14px; background:#4c1d95; color:#c084fc; border-radius:8px; text-decoration:none; font-size:13px; font-weight:600;">${enterpriseLabel}</a>
        </div>
      </div>` : '';

    let banner = '';
    if (req.query.success) banner = `<div style="background:#1a3a2a; color:#57f287; padding:12px 16px; border-radius:8px; margin-bottom:20px; border:1px solid #2d5a3d; font-size:14px;">&#x2705; ${req.query.success}</div>`;
    else if (req.query.error) banner = `<div style="background:#3a1a1a; color:#ed4245; padding:12px 16px; border-radius:8px; margin-bottom:20px; border:1px solid #5a2d2d; font-size:14px;">&#x274C; ${req.query.error}</div>`;

    const TAB = 'padding:7px 12px; border:none; border-radius:7px; font-size:12px; font-weight:600; cursor:pointer; transition:all 0.15s; white-space:nowrap; flex-shrink:0; flex-grow:1; flex-basis:calc(20% - 3px);';
    const ACTIVE = TAB + ' background:#5865F2; color:#fff;';
    const INACTIVE = TAB + ' background:transparent; color:#949ba4;';
    const PANEL = 'background:#1e2124; border-radius:12px; padding:24px; min-height:420px;';

    const verChanName = textChannels.find((c) => c.id === verification.channelId);

    const body = `
      <div style="margin-bottom:20px; text-align:left; max-width:700px; margin-left:auto; margin-right:auto;">
        <a href="/dashboard" style="color:#5865F2; text-decoration:none; font-size:14px;">&larr; Back to servers</a>
      </div>
      <img src="${guildIconUrl(guild)}" width="56" style="border-radius:50%; margin-bottom:10px;" />
      <h2 style="margin:0 0 4px; font-size:22px;">${guild.name}</h2>
      <p style="color:#949ba4; font-size:14px; margin:0 0 24px;">Server Settings</p>
      ${upgradeBanner}
      ${banner}

      <div style="max-width:700px; margin:0 auto; text-align:left;">

        <div style="display:flex; gap:3px; background:#111214; padding:4px; border-radius:10px; margin-bottom:16px; flex-wrap:wrap;">
          <button id="btn-overview" style="${ACTIVE}" onclick="showTab('overview',this)">&#128202; Overview</button>
          <button id="btn-group-setup" style="${INACTIVE}" onclick="showTab('group-setup',this)">&#9881;&#65039; Group Setup</button>
          <button id="btn-rank-management" style="${INACTIVE}" onclick="showTab('rank-management',this)">&#128081; Rank Management${!isPremium ? ' 🔒' : ''}</button>
          <button id="btn-audit-logs" style="${INACTIVE}" onclick="showTab('audit-logs',this)">&#128203; Audit Logs${!isPremium ? ' 🔒' : ''}</button>
          <button id="btn-members" style="${INACTIVE}" onclick="showTab('members',this)">&#128101; Members${!isPremium ? ' 🔒' : ''}</button>
          <button id="btn-documents" style="${INACTIVE}" onclick="showTab('documents',this)">&#128196; Documents${!isPremium ? ' 🔒' : ''}</button>
          <button id="btn-verification" style="${INACTIVE}" onclick="showTab('verification',this)">&#128276; Verification</button>
          <button id="btn-join-requests" style="${INACTIVE}" onclick="showTab('join-requests',this)">&#x1F4E8; Join Requests${!isPremium ? ' 🔒' : ''}</button>
          <button id="btn-rank-history" style="${INACTIVE}" onclick="showTab('rank-history',this)">📜 Rank History${!isEnterprise ? ' 💎' : ''}</button>
          <button id="btn-enterprise" style="${INACTIVE}" onclick="showTab('enterprise',this)">💎 Enterprise${!isEnterprise ? ' 💎' : ''}</button>
          <button id="btn-tickets" style="${INACTIVE}" onclick="showTab('tickets',this)">🎫 Tickets</button>
          <button id="btn-messages" style="${INACTIVE}" onclick="showTab('messages',this)">📨 Messages</button>
          <button id="btn-security" style="${INACTIVE}" onclick="showTab('security',this)">🔐 Security</button>
        </div>

        <!-- ── Tab: Overview ── -->
        <div id="tab-overview" style="${PANEL}">
          <!-- Server header -->
          <div style="display:flex; align-items:center; gap:14px; margin-bottom:24px;">
            <img src="${guildIconUrl(guild)}" width="52" height="52" style="border-radius:50%; flex-shrink:0;" />
            <div>
              <p style="color:#fff; font-weight:700; font-size:18px; margin:0;">${guild.name}</p>
              <p style="color:#949ba4; font-size:13px; margin:4px 0 0;">${guildMembers.length.toLocaleString()} members &nbsp;·&nbsp; ${linkedMembers.length} linked</p>
            </div>
          </div>

          <!-- Stat cards -->
          <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; margin-bottom:24px;">
            ${[
              { label: 'Linked Members', value: String(linkedMembers.length), ok: linkedMembers.length > 0, icon: '👥' },
              { label: 'Roblox Group', value: roblox.groupId ? 'Configured' : 'Not set', ok: !!roblox.groupId, icon: '🎮' },
              { label: 'Rank Roles', value: String(Object.keys(roblox.rankRoles || {}).length) + ' mapped', ok: Object.keys(roblox.rankRoles || {}).length > 0, icon: '🏅' },
              { label: 'Auto-Rank', value: autoRank.enabled ? 'Enabled' : 'Disabled', ok: autoRank.enabled, icon: '⚡' },
              { label: 'Verification', value: verification.enabled ? 'Enabled' : 'Disabled', ok: verification.enabled, icon: '✅' },
              { label: 'Audit Logs', value: auditLogs.discordChannelId ? 'Configured' : 'Not set', ok: !!auditLogs.discordChannelId, icon: '📋' },
            ].map(({ label, value, ok, icon }) => `
              <div style="background:#111214; border:1px solid ${ok ? '#2d5a3d' : '#2b2d31'}; border-radius:10px; padding:14px;">
                <p style="color:#949ba4; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.6px; margin:0 0 6px;">${icon} ${label}</p>
                <p style="color:${ok ? '#57f287' : '#949ba4'}; font-weight:700; font-size:15px; margin:0;">${value}</p>
              </div>`).join('')}
          </div>

          <!-- Quick actions -->
          <p style="color:#fff; font-weight:700; font-size:15px; margin:0 0 12px;">Quick Actions</p>
          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px;">
            ${[
              { tab: 'group-setup',     icon: '⚙️', title: 'Group Setup',     desc: roblox.groupId ? 'Change group or rank roles' : 'Connect your Roblox group' },
              { tab: 'rank-management', icon: '👑', title: 'Rank Management',  desc: 'Promote or demote directly' },
              { tab: 'members',         icon: '👥', title: 'Members',          desc: `${linkedMembers.length} linked` },
              { tab: 'verification',    icon: '🔔', title: 'Verification',     desc: 'Post the link panel' },
              { tab: 'audit-logs',      icon: '📋', title: 'Audit Logs',       desc: 'Configure log channels' },
              { tab: 'join-requests',   icon: '📨', title: 'Join Requests',    desc: 'Accept pending members' },
            ].map(({ tab, icon, title, desc }) => `
              <button onclick="showTab('${tab}',document.getElementById('btn-${tab}'))"
                style="background:#111214; border:1px solid #2b2d31; border-radius:8px; padding:10px 12px; text-align:left; cursor:pointer; transition:border-color .15s;"
                onmouseover="this.style.borderColor='#5865F2'" onmouseout="this.style.borderColor='#2b2d31'">
                <p style="color:#fff; font-weight:700; font-size:13px; margin:0 0 2px;">${icon} ${title}</p>
                <p style="color:#949ba4; font-size:11px; margin:0;">${desc}</p>
              </button>`).join('')}
          </div>
        </div>

        <div id="tab-group-setup" style="display:none; ${PANEL}">
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
              <option value="" ${!roblox.verifiedRole ? 'selected' : ''}>-- None --</option>
              ${roleOptions(roblox.verifiedRole)}
            </select>
          </form>
          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">Rank Roles</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Maps a Roblox group rank number to a Discord role.</p>

          ${roblox.groupId && roblox.openCloudKey ? `
          <div style="background:#111214; border:1px solid #2b2d31; border-radius:10px; padding:14px 16px; margin-bottom:14px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <div>
              <p style="color:#fff; font-weight:700; font-size:14px; margin:0 0 3px;">⚡ Auto-Bind Roles</p>
              <p style="color:#949ba4; font-size:12px; margin:0;">Fetches your Roblox group ranks, matches existing Discord roles by name, and creates any that are missing — then saves all mappings automatically.</p>
            </div>
            <a href="/dashboard/server/${guildId}/auto-bind-roles" style="display:inline-block; padding:9px 16px; background:#5865F2; color:#fff; border-radius:8px; text-decoration:none; font-size:13px; font-weight:600; white-space:nowrap; flex-shrink:0;">Auto-Bind Roles</a>
          </div>
          ` : roblox.groupId ? `
          <p style="color:#949ba4; font-size:12px; background:#111214; border-radius:8px; padding:10px 14px; border:1px solid #2b2d31; margin-bottom:14px;">Save an Open Cloud API key in Rank Management to enable Auto-Bind.</p>
          ` : ''}

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

        <div id="tab-rank-management" style="display:none; ${PANEL}">
          ${!isPremium ? `
          <div style="background:#1a0840; border:1px solid #5b21b6; border-radius:10px; padding:24px; margin-bottom:20px; text-align:center;">
            <p style="color:#c084fc; font-size:28px; margin:0 0 8px;">🔒</p>
            <p style="color:#fff; font-weight:700; font-size:16px; margin:0 0 6px;">Premium Feature</p>
            <p style="color:#a78bfa; font-size:13px; margin:0 0 16px;">Upgrade to unlock Rank Management and all premium features.</p>
            <a href="/upgrade/${guildId}?plan=premium" style="display:inline-block; padding:10px 24px; background:#7c3aed; color:#fff; border-radius:8px; text-decoration:none; font-size:14px; font-weight:600; margin-right:8px;">Premium — $7/mo</a>
            <a href="/upgrade/${guildId}?plan=enterprise" style="display:inline-block; padding:10px 24px; background:#4c1d95; color:#c084fc; border-radius:8px; text-decoration:none; font-size:14px; font-weight:600;">Enterprise — $15/mo</a>
          </div>` : ''}
          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">Open Cloud API Key</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Required to change Roblox group ranks. Create one at <a href="https://create.roblox.com/dashboard/credentials" target="_blank" style="color:#5865F2;">create.roblox.com</a> with <strong>group:write</strong> permission.</p>
          <form method="POST" action="/dashboard/server/${guildId}/open-cloud-key" style="display:flex; gap:8px; margin-bottom:28px;">
            <input type="password" name="openCloudKey" placeholder="${roblox.openCloudKey ? 'Key saved -- paste a new one to replace' : 'Paste Open Cloud API key'}" style="flex:1; ${fieldStyle}" />
            <button type="submit" style="${buttonStyle}">Save</button>
          </form>
          ${roblox.groupId && roblox.openCloudKey ? `
          <hr style="border:none; border-top:1px solid #2b2d31; margin:0 0 24px;" />
          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">Rank a Member</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 14px;">Look up a Roblox user and change their rank.</p>
          <div style="display:flex; gap:8px; margin-bottom:16px;">
            <input type="text" id="rankUsername" placeholder="Roblox username" style="flex:1; ${fieldStyle}" onkeydown="if(event.key==='Enter') lookupMember()" />
            <button onclick="lookupMember()" style="${buttonStyle}">Look Up</button>
          </div>
          <div id="rankResult" style="display:none; background:#111214; border-radius:10px; padding:16px; border:1px solid #2b2d31;">
            <p id="rankResultName" style="color:#fff; margin:0 0 2px; font-weight:700;"></p>
            <p id="rankResultCurrent" style="color:#949ba4; margin:0 0 14px; font-size:13px;"></p>
            <div style="display:flex; gap:8px;">
              <select id="rankSelect" style="flex:1; ${fieldStyle}"></select>
              <button onclick="changeRank()" style="${buttonStyle}">Change Rank</button>
            </div>
            <p id="rankMsg" style="margin:10px 0 0; font-size:13px;"></p>
          </div>
          <script>
            var currentRobloxId=null;
            async function lookupMember(){
              var u=document.getElementById('rankUsername').value.trim();if(!u)return;
              document.getElementById('rankResult').style.display='none';
              document.getElementById('rankMsg').textContent='';
              try{
                var r=await fetch('/dashboard/server/${guildId}/rank-lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})});
                var d=await r.json();
                if(!d.success){alert(d.error||'User not found.');return;}
                currentRobloxId=d.robloxId;
                document.getElementById('rankResultName').textContent=d.robloxUsername;
                document.getElementById('rankResultCurrent').textContent='Current rank: '+d.currentRankName+' ('+d.currentRank+')';
                document.getElementById('rankSelect').innerHTML=d.roles.filter(function(r){return r.rank!==255;}).map(function(r){return '<option value="'+r.rank+'"'+(r.rank===d.currentRank?' selected':'')+'>'+r.displayName+' ('+r.rank+')</option>';}).join('');
                document.getElementById('rankResult').style.display='block';
              }catch(e){alert('Error looking up user.');}
            }
            async function changeRank(){
              var t=Number(document.getElementById('rankSelect').value);
              var m=document.getElementById('rankMsg');
              m.style.color='#949ba4';m.textContent='Changing rank...';
              try{
                var r=await fetch('/dashboard/server/${guildId}/rank-change',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({robloxId:currentRobloxId,targetRank:t})});
                var d=await r.json();
                if(d.success){m.style.color='#57f287';m.textContent='Rank changed successfully!';var s=document.getElementById('rankSelect');document.getElementById('rankResultCurrent').textContent='Current rank: '+s.options[s.selectedIndex].text;}
                else{m.style.color='#ed4245';m.textContent=d.error||'Something went wrong.';}
              }catch(e){m.style.color='#ed4245';m.textContent='Error contacting server.';}
            }
          </script>
          ` : `<p style="color:#949ba4; padding:16px; background:#111214; border-radius:8px; border:1px solid #2b2d31; font-size:14px;">${roblox.groupId ? 'Save an Open Cloud API key above to enable rank changes.' : 'Set a Roblox Group ID in Group Setup first.'}</p>`}

          <hr style="border:none; border-top:1px solid #2b2d31; margin:28px 0;" />

          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">🤖 Auto-Rank from Promotion Logs</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 20px; line-height:1.6;">
            Phantom watches a channel for promotion log messages and automatically applies the rank on Roblox.
            It uses AI to read <strong style="color:#fff;">any format</strong> — no regex, no rigid templates needed.
            You can optionally define a preferred format to share with your rankers.
          </p>

          ${!isPremium ? `<div style="background:#1a0840; border:1px solid #5b21b6; border-radius:10px; padding:24px; text-align:center;"><p style="color:#c084fc; font-size:28px; margin:0 0 8px;">🔒</p><p style="color:#fff; font-weight:700; font-size:16px; margin:0 0 6px;">Premium Feature</p><p style="color:#a78bfa; font-size:13px; margin:0 0 16px;">Upgrade to enable auto-ranking from promotion logs.</p><a href="/upgrade/${guildId}?plan=premium" style="display:inline-block; padding:10px 24px; background:#7c3aed; color:#fff; border-radius:8px; text-decoration:none; font-size:14px; font-weight:600;">Upgrade — $7/mo</a></div>` : `
          <form method="POST" action="/dashboard/server/${guildId}/auto-rank">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:20px; background:#111214; padding:14px 16px; border-radius:8px; border:1px solid #2b2d31;">
              <input type="checkbox" name="enabled" id="autoRankEnabled" value="1" ${autoRank.enabled ? 'checked' : ''} style="width:16px; height:16px; accent-color:#5865F2; cursor:pointer;" />
              <label for="autoRankEnabled" style="color:#fff; font-size:14px; font-weight:600; cursor:pointer;">Enable auto-ranking</label>
            </div>

            <p style="font-weight:700; margin:0 0 6px; font-size:14px; color:#fff;">👁 Watch Channel${isEnterprise ? 's' : ''}</p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Phantom reads every message here looking for promotion logs.${isEnterprise ? ' Enterprise: select multiple channels.' : ''}</p>
            ${isEnterprise ? `
            <p style="color:#c084fc; font-size:12px; margin:0 0 8px;">👑 Enterprise — hold Ctrl/Cmd to select multiple channels</p>
            <select name="watchChannelIds" multiple style="width:100%; ${fieldStyle} margin-bottom:20px; height:120px;">
              ${(() => {
                const selectedIds = autoRank.watchChannelIds?.length
                  ? autoRank.watchChannelIds
                  : autoRank.watchChannelId ? [autoRank.watchChannelId] : [];
                return textChannels.filter(c => c.type === 0).map(c =>
                  `<option value="${c.id}" ${selectedIds.includes(c.id) ? 'selected' : ''}>#${c.name}</option>`
                ).join('');
              })()}
            </select>
            ` : `
            <select name="watchChannelId" style="width:100%; ${fieldStyle} margin-bottom:20px;">
              <option value="">-- None --</option>
              ${channelOptions(autoRank.watchChannelId)}
            </select>
            `}

            <p style="font-weight:700; margin:0 0 6px; font-size:14px; color:#fff;">📋 Confirmation Log Channel</p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">After applying a rank, Phantom posts a confirmation here.</p>
            <select name="logChannelId" style="width:100%; ${fieldStyle} margin-bottom:20px;">
              <option value="">-- None --</option>
              ${channelOptions(autoRank.logChannelId)}
            </select>

            <p style="font-weight:700; margin:0 0 6px; font-size:14px; color:#fff;">📝 Custom Log Format <span style="color:#949ba4; font-weight:400;">(optional)</span></p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 6px; line-height:1.6;">
              Define how the confirmation message looks. Variables: <code style="background:#2b2d31; padding:2px 5px; border-radius:4px;">{username}</code>
              <code style="background:#2b2d31; padding:2px 5px; border-radius:4px;">{newRank}</code>
              <code style="background:#2b2d31; padding:2px 5px; border-radius:4px;">{reason}</code>
              <code style="background:#2b2d31; padding:2px 5px; border-radius:4px;">{ranker}</code>
            </p>
            <p style="color:#5865F2; font-size:12px; margin:0 0 10px;">You can also share this format with your rankers so they know the preferred layout — Phantom reads any format regardless.</p>
            <textarea name="customFormat" rows="6" placeholder="Leave blank to use default format:&#10;&#10;👑 **Promotion**&#10;**User:** {username}&#10;**New Rank:** {newRank}&#10;**Reason:** {reason}&#10;**Ranked by:** {ranker}" style="width:100%; ${fieldStyle} resize:vertical; font-family:monospace; font-size:13px; line-height:1.6; box-sizing:border-box; margin-bottom:20px;">${autoRank.customFormat || ''}</textarea>

            <button type="submit" style="${buttonStyle}">Save Auto-Rank Settings</button>
          </form>
          `}

          <hr style="border:none; border-top:1px solid #2b2d31; margin:24px 0;" />
          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">🚪 Auto-Demotion on Leave</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 14px; line-height:1.6;">When a member leaves the Discord server, Phantom will automatically set their Roblox group rank to the exile rank you specify. Requires a linked Roblox account and Open Cloud API key.</p>
          <form method="POST" action="/dashboard/server/${guildId}/auto-demote">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px;">
              <input type="checkbox" name="enabled" id="autoDemoteEnabled" value="1" ${roblox.autoDemote?.enabled ? 'checked' : ''} style="width:16px; height:16px; accent-color:#ed4245; cursor:pointer;" />
              <label for="autoDemoteEnabled" style="color:#fff; font-size:14px; font-weight:600; cursor:pointer;">Enable auto-demotion on leave</label>
            </div>
            <p style="color:#949ba4; font-size:13px; margin:0 0 6px;">Exile Rank ID <span style="color:#5b6472;">(the rank number to set — e.g. 1 for Guest, 0 to exile)</span></p>
            <div style="display:flex; gap:8px; margin-bottom:16px;">
              <input type="number" name="exileRankId" value="${roblox.autoDemote?.exileRankId ?? 0}" min="0" max="255" style="width:120px; ${fieldStyle}" />
              <button type="submit" style="${buttonStyle}">Save</button>
            </div>
          </form>
        </div>

        <div id="tab-join-requests" style="display:none; ${PANEL}">
          <p style="font-weight:700; font-size:18px; margin:0 0 4px;">📨 Group Join Requests</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 24px; line-height:1.6;">
            Manage pending Roblox group join requests. Manual accept/decline is free. Auto-accepting on verification requires <strong style="color:#c084fc;">Premium</strong>.
          </p>

          ${roblox.groupId && roblox.openCloudKey ? `
          <!-- Log channel + format — mirrors auto-rank layout -->
          <hr style="border:none; border-top:1px solid #2b2d31; margin:0 0 24px;" />
          <p style="font-weight:700; font-size:14px; margin:0 0 4px; color:#fff;">📋 Confirmation Log Channel</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">After accepting a member, Phantom posts a confirmation here.</p>
          <form method="POST" action="/dashboard/server/${guildId}/join-requests/settings">
            <select name="logChannelId" style="width:100%; ${fieldStyle} margin-bottom:20px;">
              <option value="">-- None --</option>${channelOptions(joinRequestConfig.logChannelId)}
            </select>

            <p style="font-weight:700; font-size:14px; margin:0 0 4px; color:#fff;">📝 Custom Log Format <span style="color:#949ba4; font-weight:400;">(optional)</span></p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 6px; line-height:1.6;">
              Define how the confirmation message looks. Variables:
              <code style="background:#2b2d31; padding:2px 5px; border-radius:4px;">{username}</code>
              <code style="background:#2b2d31; padding:2px 5px; border-radius:4px;">{newRank}</code>
              <code style="background:#2b2d31; padding:2px 5px; border-radius:4px;">{reason}</code>
              <code style="background:#2b2d31; padding:2px 5px; border-radius:4px;">{ranker}</code>
            </p>
            <textarea name="customFormat" rows="6" placeholder="Leave blank to use default format:&#10;&#10;✅ **Group Acceptance**&#10;**User:** {username}&#10;**From:** N/A&#10;**To:** {newRank}&#10;**Reason:** {reason}&#10;**Accepted by:** {ranker}" style="width:100%; ${fieldStyle} resize:vertical; font-family:monospace; font-size:13px; line-height:1.6; box-sizing:border-box; margin-bottom:20px;">${joinRequestConfig.customFormat || ''}</textarea>
            <button type="submit" style="${buttonStyle}">Save Settings</button>
          </form>

          <hr style="border:none; border-top:1px solid #2b2d31; margin:28px 0;" />

          <!-- Pending requests list -->
          <p style="font-weight:700; font-size:14px; margin:0 0 12px; color:#fff;">Pending Requests</p>
          <div id="joinRequestsList" style="background:#111214; border:1px solid #2b2d31; border-radius:8px; padding:16px;">
            <p style="color:#949ba4; font-size:13px; margin:0;">Loading join requests...</p>
          </div>
          <script>
            var _jrRoles = [];

            (async function loadJoinRequests() {
              const container = document.getElementById('joinRequestsList');
              try {
                const [rolesRes, reqRes] = await Promise.all([
                  fetch('/dashboard/server/${guildId}/group-roles'),
                  fetch('/dashboard/server/${guildId}/join-requests'),
                ]);
                const rolesData = await rolesRes.json();
                const data = await reqRes.json();

                _jrRoles = (rolesData.roles || []).filter(r => r.rank > 0);

                if (!data.requests || data.requests.length === 0) {
                  container.innerHTML = '<p style="color:#949ba4; font-size:13px; margin:0;">✅ No pending join requests.</p>';
                  return;
                }

                const roleOptions = _jrRoles.map(r =>
                  \`<option value="\${r.rank}">\${r.displayName}</option>\`
                ).join('');

                container.innerHTML = data.requests.map(req => \`
                  <div style="padding:14px 0; border-bottom:1px solid #2b2d31;" id="jr-\${req.userId}">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                      <div>
                        <a href="https://www.roblox.com/users/\${req.userId}/profile" target="_blank"
                           style="color:#c084fc; font-weight:600; font-size:14px; text-decoration:none;">\${req.username || req.userId}</a>
                        <p style="color:#949ba4; font-size:12px; margin:2px 0 0;">ID: \${req.userId}</p>
                      </div>
                      <button onclick="toggleAcceptForm('\${req.userId}')"
                        style="padding:6px 14px; background:#57f287; color:#000; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">
                        Accept
                      </button>
                    </div>
                    <div id="acceptForm-\${req.userId}" style="display:none; background:#1a1c1e; border:1px solid #2b2d31; border-radius:8px; padding:12px; margin-top:4px;">
                      <p style="color:#fff; font-size:13px; font-weight:600; margin:0 0 10px;">Accept \${req.username || req.userId}</p>
                      <p style="color:#949ba4; font-size:12px; margin:0 0 6px;">Assign Rank</p>
                      <select id="rankSelect-\${req.userId}" style="width:100%; background:#111214; border:1px solid #2b2d31; color:#fff; padding:8px 10px; border-radius:6px; font-size:13px; margin-bottom:10px;">
                        \${roleOptions}
                      </select>
                      <p style="color:#949ba4; font-size:12px; margin:0 0 6px;">Reason</p>
                      <input id="reasonInput-\${req.userId}" type="text" placeholder="Accepted into group"
                        style="width:100%; background:#111214; border:1px solid #2b2d31; color:#fff; padding:8px 10px; border-radius:6px; font-size:13px; box-sizing:border-box; margin-bottom:10px;" />
                      <div style="display:flex; gap:8px;">
                        <button onclick="submitAccept('\${req.userId}', '\${req.username || req.userId}')"
                          style="flex:1; padding:8px; background:#5865F2; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">
                          Confirm
                        </button>
                        <button onclick="document.getElementById('acceptForm-\${req.userId}').style.display='none'"
                          style="padding:8px 14px; background:#2b2d31; color:#949ba4; border:none; border-radius:6px; font-size:13px; cursor:pointer;">
                          Cancel
                        </button>
                        <button onclick="submitDecline('\${req.userId}')"
                          style="padding:8px 14px; background:#ed4245; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">
                          Decline
                        </button>
                      </div>
                      <p id="jrMsg-\${req.userId}" style="font-size:12px; margin:8px 0 0; color:#949ba4;"></p>
                    </div>
                  </div>
                \`).join('');
              } catch(e) {
                container.innerHTML = '<p style="color:#ed4245; font-size:13px; margin:0;">Failed to load join requests.</p>';
              }
            })();

            function toggleAcceptForm(userId) {
              const form = document.getElementById('acceptForm-' + userId);
              form.style.display = form.style.display === 'none' ? 'block' : 'none';
            }

            async function submitAccept(userId, username) {
              const rank   = document.getElementById('rankSelect-' + userId).value;
              const reason = document.getElementById('reasonInput-' + userId).value.trim() || 'Accepted into group';
              const msg    = document.getElementById('jrMsg-' + userId);
              msg.textContent = 'Processing...'; msg.style.color = '#949ba4';
              try {
                const r = await fetch('/dashboard/server/${guildId}/join-requests/accept', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userId, rank, reason, username }),
                });
                const d = await r.json();
                if (d.success) {
                  document.getElementById('jr-' + userId).innerHTML =
                    '<p style="color:#57f287; font-size:13px; padding:8px 0;">✅ ' + username + ' accepted and ranked to <strong>' + d.rankName + '</strong>.</p>';
                } else { msg.textContent = d.error || 'Something went wrong.'; msg.style.color = '#ed4245'; }
              } catch(e) { msg.textContent = 'Error.'; msg.style.color = '#ed4245'; }
            }

            async function submitDecline(userId) {
              const msg = document.getElementById('jrMsg-' + userId);
              msg.textContent = 'Declining...'; msg.style.color = '#949ba4';
              try {
                const r = await fetch('/dashboard/server/${guildId}/join-requests/decline', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userId }),
                });
                const d = await r.json();
                if (d.success) {
                  document.getElementById('jr-' + userId).innerHTML =
                    '<p style="color:#ed4245; font-size:13px; padding:8px 0;">❌ Request declined.</p>';
                } else { msg.textContent = d.error || 'Something went wrong.'; msg.style.color = '#ed4245'; }
              } catch(e) { msg.textContent = 'Error.'; msg.style.color = '#ed4245'; }
            }
          </script>
          ` : `<p style="color:#949ba4; padding:16px; background:#111214; border-radius:8px; border:1px solid #2b2d31; font-size:14px;">Configure your Group ID and Open Cloud API key in Group Setup to manage join requests.</p>`}
        </div>
        <div id="tab-audit-logs" style="display:none; ${PANEL}">
          ${!isPremium ? `<div style="background:#1a0840; border:1px solid #5b21b6; border-radius:10px; padding:24px; margin-bottom:20px; text-align:center;"><p style="color:#c084fc; font-size:28px; margin:0 0 8px;">🔒</p><p style="color:#fff; font-weight:700; font-size:16px; margin:0 0 6px;">Premium Feature</p><p style="color:#a78bfa; font-size:13px; margin:0 0 16px;">Upgrade to enable audit logging.</p><a href="/upgrade/${guildId}?plan=premium" style="display:inline-block; padding:10px 24px; background:#7c3aed; color:#fff; border-radius:8px; text-decoration:none; font-size:14px; font-weight:600;">Upgrade — $7/mo</a></div>` : ''}

          <!-- Auto-create channels shortcut -->
          <div style="background:#111214; border:1px solid #2b2d31; border-radius:10px; padding:12px 16px; margin-bottom:20px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <div>
              <p style="color:#fff; font-weight:700; margin:0 0 2px; font-size:13px;">🤖 Auto-Create Log Channels</p>
              <p style="color:#949ba4; font-size:12px; margin:0;">Creates <strong style="color:#fff;">#discord-logs</strong>, <strong style="color:#fff;">#roblox-logs</strong>, <strong style="color:#fff;">#dashboard-logs</strong> under a Phantom Logs category.</p>
            </div>
            <a href="/dashboard/server/${guildId}/create-log-channels" style="display:inline-block; padding:8px 14px; background:#5865F2; color:#fff; border-radius:7px; text-decoration:none; font-size:13px; font-weight:600; white-space:nowrap;">Create Channels</a>
          </div>

          <!-- Audit sub-tabs -->
          <div style="display:flex; gap:3px; background:#0d0e10; padding:3px; border-radius:8px; margin-bottom:20px; overflow-x:auto; flex-wrap:nowrap;">
            <button id="alog-btn-discord" onclick="showAuditTab('discord',this)" style="padding:7px 12px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; background:#5865F2; color:#fff;">👥 Discord Events</button>
            <button id="alog-btn-roblox"  onclick="showAuditTab('roblox',this)"  style="padding:7px 12px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; background:transparent; color:#949ba4;">👑 Rank Changes</button>
            <button id="alog-btn-dashboard" onclick="showAuditTab('dashboard',this)" style="padding:7px 12px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; background:transparent; color:#949ba4;">📋 Dashboard Actions</button>
            <button id="alog-btn-joinleave" onclick="showAuditTab('joinleave',this)" style="padding:7px 12px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; background:transparent; color:#949ba4;">🚪 Join / Leave</button>
            <button id="alog-btn-moderation" onclick="showAuditTab('moderation',this)" style="padding:7px 12px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; background:transparent; color:#949ba4;">🔨 Moderation</button>
          </div>

          <form method="POST" action="/dashboard/server/${guildId}/audit-logs">
            <!-- Discord Events -->
            <div id="alog-discord">
              <p style="font-weight:700; margin:0 0 4px; font-size:14px;">👥 Discord Events</p>
              <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Logs member joins, leaves, role changes, username updates.</p>
              <select name="discordChannelId" style="width:100%; ${fieldStyle} margin-bottom:0;">
                <option value="">-- Disabled --</option>${channelOptions(auditLogs.discordChannelId)}
              </select>
            </div>
            <!-- Roblox Rank Changes -->
            <div id="alog-roblox" style="display:none;">
              <p style="font-weight:700; margin:0 0 4px; font-size:14px;">👑 Rank Changes</p>
              <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Logs every rank change made through the dashboard or auto-rank.</p>
              <select name="robloxChannelId" style="width:100%; ${fieldStyle} margin-bottom:0;">
                <option value="">-- Disabled --</option>${channelOptions(auditLogs.robloxChannelId)}
              </select>
            </div>
            <!-- Dashboard Actions -->
            <div id="alog-dashboard" style="display:none;">
              <p style="font-weight:700; margin:0 0 4px; font-size:14px;">📋 Dashboard Actions</p>
              <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Logs settings changes made on this dashboard (group setup, verification, etc.).</p>
              <select name="dashboardChannelId" style="width:100%; ${fieldStyle} margin-bottom:0;">
                <option value="">-- Disabled --</option>${channelOptions(auditLogs.dashboardChannelId)}
              </select>
            </div>
            <!-- Join / Leave -->
            <div id="alog-joinleave" style="display:none;">
              <p style="font-weight:700; margin:0 0 4px; font-size:14px;">🚪 Join / Leave</p>
              <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Posts a message whenever a member joins or leaves the server.</p>
              <select name="joinLeaveChannelId" style="width:100%; ${fieldStyle} margin-bottom:0;">
                <option value="">-- Disabled --</option>${channelOptions(auditLogs.joinLeaveChannelId)}
              </select>
            </div>
            <!-- Moderation -->
            <div id="alog-moderation" style="display:none;">
              <p style="font-weight:700; margin:0 0 4px; font-size:14px;">🔨 Moderation</p>
              <p style="color:#949ba4; font-size:13px; margin:0 0 10px;">Logs kicks, bans, unbans, timeouts, and message deletions.</p>
              <select name="moderationChannelId" style="width:100%; ${fieldStyle} margin-bottom:0;">
                <option value="">-- Disabled --</option>${channelOptions(auditLogs.moderationChannelId)}
              </select>
            </div>

            <button type="submit" style="${buttonStyle} margin-top:20px;">Save Log Channels</button>
          </form>

          <script>
            function showAuditTab(name,btn){
              ['discord','roblox','dashboard','joinleave','moderation'].forEach(function(t){
                document.getElementById('alog-'+t).style.display='none';
                document.getElementById('alog-btn-'+t).style.background='transparent';
                document.getElementById('alog-btn-'+t).style.color='#949ba4';
              });
              document.getElementById('alog-'+name).style.display='block';
              btn.style.background='#5865F2'; btn.style.color='#fff';
            }
          </script>
        </div>
        <div id="tab-members" style="display:none; ${PANEL}">
          ${!isPremium ? `<div style="background:#1a0840; border:1px solid #5b21b6; border-radius:10px; padding:24px; margin-bottom:20px; text-align:center;"><p style="color:#c084fc; font-size:28px; margin:0 0 8px;">🔒</p><p style="color:#fff; font-weight:700; font-size:16px; margin:0 0 6px;">Premium Feature</p><p style="color:#a78bfa; font-size:13px; margin:0 0 16px;">Upgrade to see linked members.</p><a href="/upgrade/${guildId}?plan=premium" style="display:inline-block; padding:10px 24px; background:#7c3aed; color:#fff; border-radius:8px; text-decoration:none; font-size:14px; font-weight:600;">Upgrade — $7/mo</a></div>` : ''}
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; gap:8px; flex-wrap:wrap;">
            <div>
              <p style="font-weight:700; margin:0 0 2px; font-size:15px;">Linked Members</p>
              <p style="color:#949ba4; font-size:13px; margin:0;">Roblox rank shown when group is connected, otherwise Discord role.</p>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
              ${isEnterprise ? `
              <select id="bulkRankSelect" style="background:#111214; border:1px solid #2b2d31; color:#fff; padding:6px 10px; border-radius:6px; font-size:12px;">
                <option value="">Bulk rank to…</option>
                ${(robloxRolesForMembers || []).filter(r => r.rank > 0 && r.rank !== 255).map(r => `<option value="${r.rank}">${r.displayName}</option>`).join('')}
              </select>
              <button onclick="bulkRank()" style="padding:6px 12px; background:#7c3aed; color:#fff; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">Rank Selected</button>
              ` : ''}
              <button id="exportMembersBtn" onclick="exportMembers()" style="padding:6px 12px; background:#2b2d31; color:#fff; border:none; border-radius:6px; font-size:12px; cursor:pointer;">⬇ Export CSV</button>
              <button id="refreshMembersBtn" onclick="loadMemberRanks(true)" style="padding:7px 14px; background:#2b2d31; color:#fff; border:none; border-radius:7px; font-size:13px; cursor:pointer;">↻ Refresh</button>
            </div>
          </div>
          ${linkedMembers.length ? `
          <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:14px;">
            <thead><tr style="border-bottom:1px solid #2b2d31;">
              ${isEnterprise ? `<th style="padding:8px 10px; width:20px;"><input type="checkbox" id="selectAllMembers" onchange="document.querySelectorAll('.member-cb').forEach(c=>c.checked=this.checked)" style="accent-color:#7c3aed;"/></th>` : ''}
              <th style="text-align:left; padding:8px 10px; color:#949ba4; font-weight:600; font-size:12px;">DISCORD</th>
              <th style="text-align:left; padding:8px 10px; color:#949ba4; font-weight:600; font-size:12px;">ROBLOX</th>
              <th style="text-align:left; padding:8px 10px; color:#949ba4; font-weight:600; font-size:12px;">RANK</th>
              <th style="padding:8px 10px;"></th>
            </tr></thead>
            <tbody>
              ${linkedMembers.map((m) => `
              <tr style="border-bottom:1px solid #1a1b1e;" data-roblox-id="${m.robloxId}" data-roblox-name="${m.robloxUsername}">
                ${isEnterprise ? `<td style="padding:10px;"><input type="checkbox" class="member-cb" value="${m.robloxId}" data-username="${m.robloxUsername}" style="accent-color:#7c3aed;"/></td>` : ''}
                <td style="padding:10px;">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <img src="${m.avatar}" width="26" height="26" style="border-radius:50%;" />
                    <span style="color:#fff; font-size:13px;">${m.discordName}</span>
                  </div>
                </td>
                <td style="padding:10px; color:#c084fc; font-size:13px;">
                  <a href="https://www.roblox.com/users/${m.robloxId}/profile" target="_blank" style="color:#c084fc; text-decoration:none;">${m.robloxUsername}</a>
                </td>
                <td style="padding:10px;" id="rank-${m.robloxId}" data-discord-role="${m.discordRole || ''}">
                  <span style="color:#5e6272; font-style:italic; font-size:12px;">loading…</span>
                </td>
                <td style="padding:10px;">
                  <button onclick="rankFromMembers('${m.robloxUsername}')" style="padding:4px 10px; background:#5865F2; color:#fff; border:none; border-radius:6px; font-size:12px; cursor:pointer;">Rank</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
          </div>
          <p style="color:#5e6272; font-size:12px; margin:12px 0 0;">${linkedMembers.length} linked member${linkedMembers.length !== 1 ? 's' : ''}</p>
          <script>
            function rankFromMembers(username){
              showTab('rank-management',document.getElementById('btn-rank-management'));
              var inp=document.getElementById('rankUsername');
              if(inp)inp.value=username;
            }

            function loadMemberRanks(force){
              var ids=${JSON.stringify(linkedMembers.map((m)=>({robloxId:m.robloxId,discordRole:m.discordRole||null})).filter(m=>m.robloxId))};
              if(!ids.length)return;
              var btn=document.getElementById('refreshMembersBtn');
              if(btn){btn.textContent='Loading…';btn.disabled=true;}
              // Reset all cells to loading state
              ids.forEach(function(m){
                var cell=document.getElementById('rank-'+m.robloxId);
                if(cell)cell.innerHTML='<span style="color:#5e6272;font-style:italic;font-size:12px;">loading…</span>';
              });
              fetch('/dashboard/server/${guildId}/member-ranks',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({robloxIds:ids.map(m=>m.robloxId)})
              }).then(function(r){return r.json();}).then(function(data){
                ids.forEach(function(m){
                  var cell=document.getElementById('rank-'+m.robloxId);
                  if(!cell)return;
                  var rank=data.ranks&&data.ranks[m.robloxId];
                  if(rank && rank.rankName){
                    // Roblox rank takes priority
                    cell.innerHTML='<span style="color:#57f287;font-weight:600;font-size:13px;">'+rank.rankName+'</span>'
                      +'<span style="color:#5e6272;font-size:11px;margin-left:5px;">Roblox</span>';
                  } else if(m.discordRole){
                    // Fallback to Discord role
                    cell.innerHTML='<span style="color:#5865F2;font-weight:600;font-size:13px;">'+m.discordRole+'</span>'
                      +'<span style="color:#5e6272;font-size:11px;margin-left:5px;">Discord</span>';
                  } else {
                    cell.innerHTML='<span style="color:#5e6272;font-style:italic;font-size:12px;">No rank</span>';
                  }
                });
                if(btn){btn.textContent='↻ Refresh';btn.disabled=false;}
              }).catch(function(){
                ids.forEach(function(m){
                  var cell=document.getElementById('rank-'+m.robloxId);
                  if(cell)cell.innerHTML='<span style="color:#ed4245;font-size:12px;">Error</span>';
                });
                if(btn){btn.textContent='↻ Refresh';btn.disabled=false;}
              });
            }

            // Load ranks every time the Members tab is clicked
            document.getElementById('btn-members').addEventListener('click', function(){ loadMemberRanks(true); });

            function exportMembers(){
              window.location.href='/dashboard/server/${guildId}/export-members';
            }

            async function bulkRank(){
              var sel=document.getElementById('bulkRankSelect');
              if(!sel||!sel.value){alert('Choose a rank first.');return;}
              var rank=sel.value;
              var rankName=sel.options[sel.selectedIndex].text;
              var checked=[...document.querySelectorAll('.member-cb:checked')];
              if(!checked.length){alert('Select at least one member.');return;}
              if(!confirm('Rank '+checked.length+' member(s) to '+rankName+'?'))return;
              var results=await Promise.all(checked.map(async function(cb){
                try{
                  var r=await fetch('/dashboard/server/${guildId}/rank-change',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({robloxId:cb.value,robloxUsername:cb.dataset.username,targetRank:parseInt(rank)})});
                  return await r.json();
                }catch(e){return{success:false,error:e.message};}
              }));
              var ok=results.filter(r=>r.success).length;
              var fail=results.length-ok;
              alert(ok+' ranked successfully'+(fail?' ('+fail+' failed)':'')+'.');
              loadMemberRanks(true);
            }
          </script>
          ` : `
          <div style="padding:32px; text-align:center; background:#111214; border-radius:10px; border:1px solid #2b2d31;">
            <p style="color:#949ba4; margin:0; font-size:14px;">No members have linked their Roblox account yet.</p>
            <p style="color:#5865F2; margin:8px 0 0; font-size:13px;">Members can link via <strong>/linkroblox</strong> in Discord.</p>
          </div>`}
        </div>
        <div id="tab-documents" style="display:none; ${PANEL}">
          ${!isPremium ? `<div style="background:#1a0840; border:1px solid #5b21b6; border-radius:10px; padding:24px; margin-bottom:20px; text-align:center;"><p style="color:#c084fc; font-size:28px; margin:0 0 8px;">🔒</p><p style="color:#fff; font-weight:700; font-size:16px; margin:0 0 6px;">Premium Feature</p><p style="color:#a78bfa; font-size:13px; margin:0 0 16px;">Upgrade to create and share server documents.</p><a href="/upgrade/${guildId}?plan=premium" style="display:inline-block; padding:10px 24px; background:#7c3aed; color:#fff; border-radius:8px; text-decoration:none; font-size:14px; font-weight:600;">Upgrade — $7/mo</a></div>` : ''}
          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">Server Documents</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 20px;">Private documents visible only to this server's admins. Each gets a shareable read-only link.</p>
          <form method="POST" action="/dashboard/server/${guildId}/documents" style="margin-bottom:24px; background:#111214; border-radius:10px; padding:16px; border:1px solid #2b2d31;">
            <p style="font-weight:700; margin:0 0 12px; font-size:14px; color:#fff;">+ New Document</p>
            <input type="text" name="title" placeholder="Document title" required style="width:100%; ${fieldStyle} margin-bottom:10px; box-sizing:border-box;" />
            <textarea name="content" placeholder="Write your document content here..." rows="5" style="width:100%; ${fieldStyle} resize:vertical; font-family:inherit; line-height:1.6; box-sizing:border-box;"></textarea>
            <button type="submit" style="${buttonStyle} margin-top:10px;">Create Document</button>
          </form>
          ${docs.length ? docs.map((doc) => `
          <div style="background:#111214; border-radius:10px; padding:16px; margin-bottom:12px; border:1px solid #2b2d31;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
              <div style="flex:1;">
                <p style="font-weight:700; color:#fff; margin:0 0 4px;">${doc.title}</p>
                <p style="color:#949ba4; font-size:12px; margin:0 0 8px;">By ${doc.authorName} &middot; ${new Date(doc.createdAt).toLocaleDateString()}</p>
                <p style="color:#ccc; font-size:13px; margin:0; white-space:pre-wrap; max-height:60px; overflow:hidden;">${doc.content.slice(0,180)}${doc.content.length>180?'...':''}</p>
              </div>
              <div style="display:flex; gap:8px; flex-shrink:0;">
                <a href="/dashboard/docs/${guildId}/${doc.id}" target="_blank" style="padding:6px 12px; background:#2b2d31; color:#fff; border-radius:6px; text-decoration:none; font-size:13px;">View</a>
                <a href="/dashboard/server/${guildId}/documents/${doc.id}/delete" style="padding:6px 12px; color:#ed4245; border-radius:6px; text-decoration:none; font-size:13px;" onclick="return confirm('Delete this document?')">Delete</a>
              </div>
            </div>
          </div>`).join('') : `
          <div style="padding:32px; text-align:center; background:#111214; border-radius:10px; border:1px solid #2b2d31;">
            <p style="color:#949ba4; margin:0; font-size:14px;">No documents yet -- create one above.</p>
          </div>`}
        </div>

        <div id="tab-verification" style="display:none; ${PANEL}">
          <p style="font-weight:700; margin:0 0 4px; font-size:15px;">Verification Panel</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 20px; line-height:1.6;">Choose a channel and post the verification panel so members can link their Roblox account.</p>
          <form method="POST" action="/dashboard/server/${guildId}/verification-channel" style="margin-bottom:24px;">
            <p style="font-weight:700; margin:0 0 8px; font-size:14px; color:#fff;">Verification Channel</p>
            <div style="display:flex; gap:8px;">
              <select name="channelId" style="flex:1; ${fieldStyle}">
                <option value="">-- Select a channel --</option>
                ${channelOptions(verification.channelId)}
              </select>
              <button type="submit" style="${buttonStyle}">Save</button>
            </div>
          </form>
          ${verification.channelId ? `
          <div style="background:#111214; border-radius:10px; padding:16px; border:1px solid #2b2d31; margin-bottom:20px;">
            <p style="color:#fff; font-weight:700; margin:0 0 8px; font-size:14px;">Panel Preview</p>
            <div style="background:#2b2d31; border-radius:8px; padding:14px; border-left:4px solid #5865F2;">
              <p style="color:#fff; font-weight:700; margin:0 0 4px;">Link your Roblox Account</p>
              <p style="color:#b5bac1; font-size:13px; margin:0;">Click <strong>Link Roblox</strong> to connect your account, or <strong>Update</strong> to refresh your roles.</p>
            </div>
            <p style="color:#949ba4; font-size:12px; margin:8px 0 0;">Buttons: Link Roblox &middot; Update &middot; Sign in with Roblox</p>
          </div>
          <form method="POST" action="/dashboard/server/${guildId}/post-verification-panel">
            <button type="submit" style="${buttonStyle}">Post Panel to #${verChanName ? verChanName.name : 'channel'}</button>
          </form>
          ` : `
          <div style="padding:20px; background:#111214; border-radius:10px; border:1px solid #2b2d31;">
            <p style="color:#949ba4; margin:0; font-size:14px;">Select a channel above to enable posting the panel.</p>
          </div>`}
        </div>

        <!-- ── Tab: Rank History (Enterprise) ── -->
        <div id="tab-rank-history" style="display:none; ${PANEL}">
          ${!isEnterprise ? `<div style="background:#1a0640; border:1px solid #7c3aed; border-radius:10px; padding:24px; text-align:center;"><p style="color:#c084fc; font-size:28px; margin:0 0 8px;">💎</p><p style="color:#fff; font-weight:700; font-size:16px; margin:0 0 6px;">Enterprise Feature</p><p style="color:#a78bfa; font-size:13px; margin:0 0 16px;">Upgrade to Enterprise to access full rank history and analytics.</p><a href="/upgrade/${guildId}?plan=enterprise" style="display:inline-block; padding:10px 24px; background:#7c3aed; color:#fff; border-radius:8px; text-decoration:none; font-size:14px; font-weight:600;">Upgrade — $15/mo</a></div>` : `
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:20px;">
            <div>
              <p style="font-weight:700; font-size:18px; margin:0 0 4px;">📜 Rank History</p>
              <p style="color:#949ba4; font-size:13px; margin:0;">Every rank change made through Phantom, newest first.</p>
            </div>
            <button onclick="loadRankHistory()" style="padding:7px 14px; background:#2b2d31; color:#fff; border:none; border-radius:7px; font-size:13px; cursor:pointer;">↻ Refresh</button>
          </div>
          <div id="rankHistoryList" style="background:#111214; border:1px solid #2b2d31; border-radius:8px; min-height:80px;">
            <p style="color:#949ba4; font-size:13px; padding:20px; margin:0; text-align:center;">Loading…</p>
          </div>
          <script>
            (function(){ document.getElementById('btn-rank-history').addEventListener('click', loadRankHistory); })();
            function loadRankHistory(){
              var el=document.getElementById('rankHistoryList');
              el.innerHTML='<p style="color:#949ba4;font-size:13px;padding:20px;margin:0;text-align:center;">Loading…</p>';
              fetch('/dashboard/server/${guildId}/rank-history').then(r=>r.json()).then(function(data){
                if(!data.entries||!data.entries.length){
                  el.innerHTML='<p style="color:#949ba4;font-size:13px;padding:20px;margin:0;text-align:center;">No rank changes recorded yet.</p>';
                  return;
                }
                el.innerHTML='<table style="width:100%;border-collapse:collapse;font-size:13px;">'
                  +'<thead><tr style="border-bottom:1px solid #2b2d31;">'
                  +'<th style="text-align:left;padding:8px 10px;color:#949ba4;font-size:12px;">USER</th>'
                  +'<th style="text-align:left;padding:8px 10px;color:#949ba4;font-size:12px;">FROM</th>'
                  +'<th style="text-align:left;padding:8px 10px;color:#949ba4;font-size:12px;">TO</th>'
                  +'<th style="text-align:left;padding:8px 10px;color:#949ba4;font-size:12px;">BY</th>'
                  +'<th style="text-align:left;padding:8px 10px;color:#949ba4;font-size:12px;">REASON</th>'
                  +'<th style="text-align:left;padding:8px 10px;color:#949ba4;font-size:12px;">DATE</th>'
                  +'</tr></thead><tbody>'
                  +data.entries.map(function(e){
                    var d=new Date(e.ts);
                    var date=d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
                    return '<tr style="border-bottom:1px solid #1a1b1e;">'
                      +'<td style="padding:8px 10px;color:#c084fc;font-weight:600;">'+e.username+'</td>'
                      +'<td style="padding:8px 10px;color:#5e6272;">'+( e.oldRank||'N/A')+'</td>'
                      +'<td style="padding:8px 10px;color:#57f287;font-weight:600;">'+e.newRank+'</td>'
                      +'<td style="padding:8px 10px;color:#fff;">'+e.ranker+'</td>'
                      +'<td style="padding:8px 10px;color:#949ba4;">'+( e.reason||'—')+'</td>'
                      +'<td style="padding:8px 10px;color:#5e6272;font-size:11px;">'+date+'</td>'
                      +'</tr>';
                  }).join('')
                  +'</tbody></table>';
              }).catch(function(){
                el.innerHTML='<p style="color:#ed4245;font-size:13px;padding:20px;margin:0;">Failed to load history.</p>';
              });
            }
          </script>
          `}
        </div>

        <!-- ── Tab: Enterprise Settings ── -->
        <div id="tab-enterprise" style="display:none; ${PANEL}">
          ${!isEnterprise ? `<div style="background:#1a0640; border:1px solid #7c3aed; border-radius:10px; padding:24px; text-align:center;"><p style="color:#c084fc; font-size:28px; margin:0 0 8px;">💎</p><p style="color:#fff; font-weight:700; font-size:16px; margin:0 0 6px;">Enterprise Features</p><p style="color:#a78bfa; font-size:13px; margin:0 0 16px;">Unlock rank history, bulk ranking, scheduled sync, custom branding, and more.</p><a href="/upgrade/${guildId}?plan=enterprise" style="display:inline-block; padding:10px 24px; background:#7c3aed; color:#fff; border-radius:8px; text-decoration:none; font-size:14px; font-weight:600;">Upgrade — $15/mo</a></div>` : `
          <p style="font-weight:700; font-size:18px; margin:0 0 4px;">💎 Enterprise Settings</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 24px;">Configure enterprise-exclusive features for this server.</p>

          <hr style="border:none; border-top:1px solid #2b2d31; margin:0 0 24px;" />

          <!-- Scheduled Rank Sync -->
          <p style="font-weight:700; font-size:15px; margin:0 0 4px;">🔄 Scheduled Rank Sync</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 16px; line-height:1.6;">Automatically re-syncs all linked members' Discord roles to their current Roblox group rank on a schedule. Catches rank changes made outside the bot.</p>
          <form method="POST" action="/dashboard/server/${guildId}/enterprise/sync-settings">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px; background:#111214; padding:14px 16px; border-radius:8px; border:1px solid #2b2d31;">
              <input type="checkbox" name="syncEnabled" id="syncEnabled" value="1" ${enterprise.syncEnabled ? 'checked' : ''} style="width:16px;height:16px;accent-color:#7c3aed;cursor:pointer;" />
              <label for="syncEnabled" style="color:#fff;font-size:14px;font-weight:600;cursor:pointer;">Enable scheduled sync</label>
            </div>
            <p style="font-weight:700; font-size:13px; margin:0 0 6px;">Sync Interval</p>
            <select name="syncInterval" style="width:100%; ${fieldStyle} margin-bottom:16px;">
              <option value="6"  ${enterprise.syncInterval==6  ? 'selected' : ''}>Every 6 hours</option>
              <option value="12" ${enterprise.syncInterval==12 ? 'selected' : ''}>Every 12 hours</option>
              <option value="24" ${enterprise.syncInterval==24 ? 'selected' : ''}>Daily (24 hours)</option>
              <option value="168" ${enterprise.syncInterval==168 ? 'selected' : ''}>Weekly</option>
            </select>
            <p style="font-weight:700; font-size:13px; margin:0 0 6px;">Sync Log Channel <span style="color:#949ba4;font-weight:400;">(optional)</span></p>
            <select name="syncLogChannelId" style="width:100%; ${fieldStyle} margin-bottom:20px;">
              <option value="">-- None --</option>${channelOptions(enterprise.syncLogChannelId)}
            </select>
            <button type="submit" style="${buttonStyle}">Save Sync Settings</button>
          </form>

          <hr style="border:none; border-top:1px solid #2b2d31; margin:28px 0;" />

          <!-- Custom Embed Branding -->
          <p style="font-weight:700; font-size:15px; margin:0 0 4px;">🎨 Custom Embed Branding</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 16px;">Change how Phantom's embeds look in your server.</p>
          <form method="POST" action="/dashboard/server/${guildId}/enterprise/branding">
            <p style="font-weight:700; font-size:13px; margin:0 0 6px;">Embed Colour <span style="color:#949ba4;font-weight:400;">(hex)</span></p>
            <div style="display:flex; gap:8px; margin-bottom:16px;">
              <input type="color" name="embedColorPicker" value="#${enterprise.embedColor ? enterprise.embedColor.toString(16).padStart(6,'0') : '5865F2'}" oninput="document.getElementById('embedColorHex').value=this.value.replace('#','')" style="width:44px;height:36px;padding:2px;background:#111214;border:1px solid #2b2d31;border-radius:6px;cursor:pointer;" />
              <input type="text" name="embedColor" id="embedColorHex" placeholder="5865F2" value="${enterprise.embedColor ? enterprise.embedColor.toString(16).padStart(6,'0') : '5865F2'}" maxlength="6" style="flex:1; ${fieldStyle}" />
            </div>
            <p style="font-weight:700; font-size:13px; margin:0 0 6px;">Embed Footer Text <span style="color:#949ba4;font-weight:400;">(optional)</span></p>
            <input type="text" name="embedFooter" placeholder="Powered by Phantom" value="${enterprise.embedFooter || ''}" maxlength="100" style="width:100%; ${fieldStyle} margin-bottom:16px; box-sizing:border-box;" />
            <p style="font-weight:700; font-size:13px; margin:0 0 6px;">Bot Nickname in this server <span style="color:#949ba4;font-weight:400;">(optional)</span></p>
            <input type="text" name="botNickname" placeholder="Leave blank for default (Phantom)" value="${enterprise.botNickname || ''}" maxlength="32" style="width:100%; ${fieldStyle} margin-bottom:20px; box-sizing:border-box;" />
            <button type="submit" style="${buttonStyle}">Save Branding</button>
          </form>

          <hr style="border:none; border-top:1px solid #2b2d31; margin:28px 0;" />

          <!-- Dashboard Staff Roles -->
          <p style="font-weight:700; font-size:15px; margin:0 0 4px;">🔑 Dashboard Access Roles</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 16px; line-height:1.6;">Members with any of these Discord roles can access this server's Phantom dashboard (in addition to server admins).</p>
          <form method="POST" action="/dashboard/server/${guildId}/enterprise/staff-roles">
            ${enterprise.staffRoles && enterprise.staffRoles.length ? `
            <div style="margin-bottom:12px;">
              ${enterprise.staffRoles.map(rid => `
                <div style="display:flex; align-items:center; justify-content:space-between; background:#111214; border:1px solid #2b2d31; border-radius:6px; padding:8px 12px; margin-bottom:6px;">
                  <span style="color:#fff; font-size:13px;">${roleName(rid) || rid}</span>
                  <button type="button" onclick="removeStaffRole('${rid}')" style="background:none; border:none; color:#ed4245; cursor:pointer; font-size:13px;">Remove</button>
                </div>`).join('')}
            </div>` : '<p style="color:#5e6272; font-size:13px; margin:0 0 12px;">No staff roles configured.</p>'}
            <select id="addStaffRoleSelect" style="width:100%; ${fieldStyle} margin-bottom:10px;">
              <option value="">-- Add a role --</option>
              ${assignableRoles.filter(r => !(enterprise.staffRoles||[]).includes(r.id)).map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
            </select>
            <button type="button" onclick="addStaffRole()" style="${buttonStyle}">Add Role</button>
          </form>
          <script>
            async function addStaffRole(){
              var sel=document.getElementById('addStaffRoleSelect');
              if(!sel.value)return;
              var r=await fetch('/dashboard/server/${guildId}/enterprise/staff-roles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add',roleId:sel.value})});
              if((await r.json()).success) location.reload();
            }
            async function removeStaffRole(id){
              var r=await fetch('/dashboard/server/${guildId}/enterprise/staff-roles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'remove',roleId:id})});
              if((await r.json()).success) location.reload();
            }
          </script>

          <hr style="border:none; border-top:1px solid #2b2d31; margin:28px 0;" />

          <!-- Custom Verification Message -->
          <p style="font-weight:700; font-size:15px; margin:0 0 4px;">✉️ Custom Verification Message</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 16px;">Customise the text shown in the verification embed that members see.</p>
          <form method="POST" action="/dashboard/server/${guildId}/enterprise/verification-message">
            <p style="font-weight:700; font-size:13px; margin:0 0 6px;">Title</p>
            <input type="text" name="verifyTitle" placeholder="Link your Roblox Account" value="${enterprise.verifyTitle || ''}" maxlength="80" style="width:100%; ${fieldStyle} margin-bottom:12px; box-sizing:border-box;" />
            <p style="font-weight:700; font-size:13px; margin:0 0 6px;">Description</p>
            <textarea name="verifyDescription" rows="4" placeholder="Click the button below to link your Roblox account and gain access to this server." maxlength="500" style="width:100%; ${fieldStyle} resize:vertical; font-family:inherit; margin-bottom:20px; box-sizing:border-box;">${enterprise.verifyDescription || ''}</textarea>
            <button type="submit" style="${buttonStyle}">Save Verification Message</button>
          </form>
          `}
        </div>


        <!-- ── Tab: Tickets ── -->
        <div id="tab-tickets" style="display:none; ${PANEL}">
          <p style="font-weight:700; font-size:18px; margin:0 0 4px;">🎫 Ticket Settings</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 24px;">Configure how Phantom handles support tickets in your server.</p>

          <!-- Ping Roles (Free) -->
          <div style="background:#111214; border:1px solid #2b2d31; border-radius:10px; padding:20px; margin-bottom:20px;">
            <p style="font-weight:700; font-size:15px; margin:0 0 4px; color:#fff;">📣 Ping Roles on Ticket Creation</p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 16px;">These roles will be pinged when a new ticket is opened. Add up to 5 roles.</p>
            <div id="ticketPingRolesList" style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
              ${(ticketSettings.pingRoleIds || []).map(rid => `
                <span style="display:inline-flex; align-items:center; gap:6px; background:#1e1f22; border:1px solid #3f4147; border-radius:20px; padding:4px 10px; font-size:13px; color:#fff;">
                  ${roleName(rid) || rid}
                  <button onclick="removePingRole('${rid}')" style="background:none;border:none;color:#ed4245;cursor:pointer;font-size:14px;line-height:1;padding:0;">✕</button>
                </span>`).join('')}
              ${(ticketSettings.pingRoleIds || []).length === 0 ? '<span style="color:#888; font-size:13px;">No roles set</span>' : ''}
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
              <select id="newPingRole" style="${fieldStyle} flex:1;">
                <option value="">-- Select a role to add --</option>
                ${assignableRoles.filter(r => !(ticketSettings.pingRoleIds || []).includes(r.id)).map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
              </select>
              <button onclick="addPingRole()" style="padding:9px 16px; background:#5865f2; color:#fff; border:none; border-radius:8px; cursor:pointer; font-size:13px; font-weight:600;">Add</button>
            </div>
          </div>

          <!-- Welcome Message (Free) -->
          <div style="background:#111214; border:1px solid #2b2d31; border-radius:10px; padding:20px; margin-bottom:20px;">
            <p style="font-weight:700; font-size:15px; margin:0 0 4px; color:#fff;">💬 Welcome Message</p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 12px;">Custom message sent below the ticket embed when a ticket is opened. Leave blank for none. Supports @mention, #channel, and {user} placeholder.</p>
            <form method="POST" action="/dashboard/server/${guildId}/ticket-settings/welcome">
              <textarea name="welcomeMessage" rows="3" placeholder="e.g. Welcome {user}! A staff member will be with you shortly." style="${fieldStyle} width:100%; resize:vertical; box-sizing:border-box; margin-bottom:10px;">${ticketSettings.welcomeMessage || ''}</textarea>
              <button type="submit" style="padding:8px 18px; background:#5865f2; color:#fff; border:none; border-radius:8px; cursor:pointer; font-size:13px; font-weight:600;">Save</button>
            </form>
          </div>

          <!-- Auto-Reply (Premium) -->
          <div style="background:#111214; border:1px solid ${isPremium ? '#2b2d31' : '#7c3aed44'}; border-radius:10px; padding:20px; margin-bottom:20px; position:relative;">
            ${!isPremium ? `<div style="position:absolute;top:12px;right:12px;background:#7c3aed;color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:99px;">PREMIUM</div>` : ''}
            <p style="font-weight:700; font-size:15px; margin:0 0 4px; color:#fff;">🤖 Auto-Reply to Questions</p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 16px;">Phantom automatically answers common questions in tickets using a built-in FAQ about your bot. Stays silent if staff is active.</p>
            ${isPremium ? `
              <form method="POST" action="/dashboard/server/${guildId}/ticket-settings/auto-reply" style="display:flex; align-items:center; gap:12px;">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                  <input type="hidden" name="enabled" value="false" />
                  <input type="checkbox" name="enabled" value="true" ${ticketSettings.autoReplyEnabled ? 'checked' : ''} onchange="this.form.submit()" style="width:16px; height:16px; cursor:pointer;" />
                  <span style="color:#fff; font-size:14px;">${ticketSettings.autoReplyEnabled ? '✅ Enabled' : '⬜ Disabled'}</span>
                </label>
              </form>` : `
              <p style="color:#888; font-size:13px; margin:0;">Upgrade to <a href="/upgrade/${guildId}?plan=premium" style="color:#c084fc;">Premium</a> to unlock auto-reply.</p>`}
          </div>
        </div>

        <!-- ── Tab: Messages ── -->
        <div id="tab-messages" style="display:none; ${PANEL}">
          <p style="font-weight:700; font-size:18px; margin:0 0 4px;">📨 Message Builder</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 20px;">Compose and send custom embeds through the bot. For complex embeds use the <code style="background:#111214;padding:2px 5px;border-radius:4px;">/embed</code> command in Discord.</p>

          <div style="display:flex; gap:16px; flex-wrap:wrap;">
            <!-- Composer -->
            <div style="flex:1; min-width:280px;">
              <p style="font-weight:700; font-size:13px; margin:0 0 8px; color:#fff;">Channel</p>
              <select id="msgChannel" style="width:100%; ${fieldStyle} margin-bottom:12px;">
                <option value="">-- Select channel --</option>
                ${channelOptions('')}
              </select>
              <p style="font-weight:700; font-size:13px; margin:0 0 6px; color:#fff;">Title</p>
              <input type="text" id="msgTitle" placeholder="Embed title" maxlength="256" style="width:100%; ${fieldStyle} margin-bottom:12px; box-sizing:border-box;" oninput="updatePreview()" />
              <p style="font-weight:700; font-size:13px; margin:0 0 6px; color:#fff;">Description</p>
              <textarea id="msgDesc" rows="5" placeholder="Main body text (supports **bold**, *italic*, and other markdown)" style="width:100%; ${fieldStyle} resize:vertical; font-family:inherit; margin-bottom:12px; box-sizing:border-box;" oninput="updatePreview()"></textarea>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px;">
                <div>
                  <p style="font-weight:700; font-size:13px; margin:0 0 6px; color:#fff;">Colour</p>
                  <div style="display:flex; gap:6px;">
                    <input type="color" id="msgColorPicker" value="#5865F2" oninput="document.getElementById('msgColor').value=this.value.replace('#',''); updatePreview()" style="width:40px;height:36px;padding:2px;background:#111214;border:1px solid #2b2d31;border-radius:6px;cursor:pointer;" />
                    <input type="text" id="msgColor" placeholder="5865F2" maxlength="6" value="5865F2" oninput="document.getElementById('msgColorPicker').value='#'+this.value; updatePreview()" style="flex:1; ${fieldStyle}" />
                  </div>
                </div>
                <div>
                  <p style="font-weight:700; font-size:13px; margin:0 0 6px; color:#fff;">Footer</p>
                  <input type="text" id="msgFooter" placeholder="Footer text" maxlength="2048" style="width:100%; ${fieldStyle} box-sizing:border-box;" oninput="updatePreview()" />
                </div>
              </div>
              <p style="font-weight:700; font-size:13px; margin:0 0 6px; color:#fff;">Image URL <span style="color:#949ba4;font-weight:400;">(optional)</span></p>
              <input type="text" id="msgImage" placeholder="https://..." style="width:100%; ${fieldStyle} margin-bottom:12px; box-sizing:border-box;" />
              <p style="font-weight:700; font-size:13px; margin:0 0 6px; color:#fff;">Author <span style="color:#949ba4;font-weight:400;">(optional)</span></p>
              <input type="text" id="msgAuthor" placeholder="Author name shown above title" maxlength="256" style="width:100%; ${fieldStyle} margin-bottom:16px; box-sizing:border-box;" />
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button onclick="sendEmbed()" style="${buttonStyle}; flex:1;">Send Embed</button>
                <button onclick="sendEmbed(true)" style="padding:10px 16px; background:#2b2d31; color:#fff; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer;">+ @here</button>
              </div>
              <p id="msgStatus" style="font-size:13px; margin:10px 0 0; color:#949ba4;"></p>
            </div>

            <!-- Live preview -->
            <div style="flex:1; min-width:260px;">
              <p style="font-weight:700; font-size:13px; margin:0 0 8px; color:#fff;">Live Preview</p>
              <div style="background:#313338; border-radius:8px; padding:16px;">
                <div id="previewEmbed" style="background:#2b2d31; border-left:4px solid #5865F2; border-radius:4px; padding:12px; font-family:sans-serif;">
                  <p id="previewAuthor" style="color:#949ba4; font-size:12px; margin:0 0 4px; display:none;"></p>
                  <p id="previewTitle" style="color:#fff; font-weight:700; font-size:15px; margin:0 0 6px;"></p>
                  <p id="previewDesc" style="color:#dbdee1; font-size:14px; margin:0 0 8px; white-space:pre-wrap; line-height:1.5;"></p>
                  <p id="previewFooter" style="color:#949ba4; font-size:11px; margin:0; display:none;"></p>
                </div>
              </div>
            </div>
          </div>

          <script>
            function updatePreview(){
              var color='#'+(document.getElementById('msgColor').value||'5865F2');
              document.getElementById('previewEmbed').style.borderLeftColor=color;
              var title=document.getElementById('msgTitle').value;
              var desc=document.getElementById('msgDesc').value;
              var footer=document.getElementById('msgFooter').value;
              var author=document.getElementById('msgAuthor').value;
              document.getElementById('previewTitle').textContent=title;
              document.getElementById('previewDesc').textContent=desc;
              var footerEl=document.getElementById('previewFooter');
              footerEl.textContent=footer; footerEl.style.display=footer?'block':'none';
              var authorEl=document.getElementById('previewAuthor');
              authorEl.textContent=author; authorEl.style.display=author?'block':'none';
            }
            async function sendEmbed(pingHere){
              var channelId=document.getElementById('msgChannel').value;
              if(!channelId){alert('Select a channel first.');return;}
              var title=document.getElementById('msgTitle').value;
              var desc=document.getElementById('msgDesc').value;
              if(!title&&!desc){alert('Add a title or description.');return;}
              var status=document.getElementById('msgStatus');
              status.textContent='Sending…'; status.style.color='#949ba4';
              try{
                var r=await fetch('/dashboard/server/${guildId}/send-embed',{
                  method:'POST',headers:{'Content-Type':'application/json'},
                  body:JSON.stringify({
                    channelId,title,description:desc,
                    color:parseInt(document.getElementById('msgColor').value||'5865F2',16),
                    footer:document.getElementById('msgFooter').value||null,
                    image:document.getElementById('msgImage').value||null,
                    author:document.getElementById('msgAuthor').value||null,
                    pingHere:!!pingHere,
                  })
                });
                var d=await r.json();
                if(d.success){status.textContent='✅ Sent!'; status.style.color='#57f287';}
                else{status.textContent='❌ '+d.error; status.style.color='#ed4245';}
              }catch(e){status.textContent='❌ Error'; status.style.color='#ed4245';}
            }
          </script>
        </div>

        <!-- ── Tab: Security ── -->
        <div id="tab-security" style="display:none; ${PANEL}">
          <p style="font-weight:700; font-size:18px; margin:0 0 4px;">🔐 Security</p>
          <p style="color:#949ba4; font-size:13px; margin:0 0 20px;">Protect your server from raids, bots, and suspicious accounts. Use <code style="background:#111214;padding:2px 5px;border-radius:4px;">/security scan @user</code> to risk-assess any member.</p>

          <!-- Status card -->
          <div style="background:${(security||{}).lockdownActive ? '#3a1a1a' : '#111214'}; border:1px solid ${(security||{}).lockdownActive ? '#ed4245' : '#2b2d31'}; border-radius:10px; padding:14px 16px; margin-bottom:20px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <div>
              <p style="font-weight:700; font-size:14px; color:${(security||{}).lockdownActive ? '#ed4245' : '#57f287'}; margin:0 0 2px;">${(security||{}).lockdownActive ? '🔒 Server is in LOCKDOWN' : '🟢 Server is secure'}</p>
              <p style="color:#949ba4; font-size:12px; margin:0;">Use <strong style="color:#fff;">/security lockdown</strong> to toggle lockdown mode.</p>
            </div>
          </div>

          <form method="POST" action="/dashboard/server/${guildId}/security/config">
            <p style="font-weight:700; font-size:14px; margin:0 0 4px;">🛡️ New Account Protection</p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 10px; line-height:1.5;">Automatically handle accounts that are too new when they join.</p>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px;">
              <div>
                <p style="font-weight:600; font-size:13px; margin:0 0 5px; color:#fff;">Min Account Age (days)</p>
                <input type="number" name="minAccountAgeDays" value="${security.minAccountAgeDays||0}" min="0" max="365" style="${fieldStyle} width:100%; box-sizing:border-box;" />
              </div>
              <div>
                <p style="font-weight:600; font-size:13px; margin:0 0 5px; color:#fff;">Action</p>
                <select name="newAccountAction" style="width:100%; ${fieldStyle}">
                  <option value="none"  ${security.newAccountAction==='none'  ?'selected':''}>None (log only)</option>
                  <option value="warn"  ${security.newAccountAction==='warn'  ?'selected':''}>Warn via DM</option>
                  <option value="kick"  ${security.newAccountAction==='kick'  ?'selected':''}>Kick</option>
                  <option value="ban"   ${security.newAccountAction==='ban'   ?'selected':''}>Ban</option>
                  <option value="role"  ${security.newAccountAction==='role'  ?'selected':''}>Assign role</option>
                </select>
              </div>
            </div>
            <p style="font-weight:600; font-size:13px; margin:0 0 5px; color:#fff;">New Account Role <span style="color:#949ba4;font-weight:400;">(for action = role)</span></p>
            <select name="newAccountRoleId" style="width:100%; ${fieldStyle} margin-bottom:16px;">
              <option value="">-- None --</option>
              ${assignableRoles.map(r => `<option value="${r.id}" ${r.id===security.newAccountRoleId?'selected':''}>${r.name}</option>`).join('')}
            </select>

            <hr style="border:none; border-top:1px solid #2b2d31; margin:20px 0;" />

            <p style="font-weight:700; font-size:14px; margin:0 0 4px;">🚨 Raid Protection</p>
            <p style="color:#949ba4; font-size:13px; margin:0 0 10px; line-height:1.5;">Detect and respond to mass-join attacks automatically.</p>
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px; background:#111214; padding:12px 16px; border-radius:8px; border:1px solid #2b2d31;">
              <input type="checkbox" name="raidProtection" id="raidEnabled" value="1" ${security.raidProtection?'checked':''} style="width:16px;height:16px;accent-color:#5865F2;cursor:pointer;" />
              <label for="raidEnabled" style="color:#fff;font-size:14px;font-weight:600;cursor:pointer;">Enable raid protection</label>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:16px;">
              <div>
                <p style="font-weight:600; font-size:13px; margin:0 0 5px; color:#fff;">Joins Threshold</p>
                <input type="number" name="raidThreshold" value="${security.raidThreshold||10}" min="3" max="100" style="${fieldStyle} width:100%; box-sizing:border-box;" />
              </div>
              <div>
                <p style="font-weight:600; font-size:13px; margin:0 0 5px; color:#fff;">Window (seconds)</p>
                <input type="number" name="raidWindowSeconds" value="${security.raidWindowSeconds||30}" min="5" max="300" style="${fieldStyle} width:100%; box-sizing:border-box;" />
              </div>
              <div>
                <p style="font-weight:600; font-size:13px; margin:0 0 5px; color:#fff;">Action</p>
                <select name="raidAction" style="width:100%; ${fieldStyle}">
                  <option value="lockdown" ${security.raidAction==='lockdown'?'selected':''}>Lock server</option>
                  <option value="kick"     ${security.raidAction==='kick'    ?'selected':''}>Kick joiners</option>
                  <option value="ban"      ${security.raidAction==='ban'     ?'selected':''}>Ban joiners</option>
                </select>
              </div>
            </div>

            <p style="font-weight:600; font-size:13px; margin:0 0 5px; color:#fff;">Security Log Channel</p>
            <select name="newAccountLogChannel" style="width:100%; ${fieldStyle} margin-bottom:20px;">
              <option value="">-- None --</option>
              ${channelOptions(security.newAccountLogChannel)}
            </select>

            <button type="submit" style="${buttonStyle}">Save Security Settings</button>
          </form>
        </div>

        <script>
          var ALL_TABS=['overview','group-setup','rank-management','audit-logs','members','documents','verification','join-requests','rank-history','enterprise','tickets','messages','security'];
          function showTab(name,btn){
            ALL_TABS.forEach(function(t){
              document.getElementById('tab-'+t).style.display='none';
              var b=document.getElementById('btn-'+t);
              b.style.background='transparent';b.style.color='#949ba4';
            });
            document.getElementById('tab-'+name).style.display='block';
            btn.style.background='#5865F2';btn.style.color='#fff';
            window.location.hash=name;
          }
          window.addEventListener('load',function(){
            var hash=window.location.hash.slice(1);
            if(hash&&ALL_TABS.indexOf(hash)!==-1){
              var btn=document.getElementById('btn-'+hash);
              if(btn)showTab(hash,btn);
            }
          });
          async function addPingRole(){
            var sel=document.getElementById('newPingRole');
            var roleId=sel.value;
            if(!roleId)return;
            var r=await fetch('/dashboard/server/${guildId}/ticket-settings/ping-role',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add',roleId})});
            if(r.ok)location.reload();else alert('Failed to add role');
          }
          async function removePingRole(roleId){
            var r=await fetch('/dashboard/server/${guildId}/ticket-settings/ping-role',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'remove',roleId})});
            if(r.ok)location.reload();else alert('Failed to remove role');
          }
        </script>
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

  // Post to #dashboard-logs
  const auditCfg = await getConfigValue({ db }, guildId, 'auditLogs', {});
  if (auditCfg.dashboardChannelId) {
    await sendBotEmbed(auditCfg.dashboardChannelId, {
      color: 0x5865F2,
      title: '⚙️ Group Setup Updated',
      fields: [
        { name: 'Changed By', value: access.user.username, inline: true },
        { name: 'Group', value: `${group.name} (${groupId})`, inline: true },
      ],
    }).catch(() => {});
  }

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

// Auto-bind: fetch all Roblox group ranks, match/create Discord roles, save mappings.
dashboardAuthRouter.get('/dashboard/server/:guildId/auto-bind-roles', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  if (!await checkTier(access, guildId)) return res.redirect(`/dashboard/server/${guildId}?error=Premium+required+for+auto-bind#group-setup`);

  try {
    const roblox = await getConfigValue({ db }, guildId, 'roblox', {});
    if (!roblox.groupId || !roblox.openCloudKey) {
      return res.redirect(`/dashboard/server/${guildId}?error=Configure+group+ID+and+Open+Cloud+key+first#group-setup`);
    }

    // Fetch all Roblox group ranks (skipping Guest 0 and Owner 255)
    const robloxRoles = await getGroupRoles(roblox.groupId, roblox.openCloudKey);
    if (!robloxRoles?.length) {
      return res.redirect(`/dashboard/server/${guildId}?error=Could+not+fetch+Roblox+group+ranks#group-setup`);
    }
    const ranksToMap = robloxRoles.filter((r) => r.rank > 0 && r.rank < 255);

    // Fetch existing Discord roles
    const discordRolesRes = await fetch(`https://discord.com/api/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    const discordRoles = discordRolesRes.ok ? await discordRolesRes.json() : [];
    const discordByName = new Map(discordRoles.map((r) => [r.name.toLowerCase(), r.id]));

    const rankRoles = { ...(roblox.rankRoles || {}) };
    let created = 0;
    let matched = 0;

    for (const rRole of ranksToMap) {
      const name = rRole.displayName;
      const nameLower = name.toLowerCase();

      // Already mapped — skip
      if (rankRoles[rRole.rank]) { matched++; continue; }

      // Existing Discord role with the same name?
      if (discordByName.has(nameLower)) {
        rankRoles[rRole.rank] = discordByName.get(nameLower);
        matched++;
        continue;
      }

      // Create a new Discord role
      const createRes = await fetch(`https://discord.com/api/guilds/${guildId}/roles`, {
        method: 'POST',
        headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, permissions: '0' }),
      });

      if (createRes.ok) {
        const newRole = await createRes.json();
        rankRoles[rRole.rank] = newRole.id;
        discordByName.set(nameLower, newRole.id); // prevent dupes on next loop
        created++;
      }
    }

    await updateGuildConfig({ db }, guildId, { roblox: { ...roblox, rankRoles } });

    // Post to #dashboard-logs
    const auditCfg = await getConfigValue({ db }, guildId, 'auditLogs', {});
    if (auditCfg.dashboardChannelId) {
      await sendBotEmbed(auditCfg.dashboardChannelId, {
        color: 0x57F287,
        title: '⚡ Auto-Bind Roles Run',
        fields: [
          { name: 'By', value: access.user.username, inline: true },
          { name: 'Roles Created', value: String(created), inline: true },
          { name: 'Already Matched', value: String(matched), inline: true },
        ],
      }).catch(() => {});
    }

    res.redirect(`/dashboard/server/${guildId}?success=Auto-bind+complete+%E2%80%94+${created}+role${created !== 1 ? 's' : ''}+created,+${matched}+matched#group-setup`);
  } catch (err) {
    logger.error('auto-bind-roles error:', err);
    res.redirect(`/dashboard/server/${guildId}?error=Something+went+wrong+during+auto-bind#group-setup`);
  }
});

// ---- Join request handlers ----

// GET /dashboard/server/:guildId/join-requests — fetch pending join requests
dashboardAuthRouter.get('/dashboard/server/:guildId/join-requests', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  try {
    const roblox = await getConfigValue({ db }, guildId, 'roblox', {});
    if (!roblox.groupId || !roblox.openCloudKey) {
      return res.json({ requests: [] });
    }

    const data = await getGroupJoinRequests(roblox.groupId, roblox.openCloudKey);
    const rawRequests = data.joinRequests || data.memberships || [];

    // Resolve usernames for each pending request
    const requests = await Promise.all(rawRequests.map(async (req) => {
      // The user path is like "users/123456"
      const userId = String(req.user || req.userId || '').replace('users/', '');
      let username = userId;
      try {
        const userRes = await fetch(`https://users.roblox.com/v1/users/${userId}`);
        if (userRes.ok) {
          const u = await userRes.json();
          username = u.name || userId;
        }
      } catch {}
      return { userId, username };
    }));

    return res.json({ requests });
  } catch (e) {
    logger.error('Error fetching join requests:', e.message);
    return res.json({ requests: [], error: e.message });
  }
});

// POST /dashboard/server/:guildId/join-requests/accept — accept a request
dashboardAuthRouter.post('/dashboard/server/:guildId/join-requests/accept', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const { userId, rank, reason, username } = req.body;
  if (!userId) return res.json({ success: false, error: 'Missing userId' });

  try {
    const roblox = await getConfigValue({ db }, guildId, 'roblox', {});
    if (!roblox.groupId || !roblox.openCloudKey) return res.json({ success: false, error: 'Group not configured.' });

    // Accept the join request (silent fail if no pending request)
    await acceptGroupJoinRequest(roblox.groupId, userId, roblox.openCloudKey).catch(() => {});

    // Assign rank if provided
    let rankName = null;
    if (rank) {
      const roles = await getGroupRoles(roblox.groupId, roblox.openCloudKey);
      const targetRole = roles.find(r => String(r.rank) === String(rank));
      if (targetRole) {
        await updateGroupMemberRank(roblox.groupId, userId, targetRole.rank, roblox.openCloudKey);
        rankName = targetRole.displayName;

        // Post to log channel if configured
      const autoRank  = await getConfigValue({ db }, guildId, 'autoRank', {});
      const jrCfg     = await getConfigValue({ db }, guildId, 'joinRequests', {});
      const logChanId = jrCfg.logChannelId || autoRank.logChannelId;
      if (logChanId) {
        const client = (await import('../utils/clientRef.js')).getClient();
        const guild  = client?.guilds?.cache?.get(guildId);
        const logChannel = guild?.channels?.cache?.get(logChanId) ||
          await guild?.channels?.fetch(logChanId).catch(() => null);
          if (logChannel) {
            const { applyFormat, ACCEPT_LOG_FORMAT } = await import('../services/promotionParser.js');
            const jrConfig = await getConfigValue({ db }, guildId, 'joinRequests', {});
            const format  = jrConfig.customFormat || autoRank.customFormat || ACCEPT_LOG_FORMAT;
            const logText = applyFormat(format, {
              username: username || userId,
              oldRank:  'N/A',
              newRank:  rankName,
              reason:   reason || 'Accepted into group',
              ranker:   access.user.username,
            });
            await logChannel.send(logText).catch(() => {});
          }
        }
      }
    }

    return res.json({ success: true, rankName });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

// POST /dashboard/server/:guildId/join-requests/decline — decline a request
dashboardAuthRouter.post('/dashboard/server/:guildId/join-requests/decline', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const { userId } = req.body;
  if (!userId) return res.json({ success: false, error: 'Missing userId' });

  try {
    const roblox = await getConfigValue({ db }, guildId, 'roblox', {});
    if (!roblox.groupId || !roblox.openCloudKey) return res.json({ success: false, error: 'Group not configured.' });
    await declineGroupJoinRequest(roblox.groupId, userId, roblox.openCloudKey);
    return res.json({ success: true });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});


// ── Tier enforcement helper ───────────────────────────────────────────────────
async function checkTier(access, guildId, minTier = 'premium') {
  const sub  = await getSubscription(guildId);
  const tier = isOwner(access.user.id) ? 'enterprise' : getTier(sub);
  if (minTier === 'enterprise' && tier !== 'enterprise') return null;
  if (minTier === 'premium'    && tier === 'free')       return null;
  return tier;
}

// ---- Rank management handlers ----

dashboardAuthRouter.post('/dashboard/server/:guildId/auto-rank', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  if (!await checkTier(access, guildId)) return res.redirect(`/dashboard/server/${guildId}?error=Premium+required+for+Auto-Rank#rank-management`);

  const enabled      = req.body.enabled === '1';
  const logChannelId = req.body.logChannelId || null;
  const customFormat = (req.body.customFormat || '').trim() || null;

  // Enterprise: save array of channels; Premium: save single channel
  const tier = await checkTier(access, guildId, 'enterprise');
  let watchChannelId  = null;
  let watchChannelIds = null;

  if (tier === 'enterprise' && req.body.watchChannelIds) {
    // Multi-select sends array or single string
    const raw = Array.isArray(req.body.watchChannelIds)
      ? req.body.watchChannelIds
      : [req.body.watchChannelIds];
    watchChannelIds = raw.filter(Boolean);
    watchChannelId  = watchChannelIds[0] || null; // keep single for backwards compat
  } else {
    watchChannelId  = req.body.watchChannelId || null;
    watchChannelIds = null;
  }

  await updateGuildConfig({ db }, guildId, {
    autoRank: { enabled, watchChannelId, watchChannelIds, logChannelId, customFormat },
  });

  res.redirect(`/dashboard/server/${guildId}?success=Auto-rank+settings+saved#rank-management`);
});

dashboardAuthRouter.post('/dashboard/server/:guildId/auto-demote', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const enabled     = req.body.enabled === '1';
  const exileRankId = parseInt(req.body.exileRankId ?? 0, 10);
  const roblox      = await getConfigValue({ db }, guildId, 'roblox', {});

  await updateGuildConfig({ db }, guildId, {
    roblox: { ...roblox, autoDemote: { enabled, exileRankId } },
  });

  res.redirect(`/dashboard/server/${guildId}?success=Auto-demotion+settings+saved#rank-management`);
});

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

  const discordChannelId    = req.body.discordChannelId    || null;
  const robloxChannelId     = req.body.robloxChannelId     || null;
  const joinLeaveChannelId  = req.body.joinLeaveChannelId  || null;
  const moderationChannelId = req.body.moderationChannelId || null;
  const dashboardChannelId = req.body.dashboardChannelId || null;

  await updateGuildConfig({ db }, guildId, {
    auditLogs: { discordChannelId, robloxChannelId, joinLeaveChannelId, moderationChannelId, dashboardChannelId },
  });

  res.redirect(`/dashboard/server/${guildId}?success=Audit+log+channels+saved#audit-logs`);
});

// ---- Document handlers ----

dashboardAuthRouter.post('/dashboard/server/:guildId/documents', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  if (!await checkTier(access, guildId)) return res.redirect(`/dashboard/server/${guildId}?error=Premium+required+for+Documents#documents`);
  const { title, content } = req.body;
  if (!title || !content) return res.redirect(`/dashboard/server/${guildId}?error=Title+and+content+required#documents`);
  const docId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const doc = { id: docId, guildId, title: title.trim(), content: content.trim(), authorId: access.user.id, authorName: access.user.username, createdAt: new Date().toISOString() };
  await pgDb.set(`doc:${guildId}:${docId}`, doc);
  res.redirect(`/dashboard/server/${guildId}?success=Document+created#documents`);
});

dashboardAuthRouter.get('/dashboard/server/:guildId/documents/:docId/delete', async (req, res) => {
  const { guildId, docId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  await pgDb.delete(`doc:${guildId}:${docId}`);
  res.redirect(`/dashboard/server/${guildId}?success=Document+deleted#documents`);
});

// Public read-only document view
dashboardAuthRouter.get('/dashboard/docs/:guildId/:docId', async (req, res) => {
  const { guildId, docId } = req.params;
  const doc = await pgDb.get(`doc:${guildId}:${docId}`);
  if (!doc) return res.status(404).send('<h2 style="font-family:sans-serif; text-align:center; margin-top:60px; color:#666;">Document not found.</h2>');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${doc.title}</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; max-width:720px; margin:60px auto; padding:0 24px; color:#e0e0e0; background:#111214; line-height:1.7;}
  h1{font-size:28px; margin-bottom:8px;} .meta{color:#666; font-size:14px; margin-bottom:32px;} pre{white-space:pre-wrap; font-size:15px;}</style>
  </head><body><h1>${doc.title}</h1><p class="meta">By ${doc.authorName} &middot; ${new Date(doc.createdAt).toLocaleDateString()}</p><pre>${doc.content}</pre></body></html>`);
});

// ---- Verification handlers ----

dashboardAuthRouter.post('/dashboard/server/:guildId/verification-channel', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  const channelId = req.body.channelId || null;
  const current = await getConfigValue({ db }, guildId, 'verification', {});
  await updateGuildConfig({ db }, guildId, { verification: { ...current, channelId } });
  res.redirect(`/dashboard/server/${guildId}?success=Verification+channel+saved#verification`);
});

dashboardAuthRouter.post('/dashboard/server/:guildId/post-verification-panel', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  const verification = await getConfigValue({ db }, guildId, 'verification', {});
  if (!verification.channelId) return res.redirect(`/dashboard/server/${guildId}?error=No+verification+channel+set#verification`);
  try {
    const enterprise = await getConfigValue({ db }, guildId, 'enterprise', {});
    const embedTitle = enterprise.verifyTitle || 'Link your Roblox Account';
    const embedDesc  = enterprise.verifyDescription || 'Click **Link Roblox** to connect your Roblox account and sync your group roles.\n\nAlready linked? Click **Update** to refresh your roles if your rank changed.';
    const embedColor = enterprise.embedColor || 0x5865F2;
    const embedFooter = enterprise.embedFooter ? { text: enterprise.embedFooter } : undefined;
    const panelRes = await fetch(`https://discord.com/api/channels/${verification.channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ title: embedTitle, description: embedDesc, color: embedColor, footer: embedFooter }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Link Roblox', custom_id: 'roblox_link_start' },
            { type: 2, style: 2, label: 'Update', custom_id: 'roblox_link_update' },
            { type: 2, style: 1, label: 'Sign in with Roblox', custom_id: 'roblox_oauth_start' },
          ],
        }],
      }),
    });
    if (!panelRes.ok) {
      const err = await panelRes.text();
      logger.error('Failed to post verification panel:', err);
      return res.redirect(`/dashboard/server/${guildId}?error=Failed+to+post+panel+%E2%80%94+check+bot+permissions#verification`);
    }
    res.redirect(`/dashboard/server/${guildId}?success=Verification+panel+posted#verification`);
  } catch (err) {
    logger.error('post-verification-panel error:', err);
    res.redirect(`/dashboard/server/${guildId}?error=Something+went+wrong#verification`);
  }
});

// Auto-create the three audit log channels under a "Phantom Logs" category.
dashboardAuthRouter.get('/dashboard/server/:guildId/create-log-channels', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  if (!await checkTier(access, guildId)) return res.redirect(`/dashboard/server/${guildId}?error=Premium+required+for+Audit+Logs#audit-logs`);

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
  if (!await checkTier(access, guildId)) return res.json({ success: false, error: 'Premium required to change ranks.' });

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

    // Post to #roblox-logs if the rank change succeeded
    if (result.success) {
      const auditLogs = await getConfigValue({ db }, guildId, 'auditLogs', {});
      if (auditLogs.robloxChannelId) {
        await sendBotEmbed(auditLogs.robloxChannelId, {
          color: 0x5865F2,
          title: '👑 Rank Changed (Dashboard)',
          fields: [
            { name: 'Roblox User', value: req.body.robloxUsername || `ID ${robloxId}`, inline: true },
            { name: 'New Rank', value: result.newRankName || String(targetRank), inline: true },
            { name: 'Changed By', value: access.user.username, inline: true },
          ],
        }).catch(() => {});
      }
      // Save to rank history (enterprise)
      const histEntry = {
        username: req.body.robloxUsername || `ID ${robloxId}`,
        oldRank: null,
        newRank: result.newRankName || String(targetRank),
        ranker: access.user.username,
        reason: req.body.reason || null,
        ts: Date.now(),
      };
      await pgDb.set(`rank_history:${guildId}:${histEntry.ts}:${Math.random().toString(36).slice(2)}`, histEntry).catch(() => {});
    }

    return res.json(result);
  } catch (err) {
    logger.error('Rank change error:', err);
    return res.json({ success: false, error: 'Unexpected error during rank change.' });
  }
});

// Bulk-fetch group ranks for a list of Roblox user IDs.
// Body: { robloxIds: ['123', '456', ...] }
// Returns: { ranks: { '123': { rankName: 'Member', rankValue: 5 }, ... } }
dashboardAuthRouter.post('/dashboard/server/:guildId/member-ranks', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return res.json({ ranks: {} });
  if (!await checkTier(access, guildId)) return res.json({ ranks: {} });

  const { robloxIds } = req.body;
  if (!Array.isArray(robloxIds) || !robloxIds.length) return res.json({ ranks: {} });

  try {
    const roblox = await getConfigValue({ db }, guildId, 'roblox', {});
    if (!roblox.groupId || !roblox.openCloudKey) return res.json({ ranks: {} });

    // Fetch all group roles once — build a map from role path → { rankName, rankValue }
    const allRoles = await getGroupRoles(roblox.groupId, roblox.openCloudKey);
    const roleByPath = new Map((allRoles || []).map((r) => [r.path, { rankName: r.displayName, rankValue: r.rank }]));

    // Fetch memberships in parallel (cap at 20 to avoid hammering the API)
    const ids = robloxIds.slice(0, 20);
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const m = await getGroupMembership(roblox.groupId, id, roblox.openCloudKey);
          if (!m) return [id, null];
          const role = roleByPath.get(m.role) ?? null;
          return [id, role];
        } catch {
          return [id, null];
        }
      })
    );

    const ranks = Object.fromEntries(results);
    return res.json({ ranks });
  } catch (err) {
    logger.error('member-ranks error:', err);
    return res.json({ ranks: {} });
  }
});

// ── Enterprise: Rank History ──────────────────────────────────────────────────
dashboardAuthRouter.get('/dashboard/server/:guildId/rank-history', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  const sub  = await getSubscription(guildId);
  const tier = isOwner(access.user.id) ? 'enterprise' : getTier(sub);
  if (tier !== 'enterprise') return res.json({ entries: [] });

  try {
    const keys = (await pgDb.list(`rank_history:${guildId}:`)).sort().reverse().slice(0, 200);
    const entries = (await Promise.all(keys.map(k => pgDb.get(k)))).filter(Boolean);
    return res.json({ entries });
  } catch (e) {
    return res.json({ entries: [], error: e.message });
  }
});

// ── Enterprise: Sync Settings ─────────────────────────────────────────────────
dashboardAuthRouter.post('/dashboard/server/:guildId/enterprise/sync-settings', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  const sub  = await getSubscription(guildId);
  const tier = isOwner(access.user.id) ? 'enterprise' : getTier(sub);
  if (tier !== 'enterprise') return res.redirect(`/dashboard/server/${guildId}?error=Enterprise+required`);

  const syncEnabled      = req.body.syncEnabled === '1';
  const syncInterval     = parseInt(req.body.syncInterval) || 24;
  const syncLogChannelId = req.body.syncLogChannelId || null;
  const current = await getConfigValue({ db }, guildId, 'enterprise', {});
  await updateGuildConfig({ db }, guildId, { enterprise: { ...current, syncEnabled, syncInterval, syncLogChannelId } });
  res.redirect(`/dashboard/server/${guildId}?success=Sync+settings+saved#enterprise`);
});

// ── Enterprise: Branding ──────────────────────────────────────────────────────
dashboardAuthRouter.post('/dashboard/server/:guildId/enterprise/branding', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  const sub  = await getSubscription(guildId);
  const tier = isOwner(access.user.id) ? 'enterprise' : getTier(sub);
  if (tier !== 'enterprise') return res.redirect(`/dashboard/server/${guildId}?error=Enterprise+required`);

  const embedColor  = parseInt((req.body.embedColor || '5865F2').replace('#', ''), 16) || 0x5865F2;
  const embedFooter = (req.body.embedFooter || '').trim().slice(0, 100) || null;
  const botNickname = (req.body.botNickname || '').trim().slice(0, 32) || null;
  const current = await getConfigValue({ db }, guildId, 'enterprise', {});
  await updateGuildConfig({ db }, guildId, { enterprise: { ...current, embedColor, embedFooter, botNickname } });

  // Apply bot nickname in the guild
  if (botNickname !== null) {
    const botId = process.env.CLIENT_ID;
    await fetch(`https://discord.com/api/guilds/${guildId}/members/${botId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: botNickname || '' }),
    }).catch(() => {});
  }
  res.redirect(`/dashboard/server/${guildId}?success=Branding+saved#enterprise`);
});

// ── Enterprise: Staff Roles ───────────────────────────────────────────────────
dashboardAuthRouter.post('/dashboard/server/:guildId/enterprise/staff-roles', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  const sub  = await getSubscription(guildId);
  const tier = isOwner(access.user.id) ? 'enterprise' : getTier(sub);
  if (tier !== 'enterprise') return res.json({ success: false });

  const { action, roleId } = req.body;
  const current = await getConfigValue({ db }, guildId, 'enterprise', {});
  let staffRoles = current.staffRoles || [];
  if (action === 'add' && roleId && !staffRoles.includes(roleId)) staffRoles = [...staffRoles, roleId];
  if (action === 'remove') staffRoles = staffRoles.filter(r => r !== roleId);
  await updateGuildConfig({ db }, guildId, { enterprise: { ...current, staffRoles } });
  return res.json({ success: true });
});

// ── Enterprise: Verification Message ─────────────────────────────────────────
dashboardAuthRouter.post('/dashboard/server/:guildId/enterprise/verification-message', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  const sub  = await getSubscription(guildId);
  const tier = isOwner(access.user.id) ? 'enterprise' : getTier(sub);
  if (tier !== 'enterprise') return res.redirect(`/dashboard/server/${guildId}?error=Enterprise+required`);

  const verifyTitle       = (req.body.verifyTitle || '').trim().slice(0, 80) || null;
  const verifyDescription = (req.body.verifyDescription || '').trim().slice(0, 500) || null;
  const current = await getConfigValue({ db }, guildId, 'enterprise', {});
  await updateGuildConfig({ db }, guildId, { enterprise: { ...current, verifyTitle, verifyDescription } });
  res.redirect(`/dashboard/server/${guildId}?success=Verification+message+saved#enterprise`);
});

// ── Enterprise: Member Export CSV ────────────────────────────────────────────
dashboardAuthRouter.get('/dashboard/server/:guildId/export-members', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;
  if (!await checkTier(access, guildId, 'enterprise')) return res.status(403).send('Enterprise required.');

  try {
    const [membersRes, roblox] = await Promise.all([
      fetch(`https://discord.com/api/guilds/${guildId}/members?limit=1000`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } }),
      getConfigValue({ db }, guildId, 'roblox', {}),
    ]);
    const guildMembers  = membersRes.ok ? await membersRes.json() : [];
    const guildMemberMap = new Map(guildMembers.map(m => [m.user.id, m]));
    const allLinkedKeys = await pgDb.list('roblox_link:');
    const rows = (await Promise.all(
      allLinkedKeys.map(async k => {
        const discordId = k.replace('roblox_link:', '');
        const link = await pgDb.get(k);
        if (!link) return null;
        const m = guildMemberMap.get(discordId);
        if (!m) return null;
        return [
          JSON.stringify(m.nick || m.user.username),
          JSON.stringify(m.user.id),
          JSON.stringify(link.robloxUsername || ''),
          JSON.stringify(String(link.robloxId || '')),
        ].join(',');
      })
    )).filter(Boolean);

    const csv = 'Discord Name,Discord ID,Roblox Username,Roblox ID\n' + rows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="phantom-members-${guildId}.csv"`);
    return res.send(csv);
  } catch (e) {
    return res.status(500).send('Export failed.');
  }
});

// ── Messages: Send Embed ──────────────────────────────────────────────────────
dashboardAuthRouter.post('/dashboard/server/:guildId/send-embed', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const { channelId, title, description, color, footer, image, author, pingHere } = req.body;
  if (!channelId) return res.json({ success: false, error: 'No channel selected.' });
  if (!title && !description) return res.json({ success: false, error: 'Add a title or description.' });

  try {
    const embed = { color: color || 0x5865F2, timestamp: new Date().toISOString() };
    if (title)       embed.title       = title;
    if (description) embed.description = description;
    if (footer)      embed.footer      = { text: footer };
    if (image)       embed.image       = { url: image };
    if (author)      embed.author      = { name: author };

    const body = { embeds: [embed] };
    if (pingHere) body.content = '@here';

    const r = await fetch(`https://discord.com/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.text();
      return res.json({ success: false, error: `Discord error: ${err}` });
    }
    return res.json({ success: true });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

// ── Security Config ───────────────────────────────────────────────────────────
dashboardAuthRouter.post('/dashboard/server/:guildId/security/config', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const current = await pgDb.get(`security:${guildId}`) || {};
  const updated = {
    ...current,
    minAccountAgeDays:   parseInt(req.body.minAccountAgeDays)  || 0,
    newAccountAction:    req.body.newAccountAction              || 'none',
    newAccountRoleId:    req.body.newAccountRoleId              || null,
    newAccountLogChannel: req.body.newAccountLogChannel         || null,
    raidProtection:      req.body.raidProtection === '1',
    raidThreshold:       parseInt(req.body.raidThreshold)       || 10,
    raidWindowSeconds:   parseInt(req.body.raidWindowSeconds)   || 30,
    raidAction:          req.body.raidAction                    || 'lockdown',
  };
  await pgDb.set(`security:${guildId}`, updated);
  res.redirect(`/dashboard/server/${guildId}?success=Security+settings+saved#security`);
});


// ── Ticket Settings: Ping Roles (add/remove) ──────────────────────────────────
dashboardAuthRouter.post('/dashboard/server/:guildId/ticket-settings/ping-role', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const { action, roleId } = req.body;
  if (!roleId) return res.status(400).json({ error: 'Missing roleId' });

  const current = await getConfigValue({ db }, guildId, 'ticketSettings', {});
  let pingRoleIds = Array.isArray(current.pingRoleIds) ? [...current.pingRoleIds] : [];

  if (action === 'add') {
    if (!pingRoleIds.includes(roleId) && pingRoleIds.length < 5) {
      pingRoleIds.push(roleId);
    }
  } else if (action === 'remove') {
    pingRoleIds = pingRoleIds.filter(id => id !== roleId);
  }

  await updateGuildConfig({ db }, guildId, { ticketSettings: { ...current, pingRoleIds } });
  return res.json({ ok: true, pingRoleIds });
});

// ── Ticket Settings: Welcome Message ─────────────────────────────────────────
dashboardAuthRouter.post('/dashboard/server/:guildId/ticket-settings/welcome', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const welcomeMessage = (req.body.welcomeMessage || '').trim().slice(0, 500);
  const current = await getConfigValue({ db }, guildId, 'ticketSettings', {});
  await updateGuildConfig({ db }, guildId, { ticketSettings: { ...current, welcomeMessage } });
  res.redirect(`/dashboard/server/${guildId}?success=Welcome+message+saved#tickets`);
});

// ── Ticket Settings: Auto-Reply Toggle (Premium) ──────────────────────────────
dashboardAuthRouter.post('/dashboard/server/:guildId/ticket-settings/auto-reply', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const sub  = await getSubscription(guildId);
  const tier = isOwner(access.user.id) ? 'enterprise' : getTier(sub);
  if (tier !== 'premium' && tier !== 'enterprise') {
    return res.redirect(`/dashboard/server/${guildId}?error=Premium+required#tickets`);
  }

  const raw = req.body.enabled;
  const enabled = Array.isArray(raw) ? raw.includes('true') : raw === 'true';
  const current = await getConfigValue({ db }, guildId, 'ticketSettings', {});
  await updateGuildConfig({ db }, guildId, { ticketSettings: { ...current, autoReplyEnabled: enabled } });
  res.redirect(`/dashboard/server/${guildId}?success=Auto-reply+${enabled?'enabled':'disabled'}#tickets`);
});

// ── Join Requests: Save Settings (log channel + custom format) ────────────────
dashboardAuthRouter.post('/dashboard/server/:guildId/join-requests/settings', async (req, res) => {
  const { guildId } = req.params;
  const access = await requireGuildAccess(req, res, guildId);
  if (!access) return;

  const logChannelId  = req.body.logChannelId  || null;
  const customFormat  = (req.body.customFormat || '').trim() || null;
  const current = await getConfigValue({ db }, guildId, 'joinRequests', {});
  await updateGuildConfig({ db }, guildId, { joinRequests: { ...current, logChannelId, customFormat } });
  res.redirect(`/dashboard/server/${guildId}?success=Join+request+settings+saved#join-requests`);
});
