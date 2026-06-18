import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, warningEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { getGuildConfig } from '../../services/guildConfig.js';
import { formatDuration } from '../../utils/helpers.js';
import { withErrorHandling, createError, ErrorTypes, handleInteractionError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { MessageTemplates } from '../../utils/messageTemplates.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const DAILY_COOLDOWN        = 24 * 60 * 60 * 1000;
const DAILY_AMOUNT          = 1000;
const PREMIUM_BONUS_PERCENTAGE = 0.1;

const WORK_COOLDOWN   = 30 * 60 * 1000;
const MIN_WORK_AMOUNT = 50;
const MAX_WORK_AMOUNT = 300;
const LAPTOP_MULTIPLIER = 1.5;
const WORK_JOBS = [
  "Software Developer", "Barista", "Janitor", "YouTuber",
  "Discord Bot Developer", "Cashier", "Pizza Delivery Driver",
  "Librarian", "Gardener", "Data Analyst",
];

const BEG_COOLDOWN   = 30 * 60 * 1000;
const BEG_MIN_WIN    = 50;
const BEG_MAX_WIN    = 200;
const BEG_SUCCESS_CHANCE = 0.7;

const CRIME_COOLDOWN = 60 * 60 * 1000;
const JAIL_TIME      = 2 * 60 * 60 * 1000;
const CRIME_TYPES = [
  { name: "Pickpocketing", min: 100,  max: 500,   risk: 0.3 },
  { name: "Burglary",      min: 300,  max: 1000,  risk: 0.4 },
  { name: "Bank Heist",    min: 1000, max: 5000,  risk: 0.6 },
  { name: "Art Theft",     min: 2000, max: 10000, risk: 0.7 },
  { name: "Cybercrime",    min: 5000, max: 20000, risk: 0.8 },
];

const ROB_COOLDOWN             = 4 * 60 * 60 * 1000;
const BASE_ROB_SUCCESS_CHANCE  = 0.25;
const ROB_PERCENTAGE           = 0.15;
const FINE_PERCENTAGE          = 0.1;

const FISH_COOLDOWN       = 45 * 60 * 1000;
const FISH_BASE_MIN       = 300;
const FISH_BASE_MAX       = 900;
const FISHING_ROD_MULTIPLIER = 1.5;
const FISH_TYPES = [
  { name: 'Bass',      emoji: '🐟', rarity: 'common'    },
  { name: 'Salmon',    emoji: '🐟', rarity: 'common'    },
  { name: 'Trout',     emoji: '🐟', rarity: 'common'    },
  { name: 'Tuna',      emoji: '🐟', rarity: 'uncommon'  },
  { name: 'Swordfish', emoji: '🐟', rarity: 'uncommon'  },
  { name: 'Octopus',   emoji: '🐙', rarity: 'rare'      },
  { name: 'Lobster',   emoji: '🦞', rarity: 'rare'      },
  { name: 'Shark',     emoji: '🦈', rarity: 'epic'      },
  { name: 'Whale',     emoji: '🐋', rarity: 'legendary' },
];
const CATCH_MESSAGES = [
  "You cast your line into the crystal clear waters...",
  "You wait patiently as your bobber floats...",
  "After a few minutes of waiting, you feel a tug...",
  "The water ripples as something takes your bait...",
  "You reel in your catch with expert precision...",
];

const MINE_COOLDOWN           = 60 * 60 * 1000;
const MINE_BASE_MIN           = 400;
const MINE_BASE_MAX           = 1200;
const PICKAXE_MULTIPLIER      = 1.2;
const DIAMOND_PICKAXE_MULTIPLIER = 2.0;
const MINE_LOCATIONS = [
  "abandoned gold mine", "dark, damp cave",
  "backyard rock quarry", "volcanic obsidian vent",
  "deep-sea mineral trench",
];

const BASE_WIN_CHANCE    = 0.4;
const CLOVER_WIN_BONUS   = 0.1;
const CHARM_WIN_BONUS    = 0.08;
const PAYOUT_MULTIPLIER  = 2.0;
const GAMBLE_COOLDOWN    = 5 * 60 * 1000;

// ─── Command definition ───────────────────────────────────────────────────────
export default {
  data: new SlashCommandBuilder()
    .setName("economy")
    .setDescription("Economy commands: earn, spend, and track your server money.")
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub.setName("daily").setDescription("Claim your daily cash reward"),
    )
    .addSubcommand((sub) =>
      sub.setName("work").setDescription("Work to earn some money"),
    )
    .addSubcommand((sub) =>
      sub.setName("beg").setDescription("Beg for a small amount of money"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("crime")
        .setDescription("Commit a crime to earn money (risky)")
        .addStringOption((option) =>
          option
            .setName("type")
            .setDescription("Type of crime to commit")
            .setRequired(true)
            .addChoices(
              { name: "Pickpocketing", value: "pickpocketing" },
              { name: "Burglary",      value: "burglary" },
              { name: "Bank Heist",    value: "bank-heist" },
              { name: "Art Theft",     value: "art-theft" },
              { name: "Cybercrime",    value: "cybercrime" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("rob")
        .setDescription("Attempt to rob another user (very risky)")
        .addUserOption((option) =>
          option.setName("user").setDescription("User to rob").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("fish").setDescription("Go fishing to catch fish and earn money"),
    )
    .addSubcommand((sub) =>
      sub.setName("mine").setDescription("Go mining to earn money"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("gamble")
        .setDescription("Gamble your money for a chance to win more")
        .addIntegerOption((option) =>
          option
            .setName("amount")
            .setDescription("Amount of cash to gamble")
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("leaderboard").setDescription("View the server's top 10 richest users"),
    ),

  category: "Economy",

  async execute(interaction, config, client) {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "daily":       return executeDaily(interaction, config, client);
      case "work":        return executeWork(interaction, config, client);
      case "beg":         return executeBeg(interaction, config, client);
      case "crime":       return executeCrime(interaction, config, client);
      case "rob":         return executeRob(interaction, config, client);
      case "fish":        return executeFish(interaction, config, client);
      case "mine":        return executeMine(interaction, config, client);
      case "gamble":      return executeGamble(interaction, config, client);
      case "leaderboard": return executeLeaderboard(interaction, config, client);
    }
  },
};

// ─── Subcommand handlers ──────────────────────────────────────────────────────

// Original daily.js logic, unchanged.
const executeDaily = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;
  const now     = Date.now();

  logger.debug(`[ECONOMY] Daily claimed started for ${userId}`, { userId, guildId });

  const userData = await getEconomyData(client, guildId, userId);
  if (!userData) {
    throw createError("Failed to load economy data for daily", ErrorTypes.DATABASE,
      "Failed to load your economy data. Please try again later.", { userId, guildId });
  }

  const lastDaily = userData.lastDaily || 0;
  if (now < lastDaily + DAILY_COOLDOWN) {
    const timeRemaining = lastDaily + DAILY_COOLDOWN - now;
    throw createError("Daily cooldown active", ErrorTypes.RATE_LIMIT,
      `You need to wait before claiming daily again. Try again in **${formatDuration(timeRemaining)}**.`,
      { timeRemaining, cooldownType: 'daily' });
  }

  const guildConfig    = await getGuildConfig(client, guildId);
  const PREMIUM_ROLE_ID = guildConfig.premiumRoleId;

  let earned = DAILY_AMOUNT;
  let bonusMessage = "";
  let hasPremiumRole = false;

  if (PREMIUM_ROLE_ID && interaction.member?.roles.cache.has(PREMIUM_ROLE_ID)) {
    const bonusAmount = Math.floor(DAILY_AMOUNT * PREMIUM_BONUS_PERCENTAGE);
    earned += bonusAmount;
    bonusMessage = `\n✨ **Premium Bonus:** +$${bonusAmount.toLocaleString()}`;
    hasPremiumRole = true;
  }

  userData.wallet    = (userData.wallet || 0) + earned;
  userData.lastDaily = now;
  await setEconomyData(client, guildId, userId, userData);

  logger.info(`[ECONOMY_TRANSACTION] Daily claimed`, {
    userId, guildId, amount: earned,
    newWallet: userData.wallet, hasPremium: hasPremiumRole,
    timestamp: new Date().toISOString()
  });

  const embed = successEmbed(
    "✅ Daily Claimed!",
    `You have claimed your daily **$${earned.toLocaleString()}**!${bonusMessage}`
  )
    .addFields({ name: "New Cash Balance", value: `$${userData.wallet.toLocaleString()}`, inline: true })
    .setFooter({ text: hasPremiumRole ? "Next claim in 24 hours. (Premium Active)" : "Next claim in 24 hours." });

  await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}, { command: 'economy:daily' });

// Original work.js logic, unchanged.
const executeWork = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;
  const now     = Date.now();

  const userData = await getEconomyData(client, guildId, userId);
  if (!userData) {
    throw createError("Failed to load economy data for work", ErrorTypes.DATABASE,
      "Failed to load your economy data. Please try again later.", { userId, guildId });
  }

  logger.debug(`[ECONOMY] Work command started for ${userId}`, { userId, guildId });

  const lastWork       = userData.lastWork || 0;
  const inventory      = userData.inventory || {};
  const extraWorkShifts = inventory["extra_work"] || 0;
  const hasLaptop      = inventory["laptop"] || 0;

  let cooldownActive = now < lastWork + WORK_COOLDOWN;
  let usedConsumable = false;

  if (cooldownActive) {
    if (extraWorkShifts > 0) {
      inventory["extra_work"] = (inventory["extra_work"] || 0) - 1;
      usedConsumable = true;
    } else {
      const remaining = lastWork + WORK_COOLDOWN - now;
      throw createError("Work cooldown active", ErrorTypes.RATE_LIMIT,
        `You're working too fast! Wait **${Math.floor(remaining / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m** before working again.`,
        { timeRemaining: remaining, cooldownType: 'work' });
    }
  }

  let earned = Math.floor(Math.random() * (MAX_WORK_AMOUNT - MIN_WORK_AMOUNT + 1)) + MIN_WORK_AMOUNT;
  const job  = WORK_JOBS[Math.floor(Math.random() * WORK_JOBS.length)];

  let multiplierMessage = "";
  if (hasLaptop > 0) {
    earned = Math.floor(earned * LAPTOP_MULTIPLIER);
    multiplierMessage = "\n💻 **Laptop Bonus:** +50% earnings!";
  }

  userData.wallet   = (userData.wallet || 0) + earned;
  userData.lastWork = now;
  await setEconomyData(client, guildId, userId, userData);

  logger.info(`[ECONOMY_TRANSACTION] Work completed`, {
    userId, guildId, amount: earned, job, usedConsumable,
    hasLaptop: hasLaptop > 0, newWallet: userData.wallet,
    timestamp: new Date().toISOString()
  });

  const embed = successEmbed(
    "💼 Work Complete!",
    `You worked as a **${job}** and earned **$${earned.toLocaleString()}**!${multiplierMessage}`
  )
    .addFields(
      { name: "💰 New Balance", value: `$${userData.wallet.toLocaleString()}`, inline: true },
      { name: "⏰ Next Work",   value: `<t:${Math.floor((now + WORK_COOLDOWN) / 1000)}:R>`, inline: true }
    )
    .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() });

  await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}, { command: 'economy:work' });

// Original beg.js logic, unchanged.
const executeBeg = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;

  let userData = await getEconomyData(client, guildId, userId);
  if (!userData) {
    throw createError("Failed to load economy data", ErrorTypes.DATABASE,
      "Failed to load your economy data. Please try again later.", { userId, guildId });
  }

  const lastBeg     = userData.lastBeg || 0;
  const remainingTime = lastBeg + BEG_COOLDOWN - Date.now();

  if (remainingTime > 0) {
    const minutes = Math.floor(remainingTime / 60000);
    const seconds = Math.floor((remainingTime % 60000) / 1000);
    const timeMessage = minutes > 0 ? `${minutes} minute(s)` : `${seconds} second(s)`;
    throw createError("Beg cooldown active", ErrorTypes.RATE_LIMIT,
      `You are tired from begging! Try again in **${timeMessage}**.`,
      { remainingTime, minutes, seconds, cooldownType: 'beg' });
  }

  const success = Math.random() < BEG_SUCCESS_CHANCE;
  let replyEmbed;
  let newCash = userData.wallet;

  if (success) {
    const amountWon = Math.floor(Math.random() * (BEG_MAX_WIN - BEG_MIN_WIN + 1)) + BEG_MIN_WIN;
    newCash += amountWon;
    const successMessages = [
      `A kind stranger drops **$${amountWon.toLocaleString()}** into your cup.`,
      `You spotted an unattended wallet! You grab **$${amountWon.toLocaleString()}** and run.`,
      `Someone took pity on you and gave you **$${amountWon.toLocaleString()}**!`,
      `You found **$${amountWon.toLocaleString()}** under a park bench.`,
    ];
    replyEmbed = MessageTemplates.SUCCESS.DATA_UPDATED(
      "begging",
      successMessages[Math.floor(Math.random() * successMessages.length)]
    );
  } else {
    const failMessages = [
      "The police chased you off. You got nothing.",
      "Someone yelled, 'Get a job!' and walked past.",
      "A squirrel stole the single coin you had.",
      "You tried to beg, but you were too embarrassed and gave up.",
    ];
    replyEmbed = MessageTemplates.ERRORS.INSUFFICIENT_FUNDS("nothing", "You failed to get any money from begging.");
    replyEmbed.data.description = failMessages[Math.floor(Math.random() * failMessages.length)];
  }

  userData.wallet  = newCash;
  userData.lastBeg = Date.now();
  await setEconomyData(client, guildId, userId, userData);
  await InteractionHelper.safeEditReply(interaction, { embeds: [replyEmbed] });
}, { command: 'economy:beg' });

// Original crime.js logic, unchanged.
const executeCrime = withErrorHandling(async (interaction, config, client) => {
  await InteractionHelper.safeDefer(interaction);

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;
  const now     = Date.now();

  const userData  = await getEconomyData(client, guildId, userId);
  const lastCrime = userData.cooldowns?.crime || 0;
  const isJailed  = userData.jailedUntil && userData.jailedUntil > now;

  if (isJailed) {
    const timeLeft = Math.ceil((userData.jailedUntil - now) / (1000 * 60));
    throw createError("User is in jail", ErrorTypes.RATE_LIMIT,
      `You're in jail for ${timeLeft} more minutes!`,
      { jailTimeRemaining: userData.jailedUntil - now });
  }

  if (now < lastCrime + CRIME_COOLDOWN) {
    const timeLeft = Math.ceil((lastCrime + CRIME_COOLDOWN - now) / (1000 * 60));
    throw createError("Crime cooldown active", ErrorTypes.RATE_LIMIT,
      `You need to wait ${timeLeft} more minutes before committing another crime.`,
      { remaining: lastCrime + CRIME_COOLDOWN - now, cooldownType: 'crime' });
  }

  const crimeType = interaction.options.getString("type").toLowerCase();
  const crime     = CRIME_TYPES.find(c => c.name.toLowerCase().replace(/\s+/g, '-') === crimeType);

  if (!crime) {
    throw createError("Invalid crime type", ErrorTypes.VALIDATION,
      "Please select a valid crime type.", { crimeType });
  }

  const isSuccess   = Math.random() > crime.risk;
  const amountEarned = isSuccess
    ? Math.floor(Math.random() * (crime.max - crime.min + 1)) + crime.min
    : 0;

  userData.cooldowns       = userData.cooldowns || {};
  userData.cooldowns.crime = now;

  if (isSuccess) {
    userData.wallet = (userData.wallet || 0) + amountEarned;
    await setEconomyData(client, guildId, userId, userData);
    const embed = successEmbed("Crime Successful!",
      `You successfully committed ${crime.name} and earned **${amountEarned}** coins!`);
    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
  } else {
    const fine = Math.floor(amountEarned * 0.2);
    userData.wallet      = Math.max(0, (userData.wallet || 0) - fine);
    userData.jailedUntil = now + JAIL_TIME;
    await setEconomyData(client, guildId, userId, userData);
    const embed = errorEmbed("Crime Failed!",
      `You were caught while attempting ${crime.name} and have been sent to jail! ` +
      `You were fined ${fine} coins and will be in jail for 2 hours.`);
    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
  }
}, { command: 'economy:crime' });

// Original rob.js logic, unchanged.
const executeRob = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const robberId  = interaction.user.id;
  const victimUser = interaction.options.getUser("user");
  const guildId   = interaction.guildId;
  const now       = Date.now();

  if (robberId === victimUser.id) {
    throw createError("Cannot rob self", ErrorTypes.VALIDATION,
      "You cannot rob yourself.", { robberId, victimId: victimUser.id });
  }
  if (victimUser.bot) {
    throw createError("Cannot rob bot", ErrorTypes.VALIDATION,
      "You cannot rob a bot.", { victimId: victimUser.id, isBot: true });
  }

  const robberData = await getEconomyData(client, guildId, robberId);
  const victimData = await getEconomyData(client, guildId, victimUser.id);

  if (!robberData || !victimData) {
    throw createError("Failed to load economy data", ErrorTypes.DATABASE,
      "Failed to load economy data. Please try again later.",
      { robberId: !!robberData, victimId: !!victimData, guildId });
  }

  const lastRob = robberData.lastRob || 0;
  if (now < lastRob + ROB_COOLDOWN) {
    const remaining = lastRob + ROB_COOLDOWN - now;
    const hours   = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    throw createError("Robbery cooldown active", ErrorTypes.RATE_LIMIT,
      `You need to lay low. Wait **${hours}h ${minutes}m** before attempting another robbery.`,
      { remaining, hours, minutes, cooldownType: 'rob' });
  }

  if (victimData.wallet < 500) {
    throw createError("Victim too poor", ErrorTypes.VALIDATION,
      `${victimUser.username} is too poor. They need at least $500 cash to be worth robbing.`,
      { victimWallet: victimData.wallet, required: 500 });
  }

  const hasSafe = victimData.inventory["personal_safe"] || 0;
  if (hasSafe > 0) {
    robberData.lastRob = now;
    await setEconomyData(client, guildId, robberId, robberData);
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [MessageTemplates.ERRORS.CONFIGURATION_REQUIRED(
        "robbery protection",
        `${victimUser.username} was prepared! Your attempt failed because they own a **Personal Safe**. You got away clean but didn't gain anything.`
      )],
    });
  }

  const isSuccessful = Math.random() < BASE_ROB_SUCCESS_CHANCE;
  let resultEmbed;

  if (isSuccessful) {
    const amountStolen = Math.floor(victimData.wallet * ROB_PERCENTAGE);
    robberData.wallet  = (robberData.wallet || 0) + amountStolen;
    victimData.wallet  = (victimData.wallet || 0) - amountStolen;
    resultEmbed = MessageTemplates.SUCCESS.DATA_UPDATED(
      "robbery",
      `You successfully stole **$${amountStolen.toLocaleString()}** from ${victimUser.username}!`
    );
  } else {
    const fineAmount = Math.floor((robberData.wallet || 0) * FINE_PERCENTAGE);
    robberData.wallet = (robberData.wallet || 0) < fineAmount
      ? 0
      : (robberData.wallet || 0) - fineAmount;
    resultEmbed = MessageTemplates.ERRORS.INSUFFICIENT_PERMISSIONS(
      "robbery failed",
      `You failed the robbery and were caught! You were fined **$${fineAmount.toLocaleString()}** of your own cash.`
    );
  }

  robberData.lastRob = now;
  await setEconomyData(client, guildId, robberId, robberData);
  await setEconomyData(client, guildId, victimUser.id, victimData);

  resultEmbed
    .addFields(
      { name: `Your New Cash (${interaction.user.username})`,   value: `$${robberData.wallet.toLocaleString()}`, inline: true },
      { name: `Victim's New Cash (${victimUser.username})`, value: `$${victimData.wallet.toLocaleString()}`, inline: true }
    )
    .setFooter({ text: "Next robbery available in 4 hours." });

  await InteractionHelper.safeEditReply(interaction, { embeds: [resultEmbed] });
}, { command: 'economy:rob' });

// Original fish.js logic, unchanged.
const executeFish = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;
  const now     = Date.now();

  const userData     = await getEconomyData(client, guildId, userId);
  const lastFish     = userData.lastFish || 0;
  const hasFishingRod = userData.inventory["fishing_rod"] || 0;

  if (now < lastFish + FISH_COOLDOWN) {
    const remaining = lastFish + FISH_COOLDOWN - now;
    const hours   = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    throw createError("Fishing cooldown active", ErrorTypes.RATE_LIMIT,
      `You're too tired to fish right now. Rest for **${hours}h ${minutes}m** before fishing again.`,
      { remaining, cooldownType: 'fish' });
  }

  const rand = Math.random();
  let fishCaught;
  if      (rand < 0.50) fishCaught = FISH_TYPES.filter(f => f.rarity === 'common')[Math.floor(Math.random() * 3)];
  else if (rand < 0.75) fishCaught = FISH_TYPES.filter(f => f.rarity === 'uncommon')[Math.floor(Math.random() * 2)];
  else if (rand < 0.90) fishCaught = FISH_TYPES.filter(f => f.rarity === 'rare')[Math.floor(Math.random() * 2)];
  else if (rand < 0.98) fishCaught = FISH_TYPES.find(f => f.rarity === 'epic');
  else                  fishCaught = FISH_TYPES.find(f => f.rarity === 'legendary');

  const baseEarned   = Math.floor(Math.random() * (FISH_BASE_MAX - FISH_BASE_MIN + 1)) + FISH_BASE_MIN;
  let finalEarned    = baseEarned;
  let multiplierMessage = "";

  if (hasFishingRod > 0) {
    finalEarned       = Math.floor(baseEarned * FISHING_ROD_MULTIPLIER);
    multiplierMessage = "\n🎣 **Fishing Rod Bonus: +50%**";
  }

  const catchMessage = CATCH_MESSAGES[Math.floor(Math.random() * CATCH_MESSAGES.length)];

  userData.wallet   += finalEarned;
  userData.lastFish  = now;
  await setEconomyData(client, guildId, userId, userData);

  const rarityColors = {
    common: '#95A5A6', uncommon: '#2ECC71', rare: '#3498DB',
    epic: '#9B59B6', legendary: '#F1C40F'
  };

  const embed = createEmbed({
    title: '🎣 Fishing Success!',
    description: `${catchMessage}\n\nYou caught a **${fishCaught.emoji} ${fishCaught.name}**! You sold it for **$${finalEarned.toLocaleString()}**!${multiplierMessage}`,
    color: rarityColors[fishCaught.rarity]
  })
    .addFields(
      { name: "💵 New Cash Balance", value: `$${userData.wallet.toLocaleString()}`, inline: true },
      { name: "🐟 Rarity", value: fishCaught.rarity.charAt(0).toUpperCase() + fishCaught.rarity.slice(1), inline: true }
    )
    .setFooter({ text: "Next fishing trip available in 45 minutes." });

  await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}, { command: 'economy:fish' });

// Original mine.js logic, unchanged.
const executeMine = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const userId  = interaction.user.id;
  const guildId = interaction.guildId;
  const now     = Date.now();

  const userData          = await getEconomyData(client, guildId, userId);
  const lastMine          = userData.lastMine || 0;
  const hasDiamondPickaxe = userData.inventory["diamond_pickaxe"] || 0;
  const hasPickaxe        = userData.inventory["pickaxe"] || 0;

  if (now < lastMine + MINE_COOLDOWN) {
    const remaining = lastMine + MINE_COOLDOWN - now;
    const hours   = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    throw createError("Mining cooldown active", ErrorTypes.RATE_LIMIT,
      `Your pickaxe is cooling down. Wait for **${hours}h ${minutes}m** before mining again.`,
      { remaining, cooldownType: 'mine' });
  }

  const baseEarned  = Math.floor(Math.random() * (MINE_BASE_MAX - MINE_BASE_MIN + 1)) + MINE_BASE_MIN;
  let finalEarned   = baseEarned;
  let multiplierMessage = "";

  if (hasDiamondPickaxe > 0) {
    finalEarned       = Math.floor(baseEarned * DIAMOND_PICKAXE_MULTIPLIER);
    multiplierMessage = "\n💎 **Diamond Pickaxe Bonus: +100%**";
  } else if (hasPickaxe > 0) {
    finalEarned       = Math.floor(baseEarned * PICKAXE_MULTIPLIER);
    multiplierMessage = "\n⛏️ **Pickaxe Bonus: +20%**";
  }

  const location = MINE_LOCATIONS[Math.floor(Math.random() * MINE_LOCATIONS.length)];

  userData.wallet  += finalEarned;
  userData.lastMine = now;
  await setEconomyData(client, guildId, userId, userData);

  const embed = successEmbed(
    "💰 Mining Expedition Successful!",
    `You explored a **${location}** and managed to find minerals worth **$${finalEarned.toLocaleString()}**!${multiplierMessage}`
  )
    .addFields({ name: "💵 New Cash Balance", value: `$${userData.wallet.toLocaleString()}`, inline: true })
    .setFooter({ text: "Next mine available in 1 hour." });

  await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}, { command: 'economy:mine' });

// Original gamble.js logic, unchanged.
const executeGamble = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const userId    = interaction.user.id;
  const guildId   = interaction.guildId;
  const betAmount = interaction.options.getInteger("amount");
  const now       = Date.now();

  const userData   = await getEconomyData(client, guildId, userId);
  const lastGamble = userData.lastGamble || 0;
  let cloverCount  = userData.inventory["lucky_clover"] || 0;
  let charmCount   = userData.inventory["lucky_charm"]  || 0;

  if (now < lastGamble + GAMBLE_COOLDOWN) {
    const remaining = lastGamble + GAMBLE_COOLDOWN - now;
    const minutes = Math.floor(remaining / (1000 * 60));
    const seconds = Math.floor((remaining % (1000 * 60)) / 1000);
    throw createError("Gamble cooldown active", ErrorTypes.RATE_LIMIT,
      `You need to cool down before gambling again. Wait **${minutes}m ${seconds}s**.`,
      { remaining, cooldownType: 'gamble' });
  }

  if (userData.wallet < betAmount) {
    throw createError("Insufficient cash for gamble", ErrorTypes.VALIDATION,
      `You only have $${userData.wallet.toLocaleString()} cash, but you are trying to bet $${betAmount.toLocaleString()}.`,
      { required: betAmount, current: userData.wallet });
  }

  let winChance     = BASE_WIN_CHANCE;
  let cloverMessage = "";
  let usedClover    = false;
  let usedCharm     = false;

  if (cloverCount > 0) {
    winChance                      += CLOVER_WIN_BONUS;
    userData.inventory["lucky_clover"] -= 1;
    cloverMessage = "\n🍀 **Lucky Clover Consumed:** Your win chance was boosted!";
    usedClover = true;
  } else if (charmCount > 0) {
    winChance                      += CHARM_WIN_BONUS;
    userData.inventory["lucky_charm"] -= 1;
    cloverMessage = `\n🍀 **Lucky Charm Used (${charmCount - 1} uses remaining):** Your win chance was boosted!`;
    usedCharm = true;
  }

  const win = Math.random() < winChance;
  let cashChange = 0;
  let resultEmbed;

  if (win) {
    const amountWon = Math.floor(betAmount * PAYOUT_MULTIPLIER);
    cashChange  = amountWon;
    resultEmbed = successEmbed("🎉 You Won!",
      `You successfully gambled and turned your **$${betAmount.toLocaleString()}** bet into **$${amountWon.toLocaleString()}**!${cloverMessage}`);
  } else {
    cashChange  = -betAmount;
    resultEmbed = errorEmbed("💔 You Lost...",
      `The dice rolled against you. You lost your **$${betAmount.toLocaleString()}** bet.`);
  }

  userData.wallet      = (userData.wallet || 0) + cashChange;
  userData.lastGamble  = now;
  await setEconomyData(client, guildId, userId, userData);

  resultEmbed.addFields({ name: "💵 New Cash Balance", value: `$${userData.wallet.toLocaleString()}`, inline: true });

  if (usedClover) {
    resultEmbed.setFooter({ text: `You have ${userData.inventory["lucky_clover"]} Lucky Clovers left. Win chance was ${Math.round(winChance * 100)}%.` });
  } else if (usedCharm) {
    resultEmbed.setFooter({ text: `You have ${userData.inventory["lucky_charm"]} Lucky Charm uses left. Win chance was ${Math.round(winChance * 100)}%.` });
  } else {
    resultEmbed.setFooter({ text: `Next gamble available in 5 minutes. Base win chance: ${Math.round(BASE_WIN_CHANCE * 100)}%.` });
  }

  await InteractionHelper.safeEditReply(interaction, { embeds: [resultEmbed] });
}, { command: 'economy:gamble' });

// Original eleaderboard.js logic, unchanged.
const executeLeaderboard = withErrorHandling(async (interaction, config, client) => {
  const deferred = await InteractionHelper.safeDefer(interaction);
  if (!deferred) return;

  const guildId = interaction.guildId;
  logger.debug(`[ECONOMY] Leaderboard requested`, { guildId });

  const prefix  = `economy:${guildId}:`;
  let allKeys   = await client.db.list(prefix);
  if (!Array.isArray(allKeys)) allKeys = [];

  if (allKeys.length === 0) {
    throw createError("No economy data found", ErrorTypes.VALIDATION,
      "No economy data found for this server.");
  }

  let allUserData = [];
  for (const key of allKeys) {
    const userId   = key.replace(prefix, "");
    const userData = await client.db.get(key);
    if (userData) {
      allUserData.push({ userId, net_worth: (userData.wallet || 0) + (userData.bank || 0) });
    }
  }

  allUserData.sort((a, b) => b.net_worth - a.net_worth);

  const topUsers = allUserData.slice(0, 10);
  const userRank = allUserData.findIndex(u => u.userId === interaction.user.id) + 1;
  const rankEmoji = ["🥇", "🥈", "🥉"];
  const leaderboardEntries = [];

  for (let i = 0; i < topUsers.length; i++) {
    const user  = topUsers[i];
    const emoji = rankEmoji[i] || `**#${i + 1}**`;
    leaderboardEntries.push(`${emoji} <@${user.userId}> - 🏦 ${user.net_worth.toLocaleString()}`);
  }

  logger.info(`[ECONOMY] Leaderboard generated`, { guildId, userCount: allUserData.length, userRank });

  const description = leaderboardEntries.length > 0
    ? leaderboardEntries.join("\n")
    : "No economy data is available for this server yet.";

  const embed = createEmbed({
    title:       "Economy Leaderboard",
    description,
    footer:      `Your Rank: ${userRank > 0 ? `#${userRank}` : "No ranking data available"}`,
  });

  await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}, { command: 'economy:leaderboard' });
