// src/commands/Developer/vision.js
// Developer tier — AI vision assistant, send screenshots for Lua code suggestions
import { SlashCommandBuilder, EmbedBuilder, MessageFlags, InteractionContextType, ApplicationIntegrationType } from 'discord.js';
import { errorEmbed } from '../../utils/embeds.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { getEffectiveTier } from '../../web/stripePayments.js';
import { logger } from '../../utils/logger.js';

const TIER_LIMITS = {
  'developer-basic':  100,
  'developer-pro':    200,
  'developer-elite':  400,
  'enterprise':      9999,
};

function usageKey(userId) {
  return `vision_usage:${userId}:${new Date().toISOString().slice(0, 7)}`;
}

async function getUsage(userId) {
  return (await getFromDb(usageKey(userId), 0)) || 0;
}

async function incrementUsage(userId) {
  const current = await getUsage(userId);
  await setInDb(usageKey(userId), current + 1);
  return current + 1;
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

function getMediaType(contentType) {
  if (contentType?.includes('png'))  return 'image/png';
  if (contentType?.includes('gif'))  return 'image/gif';
  if (contentType?.includes('webp')) return 'image/webp';
  return 'image/jpeg';
}

async function callClaudeVision(images, prompt) {
  const content = [];

  for (const img of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }

  content.push({ type: 'text', text: prompt });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are Phantom, an expert Roblox and Lua developer assistant. When shown screenshots of Roblox Studio or Roblox games, analyse them in detail and provide actionable Lua code suggestions. Be specific about what you see — positions, colours, UI elements, models, lighting, scripts — and explain exactly what code would be needed to recreate, modify, or interact with what is shown. Always format code in \`\`\`lua code blocks. If multiple screenshots are provided, analyse them together as a full picture of the scene.`,
      messages: [{ role: 'user', content }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || 'No response received.';
}

export default {
  data: new SlashCommandBuilder()
    .setName('vision')
    .setDescription('Send screenshots to Phantom AI for Lua code suggestions (up to 8 images)')
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
    .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel])
    .addAttachmentOption(o => o.setName('image1').setDescription('Screenshot 1').setRequired(true))
    .addStringOption(o => o.setName('prompt').setDescription('What do you want Phantom to help with? (optional)').setRequired(false))
    .addAttachmentOption(o => o.setName('image2').setDescription('Screenshot 2').setRequired(false))
    .addAttachmentOption(o => o.setName('image3').setDescription('Screenshot 3').setRequired(false))
    .addAttachmentOption(o => o.setName('image4').setDescription('Screenshot 4').setRequired(false))
    .addAttachmentOption(o => o.setName('image5').setDescription('Screenshot 5').setRequired(false))
    .addAttachmentOption(o => o.setName('image6').setDescription('Screenshot 6').setRequired(false))
    .addAttachmentOption(o => o.setName('image7').setDescription('Screenshot 7').setRequired(false))
    .addAttachmentOption(o => o.setName('image8').setDescription('Screenshot 8').setRequired(false)),

  category: 'developer',

  async execute(interaction, config, client) {
    const userId  = interaction.user.id;
    const guildId = interaction.guildId || null;

    // Tier check
    const tier  = await getEffectiveTier(userId, guildId);
    const limit = TIER_LIMITS[tier];

    if (!limit) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x7c3aed)
          .setTitle('🔒 Developer Feature')
          .setDescription('The Vision AI assistant requires a **Developer tier** subscription.\n\nUpgrade at [phantombot.org/dashboard](https://phantombot.org/dashboard).')],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Usage check
    const used = await getUsage(userId);
    if (used >= limit) {
      return interaction.reply({
        embeds: [errorEmbed('Request Limit Reached', `You have used all ${limit} vision requests for this month. Resets on the 1st.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    try {
      // Collect all provided attachments
      const attachments = [];
      for (let i = 1; i <= 8; i++) {
        const att = interaction.options.getAttachment(`image${i}`);
        if (att) attachments.push(att);
      }

      // Filter to images only
      const imageAtts = attachments.filter(a => a.contentType?.startsWith('image/'));
      if (imageAtts.length === 0) {
        return interaction.editReply({
          embeds: [errorEmbed('No Images', 'Please attach at least one image (PNG, JPG, GIF, or WebP).')],
        });
      }

      const prompt = interaction.options.getString('prompt') ||
        'Analyse these screenshots in detail. Describe exactly what you see, then provide specific Lua code to recreate, modify, or interact with what is shown. Be as specific and actionable as possible.';

      // Download and base64-encode all images
      const images = [];
      for (const att of imageAtts) {
        const base64    = await fetchImageAsBase64(att.url);
        const mediaType = getMediaType(att.contentType);
        images.push({ base64, mediaType });
      }

      const result  = await callClaudeVision(images, prompt);
      const newUsed = await incrementUsage(userId);
      const remaining = limit - newUsed;

      const maxLength = 1900;
      const header    = `👁️ **Vision AI** · ${images.length} image${images.length > 1 ? 's' : ''} · ${remaining} requests left\n\n`;

      if ((header + result).length <= 2000) {
        const embed = new EmbedBuilder()
          .setTitle(`👁️ Vision AI — ${images.length} image${images.length > 1 ? 's' : ''}`)
          .setColor(0x7c3aed)
          .setDescription(result.slice(0, 4096))
          .setFooter({ text: `${remaining} vision requests remaining this month` });
        return interaction.editReply({ embeds: [embed] });
      }

      // Long response — send as chunked plain text
      await interaction.editReply({ content: header + result.slice(0, maxLength) });
      let offset = maxLength;
      while (offset < result.length && offset < maxLength * 4) {
        await interaction.followUp({ content: result.slice(offset, offset + maxLength) });
        offset += maxLength;
      }

      logger.info(`[VisionAI] ${interaction.user.tag} used /vision with ${images.length} image(s) — ${newUsed}/${limit} requests`);
    } catch (err) {
      logger.error('[VisionAI] Error:', err.message);
      return interaction.editReply({
        embeds: [errorEmbed('AI Error', `Something went wrong: \`${err.message}\``)],
      });
    }
  },
};
