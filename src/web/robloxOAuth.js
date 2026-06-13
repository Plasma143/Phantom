// src/web/robloxOAuth.js
//
// Adds "Sign in with Roblox" routes onto the bot's existing Express server
// (the one with /health and /ready). Two routes:
//   GET /auth/roblox          -> redirects the user to Roblox's login page
//   GET /auth/roblox/callback -> Roblox sends them back here with a code;
//                                 we exchange it for their identity and save the link.

import express from 'express';
import { randomUUID } from 'crypto';
import { saveRobloxLink } from '../utils/robloxDb.js';
import { logger } from '../utils/logger.js';

const ROBLOX_AUTHORIZE_URL = 'https://apis.roblox.com/oauth/v1/authorize';
const ROBLOX_TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
const ROBLOX_USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';

const CLIENT_ID = process.env.ROBLOX_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.ROBLOX_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = process.env.ROBLOX_OAUTH_REDIRECT_URI || 'https://r2-d2-production.up.railway.app/auth/roblox/callback';

// Tracks in-progress logins: state -> { discordId, createdAt }
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(state);
  }
}

export const robloxOAuthRouter = express.Router();

// Step A: send the user to Roblox's login/consent page.
robloxOAuthRouter.get('/auth/roblox', (req, res) => {
  const discordId = req.query.discordId;
  if (!discordId) {
    return res.status(400).send('Missing discordId.');
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

  res.redirect(`${ROBLOX_AUTHORIZE_URL}?${params.toString()}`);
});

// Step B: Roblox redirects back here with a one-time code.
robloxOAuthRouter.get('/auth/roblox/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Roblox login was cancelled or failed: ${error}`);
  }

  const pending = pendingStates.get(state);
  if (!pending) {
    return res.status(400).send('This login link expired or was already used. Go back to Discord and click the button again.');
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
      return res.status(500).send('Something went wrong talking to Roblox. Please try again from Discord.');
    }

    const tokens = await tokenRes.json();

    const userRes = await fetch(ROBLOX_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userRes.ok) {
      logger.error('Roblox userinfo fetch failed', { status: userRes.status });
      return res.status(500).send('Could not retrieve your Roblox profile. Please try again from Discord.');
    }

    const profile = await userRes.json();
    const robloxUsername = profile.preferred_username || profile.name;

    await saveRobloxLink(pending.discordId, profile.sub, robloxUsername);

    logger.info('Linked Roblox account via OAuth', {
      discordId: pending.discordId,
      robloxId: profile.sub,
      robloxUsername,
    });

    res.send(`
      <html><body style="font-family: sans-serif; text-align: center; padding: 60px;">
        <h1>✅ Linked!</h1>
        <p>Your Discord account is now linked to Roblox account <strong>${robloxUsername}</strong>.</p>
        <p>You can close this tab and head back to Discord.</p>
      </body></html>
    `);
  } catch (err) {
    logger.error('Roblox OAuth callback error', { error: err.message });
    res.status(500).send('Something went wrong. Please try again from Discord.');
  }
});
