// src/web/server.js
//
// Tiny built-in HTTP server (no Express needed) for "Sign in with Roblox".
// Two routes:
//   GET /auth/roblox          -> redirects the user to Roblox's login page
//   GET /auth/roblox/callback -> Roblox sends them back here with a code;
//                                 we exchange it for their identity and save the link.

import { createServer } from 'http';
import { URL } from 'url';
import { randomUUID } from 'crypto';
import { saveRobloxLink } from '../utils/robloxDb.js';
import { logger } from '../utils/logger.js';

const ROBLOX_AUTHORIZE_URL = 'https://apis.roblox.com/oauth/v1/authorize';
const ROBLOX_TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
const ROBLOX_USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';

const CLIENT_ID = process.env.ROBLOX_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.ROBLOX_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = process.env.ROBLOX_OAUTH_REDIRECT_URI || 'http://localhost:3000/auth/roblox/callback';

// Tracks in-progress logins: state -> { discordId, createdAt }
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(state);
  }
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(html);
}

// Step A: send the user to Roblox's login/consent page.
function handleStart(req, res, url) {
  const discordId = url.searchParams.get('discordId');
  if (!discordId) {
    return sendHtml(res, 400, '<p>Missing discordId.</p>');
  }

  cleanupExpiredStates();
  const state = randomUUID();
  pendingStates.set(state, { discordId, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile',
    response_type: 'code',
    state,
  });

  res.writeHead(302, { Location: `${ROBLOX_AUTHORIZE_URL}?${params.toString()}` });
  res.end();
}

// Step B: Roblox redirects back here with a one-time code.
async function handleCallback(req, res, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return sendHtml(res, 400, `<p>Roblox login was cancelled or failed: ${error}</p>`);
  }

  const pending = pendingStates.get(state);
  if (!pending) {
    return sendHtml(res, 400, '<p>This login link expired or was already used. Go back to Discord and click the button again.</p>');
  }
  pendingStates.delete(state);

  try {
    const tokenRes = await fetch(ROBLOX_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      logger.error('Roblox token exchange failed', { status: tokenRes.status, body: await tokenRes.text() });
      return sendHtml(res, 500, '<p>Something went wrong talking to Roblox. Please try again from Discord.</p>');
    }

    const tokens = await tokenRes.json();

    const userRes = await fetch(ROBLOX_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userRes.ok) {
      logger.error('Roblox userinfo fetch failed', { status: userRes.status });
      return sendHtml(res, 500, '<p>Could not retrieve your Roblox profile. Please try again from Discord.</p>');
    }

    const profile = await userRes.json();
    const robloxUsername = profile.preferred_username || profile.name;

    await saveRobloxLink(pending.discordId, profile.sub, robloxUsername);

    logger.info('Linked Roblox account via OAuth', {
      discordId: pending.discordId,
      robloxId: profile.sub,
      robloxUsername,
    });

    sendHtml(res, 200, `
      <html><body style="font-family: sans-serif; text-align: center; padding: 60px;">
        <h1>✅ Linked!</h1>
        <p>Your Discord account is now linked to Roblox account <strong>${robloxUsername}</strong>.</p>
        <p>You can close this tab and head back to Discord.</p>
      </body></html>
    `);
  } catch (err) {
    logger.error('Roblox OAuth callback error', { error: err.message });
    sendHtml(res, 500, '<p>Something went wrong. Please try again from Discord.</p>');
  }
}

export function startWebServer() {
  const port = process.env.PORT || 3000;

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/auth/roblox') return handleStart(req, res, url);
    if (url.pathname === '/auth/roblox/callback') return handleCallback(req, res, url);

    sendHtml(res, 404, '<p>Not found.</p>');
  });

  server.listen(port, () => {
    logger.info(`Web server listening on port ${port}`);
  });

  return server;
}
