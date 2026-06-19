import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../../utils/embeds.js';
import { shopItems } from '../../config/shop/items.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { getGuildConfig } from '../../services/guildConfig.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { MessageTemplates } from '../../utils/messageTemplates.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

import shopBrowse from './modules/shop_browse.js';
import shopConfigSetrole from './modules/shop_config_setrole.js';

const SHOP_ITEMS = shopItems;

export default {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Economy shop — browse, buy, and manage your inventory.')
    .addSubcommand(subcommand =>
      subcommand
        .setName('browse')
        .setDescription('Browse the economy shop.'),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('buy')
        .setDescription('Buy an item from the shop')
        .addStringOption(option =>
          option
            .setName('item_id')
            .setDescription('ID of the item to buy')
            .setRequired(true),
        )
        .addIntegerOption(option =>
          option
            .setName('quantity')
            .setDescription('Quantity to buy (default: 1)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10),
        ),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('inventory')
        .setDescription('View your economy inventory'),
    )
    .addSubcommandGroup(group =>
      group
        .setName('config')
        .setDescription('Configure shop settings. (Manage Server required)')
        .addSubcommand(subcommand =>
          subcommand
            .setName('setrole')
            .setDescription('Set the Discord role granted when the Premium Role shop item is purchased.')
            .addRoleOption(option =>
              option
                .setName('role')
                .setDescription('The role to grant for Premium Role purchases.')
                .setRequired(true),
            ),
        ),
    ),

  async execute(interaction, config, client) {
    try {
      const subcommandGroup = interaction.options.getSubcommandGroup(false);
      const subcommand      = interaction.options.getSubcommand();

      if (subcommand === 'browse') {
        return await shopBrowse.execute(interaction, config, client);
      }

      if (subcommand === 'buy') {
        return await executeBuy(interaction, config, client);
      }

      if (subcommand === 'inventory') {
        return await executeInventory(interaction, config, client);
      }

      if (subcommandGroup === 'config' && subcommand === 'setrole') {
        return await shopConfigSetrole.execute(interaction, config, client);
      }

      return InteractionHelper.safeReply(interaction, {
        embeds: [errorEmbed('Error', 'Unknown subcommand.')],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error('shop command error:', error);
      await InteractionHelper.safeReply(interaction, {
        content: '❌ An error occurred while running the shop command.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  },
};

// Original buy.js logic, unchanged.
const executeBuy = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const userId   = interaction.user.id;
  const guildId  = interaction.guildId;
  const itemId   = interaction.options.getString("item_id").toLowerCase();
  const quantity = interaction.options.getInteger("quantity") || 1;

  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) {
    throw createError(`Item ${itemId} not found`, ErrorTypes.VALIDATION,
      `The item ID \`${itemId}\` does not exist in the shop.`, { itemId });
  }

  if (quantity < 1) {
    throw createError("Invalid quantity", ErrorTypes.VALIDATION,
      "You must purchase a quantity of 1 or more.", { quantity });
  }

  const totalCost = item.price * quantity;

  const guildConfig    = await getGuildConfig(client, guildId);
  const PREMIUM_ROLE_ID = guildConfig.premiumRoleId;

  const userData = await getEconomyData(client, guildId, userId);

  if (userData.wallet < totalCost) {
    throw createError("Insufficient funds", ErrorTypes.VALIDATION,
      `You need **$${totalCost.toLocaleString()}** to purchase ${quantity}x **${item.name}**, but you only have **$${userData.wallet.toLocaleString()}** in cash.`,
      { required: totalCost, current: userData.wallet, itemId, quantity });
  }

  if (item.type === "role" && itemId === "premium_role") {
    if (!PREMIUM_ROLE_ID) {
      throw createError("Premium role not configured", ErrorTypes.CONFIGURATION,
        "The **Premium Shop Role** has not been configured by a server administrator yet.", { itemId });
    }
    if (interaction.member.roles.cache.has(PREMIUM_ROLE_ID)) {
      throw createError("Role already owned", ErrorTypes.VALIDATION,
        `You already have the **${item.name}** role.`, { itemId, roleId: PREMIUM_ROLE_ID });
    }
    if (quantity > 1) {
      throw createError("Invalid quantity for role", ErrorTypes.VALIDATION,
        `You can only purchase the **${item.name}** role once.`, { itemId, quantity });
    }
  }

  userData.wallet -= totalCost;

  let successDescription = `You successfully purchased ${quantity}x **${item.name}** for **$${totalCost.toLocaleString()}**!`;

  if (item.type === "role" && itemId === "premium_role") {
    const role = interaction.guild.roles.cache.get(PREMIUM_ROLE_ID);
    if (!role) {
      throw createError("Role not found", ErrorTypes.CONFIGURATION,
        "The configured premium role no longer exists in this guild.", { roleId: PREMIUM_ROLE_ID });
    }
    try {
      await interaction.member.roles.add(role, `Purchased role: ${item.name}`);
      successDescription += `\n\n**👑 The role ${role.toString()} has been granted to you!**`;
    } catch (roleError) {
      userData.wallet += totalCost;
      await setEconomyData(client, guildId, userId, userData);
      throw createError("Role assignment failed", ErrorTypes.DISCORD_API,
        "Successfully deducted money, but failed to grant the role. Your cash has been refunded.",
        { roleId: PREMIUM_ROLE_ID, originalError: roleError.message });
    }
  } else if (item.type === "upgrade") {
    userData.upgrades[itemId] = true;
    successDescription += "\n\n**✨ Your upgrade is now active!**";
  } else if (item.type === "consumable") {
    userData.inventory[itemId] = (userData.inventory[itemId] || 0) + quantity;
  }

  await setEconomyData(client, guildId, userId, userData);

  const embed = successEmbed("💰 Purchase Successful", successDescription)
    .addFields({ name: "New Balance", value: `$${userData.wallet.toLocaleString()}`, inline: true });

  await InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
}, { command: 'shop:buy' });

// Original inventory.js logic, unchanged.
const executeInventory = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;

  logger.debug(`[ECONOMY] Inventory requested for ${userId}`, { userId, guildId });

  const userData = await getEconomyData(client, guildId, userId);
  if (!userData) {
    throw createError("Failed to load economy data for inventory", ErrorTypes.DATABASE,
      "Failed to load your economy data. Please try again later.", { userId, guildId });
  }

  const inventory = userData.inventory || {};

  let inventoryDescription = "Your inventory is currently empty.";
  if (Object.keys(inventory).length > 0) {
    inventoryDescription = Object.entries(inventory)
      .filter(([itemId, quantity]) => {
        const item = SHOP_ITEMS.find(i => i.id === itemId);
        return quantity > 0 && item;
      })
      .map(([itemId, quantity]) => {
        const item = SHOP_ITEMS.find(i => i.id === itemId);
        return `**${item.name}:** ${quantity}x`;
      })
      .join("\n");
  }

  logger.info(`[ECONOMY] Inventory retrieved`, {
    userId, guildId, itemCount: Object.keys(inventory).length
  });

  const embed = createEmbed({
    title:       `📦 ${interaction.user.username}'s Inventory`,
    description: inventoryDescription,
  }).setThumbnail(interaction.user.displayAvatarURL());

  await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}, { command: 'shop:inventory' });
