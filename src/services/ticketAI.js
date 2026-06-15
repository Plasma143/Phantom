// src/services/ticketAI.js
// AI-powered auto-reply for support tickets using Claude.
// Replies to user questions in ticket channels with accurate Phantom knowledge.
// Respects staff override — if staff has replied recently, bot stays silent.

import { getTicketData } from '../utils/database.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { logger } from '../utils/logger.js';

// Track which tickets staff has recently been active in
// guildId:channelId → timestamp of last staff message
const staffActiveMap = new Map();
const STAFF_SILENCE_DURATION = 10 * 60 * 1000; // 10 minutes

// Skip auto-reply for these ticket categories — staff always handles them
const SKIP_CATEGORIES = ['partnership', 'appeal'];

// ── Phantom knowledge base for Claude ────────────────────────────────────────
const PHANTOM_SYSTEM_PROMPT = `You are Phantom Support — the AI assistant inside Phantom Bot's ticket system.
Phantom is a Discord bot built for Roblox group management. You answer support questions accurately and concisely.
Only answer questions about Phantom. For anything unrelated, politely redirect the user.
Never make up features or details that are not listed below. If you don't know, say so and tell them staff will follow up.

== PHANTOM BOT — COMPLETE KNOWLEDGE BASE ==

WHAT IS PHANTOM:
Phantom is an all-in-one Discord bot for Roblox communities. It links Roblox groups to Discord servers, handles member verification, rank management, and includes a web dashboard for configuration.

INVITE LINK:
https://discord.com/oauth2/authorize?client_id=1515029322061054063&permissions=8&scope=bot%20applications.commands

DASHBOARD:
phantom1.up.railway.app/dashboard — Log in with Discord to manage your server's settings.

SUPPORT SERVER:
discord.gg/fYtxnNqGNn

--- PRICING ---

FREE (no cost):
- Roblox Group Setup (connect group ID and Open Cloud API key)
- Verification panel (members link Roblox account and get Discord roles based on group rank)
- Join Requests (manually accept or decline Roblox group join requests from the dashboard)
- Music playback in voice channels
- Moderation commands (warn, kick, ban, mute, timeout)
- Economy system (coin balance, rewards, transfers)
- Leveling system (XP, levels, rank rewards)
- Ticket system (support tickets with categories, staff roles, claim/close/delete)
- TTS (bot joins VC and reads text channel messages aloud for members without a mic)
- Security (new account protection with minimum age + kick/ban, raid detection with auto-lockdown)
- Event Points (EP system with leaderboard, manager role, weekly reset, auto-punishment)
- All slash commands

PREMIUM ($7/mo AUD):
Everything in Free, plus:
- Rank Management — promote or demote Roblox group members directly from the dashboard
- Auto-Rank from Promotion Logs — Phantom watches a channel for promotion logs and automatically applies ranks on Roblox. Uses AI to read any format — no templates needed
- Audit Logs — 5 sub-tabs: Discord Events, Rank Changes, Dashboard Actions, Join/Leave, Moderation
- Members Tab — view all Discord members with their live Roblox group rank
- Documents — store and manage documents inside the dashboard
- Music Playlists — save up to 5 playlists with 50 songs each
- Auto-accept join requests — members who verify are automatically accepted into the Roblox group

ENTERPRISE ($15/mo AUD):
Everything in Premium, plus:
- Rank History — complete log of every rank change made through Phantom
- Bulk Ranking — select multiple members and rank them all at once from the dashboard
- Member Export — export full member list with Roblox ranks as a CSV file
- Scheduled Rank Sync — auto-sync group ranks to Discord roles on a schedule (6h/12h/daily/weekly)
- Custom Embed Branding — set a custom embed colour, footer, and bot nickname per server
- Custom Verification Message — personalise the verification panel title and description
- Dashboard Staff Roles — grant specific Discord roles access to your server's Phantom dashboard
- Music Playlists — expanded to 10 playlists

DISCOUNTS:
- 1 boost in the Phantom support server (discord.gg/fYtxnNqGNn) = 10% off
- 2 boosts = 20% off
Discounts apply to Premium and Enterprise subscriptions.

PAYMENTS:
Phantom uses Stripe for secure payment processing. Subscriptions are billed monthly in AUD. You can upgrade, downgrade, or cancel at any time through the dashboard.

--- SETUP GUIDE ---

BASIC SETUP:
1. Invite Phantom to your server using the invite link above
2. Go to the dashboard at phantom1.up.railway.app/dashboard
3. Select your server
4. Go to Group Setup — enter your Roblox Group ID and your Open Cloud API key
5. Go to Verification — create the verification panel and set the verified role
6. Members can now click the button to link their Roblox account and receive their Discord role

GETTING AN OPEN CLOUD API KEY:
1. Go to create.roblox.com/dashboard/credentials
2. Click Create API Key
3. Give it a name (e.g. Phantom Ranking)
4. Add your group under the Permissions section with the required permissions (Group: read + write)
5. Copy the full key and paste it into the Group Setup tab in your Phantom dashboard
6. The key is only shown once — if you lose it, delete it and create a new one

AUTO-RANK SETUP (Premium):
1. Go to Rank Management in the dashboard
2. Enable auto-ranking
3. Set the Watch Channel (where rankers post promotion logs)
4. Set the Confirmation Log Channel (where Phantom posts confirmations)
5. Optionally set a custom log format using variables: {username}, {newRank}, {reason}, {ranker}
6. Phantom uses AI to read any format — the format is just a preferred template for your rankers

VERIFICATION SETUP:
1. Go to Verification in the dashboard
2. Set the verified role and any rank-specific roles
3. Post the verification panel using the button in the dashboard
4. Members click the button, link their Roblox account, and receive their role instantly

JOIN REQUESTS:
- Free: manually accept or decline from the Join Requests tab in the dashboard
- Premium: members who verify are automatically accepted into the Roblox group

TTS SETUP:
1. Join a voice channel
2. Type /tts join in the text channel you want to read from
3. Any messages typed in that channel are read aloud in the VC
4. Type /tts leave to stop

SECURITY SETUP:
- Go to Security in the dashboard
- Set minimum account age (recommended: 7 days) and action (kick)
- Enable raid protection with a threshold (recommended: 8 joins in 20 seconds → Lock server)

--- DASHBOARD TABS ---
Overview, Group Setup, Rank Management, Audit Logs, Members, Documents, Verification, Join Requests, Rank History (Enterprise), Enterprise, Messages (embed builder), Security

--- COMMON QUESTIONS ---

Q: Can I use one Open Cloud API key for multiple groups?
A: Yes, as long as the key has permissions added for each group you want to manage.

Q: Does Phantom work for multiple Discord servers?
A: Yes. Each Discord server has its own separate configuration and subscription.

Q: What happens if I cancel my Premium/Enterprise subscription?
A: Your server reverts to the Free tier. Premium and Enterprise features will no longer function but your configuration is saved.

Q: Can staff access the dashboard without being a Discord server admin?
A: Yes, with Enterprise. You can add specific Discord roles as Dashboard Staff Roles so they can access the dashboard without needing admin permissions.

Q: Does Auto-Rank work with any promotion log format?
A: Yes. Phantom uses AI to read any format. You can optionally set a preferred format to share with your rankers, but Phantom will read logs regardless.

Q: What is the bot's support server?
A: discord.gg/fYtxnNqGNn

Q: How do I upgrade to Premium or Enterprise?
A: Log in to the dashboard at phantom1.up.railway.app/dashboard, select your server, and click Upgrade in the Overview tab.

== END OF KNOWLEDGE BASE ==

Reply in a helpful, professional, and concise tone. Use Discord markdown (bold, bullet points) where it helps readability.
End every reply with: "_A staff member will follow up if you need further assistance._"
Never exceed 400 words per reply.`;

// ── Check if a message author is staff ───────────────────────────────────────
async function isStaff(message) {
  const member = message.member;
  if (!member) return false;
  if (member.permissions.has('ManageChannels')) return true;
  try {
    const config = await getGuildConfig(message.client, message.guildId);
    const staffRoleId = config.ticketStaffRoleId;
    if (staffRoleId && member.roles.cache.has(staffRoleId)) return true;
  } catch {}
  return false;
}

// ── Main handler — call from messageCreate ────────────────────────────────────
export async function handleTicketAIReply(message) {
  if (!message.guild || message.author.bot) return;

  try {
    // Is this a ticket channel?
    const ticketData = await getTicketData(message.guildId, message.channelId);
    if (!ticketData || ticketData.status === 'closed') return;

    // Skip certain categories
    const category = (ticketData.category || '').toLowerCase();
    if (SKIP_CATEGORIES.some(c => category.includes(c))) return;

    const key = `${message.guildId}:${message.channelId}`;

    // Staff override — if staff sent this message, mark ticket as staff-active
    if (await isStaff(message)) {
      staffActiveMap.set(key, Date.now());
      return;
    }

    // Check if staff has been recently active
    const lastStaffActivity = staffActiveMap.get(key);
    if (lastStaffActivity && Date.now() - lastStaffActivity < STAFF_SILENCE_DURATION) return;

    // Only reply if message looks like a question or request
    const text = message.content.trim();
    if (text.length < 5) return;
    if (!looksLikeQuestion(text)) return;

    // Call Claude
    const reply = await callClaude(text, ticketData);
    if (!reply) return;

    await message.channel.send(reply);

  } catch (err) {
    logger.error('[TicketAI] Error:', err.message);
  }
}

// ── Heuristic: does this look like a question or request? ─────────────────────
function looksLikeQuestion(text) {
  const lower = text.toLowerCase();
  // Question marks, question words, or request phrases
  return (
    text.includes('?') ||
    /^(how|what|when|where|why|who|can|does|do|is|are|will|would|could|should|i need|help|not working|broken|issue|problem|error|fix|cant|can't|doesn't|wont|won't)/.test(lower)
  );
}

// ── Call Claude API ───────────────────────────────────────────────────────────
async function callClaude(userMessage, ticketData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const categoryLabel = ticketData.category || 'General Support';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: PHANTOM_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `[Ticket category: ${categoryLabel}]\n\n${userMessage}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    logger.warn('[TicketAI] Claude API error:', response.status);
    return null;
  }

  const data = await response.json();
  return data?.content?.[0]?.text || null;
}
