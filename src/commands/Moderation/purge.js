import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/rateLimiter.js';
import { getColor } from '../../config/bot.js';
import { getSubscription, getTier, isOwner } from '../../web/stripePayments.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

// Purge limits by tier
const PURGE_LIMIT = { free: 100, premium: 500, enterprise: 1000 };

export default {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete messages in this channel')
    .addIntegerOption(o =>
      o.setName('amount')
        .setDescription('Number of messages to scan (1-100 free · 1-500 premium · 1-1000 enterprise)')
        .setRequired(true)
    )
    .addUserOption(o =>
      o.setName('user')
        .setDescription('Only delete messages from this user (optional)')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  category: 'moderation',

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn('Purge interaction defer failed', {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      return;
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return InteractionHelper.safeEditReply(interaction, {
        embeds: [errorEmbed('Permission Denied', 'You need the `Manage Messages` permission to purge messages.')],
      });
    }

    // Tier limits
    const sub      = await getSubscription(interaction.guildId);
    const tier     = isOwner(interaction.user.id) ? 'enterprise' : getTier(sub);
    const maxAmount = PURGE_LIMIT[tier] ?? PURGE_LIMIT.free;

    const amount    = interaction.options.getInteger('amount');
    const targetUser = interaction.options.getUser('user') ?? null;
    const channel   = interaction.channel;

    if (amount < 1 || amount > maxAmount) {
      return InteractionHelper.safeEditReply(interaction, {
        embeds: [errorEmbed(
          'Invalid Amount',
          tier === 'free'
            ? 'Free plan allows 1–100 messages. Upgrade to Premium (500) or Enterprise (1000) for higher limits.'
            : `Please specify a number between 1 and ${maxAmount}.`
        )],
      });
    }

    try {
      const rateLimitKey = `purge_${interaction.user.id}`;
      const isAllowed = await checkRateLimit(rateLimitKey, 5, 60000);
      if (!isAllowed) {
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [warningEmbed('You\'re purging messages too fast. Please wait a minute before trying again.', '⏳ Rate Limited')],
          flags: MessageFlags.Ephemeral,
        });
      }

      let deletedCount = 0;
      let remaining    = amount;

      while (remaining > 0) {
        const batchSize = Math.min(remaining, 100);
        const fetched   = await channel.messages.fetch({ limit: batchSize });
        if (fetched.size === 0) break;

        // If filtering by user, only keep that user's messages
        const toDelete = targetUser
          ? fetched.filter(m => m.author.id === targetUser.id)
          : fetched;

        if (toDelete.size === 0) {
          // No matching messages in this batch — stop to avoid infinite loop
          break;
        }

        const deleted = await channel.bulkDelete(toDelete, true); // true = skip messages >14 days
        deletedCount += deleted.size;
        remaining -= batchSize;
        if (deleted.size < toDelete.size) break; // ran out of deletable messages
        if (remaining > 0) await new Promise(r => setTimeout(r, 1000));
      }

      const description = targetUser
        ? `${deletedCount} messages from ${targetUser} were deleted by ${interaction.user}.`
        : `${deletedCount} messages were deleted by ${interaction.user}.`;

      await logEvent({
        client,
        guild: interaction.guild,
        event: {
          action: 'Messages Purged',
          target: `${channel} (${deletedCount} messages${targetUser ? ` from ${targetUser.tag}` : ''})`,
          executor: `${interaction.user.tag} (${interaction.user.id})`,
          reason: description,
          metadata: {
            channelId: channel.id,
            messageCount: deletedCount,
            requestedAmount: amount,
            moderatorId: interaction.user.id,
            targetUserId: targetUser?.id ?? null,
          },
        },
      });

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
          targetUser
            ? `🗑️ Deleted ${deletedCount} messages from ${targetUser} in ${channel}.`
            : `🗑️ Deleted ${deletedCount} messages in ${channel}.`
        )],
        flags: MessageFlags.Ephemeral,
      });

      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 3000);

    } catch (error) {
      logger.error('Purge command error:', error);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [errorEmbed('An unexpected error occurred. Note: Messages older than 14 days cannot be bulk deleted.')],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
