// src/commands/groupaccept.js
// Accepts a pending Roblox group join request, assigns a rank, and posts
// a confirmation log to the auto-rank log channel.
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { handleInteractionError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { getConfigValue } from '../utils/database.js';
import { db } from '../utils/database.js';
import {
  getRobloxUserByUsername,
  getGroupRoles,
  acceptGroupJoinRequest,
  updateGroupMemberRank,
} from '../utils/roblox.js';
import { applyFormat, ACCEPT_LOG_FORMAT } from '../services/promotionParser.js';

export default {
  data: new SlashCommandBuilder()
    .setName('groupaccept')
    .setDescription('Accept a pending Roblox group join request and assign a rank')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption(opt => opt
      .setName('username')
      .setDescription('Roblox username of the person to accept')
      .setRequired(true)
    )
    .addStringOption(opt => opt
      .setName('rank')
      .setDescription('Rank name to assign them after accepting')
      .setRequired(true)
    )
    .addStringOption(opt => opt
      .setName('reason')
      .setDescription('Reason for acceptance')
      .setRequired(false)
      .setMaxLength(500)
    ),
  category: 'commands',

  async execute(interaction) {
    try {
      await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

      const roblox = await getConfigValue({ db }, interaction.guildId, 'roblox', {});
      if (!roblox.groupId || !roblox.openCloudKey) {
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [errorEmbed('Not Configured', 'Set up your Group ID and Open Cloud API key in the dashboard first.')],
        });
      }

      const username  = interaction.options.getString('username').trim();
      const rankInput = interaction.options.getString('rank').trim();
      const reason    = interaction.options.getString('reason') || 'Accepted into group';

      // Look up the Roblox user
      const robloxUser = await getRobloxUserByUsername(username);
      if (!robloxUser) {
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [errorEmbed('User Not Found', `No Roblox account found for **${username}**.`)],
        });
      }

      // Get group roles to validate rank name
      const roles = await getGroupRoles(roblox.groupId, roblox.openCloudKey);
      const targetRole =
        roles.find(r => r.displayName.toLowerCase() === rankInput.toLowerCase()) ||
        roles.find(r => r.displayName.toLowerCase().includes(rankInput.toLowerCase())) ||
        roles.find(r => String(r.rank) === rankInput);

      if (!targetRole) {
        const roleNames = roles.map(r => r.displayName).join(', ');
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [errorEmbed('Rank Not Found', `No rank matching **${rankInput}** found.\n\nAvailable ranks: ${roleNames}`)],
        });
      }

      // Accept the join request (silent fail if no pending request)
      try {
        await acceptGroupJoinRequest(roblox.groupId, robloxUser.id, roblox.openCloudKey);
      } catch (e) {
        logger.debug(`[groupaccept] acceptGroupJoinRequest skipped for ${robloxUser.id}: ${e.message}`);
        // Continue — they might already be in the group with a pending rank
      }

      // Assign the rank
      const rankResult = await updateGroupMemberRank(roblox.groupId, robloxUser.id, targetRole.rank, roblox.openCloudKey);
      if (!rankResult.success) {
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [errorEmbed('Rank Failed', rankResult.error || 'Could not assign rank on Roblox.')],
        });
      }

      // Post to the auto-rank log channel
      const autoRank = await getConfigValue({ db }, interaction.guildId, 'autoRank', {});
      if (autoRank.logChannelId) {
        const logChannel = interaction.guild.channels.cache.get(autoRank.logChannelId) ||
          await interaction.guild.channels.fetch(autoRank.logChannelId).catch(() => null);

        if (logChannel) {
          const format = autoRank.customFormat || ACCEPT_LOG_FORMAT;
          const logText = applyFormat(format, {
            username: robloxUser.name,
            oldRank:  'N/A',
            newRank:  targetRole.displayName,
            reason,
            ranker:   interaction.user.tag,
          });
          await logChannel.send(logText).catch(err =>
            logger.warn('[groupaccept] Could not post to log channel:', err.message)
          );
        }
      }

      logger.info(`[groupaccept] ${interaction.user.tag} accepted ${robloxUser.name} into group ${roblox.groupId} as ${targetRole.displayName}`);

      return InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({
          title: '✅ Accepted',
          color: 'success',
          description:
            `**${robloxUser.name}** has been accepted into the group and ranked to **${targetRole.displayName}**.\n\n` +
            `**Reason:** ${reason}`,
        })],
      });

    } catch (error) {
      logger.error('[groupaccept] Error:', error);
      await handleInteractionError(interaction, error, { commandName: 'groupaccept' });
    }
  },
};
