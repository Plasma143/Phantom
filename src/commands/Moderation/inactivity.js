// src/commands/Moderation/inactivity.js
// Enterprise — scan all linked members for inactivity based on last message timestamp.
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } from 'discord.js';
import { errorEmbed } from '../../utils/embeds.js';
import { getSubscription, getTier, isOwner } from '../../web/stripePayments.js';
import { getRobloxLink } from '../../utils/robloxDb.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_DAYS = 14;
const MAX_RESULTS  = 30;

export default {
  data: new SlashCommandBuilder()
    .setName('inactivity')
    .setDescription('Scan for inactive members (Enterprise)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addIntegerOption(o => o
      .setName('days')
      .setDescription(`Members inactive for longer than this many days (default: ${DEFAULT_DAYS})`)
      .setMinValue(1)
      .setMaxValue(90)
    )
    .addBooleanOption(o => o
      .setName('roblox_only')
      .setDescription('Only show members with a linked Roblox account (default: true)')
    ),

  category: 'moderation',

  async execute(interaction, config, client) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Enterprise check
    const sub  = await getSubscription(interaction.guildId);
    const tier = isOwner(interaction.user.id) ? 'enterprise' : getTier(sub);
    if (tier !== 'enterprise') {
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0x4c1d95)
          .setTitle('👑 Enterprise Feature')
          .setDescription('The Inactivity Scanner requires **Enterprise**.\n\nUpgrade at the [dashboard](https://phantom1.up.railway.app/dashboard).')
        ],
      });
    }

    const days       = interaction.options.getInteger('days') ?? DEFAULT_DAYS;
    const robloxOnly = interaction.options.getBoolean('roblox_only') ?? true;
    const cutoff     = Date.now() - days * 86_400_000;
    const guildId    = interaction.guildId;

    try {
      // Fetch all members
      await interaction.guild.members.fetch();
      const members = interaction.guild.members.cache.filter(m => !m.user.bot);

      const inactive = [];

      for (const [, member] of members) {
        try {
          // Get level data (contains lastMessage timestamp)
          const prefix = `guild:${guildId}:leveling:users:${member.user.id}`;
          const data   = await client.db?.get(prefix).catch(() => null);
          const lastMessage = data?.lastMessage || 0;

          if (lastMessage > cutoff) continue; // active — skip

          // Optionally filter to Roblox-linked only
          let robloxInfo = null;
          if (robloxOnly) {
            robloxInfo = await getRobloxLink(member.user.id);
            if (!robloxInfo?.roblox_id) continue;
          } else {
            robloxInfo = await getRobloxLink(member.user.id).catch(() => null);
          }

          const daysSince = lastMessage
            ? Math.floor((Date.now() - lastMessage) / 86_400_000)
            : null;

          inactive.push({
            tag: member.user.tag,
            id: member.user.id,
            robloxUsername: robloxInfo?.roblox_username || null,
            daysSince,
          });
        } catch {
          // Skip members with errors
        }
      }

      if (!inactive.length) {
        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('✅ No Inactive Members')
            .setDescription(`All ${robloxOnly ? 'linked ' : ''}members have been active within the last **${days} days**.`)
          ],
        });
      }

      // Sort by most inactive first
      inactive.sort((a, b) => (b.daysSince ?? 999) - (a.daysSince ?? 999));
      const display = inactive.slice(0, MAX_RESULTS);

      const lines = display.map(m => {
        const since   = m.daysSince !== null ? `${m.daysSince}d ago` : 'Never';
        const roblox  = m.robloxUsername ? ` · ${m.robloxUsername}` : '';
        return `<@${m.id}>${roblox} — last active **${since}**`;
      }).join('\n');

      const embed = new EmbedBuilder()
        .setTitle(`🔍 Inactive Members (${inactive.length})`)
        .setDescription(lines)
        .setColor(0xffa500)
        .addFields(
          { name: 'Threshold', value: `${days} days`, inline: true },
          { name: 'Roblox-linked only', value: robloxOnly ? 'Yes' : 'No', inline: true },
          { name: 'Showing', value: `${display.length} of ${inactive.length}`, inline: true },
        )
        .setTimestamp()
        .setFooter({ text: 'Based on last message sent in this server' });

      logger.info(`[Inactivity] ${interaction.user.tag} scanned ${interaction.guild.name}: ${inactive.length} inactive`);

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('[Inactivity] Scan error:', err.message);
      return interaction.editReply({ embeds: [errorEmbed('Scan Failed', `An error occurred: \`${err.message}\``)] });
    }
  },
};
