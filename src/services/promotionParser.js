// src/services/promotionParser.js
//
// Uses Claude to extract promotion information from ANY log format.
// Works on plain text, embeds converted to text, custom formats — anything.
//
// Returns: { username, newRank, reason, ranker } on success
//          { error: '...' } if the message isn't a valid promotion log

import { logger } from '../utils/logger.js';

const SYSTEM_PROMPT = `You extract Roblox group promotion information from log messages.
Your job is to identify:
1. The Roblox username of the person BEING promoted (not the person doing the ranking)
2. Their NEW rank (not their old rank — if both old and new are shown, pick the new one)
3. The reason for the promotion (if mentioned)
4. The name of the person who did the ranking (if mentioned)

Return ONLY valid JSON. No extra text, no markdown, no explanation.`;

const USER_PROMPT = (content) => `Extract promotion info from this log message.

Return exactly one of these:
{"username": "RobloxUsername", "newRank": "New Rank Name", "reason": "reason text or null", "ranker": "ranker name or null"}
{"error": "brief reason this is not a valid promotion log"}

Examples of valid promotion logs:
- "Username: @JG | darth_killerGRW\\nPerson ranked: SamTrunGRW\\nFrom: staff sergeant\\nTo: master sergeant\\nReason: attended SSU" → username: SamTrunGRW, newRank: master sergeant
- "Promoted: Aspect\\nRank: FS -> Elder\\nReason: Retired" → username: Aspect, newRank: Elder
- "Username: @daboss\\nPrevious Rank: Force Sensitive\\nNew rank: Jedi Sentinel\\nReason: Handpicked" → username: daboss (or whoever is listed as the one being promoted), newRank: Jedi Sentinel

The message to parse:
${content}`;

export async function parsePromotionLog(messageContent) {
  if (!messageContent || messageContent.trim().length < 5) {
    return { error: 'Message too short' };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: USER_PROMPT(messageContent) }],
      }),
    });

    if (!response.ok) {
      logger.error('promotionParser: Claude API error', response.status);
      return { error: `API error ${response.status}` };
    }

    const data = await response.json();
    const text = data.content?.[0]?.text?.trim() || '';

    const parsed = JSON.parse(text);
    return parsed;
  } catch (err) {
    logger.error('promotionParser: parse failed', err.message);
    return { error: `Parse failed: ${err.message}` };
  }
}

// Apply a custom format template string, substituting variables.
// Variables: {username} {newRank} {reason} {ranker}
export function applyFormat(template, vars) {
  return template
    .replace(/\{username\}/gi, vars.username || 'Unknown')
    .replace(/\{newRank\}/gi, vars.newRank || 'Unknown')
    .replace(/\{reason\}/gi, vars.reason || 'No reason given')
    .replace(/\{ranker\}/gi, vars.ranker || 'Unknown');
}

export const DEFAULT_LOG_FORMAT =
  '👑 **Promotion**\n' +
  '**User:** {username}\n' +
  '**New Rank:** {newRank}\n' +
  '**Reason:** {reason}\n' +
  '**Ranked by:** {ranker}';
