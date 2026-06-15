// src/commands/Core/notifications.js
// Lets users control which DM notifications they receive from Phantom.
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

export const DM_CATEGORIES = {
  rank:         { label: 'Rank Updates',        desc: 'Rank request approved or denied' },
  verification: { label: 'Verification',         desc: 'Success notification when you verify' },
  applications: { label: 'Applications',         desc: 'Application accepted or denied' },
  votes:        { label: 'Vote Rewards',         desc: 'Coin reward when you vote on Top.gg' },
  reminders:    { label: 'Reminders',            desc: 'Your personal reminders (recommended on)' },
};

// Defaults — rank and verification off by default to avoid annoyance
const DEFAULTS = {
  rank:         false,
  verification: false,
  applications: true,
  votes:        true,
  reminders:    true,
};

function prefKey(userId) { return `dm_prefs:${userId}`; }

export async function getDmPrefs(userId) {
  const stored = await getFromDb(prefKey(userId), null);
  return { ...DEFAULTS, ...(stored || {}) };
}

export async function canDm(userId, category) {
  const prefs = await getDmPrefs(userId);
  return prefs[category] ?? DEFAULTS[category] ?? true;
}

function buildEmbed(prefs) {
  const lines = Object.entries(DM_CATEGORIES).map(([key, { label, desc }]) => {
    const on = prefs[key] ?? DEFAULTS[key];
    return `${on ? '🟢' : '🔴'} **${label}** — ${desc}`;
  }).join('\n');

  return new EmbedBuilder()
    .setTitle('🔔 Notification Preferences')
    .setDescription('Choose which DMs you want to receive from Phantom.\n\n' + lines)
    .setColor(0x7c3aed)
    .setFooter({ text: 'These are your personal preferences and apply across all servers.' });
}

function buildButtons(prefs) {
  const rows = [];
  const entries = Object.entries(DM_CATEGORIES);

  // 2 buttons per row max
  for (let i = 0; i < entries.length; i += 2) {
    const row = new ActionRowBuilder();
    for (let j = i; j < Math.min(i + 2, entries.length); j++) {
      const [key, { label }] = entries[j];
      const on = prefs[key] ?? DEFAULTS[key];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`notif_toggle:${key}`)
          .setLabel(`${on ? '🟢' : '🔴'} ${label}`)
          .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary)
      );
    }
    rows.push(row);
  }
  return rows;
}

// ── Button handler ─────────────────────────────────────────────────────────────
export async function handleNotifToggle(interaction) {
  const [, category] = interaction.customId.split(':');
  const userId = interaction.user.id;
  const prefs  = await getDmPrefs(userId);

  prefs[category] = !prefs[category];
  await setInDb(prefKey(userId), prefs);

  await interaction.update({
    embeds: [buildEmbed(prefs)],
    components: buildButtons(prefs),
  });
}

// ── Slash command ──────────────────────────────────────────────────────────────
export default {
  data: new SlashCommandBuilder()
    .setName('notifications')
    .setDescription('Manage which DM notifications you receive from Phantom')
    .setDMPermission(true),

  category: 'core',

  async execute(interaction) {
    const prefs = await getDmPrefs(interaction.user.id);

    return InteractionHelper.safeReply(interaction, {
      embeds: [buildEmbed(prefs)],
      components: buildButtons(prefs),
      flags: MessageFlags.Ephemeral,
    });
  },
};
