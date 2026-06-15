// src/services/ticketAI.js
// Auto-reply for support tickets using keyword-based FAQ matching.
// No API key needed — matches questions against Phantom's knowledge base.

import { getTicketData } from '../utils/database.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { logger } from '../utils/logger.js';

// Staff active tracking — if staff replied recently, bot stays silent
const staffActiveMap = new Map();
const STAFF_SILENCE_DURATION = 10 * 60 * 1000; // 10 minutes

const SKIP_CATEGORIES = ['partnership', 'appeal'];

// ── Knowledge base ────────────────────────────────────────────────────────────
const FAQ = [
  {
    keywords: ['what is phantom', 'what does phantom do', 'who are you', 'what are you', 'about phantom', 'tell me about'],
    answer: `**Phantom** is an all-in-one Discord bot built for Roblox communities.\n\nIt links your Roblox group to your Discord server and handles:\n• Member verification & role sync based on Roblox group rank\n• Rank management from a web dashboard\n• Audit logs, moderation, leveling, economy, tickets, music, and more\n\n**Dashboard:** https://phantom1.up.railway.app/dashboard\n**Invite:** https://discord.com/oauth2/authorize?client_id=1515029322061054063&permissions=8&scope=bot%20applications.commands`,
  },
  {
    keywords: ['features', 'what can', 'capabilities', 'commands', 'what do you offer'],
    answer: `**Phantom's features include:**\n\n🆓 **Free:**\n• Roblox verification & role sync\n• Moderation, economy, leveling, tickets, music, TTS\n• Security & raid protection, event points\n\n💜 **Premium ($7/mo AUD):**\n• Dashboard rank management\n• Auto-rank from promotion logs\n• Audit logs & member tab\n\n👑 **Enterprise ($15/mo AUD):**\n• Multiple Roblox group bindings\n• Bulk ranking, scheduled sync, custom branding\n\nSee full details at: https://phantom1.up.railway.app/dashboard`,
  },
  {
    keywords: ['price', 'pricing', 'cost', 'how much', 'subscription', 'premium', 'enterprise', 'free'],
    answer: `**Phantom Pricing:**\n\n🆓 **Free** — Core features including verification, moderation, economy, leveling, tickets, music\n\n💜 **Premium — $7/month AUD** — Rank management, auto-rank, audit logs, members tab, documents\n\n👑 **Enterprise — $15/month AUD** — Everything in Premium + multiple group bindings, bulk ranking, custom branding\n\nSubscribe via the dashboard: https://phantom1.up.railway.app/dashboard`,
  },
  {
    keywords: ['verify', 'verification', 'link', 'roblox account', 'link account', 'how to verify'],
    answer: `**To verify your Roblox account:**\n\n1. Go to the verification channel in your server\n2. Click the **Verify** button\n3. Follow the instructions to link your Roblox account\n4. Once linked, your Discord roles will update based on your Roblox group rank\n\nIf there's no verification panel, ask a server admin to run \`/verification setup\`.`,
  },
  {
    keywords: ['dashboard', 'panel', 'settings', 'configure', 'setup', 'how to set up'],
    answer: `**Phantom Dashboard:**\n\nAccess it at: https://phantom1.up.railway.app/dashboard\n\n1. Log in with your Discord account\n2. Select your server\n3. Configure features — verification, rank management, audit logs, and more\n\nYou need **Manage Server** permission to access your server's dashboard.`,
  },
  {
    keywords: ['rank', 'promote', 'demote', 'rank management', 'change rank'],
    answer: `**Rank Management** is a **Premium** feature.\n\nWith Premium you can:\n• Look up any linked member and change their Roblox group rank directly from the dashboard\n• Set up Auto-Rank to automatically promote/demote members from promotion logs\n\nUpgrade at: https://phantom1.up.railway.app/dashboard`,
  },
  {
    keywords: ['invite', 'add bot', 'add phantom', 'invite link', 'add to server'],
    answer: `**Invite Phantom to your server:**\nhttps://discord.com/oauth2/authorize?client_id=1515029322061054063&permissions=8&scope=bot%20applications.commands`,
  },
  {
    keywords: ['support', 'help', 'contact', 'staff', 'human', 'talk to someone'],
    answer: `A staff member will be with you shortly to help!\n\nFor general questions, you can also check our support server: https://discord.gg/fYtxnNqGNn`,
  },
  {
    keywords: ['not working', 'broken', 'bug', 'error', 'issue', 'problem', 'fix', "doesn't work", "won't work"],
    answer: `Thanks for reporting this issue! A staff member will review it shortly.\n\nWhile you wait, please provide:\n• What command or feature isn't working\n• Any error messages you see\n• Your server ID (right-click your server icon → Copy Server ID)\n\nThis helps us resolve your issue faster! 🙏`,
  },
  {
    keywords: ['music', 'play', 'song', 'playlist', 'voice'],
    answer: `**Phantom Music** is available on the **Free** plan!\n\n• \`/play <song>\` — Play a song in your voice channel\n• \`/music skip\` — Skip the current song\n• \`/music pause\` / \`/music resume\` — Pause and resume\n• \`/music queue\` — View the queue\n• \`/playlist\` — Create and manage playlists (Premium)`,
  },
  {
    keywords: ['ticket', 'tickets', 'how does ticket', 'ticket system'],
    answer: `**Phantom Ticket System:**\n\n• Members click a button to open a ticket\n• A private channel is created with the ticket details\n• Staff can claim, close, and manage tickets\n• Configure the ticket system in the dashboard under your server settings`,
  },
  {
    keywords: ['audit', 'logs', 'audit log'],
    answer: `**Audit Logs** is a **Premium** feature with 5 sub-tabs:\n• Discord Events\n• Rank Changes\n• Dashboard Actions\n• Join/Leave\n• Moderation\n\nUpgrade at: https://phantom1.up.railway.app/dashboard`,
  },
];

// ── Match message to FAQ ──────────────────────────────────────────────────────
function matchFAQ(text) {
  const lower = text.toLowerCase();
  for (const entry of FAQ) {
    if (entry.keywords.some(kw => lower.includes(kw))) {
      return entry.answer;
    }
  }
  return null;
}

// ── Does this look like a question or request? ────────────────────────────────
function looksLikeQuestion(text) {
  const lower = text.toLowerCase();
  return (
    text.includes('?') ||
    /^(how|what|when|where|why|who|can|does|do|is|are|will|would|could|should|i need|help|not working|broken|issue|problem|error|fix|cant|can't|doesn't|wont|won't|tell me|explain)/.test(lower)
  );
}

// ── Is this message from a staff member? ─────────────────────────────────────
async function isStaff(message) {
  try {
    const member = message.member || await message.guild.members.fetch(message.author.id);
    return member.permissions.has('ManageChannels') || member.permissions.has('ManageGuild');
  } catch {
    return false;
  }
}

// ── Main handler — called from messageCreate ──────────────────────────────────
export async function handleTicketAIReply(message) {
  try {
    if (!message.guild || message.author.bot) return;

    // Check if auto-reply is enabled for this server (Premium feature)
    const config = await getGuildConfig(message.client, message.guildId);
    const ticketSettings = config.ticketSettings || {};
    if (!ticketSettings.autoReplyEnabled) return;

    const ticketData = await getTicketData(message.guildId, message.channelId);
    if (!ticketData || ticketData.status === 'closed') return;

    const category = (ticketData.category || '').toLowerCase();
    if (SKIP_CATEGORIES.some(c => category.includes(c))) return;

    const key = `${message.guildId}:${message.channelId}`;

    // Staff override
    if (await isStaff(message)) {
      staffActiveMap.set(key, Date.now());
      return;
    }

    // Stay silent if staff was recently active
    const lastStaff = staffActiveMap.get(key);
    if (lastStaff && Date.now() - lastStaff < STAFF_SILENCE_DURATION) return;

    const text = message.content?.trim();
    if (!text || text.length < 3) return;
    if (!looksLikeQuestion(text)) return;

    // Match against FAQ
    const reply = matchFAQ(text);
    if (!reply) return;

    // Small delay so it doesn't feel instant/robotic
    await new Promise(r => setTimeout(r, 1200));

    await message.channel.send(
      `${reply}\n\n*— Phantom Support Bot | A staff member will follow up if you need further assistance.*`
    );

  } catch (err) {
    logger.error('[TicketAI] Error:', err.message);
  }
}
