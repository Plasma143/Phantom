import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
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
    .setName("purge")
    .setDescription("Delete a specific amount of messages")
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Number of messages (1-100 free · 1-500 premium · 1-1000 enterprise)")
        .setRequired(true),
    )
.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  category: "moderation",

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`Purge interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'purge'
      });
      return;
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages))
      return await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          errorEmbed(
            "Permission Denied",
            "You need the `Manage Messages` permission to purge messages.",
          ),
        ],
      });

    // Get tier and max limit
    const sub  = await getSubscription(interaction.guildId);
    const tier = isOwner(interaction.user.id) ? 'enterprise' : getTier(sub);
    const maxAmount = PURGE_LIMIT[tier] ?? PURGE_LIMIT.free;

    const amount = interaction.options.getInteger("amount");
    const channel = interaction.channel;

    if (amount < 1 || amount > maxAmount)
      return await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          errorEmbed(
            "Invalid Amount",
            tier === 'free'
              ? `Free plan allows 1–100 messages. Upgrade to Premium (500) or Enterprise (1000) for higher limits.`
              : `Please specify a number between 1 and ${maxAmount}.`,
          ),
        ],
      });

    try {
      
      const rateLimitKey = `purge_${interaction.user.id}`;
      const isAllowed = await checkRateLimit(rateLimitKey, 5, 60000);
      if (!isAllowed) {
        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            warningEmbed(
              "You're purging messages too fast. Please wait a minute before trying again.",
              "⏳ Rate Limited"
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }

      // Discord bulkDelete only handles 100 at a time — loop for higher amounts
      let deletedCount = 0;
      let remaining = amount;
      while (remaining > 0) {
        const batchSize = Math.min(remaining, 100);
        const fetched = await channel.messages.fetch({ limit: batchSize });
        if (fetched.size === 0) break;
        const deleted = await channel.bulkDelete(fetched, true);
        deletedCount += deleted.size;
        remaining -= batchSize;
        if (deleted.size < batchSize) break; // no more deletable messages
        if (remaining > 0) await new Promise(r => setTimeout(r, 1000)); // avoid rate limits
      }

      const purgeEmbed = createEmbed(
        "🗑️ Messages Purged (Action Log)",
        `${deletedCount} messages were deleted by ${interaction.user}.`,
      )
.setColor(getColor('moderation'))
        .addFields(
          { name: "Channel", value: channel.toString(), inline: true },
          {
            name: "Moderator",
            value: `${interaction.user.tag} (${interaction.user.id})`,
            inline: true,
          },
          { name: "Count", value: `${deletedCount} messages`, inline: false },
        );

      await logEvent({
        client,
        guild: interaction.guild,
        event: {
          action: "Messages Purged",
          target: `${channel} (${deletedCount} messages)`,
          executor: `${interaction.user.tag} (${interaction.user.id})`,
          reason: `Deleted ${deletedCount} messages`,
          metadata: {
            channelId: channel.id,
            messageCount: deletedCount,
            requestedAmount: amount,
            moderatorId: interaction.user.id
          }
        }
      });

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(`🗑️ Deleted ${deletedCount} messages in ${channel}.`),
        ],
flags: MessageFlags.Ephemeral,
      });

      setTimeout(() => {
        interaction.deleteReply().catch(err => 
          logger.debug('Failed to auto-delete purge response:', err)
        );
      }, 3000);
    } catch (error) {
      logger.error('Purge command error:', error);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          errorEmbed(
            "An unexpected error occurred during message deletion. Note: Messages older than 14 days cannot be bulk deleted.",
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  }
};
