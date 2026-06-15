// src/commands/Giveaway/giveaway.js
// Replaces: gcreate.js, gdelete.js, gend.js, greroll.js
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes, handleInteractionError } from '../../utils/errorHandler.js';
import { saveGiveaway, getGuildGiveaways, deleteGiveaway } from '../../utils/giveaways.js';
import {
  parseDuration,
  validatePrize,
  validateWinnerCount,
  createGiveawayEmbed,
  createGiveawayButtons,
  endGiveaway as endGiveawayService,
  selectWinners,
} from '../../services/giveawayService.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const MANAGE_GUILD = PermissionFlagsBits.ManageGuild;

function requireGuild(interaction) {
  if (!interaction.inGuild()) {
    throw new TitanBotError(
      'Giveaway command used outside guild',
      ErrorTypes.VALIDATION,
      'This command can only be used in a server.',
      { userId: interaction.user.id }
    );
  }
  if (!interaction.member.permissions.has(MANAGE_GUILD)) {
    throw new TitanBotError(
      'User lacks ManageGuild permission',
      ErrorTypes.PERMISSION,
      "You need the 'Manage Server' permission to manage giveaways.",
      { userId: interaction.user.id, guildId: interaction.guildId }
    );
  }
}

function validMessageId(messageId) {
  if (!messageId || !/^\d+$/.test(messageId)) {
    throw new TitanBotError(
      'Invalid message ID format',
      ErrorTypes.VALIDATION,
      'Please provide a valid message ID.',
      { providedId: messageId }
    );
  }
}

async function findGiveaway(interaction, messageId) {
  const giveaways = await getGuildGiveaways(interaction.client, interaction.guildId);
  const giveaway = giveaways.find(g => g.messageId === messageId);
  if (!giveaway) {
    throw new TitanBotError(
      `Giveaway not found: ${messageId}`,
      ErrorTypes.VALIDATION,
      'No giveaway was found with that message ID.',
      { messageId, guildId: interaction.guildId }
    );
  }
  return giveaway;
}

export default {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Manage giveaways')
    .setDefaultMemberPermissions(MANAGE_GUILD)
    // --- CREATE ---
    .addSubcommand(sub => sub
      .setName('create')
      .setDescription('Start a new giveaway')
      .addStringOption(opt => opt.setName('duration').setDescription('How long the giveaway lasts (e.g. 1h, 30m, 5d)').setRequired(true))
      .addIntegerOption(opt => opt.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(10).setRequired(true))
      .addStringOption(opt => opt.setName('prize').setDescription('The prize being given away').setRequired(true))
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post in (defaults to current)').addChannelTypes(ChannelType.GuildText))
      .addIntegerOption(opt => opt.setName('min_account_age').setDescription('Minimum Discord account age in days to enter (default: 7)').setMinValue(0).setMaxValue(365))
      .addIntegerOption(opt => opt.setName('min_messages').setDescription('Minimum messages sent in this server to enter (default: 10)').setMinValue(0).setMaxValue(10000))
    )
    // --- DELETE ---
    .addSubcommand(sub => sub
      .setName('delete')
      .setDescription('Delete a giveaway and remove it from the database')
      .addStringOption(opt => opt.setName('messageid').setDescription('Message ID of the giveaway').setRequired(true))
    )
    // --- END ---
    .addSubcommand(sub => sub
      .setName('end')
      .setDescription('End an active giveaway immediately and pick winners')
      .addStringOption(opt => opt.setName('messageid').setDescription('Message ID of the giveaway to end').setRequired(true))
    )
    // --- REROLL ---
    .addSubcommand(sub => sub
      .setName('reroll')
      .setDescription('Reroll the winner(s) of an ended giveaway')
      .addStringOption(opt => opt.setName('messageid').setDescription('Message ID of the ended giveaway').setRequired(true))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    try {
      requireGuild(interaction);

      // ── CREATE ──────────────────────────────────────────────────────────────
      if (sub === 'create') {
        logger.info(`Giveaway creation started by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const durationString = interaction.options.getString('duration');
        const winnerCount    = interaction.options.getInteger('winners');
        const prize          = interaction.options.getString('prize');
        const targetChannel  = interaction.options.getChannel('channel') || interaction.channel;
        const minAccountAgeDays = interaction.options.getInteger('min_account_age') ?? 7;
        const minMessages       = interaction.options.getInteger('min_messages') ?? 10;

        const durationMs = parseDuration(durationString);
        validateWinnerCount(winnerCount);
        const prizeName = validatePrize(prize);

        if (!targetChannel.isTextBased()) {
          throw new TitanBotError('Target channel is not text-based', ErrorTypes.VALIDATION, 'The channel must be a text channel.', { channelId: targetChannel.id });
        }

        const endTime = Date.now() + durationMs;
        const initialData = {
          messageId: 'placeholder',
          channelId: targetChannel.id,
          guildId: interaction.guildId,
          prize: prizeName,
          hostId: interaction.user.id,
          endTime,
          endsAt: endTime,
          winnerCount,
          participants: [],
          isEnded: false,
          ended: false,
          createdAt: new Date().toISOString(),
          minAccountAgeDays,
          minMessages,
        };

        const embed = createGiveawayEmbed(initialData, 'active');
        const row   = createGiveawayButtons(false);
        const msg   = await targetChannel.send({ content: '🎉 **NEW GIVEAWAY** 🎉', embeds: [embed], components: [row] });

        initialData.messageId = msg.id;
        await saveGiveaway(interaction.client, interaction.guildId, initialData);

        try {
          await logEvent({ client: interaction.client, guildId: interaction.guildId, eventType: EVENT_TYPES.GIVEAWAY_CREATE, data: {
            description: `Giveaway created: ${prizeName}`,
            channelId: targetChannel.id,
            userId: interaction.user.id,
            fields: [
              { name: '🎁 Prize',    value: prizeName,                  inline: true },
              { name: '🏆 Winners',  value: winnerCount.toString(),     inline: true },
              { name: '⏰ Duration', value: durationString,             inline: true },
              { name: '📍 Channel',  value: targetChannel.toString(),   inline: true },
            ],
          }});
        } catch (e) { logger.debug('Error logging giveaway create:', e); }

        logger.info(`Giveaway created: ${msg.id} in ${targetChannel.name}`);
        return InteractionHelper.safeReply(interaction, {
          embeds: [successEmbed('Giveaway Started! 🎉', `Giveaway for **${prizeName}** started in ${targetChannel}, ends in **${durationString}**.`)],
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── DELETE ──────────────────────────────────────────────────────────────
      if (sub === 'delete') {
        const messageId = interaction.options.getString('messageid');
        validMessageId(messageId);
        logger.info(`Giveaway deletion by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const giveaway = await findGiveaway(interaction, messageId);

        let deletedMessage = false;
        let channelName = 'Unknown Channel';

        const tryDelete = async (channel) => {
          if (!channel?.isTextBased?.() || !channel.messages?.fetch) return false;
          const message = await channel.messages.fetch(messageId).catch(() => null);
          if (!message) return false;
          await message.delete();
          channelName = channel.name || 'unknown-channel';
          deletedMessage = true;
          return true;
        };

        try {
          const ch = await interaction.client.channels.fetch(giveaway.channelId).catch(() => null);
          if (!await tryDelete(ch) && interaction.guild) {
            for (const [, gc] of interaction.guild.channels.cache.filter(c => c.id !== giveaway.channelId && c.isTextBased())) {
              if (await tryDelete(gc).catch(() => false)) break;
            }
          }
        } catch (e) { logger.warn(`Could not delete giveaway message: ${e.message}`); }

        const removed = await deleteGiveaway(interaction.client, interaction.guildId, messageId);
        if (!removed) throw new TitanBotError('Failed to delete from DB', ErrorTypes.UNKNOWN, 'The giveaway could not be removed from the database.', { messageId });

        const after = await getGuildGiveaways(interaction.client, interaction.guildId);
        if (after.some(g => g.messageId === messageId)) throw new TitanBotError('Still exists after deletion', ErrorTypes.UNKNOWN, 'Deletion did not persist. Please try again.', { messageId });

        const winnerIds  = Array.isArray(giveaway.winnerIds) ? giveaway.winnerIds : [];
        const wasEnded   = giveaway.ended || giveaway.isEnded || winnerIds.length > 0;
        const statusMsg  = deletedMessage ? `and the message was deleted from #${channelName}` : 'but the message was already deleted or the channel was inaccessible.';
        const winnerMsg  = winnerIds.length > 0 ? `This giveaway had ${winnerIds.length} winner(s) selected.` : wasEnded ? 'Ended with no valid winners.' : 'No winner was picked before deletion.';

        try {
          await logEvent({ client: interaction.client, guildId: interaction.guildId, eventType: EVENT_TYPES.GIVEAWAY_DELETE, data: {
            description: `Giveaway deleted: ${giveaway.prize}`,
            channelId: giveaway.channelId,
            userId: interaction.user.id,
            fields: [
              { name: '🎁 Prize',   value: giveaway.prize || 'Unknown',                      inline: true },
              { name: '📊 Entries', value: (giveaway.participants?.length || 0).toString(),  inline: true },
            ],
          }});
        } catch (e) { logger.debug('Error logging giveaway delete:', e); }

        logger.info(`Giveaway deleted: ${messageId} in ${channelName}`);
        return InteractionHelper.safeReply(interaction, {
          embeds: [successEmbed('Giveaway Deleted', `Successfully deleted the giveaway for **${giveaway.prize}** ${statusMsg}. ${winnerMsg}`)],
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── END ─────────────────────────────────────────────────────────────────
      if (sub === 'end') {
        const messageId = interaction.options.getString('messageid');
        validMessageId(messageId);
        logger.info(`Giveaway end initiated by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const giveaway = await findGiveaway(interaction, messageId);
        const endResult = await endGiveawayService(interaction.client, giveaway, interaction.guildId, interaction.user.id);
        const { giveaway: updated, winners } = endResult;

        const channel = await interaction.client.channels.fetch(updated.channelId).catch(() => null);
        if (!channel?.isTextBased()) throw new TitanBotError('Channel not found', ErrorTypes.VALIDATION, 'Could not find the giveaway channel. State has been updated.', { channelId: updated.channelId });

        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) throw new TitanBotError('Message not found', ErrorTypes.VALIDATION, 'Could not find the giveaway message. State has been updated.', { messageId });

        await saveGiveaway(interaction.client, interaction.guildId, updated);
        await message.edit({ content: '🎉 **GIVEAWAY ENDED** 🎉', embeds: [createGiveawayEmbed(updated, 'ended', winners)], components: [createGiveawayButtons(true)] });

        if (winners.length > 0) {
          const mentions = winners.map(id => `<@${id}>`).join(', ');
          const pingMsg  = await channel.send({ content: `🎉 CONGRATULATIONS ${mentions}! You won **${updated.prize}**! Contact <@${updated.hostId}> to claim your prize.` });
          updated.winnerPingMessageId = pingMsg.id;
          await saveGiveaway(interaction.client, interaction.guildId, updated);
          try {
            await logEvent({ client: interaction.client, guildId: interaction.guildId, eventType: EVENT_TYPES.GIVEAWAY_WINNER, data: {
              description: `Giveaway ended with ${winners.length} winner(s)`,
              channelId: channel.id,
              userId: interaction.user.id,
              fields: [
                { name: '🎁 Prize',     value: updated.prize || 'Mystery Prize!',       inline: true },
                { name: '🏆 Winners',   value: mentions,                                inline: false },
                { name: '👥 Entries',   value: endResult.participantCount.toString(),   inline: true },
              ],
            }});
          } catch (e) { logger.debug('Error logging giveaway end:', e); }
        } else {
          await channel.send({ content: `The giveaway for **${updated.prize}** ended with no valid entries.` });
        }

        logger.info(`Giveaway ended by ${interaction.user.tag}: ${messageId}`);
        return InteractionHelper.safeReply(interaction, {
          embeds: [successEmbed('Giveaway Ended ✅', `Ended giveaway for **${updated.prize}** in ${channel}. Selected ${winners.length} winner(s) from ${endResult.participantCount} entries.`)],
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── REROLL ──────────────────────────────────────────────────────────────
      if (sub === 'reroll') {
        const messageId = interaction.options.getString('messageid');
        validMessageId(messageId);
        logger.info(`Giveaway reroll initiated by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const giveaway = await findGiveaway(interaction, messageId);

        if (!giveaway.isEnded && !giveaway.ended) {
          throw new TitanBotError('Giveaway still active', ErrorTypes.VALIDATION, 'This giveaway is still active. Use `/giveaway end` first.', { messageId });
        }

        const participants = giveaway.participants || [];
        if (participants.length < giveaway.winnerCount) {
          throw new TitanBotError('Insufficient participants', ErrorTypes.VALIDATION, 'Not enough entries to pick the required number of winners.', { participantsCount: participants.length });
        }

        const newWinners = selectWinners(participants, giveaway.winnerCount);
        const updated    = { ...giveaway, winnerIds: newWinners, rerolledAt: new Date().toISOString(), rerolledBy: interaction.user.id };

        const channel = await interaction.client.channels.fetch(giveaway.channelId).catch(() => null);
        if (!channel?.isTextBased()) {
          await saveGiveaway(interaction.client, interaction.guildId, updated);
          return InteractionHelper.safeReply(interaction, {
            embeds: [successEmbed('Reroll Complete', 'New winners saved. Could not find channel to announce.')],
            flags: MessageFlags.Ephemeral,
          });
        }

        const message       = await channel.messages.fetch(messageId).catch(() => null);
        const winnerMentions = newWinners.map(id => `<@${id}>`).join(', ');

        const announceReroll = async () => {
          const existingPing = giveaway.winnerPingMessageId
            ? await channel.messages.fetch(giveaway.winnerPingMessageId).catch(() => null)
            : null;
          const content = `🔄 **REROLL WINNERS** 🔄 CONGRATULATIONS ${winnerMentions}! New winners for **${giveaway.prize}**! Contact <@${giveaway.hostId}> to claim.`;
          if (existingPing) {
            await existingPing.edit({ content });
          } else {
            const pingMsg = await channel.send({ content });
            updated.winnerPingMessageId = pingMsg.id;
          }
        };

        if (!message) {
          await saveGiveaway(interaction.client, interaction.guildId, updated);
          await announceReroll();
        } else {
          await saveGiveaway(interaction.client, interaction.guildId, updated);
          await message.edit({ content: '🔄 **GIVEAWAY REROLLED** 🔄', embeds: [createGiveawayEmbed(updated, 'reroll', newWinners)], components: [createGiveawayButtons(true)] });
          await announceReroll();
        }

        try {
          await logEvent({ client: interaction.client, guildId: interaction.guildId, eventType: EVENT_TYPES.GIVEAWAY_REROLL, data: {
            description: `Giveaway rerolled: ${giveaway.prize}`,
            channelId: giveaway.channelId,
            userId: interaction.user.id,
            fields: [
              { name: '🎁 Prize',       value: giveaway.prize || 'Mystery Prize!',   inline: true },
              { name: '🏆 New Winners', value: winnerMentions,                        inline: false },
              { name: '👥 Entries',     value: participants.length.toString(),        inline: true },
            ],
          }});
        } catch (e) { logger.debug('Error logging giveaway reroll:', e); }

        logger.info(`Giveaway rerolled: ${messageId} with ${newWinners.length} new winners`);
        return InteractionHelper.safeReply(interaction, {
          embeds: [successEmbed('Reroll Successful ✅', `Rerolled giveaway for **${giveaway.prize}** in ${channel}. Selected ${newWinners.length} new winner(s).`)],
          flags: MessageFlags.Ephemeral,
        });
      }

    } catch (error) {
      await handleInteractionError(interaction, error, { type: 'command', commandName: `giveaway ${sub}`, context: 'giveaway_management' });
    }
  },
};
