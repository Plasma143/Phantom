// src/commands/robloxsetup.js
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getConfigValue, updateGuildConfig } from '../services/guildConfig.js';
import { getRobloxGroupInfo } from '../utils/roblox.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('robloxsetup')
    .setDescription("Configure this server's Roblox group integration")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('group')
        .setDescription('Set the Roblox group this server is bound to')
        .addStringOption((opt) =>
          opt
            .setName('group_id')
            .setDescription("Your Roblox group's ID number")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('verifiedrole')
        .setDescription('Set the role given to everyone once they link Roblox')
        .addRoleOption((opt) =>
          opt
            .setName('role')
            .setDescription('Discord role to assign')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rankrole')
        .setDescription('Map a Roblox group rank to a Discord role')
        .addIntegerOption((opt) =>
          opt
            .setName('rank')
            .setDescription("The Roblox rank number (0-255) — see your group's Manage > Roles page")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(255),
        )
        .addRoleOption((opt) =>
          opt
            .setName('role')
            .setDescription('Discord role for members at this rank')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('view').setDescription("View this server's current Roblox setup"),
    ),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'group') {
      const groupId = interaction.options.getString('group_id').trim();

      if (!/^\d+$/.test(groupId)) {
        return interaction.reply({
          embeds: [errorEmbed(
            'Invalid Group ID',
            "Group IDs are numbers only — find yours in your group's URL on roblox.com (the number right after /groups/).",
          )],
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const group = await getRobloxGroupInfo(groupId);
      if (!group) {
        return interaction.editReply({
          embeds: [errorEmbed(
            'Group Not Found',
            `Couldn't find a Roblox group with ID **${groupId}**. Double check the number from the group's URL.`,
          )],
        });
      }

      const currentRoblox = await getConfigValue(client, guildId, 'roblox', {});
      await updateGuildConfig(client, guildId, {
        roblox: { ...currentRoblox, enabled: true, groupId },
      });

      return interaction.editReply({
        embeds: [successEmbed(
          'Group Set',
          `This server is now bound to **${group.name}** (ID: ${groupId}, ${group.memberCount.toLocaleString()} members).`,
        )],
      });
    }

    if (sub === 'verifiedrole') {
      const role = interaction.options.getRole('role');

      const currentRoblox = await getConfigValue(client, guildId, 'roblox', {});
      await updateGuildConfig(client, guildId, {
        roblox: { ...currentRoblox, verifiedRole: role.id },
      });

      return interaction.reply({
        embeds: [successEmbed('Verified Role Set', `Everyone who links their Roblox account will now get ${role}.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'rankrole') {
      const rank = interaction.options.getInteger('rank');
      const role = interaction.options.getRole('role');

      const currentRoblox = await getConfigValue(client, guildId, 'roblox', {});
      if (!currentRoblox.groupId) {
        return interaction.reply({
          embeds: [errorEmbed('Set Up a Group First', 'Run `/robloxsetup group` before mapping rank roles.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const rankRoles = { ...(currentRoblox.rankRoles || {}), [rank]: role.id };
      await updateGuildConfig(client, guildId, {
        roblox: { ...currentRoblox, rankRoles },
      });

      return interaction.reply({
        embeds: [successEmbed('Rank Role Set', `Roblox rank **${rank}** will now map to ${role}. Run this again with a different rank to add more.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'view') {
      const roblox = await getConfigValue(client, guildId, 'roblox', {});

      if (!roblox.groupId) {
        return interaction.reply({
          embeds: [errorEmbed('Not Set Up', 'No Roblox group is configured yet. Start with `/robloxsetup group`.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const rankRoleLines = Object.entries(roblox.rankRoles || {})
        .map(([rank, roleId]) => `Rank ${rank} → <@&${roleId}>`)
        .join('\n') || '*None set yet*';

      return interaction.reply({
        embeds: [successEmbed(
          'Roblox Setup',
          `**Group ID:** ${roblox.groupId}\n` +
            `**Verified Role:** ${roblox.verifiedRole ? `<@&${roblox.verifiedRole}>` : '*Not set*'}\n\n` +
            `**Rank Roles:**\n${rankRoleLines}`,
        )],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
