// src/commands/Community/suggest.js
// Members submit suggestions; staff approve or deny with a reason via buttons.
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getColor } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';
import { getGuildConfig, updateGuildConfig } from '../../services/guildConfig.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

function getSuggestionKey(guildId, id) {
  return `suggestion:${guildId}:${id}`;
}
function getCounterKey(guildId) {
  return `suggestion_counter:${guildId}`;
}

async function nextId(guildId) {
  const key  = getCounterKey(guildId);
  const curr = (await getFromDb(key, 0)) || 0;
  const next = curr + 1;
  await setInDb(key, next);
  return next;
}

function buildEmbed(data, status) {
  const colors  = { pending: 0x5865f2, approved: 0x57f287, denied: 0xed4245 };
  const labels  = { pending: 'Pending', approved: 'Approved', denied: 'Denied' };
  const embed   = new EmbedBuilder()
    .setTitle(`Suggestion #${data.id}`)
    .setDescription(data.content)
    .setColor(colors[status] ?? 0x5865f2)
    .addFields(
      { name: 'Status', value: labels[status] ?? 'Pending', inline: true },
      { name: 'Submitted by', value: `<@${data.userId}>`, inline: true },
    )
    .setTimestamp(data.createdAt);

  if (data.reason) {
    embed.addFields({ name: status === 'approved' ? 'Approval Note' : 'Denial Reason', value: data.reason, inline: false });
  }
  if (data.reviewerId) {
    embed.setFooter({ text: `Reviewed by ${data.reviewerTag}` });
  }
  return embed;
}

function buildButtons(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`suggest_approve:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`suggest_deny:${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

// ── Button / modal handlers (exported for interactionCreate.js) ────────────────
export async function handleSuggestionButton(interaction, client) {
  const [action, idStr] = interaction.customId.split(':');
  const suggId = parseInt(idStr, 10);
  const guildId = interaction.guildId;

  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return interaction.reply({ embeds: [errorEmbed('Permission Denied', 'You need `Manage Messages` to review suggestions.')], flags: MessageFlags.Ephemeral });
  }

  const data = await getFromDb(getSuggestionKey(guildId, suggId), null);
  if (!data) return interaction.reply({ embeds: [errorEmbed('Not Found', 'Suggestion not found.')], flags: MessageFlags.Ephemeral });
  if (data.status !== 'pending') return interaction.reply({ embeds: [errorEmbed('Already Reviewed', 'This suggestion has already been reviewed.')], flags: MessageFlags.Ephemeral });

  // Show modal to collect optional reason
  const modal = new ModalBuilder()
    .setCustomId(`suggest_modal:${action}:${suggId}`)
    .setTitle(action === 'suggest_approve' ? 'Approve Suggestion' : 'Deny Suggestion')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500)
      )
    );
  await interaction.showModal(modal);
}

export async function handleSuggestionModal(interaction, client) {
  await interaction.deferUpdate();
  const [, action, idStr] = interaction.customId.split(':');
  const suggId  = parseInt(idStr, 10);
  const guildId = interaction.guildId;
  const reason  = interaction.fields.getTextInputValue('reason')?.trim() || null;
  const status  = action === 'suggest_approve' ? 'approved' : 'denied';

  const data = await getFromDb(getSuggestionKey(guildId, suggId), null);
  if (!data) return;

  data.status      = status;
  data.reason      = reason;
  data.reviewerId  = interaction.user.id;
  data.reviewerTag = interaction.user.tag;
  await setInDb(getSuggestionKey(guildId, suggId), data);

  const embed   = buildEmbed(data, status);
  const buttons = buildButtons(suggId, true);
  await interaction.message.edit({ embeds: [embed], components: [buttons] });

  logger.info(`[Suggest] #${suggId} ${status} by ${interaction.user.tag} in ${guildId}`);
}

// ── Slash command ──────────────────────────────────────────────────────────────
export default {
  data: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Suggestion management')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('submit').setDescription('Submit a suggestion')
      .addStringOption(o => o.setName('idea').setDescription('Your suggestion').setRequired(true).setMaxLength(1000))
    )
    .addSubcommand(s => s.setName('setup').setDescription('Set the suggestions channel (admin only)')
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post suggestions in').setRequired(true))
    ),

  category: 'community',

  async execute(interaction, config, client) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'setup') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return InteractionHelper.safeReply(interaction, { embeds: [errorEmbed('Permission Denied', 'You need `Manage Server` to configure suggestions.')], flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel');
      await updateGuildConfig(interaction.guildId, { suggestionsChannelId: channel.id });
      return InteractionHelper.safeReply(interaction, { embeds: [successEmbed('Suggestions channel set to ' + channel.toString())], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'submit') {
      const guildConfig = await getGuildConfig(client, interaction.guildId);
      if (!guildConfig.suggestionsChannelId) {
        return InteractionHelper.safeReply(interaction, { embeds: [errorEmbed('Not Configured', 'No suggestions channel has been set. Ask an admin to run `/suggest setup`.')], flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.guild.channels.cache.get(guildConfig.suggestionsChannelId);
      if (!channel) {
        return InteractionHelper.safeReply(interaction, { embeds: [errorEmbed('Channel Not Found', 'The configured suggestions channel no longer exists.')], flags: MessageFlags.Ephemeral });
      }

      const idea = interaction.options.getString('idea');
      const id   = await nextId(interaction.guildId);
      const data = {
        id,
        content: idea,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        status: 'pending',
        reason: null,
        reviewerId: null,
        reviewerTag: null,
        createdAt: Date.now(),
      };

      await setInDb(getSuggestionKey(interaction.guildId, id), data);

      const embed   = buildEmbed(data, 'pending');
      const buttons = buildButtons(id);
      await channel.send({ embeds: [embed], components: [buttons] });

      return InteractionHelper.safeReply(interaction, { embeds: [successEmbed('Suggestion submitted!', `Your suggestion has been posted to ${channel}.`)], flags: MessageFlags.Ephemeral });
    }
  },
};
