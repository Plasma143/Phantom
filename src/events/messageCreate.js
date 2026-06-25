// src/events/messageCreate.js
// Conversational AI — DM Phantom or mention it to chat naturally
// Replaces the rigid /lua command with natural back-and-forth conversation

import { EmbedBuilder } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { getEffectiveTier } from '../web/stripePayments.js';
import { logger } from '../utils/logger.js';

// ── Conversation history (in-memory, per user) ────────────────────
// Keeps the last 16 messages (8 back-and-forth exchanges) per user
const histories = new Map();
const MAX_PAIRS = 8;

function getHistory(userId) {
  return histories.get(userId) || [];
}

function pushHistory(userId, role, content) {
  const h = getHistory(userId);
  h.push({ role, content });
  // Trim to last MAX_PAIRS * 2 messages
  if (h.length > MAX_PAIRS * 2) h.splice(0, h.length - MAX_PAIRS * 2);
  histories.set(userId, h);
}

function clearHistory(userId) {
  histories.delete(userId);
}

// ── Usage tracking ─────────────────────────────────────────────────
const TIER_LIMITS = {
  'developer-basic':  200,
  'developer-pro':    800,
  'developer-elite':  1500,
  'enterprise':       9999,
  'premium':          50,
  'free':             15,
};

function usageKey(userId) {
  return `chat_usage:${userId}:${new Date().toISOString().slice(0, 7)}`;
}

async function getUsage(userId) {
  return (await getFromDb(usageKey(userId), 0)) || 0;
}

async function incrementUsage(userId) {
  const current = await getUsage(userId);
  await setInDb(usageKey(userId), current + 1);
  return current + 1;
}

// ── Claude call ───────────────────────────────────────────────────
async function callClaude(messages, guildContext) {
  const systemPrompt = `You are Phantom, an AI assistant built into Phantom Bot — a commercial Discord bot for Roblox group management made by Phantom Studios (phantombot.org).

You have deep expertise in:
- Roblox Lua scripting and game development (scripts, LocalScripts, RemoteEvents, services, UI, datastores, physics)
- Roblox Studio workflows, plugins, and best practices
- Discord bot configuration and Phantom Bot's features (verification, rank sync, tickets, dashboards, economy, suggestions, etc.)
- General programming concepts as they apply to Roblox/Lua

How you communicate:
- Natural, conversational tone — like a knowledgeable friend, not a formal assistant
- Be direct and practical. Skip unnecessary preamble.
- When writing code, always use \`\`\`lua code blocks and explain what it does and why
- If a question is ambiguous, ask one focused follow-up rather than guessing
- Point out bugs, edge cases, and gotchas proactively
- Keep responses focused — don't pad with unnecessary text
${guildContext ? `\nServer context: ${guildContext}` : ''}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages,
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || 'No response received.';
}

// ── Send response (handles splitting) ────────────────────────────
async function sendReply(message, text) {
  const MAX = 1900;
  if (text.length <= MAX) {
    return message.reply({ content: text, allowedMentions: { repliedUser: false } });
  }
  // Split on newlines where possible
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > MAX) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await message.reply({ content: chunks[i], allowedMentions: { repliedUser: false } });
    } else {
      await message.channel.send(chunks[i]);
    }
  }
}

// ── Main handler ──────────────────────────────────────────────────
export default {
  name: 'messageCreate',
  async execute(message, config, client) {
    // Ignore bots and system messages
    if (message.author.bot || message.system) return;

    const isDM      = !message.guild;
    const isMention = message.mentions.has(client.user);

    // Only respond to DMs or direct mentions
    if (!isDM && !isMention) return;

    // Strip mention prefix and trim
    let content = message.content
      .replace(/<@!?[0-9]+>/g, '')
      .trim();

    const userId  = message.author.id;
    const guildId = message.guild?.id || null;

    // ── Special commands ───────────────────────────────────────────
    const lower = content.toLowerCase();

    if (!content || lower === 'hi' || lower === 'hey' || lower === 'hello') {
      const used  = await getUsage(userId);
      const tier  = await getEffectiveTier(userId, guildId);
      const limit = TIER_LIMITS[tier] || TIER_LIMITS['free'];
      return message.reply({
        content: `Hey! I'm Phantom — ask me anything about Roblox development, Lua scripting, or your server setup. You've used **${used}/${limit}** messages this month.\n\nType \`reset\` to clear our conversation history.`,
        allowedMentions: { repliedUser: false },
      });
    }

    if (lower === 'reset' || lower === 'clear') {
      clearHistory(userId);
      return message.reply({ content: 'Conversation cleared — fresh start!', allowedMentions: { repliedUser: false } });
    }

    if (lower === 'usage') {
      const used  = await getUsage(userId);
      const tier  = await getEffectiveTier(userId, guildId);
      const limit = TIER_LIMITS[tier] || TIER_LIMITS['free'];
      return message.reply({
        content: `**${used}/${limit}** chat messages used this month (${tier} tier). Resets on the 1st.`,
        allowedMentions: { repliedUser: false },
      });
    }

    // ── Tier & usage check ─────────────────────────────────────────
    const tier  = await getEffectiveTier(userId, guildId);
    const limit = TIER_LIMITS[tier] || TIER_LIMITS['free'];
    const used  = await getUsage(userId);

    if (used >= limit) {
      const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle('Monthly limit reached')
        .setDescription(
          tier === 'free'
            ? `Free users get **${TIER_LIMITS['free']} messages/month**.\nUpgrade at **phantombot.org/dashboard** for more.`
            : `You've used all **${limit}** messages this month. Resets on the 1st.`
        )
        .setFooter({ text: 'Phantom Studios · phantombot.org' });
      return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    }

    // ── Send typing indicator ──────────────────────────────────────
    await message.channel.sendTyping();

    // Keep typing alive for long responses
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);

    // ── Build context ──────────────────────────────────────────────
    let guildContext = null;
    if (message.guild) {
      guildContext = `Server: "${message.guild.name}" (${message.guild.memberCount} members)`;
    }

    // ── Call Claude ────────────────────────────────────────────────
    try {
      const history  = getHistory(userId);
      const messages = [...history, { role: 'user', content }];

      const reply = await callClaude(messages, guildContext);

      clearInterval(typingInterval);

      // Save to history
      pushHistory(userId, 'user', content);
      pushHistory(userId, 'assistant', reply);

      // Track usage
      const newUsed = await incrementUsage(userId);

      await sendReply(message, reply);

      logger.info(`[Chat] ${message.author.tag} — ${newUsed}/${limit} (${tier})`);
    } catch (err) {
      clearInterval(typingInterval);
      logger.error('[Chat] Error:', err.message);
      await message.reply({
        content: `Something went wrong: \`${err.message}\``,
        allowedMentions: { repliedUser: false },
      });
    }
  },
};
