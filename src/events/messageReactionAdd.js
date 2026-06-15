// src/events/messageReactionAdd.js
// Handles the starboard feature — reposts messages that reach the star threshold.
import { Events, EmbedBuilder } from 'discord.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

function getStarboardKey(guildId, messageId) {
  return `starboard:${guildId}:${messageId}`;
}

export default {
  name: Events.MessageReactionAdd,
  async execute(reaction, user, client) {
    try {
      if (user.bot) return;

      // Fetch partial reaction/message if needed
      if (reaction.partial) await reaction.fetch().catch(() => null);
      if (!reaction.message.guild) return;

      // Only handle ⭐
      if (reaction.emoji.name !== '⭐') return;

      const { guild, channel, id: messageId } = reaction.message;

      const config = await getGuildConfig(client, guild.id);
      if (!config.starboardEnabled || !config.starboardChannelId) return;

      // Don't star messages in the starboard channel itself
      if (channel.id === config.starboardChannelId) return;

      const threshold = config.starboardThreshold ?? 3;
      const starCount = reaction.count;

      if (starCount < threshold) return;

      const starboardChannel = guild.channels.cache.get(config.starboardChannelId);
      if (!starboardChannel) return;

      // Fetch message if partial
      const msg = reaction.message.partial
        ? await reaction.message.fetch().catch(() => null)
        : reaction.message;
      if (!msg) return;

      const key     = getStarboardKey(guild.id, messageId);
      const existing = await getFromDb(key, null);

      if (existing) {
        // Update the star count on the existing starboard post
        try {
          const starMsg = await starboardChannel.messages.fetch(existing.starboardMessageId).catch(() => null);
          if (starMsg) {
            const updatedContent = `⭐ **${starCount}** — ${channel}`;
            await starMsg.edit({ content: updatedContent });
          }
        } catch {}
        return;
      }

      // Build the starboard embed
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
        .setDescription(msg.content || null)
        .addFields({ name: 'Source', value: `[Jump to message](${msg.url})`, inline: true })
        .setTimestamp(msg.createdAt);

      // Attach first image if present
      const image = msg.attachments.find(a => a.contentType?.startsWith('image/'));
      if (image) embed.setImage(image.url);
      if (msg.embeds[0]?.image) embed.setImage(msg.embeds[0].image.url);

      const sent = await starboardChannel.send({
        content: `⭐ **${starCount}** — ${channel}`,
        embeds: [embed],
      });

      await setInDb(key, { starboardMessageId: sent.id, originalMessageId: messageId });
      logger.info(`[Starboard] Posted message ${messageId} from ${channel.name} (${starCount} stars)`);
    } catch (err) {
      logger.error('[Starboard] messageReactionAdd error:', err.message);
    }
  },
};
