// src/commands/Community/review.js
// Staff posts a persistent "Leave a Review" button; members click it to submit
// a star rating + review text via modal. Bot formats and posts to #reviews.
import {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getGuildConfig, updateGuildConfig } from '../../services/guildConfig.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

const STARS = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];

// ── Button handler (click → modal) ────────────────────────────────────────────
export async function handleReviewButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('review_submit_modal')
    .setTitle('Leave a Review')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('rating')
          .setLabel('Rating (1–5 stars)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter a number from 1 to 5')
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(1)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('review_text')
          .setLabel('Your Review')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Share your experience with Phantom...')
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(500)
      ),
    );
  await interaction.showModal(modal);
}

// ── Modal handler (submit → post embed) ───────────────────────────────────────
export async function handleReviewModal(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ratingRaw = interaction.fields.getTextInputValue('rating').trim();
  const rating    = parseInt(ratingRaw, 10);

  if (isNaN(rating) || rating < 1 || rating > 5) {
    return interaction.editReply({
      embeds: [errorEmbed('Invalid Rating', 'Please enter a number between 1 and 5.')],
    });
  }

  const text   = interaction.fields.getTextInputValue('review_text').trim();
  const config = await getGuildConfig(client, interaction.guildId);

  if (!config.reviewChannelId) {
    return interaction.editReply({
      embeds: [errorEmbed('Not Configured', 'No review channel has been set up.')],
    });
  }

  const channel = interaction.guild.channels.cache.get(config.reviewChannelId);
  if (!channel) {
    return interaction.editReply({
      embeds: [errorEmbed('Channel Not Found', 'The review channel no longer exists.')],
    });
  }

  const embed = new EmbedBuilder()
    .setColor(rating >= 4 ? 0x57f287 : rating === 3 ? 0xfee75c : 0xed4245)
    .setAuthor({
      name: interaction.member?.displayName || interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setDescription(`*"${text}"*`)
    .addFields({ name: 'Rating', value: `${STARS[rating]} (${rating}/5)`, inline: true })
    .setTimestamp()
    .setFooter({ text: 'Phantom Review' });

  await channel.send({ embeds: [embed] });

  logger.info(`[Review] ${interaction.user.tag} left a ${rating}/5 review in ${interaction.guild.name}`);

  return interaction.editReply({
    embeds: [successEmbed('Review submitted! Thank you for your feedback.')],
  });
}

// ── Slash command ──────────────────────────────────────────────────────────────
export default {
  data: new SlashCommandBuilder()
    .setName('review')
    .setDescription('Review system')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('setup')
      .setDescription('Post the review button and set the review channel (admin only)')
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post reviews in').setRequired(true))
    ),

  category: 'community',

  async execute(interaction, config, client) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return InteractionHelper.safeReply(interaction, {
        embeds: [errorEmbed('Permission Denied', 'You need `Manage Server` to set up reviews.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = interaction.options.getChannel('channel');
    await updateGuildConfig(interaction.guildId, { reviewChannelId: channel.id });

    // Post the persistent button in the current channel (where setup is run)
    const panelEmbed = new EmbedBuilder()
      .setTitle('Leave a Review')
      .setDescription('Enjoyed using Phantom? Click the button below to leave a review.\n\nYour feedback helps us improve and lets others know what to expect.')
      .setColor(0x7c3aed)
      .setFooter({ text: 'Phantom Reviews' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('review_open_modal')
        .setLabel('Leave a Review')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('⭐')
    );

    await interaction.channel.send({ embeds: [panelEmbed], components: [row] });

    return InteractionHelper.safeReply(interaction, {
      embeds: [successEmbed('Review panel posted!', `Reviews will be posted to ${channel}.`)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
