import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, errorEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData, getMaxBankCapacity, addMoney, removeMoney } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { MessageTemplates } from '../../utils/messageTemplates.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import EconomyService from '../../services/economyService.js';

export default {
  data: new SlashCommandBuilder()
    .setName("bank")
    .setDescription("Banking commands: check balances, deposit, withdraw, and pay other users.")
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("balance")
        .setDescription("Check your or someone else's balance")
        .addUserOption((option) =>
          option.setName("user").setDescription("User to check balance for").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("deposit")
        .setDescription("Deposit money from your wallet into your bank")
        .addStringOption((option) =>
          option
            .setName("amount")
            .setDescription('Amount to deposit (number or "all")')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("withdraw")
        .setDescription("Withdraw money from your bank to your wallet")
        .addIntegerOption((option) =>
          option
            .setName("amount")
            .setDescription("Amount to withdraw")
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("pay")
        .setDescription("Pay another user some of your cash")
        .addUserOption((option) =>
          option.setName("user").setDescription("User to pay").setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("amount")
            .setDescription("Amount to pay")
            .setRequired(true)
            .setMinValue(1),
        ),
    ),

  category: "Economy",

  async execute(interaction, config, client) {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "balance":  return executeBalance(interaction, config, client);
      case "deposit":  return executeDeposit(interaction, config, client);
      case "withdraw": return executeWithdraw(interaction, config, client);
      case "pay":      return executePay(interaction, config, client);
    }
  },
};

// Original balance.js logic, unchanged.
const executeBalance = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const targetUser = interaction.options.getUser("user") || interaction.user;
  const guildId    = interaction.guildId;

  logger.debug(`[ECONOMY] Balance check for ${targetUser.id}`, { userId: targetUser.id, guildId });

  if (targetUser.bot) {
    throw createError("Bot user queried for balance", ErrorTypes.VALIDATION,
      "Bots don't have an economy balance.");
  }

  const userData = await getEconomyData(client, guildId, targetUser.id);
  if (!userData) {
    throw createError("Failed to load economy data", ErrorTypes.DATABASE,
      "Failed to load economy data. Please try again later.",
      { userId: targetUser.id, guildId });
  }

  const maxBank = getMaxBankCapacity(userData);
  const wallet  = typeof userData.wallet === 'number' ? userData.wallet : 0;
  const bank    = typeof userData.bank   === 'number' ? userData.bank   : 0;

  const embed = createEmbed({
    title:       `💰 ${targetUser.username}'s Balance`,
    description: `Here is the current financial status for ${targetUser.username}.`,
  })
    .addFields(
      { name: "💵 Cash",  value: `$${wallet.toLocaleString()}`, inline: true },
      { name: "🏦 Bank",  value: `$${bank.toLocaleString()} / $${maxBank.toLocaleString()}`, inline: true },
      { name: "💎 Total", value: `$${(wallet + bank).toLocaleString()}`, inline: true }
    )
    .setFooter({
      text:    `Requested by ${interaction.user.tag}`,
      iconURL: interaction.user.displayAvatarURL(),
    });

  logger.info(`[ECONOMY] Balance retrieved`, { userId: targetUser.id, wallet, bank });
  await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}, { command: 'bank:balance' });

// Original deposit.js logic, unchanged.
const executeDeposit = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const userId      = interaction.user.id;
  const guildId     = interaction.guildId;
  const amountInput = interaction.options.getString("amount");

  const userData = await getEconomyData(client, guildId, userId);
  if (!userData) {
    throw createError("Failed to load economy data", ErrorTypes.DATABASE,
      "Failed to load your economy data. Please try again later.", { userId, guildId });
  }

  const maxBank = getMaxBankCapacity(userData);
  let depositAmount;

  if (amountInput.toLowerCase() === "all") {
    depositAmount = userData.wallet;
  } else {
    depositAmount = parseInt(amountInput);
    if (isNaN(depositAmount) || depositAmount <= 0) {
      throw createError("Invalid deposit amount", ErrorTypes.VALIDATION,
        `Please enter a valid number or 'all'. You entered: \`${amountInput}\``,
        { amountInput, userId });
    }
  }

  if (depositAmount === 0) {
    throw createError("Zero deposit amount", ErrorTypes.VALIDATION,
      "You have no cash to deposit.", { userId, walletBalance: userData.wallet });
  }

  if (depositAmount > userData.wallet) {
    depositAmount = userData.wallet;
    await interaction.followUp({
      embeds: [MessageTemplates.ERRORS.INVALID_INPUT(
        "deposit amount",
        `You tried to deposit more than you have. Depositing your remaining cash: **$${depositAmount.toLocaleString()}**`
      )],
      flags: ["Ephemeral"],
    });
  }

  const availableSpace = maxBank - userData.bank;
  if (availableSpace <= 0) {
    throw createError("Bank is full", ErrorTypes.VALIDATION,
      `Your bank is currently full (Max Capacity: $${maxBank.toLocaleString()}). Purchase a **Bank Upgrade** to increase your limit.`,
      { maxBank, currentBank: userData.bank, userId });
  }

  if (depositAmount > availableSpace) {
    depositAmount = availableSpace;
    if (amountInput.toLowerCase() !== "all") {
      await interaction.followUp({
        embeds: [MessageTemplates.ERRORS.INVALID_INPUT(
          "deposit amount",
          `You only had space for **$${depositAmount.toLocaleString()}** in your bank account (Max: $${maxBank.toLocaleString()}). The rest remains in your cash.`
        )],
        flags: ["Ephemeral"],
      });
    }
  }

  if (depositAmount === 0) {
    throw createError("No space or cash for deposit", ErrorTypes.VALIDATION,
      "The amount you tried to deposit was either 0 or exceeded your bank capacity after checking your cash balance.",
      { depositAmount, availableSpace, walletBalance: userData.wallet });
  }

  userData.wallet -= depositAmount;
  userData.bank   += depositAmount;
  await setEconomyData(client, guildId, userId, userData);

  const embed = MessageTemplates.SUCCESS.DATA_UPDATED(
    "deposit",
    `You successfully deposited **$${depositAmount.toLocaleString()}** into your bank.`
  )
    .addFields(
      { name: "💵 New Cash Balance", value: `$${userData.wallet.toLocaleString()}`, inline: true },
      { name: "🏦 New Bank Balance", value: `$${userData.bank.toLocaleString()} / $${maxBank.toLocaleString()}`, inline: true }
    );

  await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}, { command: 'bank:deposit' });

// Original withdraw.js logic, unchanged.
const executeWithdraw = withErrorHandling(async (interaction, config, client) => {
  await InteractionHelper.safeDefer(interaction);

  const userId      = interaction.user.id;
  const guildId     = interaction.guildId;
  const amountInput = interaction.options.getInteger("amount");

  const userData = await getEconomyData(client, guildId, userId);
  if (!userData) {
    throw createError("Failed to load economy data", ErrorTypes.DATABASE,
      "Failed to load your economy data. Please try again later.", { userId, guildId });
  }

  let withdrawAmount = amountInput;
  if (withdrawAmount <= 0) {
    throw createError("Invalid withdrawal amount", ErrorTypes.VALIDATION,
      "You must withdraw a positive amount.", { amount: withdrawAmount, userId });
  }

  if (withdrawAmount > userData.bank) withdrawAmount = userData.bank;

  if (withdrawAmount === 0) {
    throw createError("Empty bank account", ErrorTypes.VALIDATION,
      "Your bank account is empty.", { userId, bankBalance: userData.bank });
  }

  userData.wallet += withdrawAmount;
  userData.bank   -= withdrawAmount;
  await setEconomyData(client, guildId, userId, userData);

  const embed = MessageTemplates.SUCCESS.DATA_UPDATED(
    "withdrawal",
    `You successfully withdrew **$${withdrawAmount.toLocaleString()}** from your bank.`
  )
    .addFields(
      { name: "💵 New Cash Balance", value: `$${userData.wallet.toLocaleString()}`, inline: true },
      { name: "🏦 New Bank Balance", value: `$${userData.bank.toLocaleString()}`,  inline: true }
    );

  await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}, { command: 'bank:withdraw' });

// Original pay.js logic, unchanged.
const executePay = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const senderId = interaction.user.id;
  const receiver = interaction.options.getUser("user");
  const amount   = interaction.options.getInteger("amount");
  const guildId  = interaction.guildId;

  logger.debug(`[ECONOMY] Pay command initiated`, { senderId, receiverId: receiver.id, amount, guildId });

  if (receiver.bot) {
    throw createError("Cannot pay bot", ErrorTypes.VALIDATION,
      "You cannot pay a bot.", { receiverId: receiver.id, isBot: true });
  }
  if (receiver.id === senderId) {
    throw createError("Cannot pay self", ErrorTypes.VALIDATION,
      "You cannot pay yourself.", { senderId, receiverId: receiver.id });
  }
  if (amount <= 0) {
    throw createError("Invalid payment amount", ErrorTypes.VALIDATION,
      "Amount must be greater than zero.", { amount, senderId });
  }

  const [senderData, receiverData] = await Promise.all([
    getEconomyData(client, guildId, senderId),
    getEconomyData(client, guildId, receiver.id)
  ]);

  if (!senderData) {
    throw createError("Failed to load sender economy data", ErrorTypes.DATABASE,
      "Failed to load your economy data. Please try again later.", { userId: senderId, guildId });
  }
  if (!receiverData) {
    throw createError("Failed to load receiver economy data", ErrorTypes.DATABASE,
      "Failed to load the receiver's economy data. Please try again later.",
      { userId: receiver.id, guildId });
  }

  await EconomyService.transferMoney(client, guildId, senderId, receiver.id, amount);

  const updatedSenderData   = await getEconomyData(client, guildId, senderId);
  const updatedReceiverData = await getEconomyData(client, guildId, receiver.id);

  const embed = MessageTemplates.SUCCESS.DATA_UPDATED(
    "payment",
    `You successfully paid **${receiver.username}** the amount of **$${amount.toLocaleString()}**!`
  )
    .addFields(
      { name: "💳 Payment Amount",  value: `$${amount.toLocaleString()}`,                    inline: true },
      { name: "💵 Your New Balance", value: `$${updatedSenderData.wallet.toLocaleString()}`, inline: true }
    )
    .setFooter({ text: `Paid to ${receiver.tag}`, iconURL: receiver.displayAvatarURL() });

  await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });

  logger.info(`[ECONOMY] Payment sent successfully`, {
    senderId, receiverId: receiver.id, amount,
    senderBalance: updatedSenderData.wallet, receiverBalance: updatedReceiverData.wallet
  });

  try {
    const receiverEmbed = createEmbed({
      title:       "💰 Incoming Payment!",
      description: `${interaction.user.username} paid you **$${amount.toLocaleString()}**.`
    }).addFields({ name: "Your New Cash", value: `$${updatedReceiverData.wallet.toLocaleString()}`, inline: true });
    await receiver.send({ embeds: [receiverEmbed] });
  } catch (e) {
    logger.warn(`Could not DM user ${receiver.id}: ${e.message}`);
  }
}, { command: 'bank:pay' });
