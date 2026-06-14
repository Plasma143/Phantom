// src/commands/Utility/tts.js
// Sends a Discord-native TTS message (Discord reads it aloud to users who have
// TTS enabled). Works in any text channel — no voice connection needed.
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Send a text-to-speech message that Discord reads aloud')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addStringOption(o => o
      .setName('text')
      .setDescription('Text to speak (max 200 characters)')
      .setRequired(true)
      .setMaxLength(200))
    .addChannelOption(o => o
      .setName('channel')
      .setDescription('Channel to send TTS in (defaults to this channel)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(false)),
  category: 'commands',

  async execute(interaction) {
    const text    = interaction.options.getString('text');
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    try {
      await channel.send({ content: text, tts: true });
      return interaction.reply({
        content: `🔊 TTS sent to ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      return interaction.reply({
        content: `❌ Couldn't send TTS: ${e.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
