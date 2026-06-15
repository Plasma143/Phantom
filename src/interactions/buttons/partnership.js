// src/interactions/buttons/partnership.js
// Handles partnership_accept and partnership_deny buttons posted in partnership tickets.
import {
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags,
} from 'discord.js';
import { logger } from '../../utils/logger.js';

const partnershipAccept = {
  name: 'partnership_accept',
  async execute(interaction) {
    // Show advertisement collection modal
    const modal = new ModalBuilder()
      .setCustomId('partnership_ad_modal')
      .setTitle('Partnership — Advertisement');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('server_name')
          .setLabel('Server / Community Name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. The Clone Army')
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('invite_link')
          .setLabel('Discord Invite Link')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. discord.gg/yourserver')
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Server Description')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('A short description of your community...')
          .setRequired(true)
          .setMaxLength(500)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('member_count')
          .setLabel('Member Count')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 250')
          .setRequired(true)
          .setMaxLength(20)
      ),
    );

    await interaction.showModal(modal);
  },
};

const partnershipDeny = {
  name: 'partnership_deny',
  async execute(interaction) {
    const modal = new ModalBuilder()
      .setCustomId('partnership_deny_modal')
      .setTitle('Partnership — Denial Reason');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason for denial')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Explain why the partnership is being declined...')
          .setRequired(false)
          .setMaxLength(500)
      ),
    );

    await interaction.showModal(modal);
  },
};

export default [partnershipAccept, partnershipDeny];
