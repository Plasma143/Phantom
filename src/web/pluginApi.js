// src/web/pluginApi.js
// REST endpoints consumed by the Roblox Studio plugin
//   POST /api/plugin/analyse   — scan scripts for issues
//   POST /api/plugin/write     — write a Lua script from description
//   POST /api/plugin/fix       — fix an error in a script
//   POST /api/plugin/verify    — verify game ownership (called on plugin init)

import { Router } from 'express';
import { db } from '../utils/database.js';
import { pgDb } from '../utils/postgresDatabase.js';
import { logger } from '../utils/logger.js';

export const pluginRouter = Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── Tier request limits ───────────────────────────────────────────────────────
const TIER_LIMITS = {
  'developer-pro':   800,
  'developer-elite': 1500,
  'enterprise':      9999,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveApiKey(key) {
  if (!key) return null;
  try {
    return await db.get(`plugin_api_key:${key}`);
  } catch { return null; }
}

async function getPluginUsage(userId) {
  const k = `plugin_usage:${userId}:${new Date().toISOString().slice(0, 7)}`;
  return (await db.get(k, 0)) || 0;
}

async function incrementPluginUsage(userId) {
  const k = `plugin_usage:${userId}:${new Date().toISOString().slice(0, 7)}`;
  const current = await getPluginUsage(userId);
  await db.set(k, current + 1);
  return current + 1;
}

async function callClaude(systemPrompt, userMessage) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || 'No response received.';
}

async function verifyGameOwnership(universeId, robloxId) {
  try {
    const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
    if (!res.ok) return { owned: false, error: 'Could not verify game ownership.' };
    const data = await res.json();
    const game = data?.data?.[0];
    if (!game) return { owned: false, error: 'Game not found.' };
    const isOwner = String(game.creator?.id) === String(robloxId) && game.creator?.type === 'User';
    return { owned: isOwner, gameName: game.name, creatorId: game.creator?.id };
  } catch (e) {
    return { owned: false, error: e.message };
  }
}

// ── Middleware: validate API key + tier ───────────────────────────────────────
async function requirePluginAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing API key.' });

  const record = await resolveApiKey(key);
  if (!record) return res.status(401).json({ error: 'Invalid API key.' });

  const tier = record.tier;
  if (!TIER_LIMITS[tier]) {
    return res.status(403).json({ error: 'Developer Pro or higher required for Studio plugin.' });
  }

  const used = await getPluginUsage(record.userId);
  const limit = TIER_LIMITS[tier];
  if (used >= limit) {
    return res.status(429).json({ error: `Monthly request limit reached (${limit}). Resets on the 1st.` });
  }

  req.pluginUserId = record.userId;
  req.pluginTier   = tier;
  req.pluginLimit  = limit;
  req.pluginUsed   = used;
  next();
}

// ── POST /api/plugin/verify ───────────────────────────────────────────────────
// Called by the plugin on init to verify the API key and game ownership
pluginRouter.post('/verify', async (req, res) => {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing API key.' });

  const record = await resolveApiKey(key);
  if (!record) return res.status(401).json({ error: 'Invalid API key.' });

  const { universeId } = req.body;
  if (!universeId) return res.status(400).json({ error: 'Missing universeId.' });

  // Get linked Roblox account
  let robloxId = null;
  try {
    const link = await pgDb.get(`roblox_link:${record.userId}`);
    if (link) robloxId = link.robloxId;
  } catch {}

  if (!robloxId) {
    return res.status(403).json({ error: 'No linked Roblox account. Use /linkroblox in Discord first.' });
  }

  const ownership = await verifyGameOwnership(universeId, robloxId);
  if (!ownership.owned) {
    return res.status(403).json({ error: `You must own this game to use Phantom Studio. ${ownership.error || ''}`.trim() });
  }

  const tier = record.tier;
  const limit = TIER_LIMITS[tier] || 0;
  const used = await getPluginUsage(record.userId);

  return res.json({
    success: true,
    gameName: ownership.gameName,
    tier,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  });
});

// ── POST /api/plugin/analyse ──────────────────────────────────────────────────
pluginRouter.post('/analyse', requirePluginAuth, async (req, res) => {
  const { scripts } = req.body;
  if (!scripts || !Array.isArray(scripts) || scripts.length === 0) {
    return res.status(400).json({ error: 'No scripts provided.' });
  }

  const scriptText = scripts.map((s, i) =>
    `--- Script ${i + 1}: ${s.name || 'Unnamed'} (${s.type || 'Script'}) ---\n${s.source}`
  ).join('\n\n');

  const systemPrompt = `You are Phantom, an expert Roblox Lua developer assistant integrated into Roblox Studio. 
Analyse the provided scripts for bugs, errors, bad practices, performance issues, and security vulnerabilities.
For each issue found:
1. State which script and approximately which line
2. Explain what the problem is clearly
3. Show the fix with corrected code in \`\`\`lua blocks
Be thorough but concise. If a script is clean, say so. Format issues clearly so developers can act on them immediately.`;

  try {
    const result = await callClaude(systemPrompt, `Please analyse these scripts:\n\n${scriptText}`);
    const newUsed = await incrementPluginUsage(req.pluginUserId);
    logger.info(`[Plugin] ${req.pluginUserId} used analyse — ${newUsed}/${req.pluginLimit}`);
    return res.json({ success: true, result, remaining: req.pluginLimit - newUsed });
  } catch (e) {
    logger.error('[Plugin] analyse error:', e.message);
    return res.status(500).json({ error: `AI error: ${e.message}` });
  }
});

// ── POST /api/plugin/write ────────────────────────────────────────────────────
pluginRouter.post('/write', requirePluginAuth, async (req, res) => {
  const { description, scriptType } = req.body;
  if (!description) return res.status(400).json({ error: 'No description provided.' });

  const systemPrompt = `You are Phantom, an expert Roblox Lua developer assistant integrated into Roblox Studio.
Write clean, well-commented Roblox Lua scripts based on descriptions. 
Use modern Roblox API practices. Specify whether the code should go in a Script, LocalScript, or ModuleScript.
Format all code in \`\`\`lua code blocks. Explain briefly what the script does before the code.
Script type requested: ${scriptType || 'auto-detect'}.`;

  try {
    const result = await callClaude(systemPrompt, description);
    const newUsed = await incrementPluginUsage(req.pluginUserId);
    logger.info(`[Plugin] ${req.pluginUserId} used write — ${newUsed}/${req.pluginLimit}`);
    return res.json({ success: true, result, remaining: req.pluginLimit - newUsed });
  } catch (e) {
    logger.error('[Plugin] write error:', e.message);
    return res.status(500).json({ error: `AI error: ${e.message}` });
  }
});

// ── POST /api/plugin/fix ──────────────────────────────────────────────────────
pluginRouter.post('/fix', requirePluginAuth, async (req, res) => {
  const { error, script, scriptName } = req.body;
  if (!error) return res.status(400).json({ error: 'No error message provided.' });

  const systemPrompt = `You are Phantom, an expert Roblox Lua developer assistant integrated into Roblox Studio.
Fix Lua errors clearly and accurately. Always:
1. Explain what caused the error in simple terms
2. Show the exact fix with corrected code in \`\`\`lua blocks
3. If the fix changes multiple areas, highlight each change
Be concise but thorough.`;

  const userMessage = `Error in ${scriptName || 'script'}:\n${error}${script ? `\n\nScript:\n${script}` : ''}`;

  try {
    const result = await callClaude(systemPrompt, userMessage);
    const newUsed = await incrementPluginUsage(req.pluginUserId);
    logger.info(`[Plugin] ${req.pluginUserId} used fix — ${newUsed}/${req.pluginLimit}`);
    return res.json({ success: true, result, remaining: req.pluginLimit - newUsed });
  } catch (e) {
    logger.error('[Plugin] fix error:', e.message);
    return res.status(500).json({ error: `AI error: ${e.message}` });
  }
});
