// src/services/promotionParser.js
//
// Pattern-based promotion log parser — no AI, no API calls, no cost.
// Parses any promotion log format by looking for common field labels.
//
// Returns: { username, newRank, reason, ranker } on success
//          { error: '...' } if the message isn't a valid promotion log

import { logger } from '../utils/logger.js';

/**
 * Parse a promotion log message.
 * If customFormat is provided (the template saved in the dashboard),
 * we use that to know exactly which label precedes each field.
 * Otherwise we fall back to generic pattern matching.
 */
export function parsePromotionLog(messageContent, customFormat = null) {
  if (!messageContent?.trim()) return { error: 'Empty message' };

  // Strip Discord bold/italic markers and clean up
  const clean = messageContent.replace(/\*\*/g, '').replace(/\*/g, '').trim();
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);

  // Try template-based parsing first (exact label matching from dashboard format)
  if (customFormat) {
    const result = parseWithTemplate(clean, customFormat);
    if (result.username && result.newRank) {
      logger.debug('[promotionParser] Parsed via template');
      return result;
    }
  }

  // Fall back to generic pattern matching
  const result = parseGeneric(lines);
  if (result.username && result.newRank) {
    logger.debug('[promotionParser] Parsed via generic patterns');
    return result;
  }

  return { error: 'Could not identify username or new rank' };
}

// ---- Template-based parsing ----
// Reads the field labels straight from the dashboard's custom format string
// e.g. "**Ranked by:** {ranker}\n**User:** {username}\n**New Rank:** {newRank}"
// becomes: look for "Ranked by:" → capture ranker, "User:" → capture username, etc.

function parseWithTemplate(content, template) {
  const cleanTemplate = template.replace(/\*\*/g, '').replace(/\*/g, '');
  const result = {};

  for (const variable of ['username', 'newRank', 'reason', 'ranker']) {
    const placeholder = `{${variable}}`;
    const idx = cleanTemplate.indexOf(placeholder);
    if (idx === -1) continue;

    // Get the label: everything on the same line before the placeholder
    const lineStart = cleanTemplate.lastIndexOf('\n', idx) + 1;
    const label = cleanTemplate.slice(lineStart, idx).trim();
    if (!label) continue;

    // Find that label in the actual message and grab what comes after it
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = content.match(new RegExp(escaped + '\\s*(.+)', 'i'));
    if (match) result[variable] = match[1].trim();
  }

  return result;
}

// ---- Generic pattern matching ----
// Handles all common promotion log formats without AI

function parseGeneric(lines) {
  const result = {};
  const fullText = lines.join('\n');
  const hasNewRankLine = lines.some((l) => /^new\s*rank[\s:]/i.test(l));

  for (const line of lines) {
    // ── Username ──
    // "Person ranked:", "Username:", "User:", "Promoted:", "Member:", "Rank:" (only if "New Rank:" also exists)
    if (!result.username) {
      const m =
        line.match(/^(?:person\s*ranked|username|user|promoted|member)[\s:]+(.+)/i) ||
        (hasNewRankLine && line.match(/^(?:rank)[\s:]+(.+)/i));
      if (m) {
        // Strip @mentions and pipe-separated prefixes — take the last clean token
        result.username = m[1]
          .replace(/^.*\|\s*/, '')  // "JG | darth_killerGRW" → "darth_killerGRW"
          .replace(/^@/, '')         // "@Username" → "Username"
          .trim();
      }
    }

    // ── New rank ──
    // "New Rank:", "To:", or arrow formats "FS -> Elder" / "FS → Elder"
    if (!result.newRank) {
      const m =
        line.match(/^(?:new\s*rank|to)[\s:]+(.+)/i) ||
        line.match(/(?:→|->|=>)\s*(.+)/);        // arrow notation
      if (m) result.newRank = m[1].trim();
    }

    // ── Reason ──
    if (!result.reason) {
      const m = line.match(/^reason[\s:]+(.+)/i);
      if (m) result.reason = m[1].trim();
    }

    // ── Ranker ──
    if (!result.ranker) {
      const m = line.match(/^(?:ranked\s*by|by|promoter|ranker)[\s:]+(.+)/i);
      if (m) result.ranker = m[1].replace(/^@/, '').trim();
    }
  }

  // Handle "Rank: OldRank -> NewRank" on a single line (e.g. "Rank: FS -> Elder")
  if (!result.newRank) {
    const arrowLine = lines.find((l) => /(?:→|->|=>)/.test(l));
    if (arrowLine) {
      const m = arrowLine.match(/(?:→|->|=>)\s*(.+)/);
      if (m) result.newRank = m[1].trim();
    }
  }

  return result;
}

// Apply a custom format template, substituting variables.
// Variables: {username} {newRank} {reason} {ranker}
export function applyFormat(template, vars) {
  return template
    .replace(/\{username\}/gi, vars.username || 'Unknown')
    .replace(/\{oldRank\}/gi,  vars.oldRank  || 'N/A')
    .replace(/\{newRank\}/gi,  vars.newRank  || 'Unknown')
    .replace(/\{reason\}/gi,   vars.reason   || 'No reason given')
    .replace(/\{ranker\}/gi,   vars.ranker   || 'Unknown');
}

export const DEFAULT_LOG_FORMAT =
  '👑 **Promotion**\n' +
  '**User:** {username}\n' +
  '**New Rank:** {newRank}\n' +
  '**Reason:** {reason}\n' +
  '**Ranked by:** {ranker}';

export const ACCEPT_LOG_FORMAT =
  '✅ **Group Acceptance**\n' +
  '**User:** {username}\n' +
  '**From:** {oldRank}\n' +
  '**To:** {newRank}\n' +
  '**Reason:** {reason}\n' +
  '**Accepted by:** {ranker}';
