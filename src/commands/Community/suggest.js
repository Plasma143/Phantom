// src/commands/Community/suggest.js
// Staff posts a persistent "Submit a Suggestion" button panel.
// Members click it → modal → bot posts formatted suggestion embed with Approve/Deny buttons.
import {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getGuildConfig, updateGuildConfig } from '../../services/guildConfig.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

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
  const colors = { pending: 0x5865f2, approved: 0x57f287, denied: 0xed4245 };
  const labels = { pending: '⏳ Pending', approved: '✅ Approved', denied: '❌ Denied' };

  const embed = new EmbedBuilder()
    .setTitle(`Suggestion #${data.id}`)
    .setDescription(
      `**Username:** <@${data.userId}>\n**Suggestion:** ${data.content}`
    )
    .setColor(colors[status] ?? 0x5865f2)
    .addFields({ name: 'Status', value: labels[status] ?? '⏳ Pending', inline: true })
    .setTimestamp(data.createdAt);

  if (data.reason) {
    embed.addFields({ name: status === 'approved' ? 'Note' : 'Reason', value: data.reason, inline: false });
  }
  if (data.reviewerId) {
    embed.setFooter({ text: `Reviewed by ${data.reviewerTag}` });
  }
  return embed;
}

function buildReviewButtons(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`suggest_approve:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`suggest_deny:${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

// ── Button: open suggestion modal ─────────────────────────────────────────────
export async function handleSuggestionPanelButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('suggest_submit_modal')
    .setTitle('Submit a Suggestion')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('suggestion')
          .setLabel('Your Suggestion')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Describe your idea clearly and concisely...')
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(1000)
      )
    );
  await interaction.showModal(modal);
}

// ── Modal: save and post suggestion ───────────────────────────────────────────
export async function handleSuggestionSubmitModal(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const content = interaction.fields.getTextInputValue('suggestion').trim();
  const config  = await getGuildConfig(client, interaction.guildId);

  if (!config.suggestionsChannelId) {
    return interaction.editReply({ embeds: [errorEmbed('Not Configured', 'No suggestions channel has been set up.')] });
  }

  const channel = interaction.guild.channels.cache.get(config.suggestionsChannelId);
  if (!channel) {
    return interaction.editReply({ embeds: [errorEmbed('Channel Not Found', 'The suggestions channel no longer exists.')] });
  }

  const id   = await nextId(interaction.guildId);
  const data = {
    id,
    content,
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
  const buttons = buildReviewButtons(id);
  await channel.send({ embeds: [embed], components: [buttons] });

  logger.info(`[Suggest] #${id} submitted by ${interaction.user.tag} in ${interaction.guildId}`);
  return interaction.editReply({ embeds: [successEmbed('Suggestion submitted!', `Your idea has been posted to ${channel}.`)] });
}

// ── Button: approve/deny ──────────────────────────────────────────────────────
export async function handleSuggestionButton(interaction, client) {
  const [action, idStr] = interaction.customId.split(':');
  const suggId  = parseInt(idStr, 10);

  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return interaction.reply({ embeds: [errorEmbed('Permission Denied', 'You need `Manage Messages` to review suggestions.')], flags: MessageFlags.Ephemeral });
  }

  const data = await getFromDb(getSuggestionKey(interaction.guildId, suggId), null);
  if (!data) return interaction.reply({ embeds: [errorEmbed('Not Found', 'Suggestion not found.')], flags: MessageFlags.Ephemeral });
  if (data.status !== 'pending') return interaction.reply({ embeds: [errorEmbed('Already Reviewed', 'This suggestion has already been reviewed.')], flags: MessageFlags.Ephemeral });

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

// ── Modal: save verdict ───────────────────────────────────────────────────────
export async function handleSuggestionModal(interaction, client) {
  await interaction.deferUpdate();
  const [, action, idStr] = interaction.customId.split(':');
  const suggId = parseInt(idStr, 10);
  const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;
  const status = action === 'suggest_approve' ? 'approved' : 'denied';

  const data = await getFromDb(getSuggestionKey(interaction.guildId, suggId), null);
  if (!data) return;

  data.status      = status;
  data.reason      = reason;
  data.reviewerId  = interaction.user.id;
  data.reviewerTag = interaction.user.tag;
  await setInDb(getSuggestionKey(interaction.guildId, suggId), data);

  await interaction.message.edit({
    embeds: [buildEmbed(data, status)],
    components: [buildReviewButtons(suggId, true)],
  });
}

// ── Slash command ──────────────────────────────────────────────────────────────
export default {
  data: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Suggestion management')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('setup')
      .setDescription('Post the suggestion panel and set the suggestions channel (admin only)')
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post suggestions in').setRequired(true))
    ),

  category: 'community',

  async execute(interaction, config, client) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return InteractionHelper.safeReply(interaction, {
        embeds: [errorEmbed('Permission Denied', 'You need `Manage Server` to set up suggestions.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = interaction.options.getChannel('channel');
    await updateGuildConfig(interaction.guildId, { suggestionsChannelId: channel.id });

    const panelEmbed = new EmbedBuilder()
      .setTitle('Submit a Suggestion')
      .setDescription('Have an idea or feature request for Phantom? Click the button below to submit it.\n\nKeep suggestions clear and relevant — one idea per submission.')
      .setColor(0x7c3aed)
      .setFooter({ text: 'Phantom Suggestions' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('suggest_open_modal')
        .setLabel('Submit a Suggestion')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('💡')
    );

    await interaction.channel.send({ embeds: [panelEmbed], components: [row] });

    return InteractionHelper.safeReply(interaction, {
      embeds: [successEmbed('Suggestion panel posted!', `Suggestions will be posted to ${channel}.`)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
