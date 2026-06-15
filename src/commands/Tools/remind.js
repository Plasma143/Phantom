// src/commands/Tools/remind.js
// Members set personal reminders; bot DMs them when the time is up.
// Cron job in app.js checks every minute.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed, infoEmbed } from '../../utils/embeds.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

function getUserRemindersKey(userId) {
  return `reminders:${userId}`;
}

function parseDuration(str) {
  const match = str.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i);
  if (!match) return null;
  const n  = parseInt(match[1], 10);
  const u  = match[2].toLowerCase();
  if (u.startsWith('s')) return n * 1000;
  if (u.startsWith('m')) return n * 60 * 1000;
  if (u.startsWith('h')) return n * 3600 * 1000;
  if (u.startsWith('d')) return n * 86400 * 1000;
  return null;
}

export async function checkReminders(client) {
  try {
    const now = Date.now();
    // Scan all reminder keys — in production this would use a DB index
    // For now iterate via the list function if available, otherwise skip
    if (typeof client._reminderUserIds === 'undefined') return;
    for (const userId of client._reminderUserIds) {
      const key      = getUserRemindersKey(userId);
      const reminders = await getFromDb(key, []);
      const due      = reminders.filter(r => r.fireAt <= now);
      const pending  = reminders.filter(r => r.fireAt > now);
      if (!due.length) continue;
      await setInDb(key, pending);
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) continue;
      for (const r of due) {
        await user.send({
          embeds: [infoEmbed(`⏰ Reminder: ${r.message}`, `Set <t:${Math.floor(r.createdAt / 1000)}:R> ago`)],
        }).catch(() => {});
      }
      if (!pending.length) {
        client._reminderUserIds.delete(userId);
      }
    }
  } catch (err) {
    logger.error('[Reminders] checkReminders error:', err.message);
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set and manage personal reminders')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('set').setDescription('Set a reminder')
      .addStringOption(o => o.setName('time').setDescription('When to remind you (e.g. 30m, 2h, 1d)').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('What to remind you about').setRequired(true).setMaxLength(300))
    )
    .addSubcommand(s => s.setName('list').setDescription('View your active reminders'))
    .addSubcommand(s => s.setName('cancel').setDescription('Cancel a reminder')
      .addIntegerOption(o => o.setName('id').setDescription('Reminder number from /remind list').setRequired(true).setMinValue(1))
    ),

  category: 'tools',

  async execute(interaction) {
    const sub    = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const key    = getUserRemindersKey(userId);

    if (sub === 'set') {
      const timeStr  = interaction.options.getString('time');
      const message  = interaction.options.getString('message');
      const durationMs = parseDuration(timeStr);

      if (!durationMs) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Invalid Time', 'Use a format like `30m`, `2h`, `1d`. Maximum 7 days.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (durationMs > 7 * 86400 * 1000) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Too Long', 'Maximum reminder duration is 7 days.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const reminders = await getFromDb(key, []);
      if (reminders.length >= 10) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Too Many Reminders', 'You can have a maximum of 10 active reminders. Cancel some first.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const fireAt = Date.now() + durationMs;
      reminders.push({ message, fireAt, createdAt: Date.now() });
      await setInDb(key, reminders);

      // Track user ID for cron scan
      if (!interaction.client._reminderUserIds) interaction.client._reminderUserIds = new Set();
      interaction.client._reminderUserIds.add(userId);

      return InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Reminder Set!', `I'll DM you <t:${Math.floor(fireAt / 1000)}:R>: **${message}**`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'list') {
      const reminders = await getFromDb(key, []);
      if (!reminders.length) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [infoEmbed('No active reminders.', 'Use `/remind set` to create one.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      const lines = reminders.map((r, i) =>
        `**${i + 1}.** ${r.message} — <t:${Math.floor(r.fireAt / 1000)}:R>`
      ).join('\n');
      return InteractionHelper.safeReply(interaction, {
        embeds: [infoEmbed('Your Reminders', lines)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'cancel') {
      const num = interaction.options.getInteger('id');
      const reminders = await getFromDb(key, []);
      if (num < 1 || num > reminders.length) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Invalid ID', `You only have ${reminders.length} reminder(s). Use \`/remind list\` to see them.`)],
          flags: MessageFlags.Ephemeral,
        });
      }
      const [removed] = reminders.splice(num - 1, 1);
      await setInDb(key, reminders);
      return InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Reminder Cancelled', `Cancelled: **${removed.message}**`)],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
