// src/commands/Core/status.js
// Staff command for posting bot/service status updates to the configured #status channel.
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getGuildConfig, updateGuildConfig } from '../../services/guildConfig.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const STATUS_CONFIG = {
  operational:   { color: 0x57f287, emoji: '🟢', label: 'Operational'   },
  investigating: { color: 0xfee75c, emoji: '🟡', label: 'Investigating'  },
  degraded:      { color: 0xffa500, emoji: '🟠', label: 'Degraded'       },
  outage:        { color: 0xed4245, emoji: '🔴', label: 'Outage'         },
  maintenance:   { color: 0x5865f2, emoji: '🔵', label: 'Maintenance'    },
};

export default {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Post a status update to the status channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(s => s.setName('post').setDescription('Post a status update')
      .addStringOption(o => o.setName('type').setDescription('Status type').setRequired(true)
        .addChoices(
          { name: '🟢 Operational — everything is working', value: 'operational' },
          { name: '🟡 Investigating — looking into an issue', value: 'investigating' },
          { name: '🟠 Degraded — some features affected', value: 'degraded' },
          { name: '🔴 Outage — service is down', value: 'outage' },
          { name: '🔵 Maintenance — scheduled downtime', value: 'maintenance' },
        )
      )
      .addStringOption(o => o.setName('message').setDescription('Details about the status').setRequired(true).setMaxLength(1000))
    )
    .addSubcommand(s => s.setName('setup').setDescription('Set the status channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post status updates in').setRequired(true))
    ),

  category: 'core',

  async execute(interaction, config, client) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'setup') {
      const channel = interaction.options.getChannel('channel');
      await updateGuildConfig(interaction.guildId, { statusChannelId: channel.id });
      return InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Status channel set to ' + channel.toString())],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'post') {
      const guildConfig = await getGuildConfig(client, interaction.guildId);
      if (!guildConfig.statusChannelId) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Not Configured', 'No status channel set. Run `/status setup` first.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const channel = interaction.guild.channels.cache.get(guildConfig.statusChannelId);
      if (!channel) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Channel Not Found', 'The configured status channel no longer exists.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const type    = interaction.options.getString('type');
      const message = interaction.options.getString('message');
      const cfg     = STATUS_CONFIG[type];

      const embed = new EmbedBuilder()
        .setTitle(`${cfg.emoji} ${cfg.label}`)
        .setDescription(message)
        .setColor(cfg.color)
        .addFields({ name: 'Posted by', value: `${interaction.user}`, inline: true })
        .setTimestamp();

      await channel.send({ embeds: [embed] });

      return InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Status posted!', `Update posted to ${channel}.`)],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
