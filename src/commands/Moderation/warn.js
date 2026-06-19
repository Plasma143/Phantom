import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logModerationAction, logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { WarningService } from '../../services/warningService.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a user, or view their warning history.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Warn a user")
        .addUserOption((o) =>
          o
            .setName("target")
            .setRequired(true)
            .setDescription("User to warn"),
        )
        .addStringOption((o) =>
          o
            .setName("reason")
            .setRequired(true)
            .setDescription("Reason for the warning"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("View all warnings for a user")
        .addUserOption((o) =>
          o
            .setName("target")
            .setRequired(true)
            .setDescription("User to check warnings for"),
        ),
    ),
  category: "moderation",

  async execute(interaction, config, client) {
    const sub = interaction.options.getSubcommand();
    if (sub === "list") {
      return executeList(interaction, config, client);
    }
    return executeAdd(interaction, config, client);
  },
};

// Original warn.js logic, unchanged.
async function executeAdd(interaction, config, client) {
  const deferSuccess = await InteractionHelper.safeDefer(interaction);
  if (!deferSuccess) {
    logger.warn(`Warn interaction defer failed`, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      commandName: 'warn'
    });
    return;
  }

  try {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      throw new Error("You need the `Moderate Members` permission to issue warnings.");
    }

    const target = interaction.options.getUser("target");
    const member = interaction.options.getMember("target");
    const reason = interaction.options.getString("reason");
    const moderator = interaction.user;
    const guildId = interaction.guildId;

    if (!member) {
      throw new Error("The target user is not currently in this server.");
    }

    const result = await WarningService.addWarning({
      guildId,
      userId: target.id,
      moderatorId: moderator.id,
      reason,
      timestamp: Date.now()
    });

    if (!result.success) {
      throw new Error("Failed to store warning in database");
    }

    const totalWarns = result.totalCount;

    await logModerationAction({
      client,
      guild: interaction.guild,
      event: {
        action: "User Warned",
        target: `${target.tag} (${target.id})`,
        executor: `${moderator.tag} (${moderator.id})`,
        reason,
        metadata: {
          userId: target.id,
          moderatorId: moderator.id,
          totalWarns,
          warningNumber: totalWarns,
          warningId: result.id
        }
      }
    });

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [
        successEmbed(
          `⚠️ **Warned** ${target.tag}`,
          `**Reason:** ${reason}\n**Total Warns:** ${totalWarns}`,
        ),
      ],
    });
  } catch (error) {
    logger.error('Warn command error:', error);
    await handleInteractionError(interaction, error, { subtype: 'warn_failed' });
  }
}

// Original warnings.js logic, unchanged.
async function executeList(interaction, config, client) {
  const deferSuccess = await InteractionHelper.safeDefer(interaction);
  if (!deferSuccess) {
    logger.warn(`Warnings interaction defer failed`, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      commandName: 'warnings'
    });
    return;
  }

  try {
    const target = interaction.options.getUser("target");
    const guildId = interaction.guildId;

    const validWarnings = await WarningService.getWarnings(guildId, target.id);
    const totalWarns = validWarnings.length;

    if (totalWarns === 0) {
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          createEmbed({
            title: `Warnings: ${target.tag}`,
            description: "✅ This user has no recorded warnings."
          }).setColor(getColor('success')),
        ],
      });
      return;
    }

    const embed = createEmbed({
      title: `Warnings: ${target.tag}`,
      description: `Total Warnings: **${totalWarns}**`
    }).setColor(getColor('warning'));

    const warningFields = validWarnings
      .map((w, i) => {
        const discordTimestamp = Math.floor(w.timestamp / 1000);
        return {
          name: `[#${i + 1}] Reason: ${w.reason.substring(0, 100)}`,
          value: `**Moderator:** <@${w.moderatorId}>\n**Date:** <t:${discordTimestamp}:F> (<t:${discordTimestamp}:R>)`,
          inline: false,
        };
      })
      .slice(0, 25);

    embed.addFields(warningFields);

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`warning_delete_specific:${target.id}:${interaction.user.id}`)
        .setLabel('Delete Specific Warning')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`warning_clear_all:${target.id}:${interaction.user.id}`)
        .setLabel('Clear All Warnings')
        .setStyle(ButtonStyle.Danger)
    );

    await logEvent({
      client,
      guild: interaction.guild,
      event: {
        action: "Warnings Viewed",
        target: `${target.tag} (${target.id})`,
        executor: `${interaction.user.tag} (${interaction.user.id})`,
        reason: `Viewed ${totalWarns} warnings`,
        metadata: {
          userId: target.id,
          moderatorId: interaction.user.id,
          totalWarnings: totalWarns
        }
      }
    });

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components: [actionRow] });
  } catch (error) {
    logger.error('Warnings command error:', error);
    await handleInteractionError(interaction, error, { subtype: 'warnings_view_failed' });
  }
}
