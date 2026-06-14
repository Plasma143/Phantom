// src/commands/Utility/embed.js
// Allows staff to compose and send/edit rich embeds through the bot.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} from 'discord.js';
import { logger } from '../../utils/logger.js';

function parseColor(str) {
  if (!str) return 0x5865F2;
  const hex = parseInt(str.replace(/^#/, ''), 16);
  return isNaN(hex) ? 0x5865F2 : hex;
}

export default {
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Create, send, or edit custom embed messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)

    // ── send ──────────────────────────────────────────────────────────────────
    .addSubcommand(sub => sub
      .setName('send')
      .setDescription('Send a custom embed to a channel')
      .addChannelOption(o => o
        .setName('channel')
        .setDescription('Channel to send the embed to')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Embed title (supports **bold**, *italic*)').setMaxLength(256))
      .addStringOption(o => o.setName('description').setDescription('Main body text (supports markdown)').setMaxLength(4000))
      .addStringOption(o => o.setName('color').setDescription('Hex colour, e.g. #FF5733').setMaxLength(9))
      .addStringOption(o => o.setName('footer').setDescription('Footer text').setMaxLength(2048))
      .addStringOption(o => o.setName('image').setDescription('Large bottom image URL'))
      .addStringOption(o => o.setName('thumbnail').setDescription('Small top-right image URL'))
      .addStringOption(o => o.setName('author').setDescription('Author name shown at the top'))
      .addBooleanOption(o => o.setName('timestamp').setDescription('Show current timestamp in footer'))
      .addBooleanOption(o => o.setName('ping_here').setDescription('Send @here before the embed'))
    )

    // ── edit ──────────────────────────────────────────────────────────────────
    .addSubcommand(sub => sub
      .setName('edit')
      .setDescription("Edit one of the bot's existing embeds")
      .addStringOption(o => o.setName('message_id').setDescription('ID of the message to edit').setRequired(true))
      .addChannelOption(o => o
        .setName('channel')
        .setDescription('Channel containing the message')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('New title').setMaxLength(256))
      .addStringOption(o => o.setName('description').setDescription('New description').setMaxLength(4000))
      .addStringOption(o => o.setName('color').setDescription('New hex colour').setMaxLength(9))
      .addStringOption(o => o.setName('footer').setDescription('New footer').setMaxLength(2048))
      .addStringOption(o => o.setName('image').setDescription('New image URL'))
      .addStringOption(o => o.setName('thumbnail').setDescription('New thumbnail URL'))
    )

    // ── announce ──────────────────────────────────────────────────────────────
    .addSubcommand(sub => sub
      .setName('announce')
      .setDescription('Send a styled announcement embed (title + description + optional ping)')
      .addChannelOption(o => o
        .setName('channel')
        .setDescription('Channel to announce in')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Announcement title').setRequired(true).setMaxLength(256))
      .addStringOption(o => o.setName('body').setDescription('Announcement body').setRequired(true).setMaxLength(4000))
      .addStringOption(o => o
        .setName('ping')
        .setDescription('Who to ping')
        .addChoices(
          { name: 'No ping', value: 'none' },
          { name: '@here', value: 'here' },
          { name: '@everyone', value: 'everyone' },
        ))
      .addStringOption(o => o.setName('color').setDescription('Hex colour').setMaxLength(9))
    ),

  category: 'commands',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // ── SEND ──
    if (sub === 'send') {
      const channel     = interaction.options.getChannel('channel');
      const title       = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const color       = parseColor(interaction.options.getString('color'));
      const footer      = interaction.options.getString('footer');
      const image       = interaction.options.getString('image');
      const thumbnail   = interaction.options.getString('thumbnail');
      const author      = interaction.options.getString('author');
      const showTs      = interaction.options.getBoolean('timestamp') ?? true;
      const pingHere    = interaction.options.getBoolean('ping_here') ?? false;

      if (!title && !description) {
        return interaction.editReply('❌ Provide at least a title or description.');
      }

      const embed = new EmbedBuilder().setColor(color);
      if (title)       embed.setTitle(title);
      if (description) embed.setDescription(description);
      if (footer)      embed.setFooter({ text: footer });
      if (image)       embed.setImage(image);
      if (thumbnail)   embed.setThumbnail(thumbnail);
      if (author)      embed.setAuthor({ name: author });
      if (showTs)      embed.setTimestamp();

      try {
        await channel.send({ content: pingHere ? '@here' : null, embeds: [embed] });
        return interaction.editReply(`✅ Embed sent to ${channel}.`);
      } catch (e) {
        logger.warn('embed send failed:', e.message);
        return interaction.editReply(`❌ Couldn't send to that channel — check my permissions.`);
      }
    }

    // ── EDIT ──
    if (sub === 'edit') {
      const msgId   = interaction.options.getString('message_id');
      const channel = interaction.options.getChannel('channel');

      let msg;
      try {
        msg = await channel.messages.fetch(msgId);
      } catch {
        return interaction.editReply('❌ Message not found. Check the ID and channel.');
      }

      if (msg.author.id !== interaction.client.user.id) {
        return interaction.editReply("❌ I can only edit messages I sent.");
      }

      const existing = msg.embeds[0];
      const embed = new EmbedBuilder();

      embed.setTitle(interaction.options.getString('title')       ?? existing?.title       ?? '');
      embed.setDescription(interaction.options.getString('description') ?? existing?.description ?? '');
      embed.setColor(parseColor(interaction.options.getString('color') ?? null) || existing?.color || 0x5865F2);

      const footer = interaction.options.getString('footer') ?? existing?.footer?.text;
      if (footer) embed.setFooter({ text: footer });

      const image = interaction.options.getString('image') ?? existing?.image?.url;
      if (image) embed.setImage(image);

      const thumb = interaction.options.getString('thumbnail') ?? existing?.thumbnail?.url;
      if (thumb) embed.setThumbnail(thumb);

      if (existing?.author?.name) embed.setAuthor({ name: existing.author.name });
      if (existing?.timestamp)    embed.setTimestamp(new Date(existing.timestamp));

      try {
        await msg.edit({ embeds: [embed] });
        return interaction.editReply('✅ Message updated.');
      } catch (e) {
        return interaction.editReply(`❌ Edit failed: ${e.message}`);
      }
    }

    // ── ANNOUNCE ──
    if (sub === 'announce') {
      const channel = interaction.options.getChannel('channel');
      const title   = interaction.options.getString('title');
      const body    = interaction.options.getString('body');
      const pingOpt = interaction.options.getString('ping') ?? 'none';
      const color   = parseColor(interaction.options.getString('color') ?? '#5865F2');

      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`📢 ${title}`)
        .setDescription(body)
        .setTimestamp()
        .setFooter({ text: `Announced by ${interaction.user.tag}` });

      const pingContent = pingOpt === 'here' ? '@here' : pingOpt === 'everyone' ? '@everyone' : null;

      try {
        await channel.send({ content: pingContent, embeds: [embed] });
        return interaction.editReply(`✅ Announcement sent to ${channel}.`);
      } catch (e) {
        return interaction.editReply(`❌ Failed: ${e.message}`);
      }
    }
  },
};
