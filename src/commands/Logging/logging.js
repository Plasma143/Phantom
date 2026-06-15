// src/commands/Logging/starboard.js
// Setup command for the starboard feature.
// The actual reposting logic lives in src/events/messageReactionAdd.js
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags, ChannelType } from 'discord.js';
import { errorEmbed, successEmbed, infoEmbed } from '../../utils/embeds.js';
import { getGuildConfig, updateGuildConfig } from '../../services/guildConfig.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
  data: new SlashCommandBuilder()
    .setName('starboard')
    .setDescription('Configure the starboard')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(s => s.setName('setup').setDescription('Enable starboard and set the channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post starred messages in').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addIntegerOption(o => o.setName('threshold').setDescription('Number of ⭐ reactions needed (default: 3)').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand(s => s.setName('disable').setDescription('Disable the starboard'))
    .addSubcommand(s => s.setName('info').setDescription('Show current starboard settings')),

  category: 'logging',

  async execute(interaction, config, client) {
    const sub = interaction.options.getSubcommand();
    const guildConfig = await getGuildConfig(client, interaction.guildId);

    if (sub === 'setup') {
      const channel   = interaction.options.getChannel('channel');
      const threshold = interaction.options.getInteger('threshold') ?? 3;
      await updateGuildConfig(interaction.guildId, {
        starboardChannelId: channel.id,
        starboardThreshold: threshold,
        starboardEnabled:   true,
      });
      return InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Starboard enabled!', `Posting to ${channel} when a message reaches **${threshold} ⭐**`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'disable') {
      await updateGuildConfig(interaction.guildId, { starboardEnabled: false });
      return InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Starboard disabled.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'info') {
      const enabled   = guildConfig.starboardEnabled;
      const channel   = guildConfig.starboardChannelId ? `<#${guildConfig.starboardChannelId}>` : 'Not set';
      const threshold = guildConfig.starboardThreshold ?? 3;
      return InteractionHelper.safeReply(interaction, {
        embeds: [infoEmbed('Starboard Settings', [
          `**Status:** ${enabled ? '🟢 Enabled' : '🔴 Disabled'}`,
          `**Channel:** ${channel}`,
          `**Threshold:** ${threshold} ⭐`,
        ].join('\n'))],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
