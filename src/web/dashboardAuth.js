// src/web/dashboardAuth.js
//
// Web dashboard — "Login with Discord" flow.
//   /dashboard/login         -> redirects to Discord's OAuth consent screen
//   /dashboard/auth/callback -> exchanges the code, fetches the user, sets a cookie
//   /dashboard                -> placeholder landing page (shows who's logged in)
//
// More pages (server list, per-server settings) get added to this same
// dashboard area in later steps.

import { Router } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://r2-d2-production.up.railway.app';
const REDIRECT_URI = `${PUBLIC_URL}/dashboard/auth/callback`;

const CLIENT_ID = process.env.DASHBOARD_CLIENT_ID;
const CLIENT_SECRET = process.env.DASHBOARD_CLIENT_SECRET;

export const dashboardAuthRouter = Router();

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

// Step 3 (placeholder for now): show who's logged in.
dashboardAuthRouter.get('/dashboard', async (req, res) => {
  const token = getCookie(req, 'dashboard_token');

  if (!token) {
    return res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 60px; background:#1e1f22; color:#fff;">
          <h1>R2-D2 Dashboard</h1>
          <p>Log in with Discord to manage your server's settings.</p>
          <a href="/dashboard/login" style="display:inline-block; padding:12px 24px; background:#5865F2; color:#fff; border-radius:8px; text-decoration:none; font-weight:bold;">Login with Discord</a>
        </body>
      </html>
    `);
  }

  try {
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!userRes.ok) {
      clearCookie(res, 'dashboard_token');
      return res.redirect('/dashboard');
    }

    const user = await userRes.json();
    const avatarUrl = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;

    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 60px; background:#1e1f22; color:#fff;">
          <h1>R2-D2 Dashboard</h1>
          <img src="${avatarUrl}" width="80" style="border-radius:50%; margin-bottom:16px;" />
          <p>✅ Logged in as <strong>${user.username}</strong></p>
        </body>
      </html>
    `);
  } catch (error) {
    logger.error('Dashboard error:', error);
    res.status(500).send('Something went wrong.');
  }
});
