// src/commands/linkroblox.js
import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { ROBLOX_LINK_BUTTON_ID, ROBLOX_UPDATE_BUTTON_ID } from '../handlers/robloxVerify.js';

export default {
  data: new SlashCommandBuilder()
    .setName('linkroblox')
    .setDescription('Post the Roblox account-linking panel'),

  async execute(interaction, client) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(ROBLOX_LINK_BUTTON_ID)
        .setLabel('Link Roblox')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(ROBLOX_UPDATE_BUTTON_ID)
        .setLabel('Update')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({
      embeds: [successEmbed(
        'Roblox Account Linking',
        'Click **Link Roblox** to connect your Roblox account, or **Update** to refresh your roles if your rank changed.',
      )],
      components: [row],
    });
  },
};
