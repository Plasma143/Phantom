// src/commands/Fun/fun.js
// Replaces: fact.js, fight.js, flip.js, mock.js, reverse.js, roll.js, ship.js, wanted.js
import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { sanitizeInput } from '../../utils/sanitization.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const facts = [
  "A day on Venus is longer than a year on Venus.",
  "The shortest war in history was between Britain and Zanzibar on August 27, 1896. It lasted 38 to 45 minutes.",
  "The word 'Strengths' is the longest word in the English language with only one vowel.",
  "Octopuses have three hearts and blue blood.",
  "There are more trees on Earth than stars in the Milky Way galaxy.",
  "The total weight of all the ants on Earth is thought to be about the same as the total weight of all humans.",
];

function stringToHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export default {
  data: new SlashCommandBuilder()
    .setName('fun')
    .setDescription('Fun commands')
    // fact
    .addSubcommand(sub => sub
      .setName('fact')
      .setDescription('Share a random interesting fact'))
    // fight
    .addSubcommand(sub => sub
      .setName('fight')
      .setDescription('Start a simulated 1v1 text battle')
      .addUserOption(opt => opt.setName('opponent').setDescription('The user to fight').setRequired(true)))
    // flip
    .addSubcommand(sub => sub
      .setName('flip')
      .setDescription('Flip a coin (Heads or Tails)'))
    // mock
    .addSubcommand(sub => sub
      .setName('mock')
      .setDescription('cOnVeRtS yOuR tExT tO sPoNgEbOb CaSe')
      .addStringOption(opt => opt.setName('text').setDescription('The text to mock').setRequired(true).setMaxLength(1000)))
    // reverse
    .addSubcommand(sub => sub
      .setName('reverse')
      .setDescription('Write your text backwards')
      .addStringOption(opt => opt.setName('text').setDescription('The text to reverse').setRequired(true).setMaxLength(1000)))
    // roll
    .addSubcommand(sub => sub
      .setName('roll')
      .setDescription('Roll dice using standard notation (e.g. 2d20, 1d6+5)')
      .addStringOption(opt => opt.setName('notation').setDescription('Dice notation (e.g. 2d6, 1d20+4)').setRequired(true).setMaxLength(50)))
    // ship
    .addSubcommand(sub => sub
      .setName('ship')
      .setDescription('Calculate compatibility between two people')
      .addStringOption(opt => opt.setName('name1').setDescription('First name or user').setRequired(true).setMaxLength(100))
      .addStringOption(opt => opt.setName('name2').setDescription('Second name or user').setRequired(true).setMaxLength(100)))
    // wanted
    .addSubcommand(sub => sub
      .setName('wanted')
      .setDescription('Create a WANTED poster for a user')
      .addUserOption(opt => opt.setName('user').setDescription('The wanted user').setRequired(true))
      .addStringOption(opt => opt.setName('crime').setDescription('Their crime').setRequired(false).setMaxLength(100))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    try {

      // ── FACT ──────────────────────────────────────────────────────────────
      if (sub === 'fact') {
        const randomFact = facts[Math.floor(Math.random() * facts.length)];
        await InteractionHelper.safeReply(interaction, {
          embeds: [successEmbed('🧠 Did You Know?', `💡 **${randomFact}**`)],
        });
      }

      // ── FIGHT ─────────────────────────────────────────────────────────────
      else if (sub === 'fight') {
        await InteractionHelper.safeDefer(interaction);
        const challenger = interaction.user;
        const opponent   = interaction.options.getUser('opponent');

        if (challenger.id === opponent.id)
          return InteractionHelper.safeEditReply(interaction, { embeds: [warningEmbed("You can't fight yourself! That's a draw before it starts.", '⚔️ Invalid Challenge')] });
        if (opponent.bot)
          return InteractionHelper.safeEditReply(interaction, { embeds: [warningEmbed("You can't fight bots! Challenge a real person.", '⚔️ Invalid Opponent')] });

        const winner = rand(0, 1) === 0 ? challenger : opponent;
        const loser  = winner.id === challenger.id ? opponent : challenger;
        const rounds = rand(3, 7);
        const damage = rand(10, 50);
        const log    = [`💥 **${challenger.username}** challenges **${opponent.username}** to a duel! (Best of ${rounds} rounds)`];
        const actions = ['throws a wild punch', 'lands a critical hit', 'uses a weak spell', 'parries and counterattacks'];

        for (let i = 1; i <= rounds; i++) {
          const attacker = rand(0, 1) === 0 ? challenger : opponent;
          const target   = attacker.id === challenger.id ? opponent : challenger;
          log.push(`\n**Round ${i}:** ${attacker.username} ${actions[rand(0, 3)]} on ${target.username} for ${rand(1, damage)} damage!`);
        }

        const full = `${log.join('\n')}\n\n👑 **${winner.username}** has defeated ${loser.username} and claims the victory!`;
        const desc = full.length <= 4096 ? full : `${full.slice(0, 4081)}\n\n...`;
        await InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(desc, '🏆 Duel Complete!')] });
      }

      // ── FLIP ──────────────────────────────────────────────────────────────
      else if (sub === 'flip') {
        const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
        const emoji  = result === 'Heads' ? '🪙' : '🔮';
        await InteractionHelper.safeReply(interaction, {
          embeds: [successEmbed('Heads or Tails?', `The coin landed on... **${result}** ${emoji}!`)],
        });
      }

      // ── MOCK ──────────────────────────────────────────────────────────────
      else if (sub === 'mock') {
        const raw = interaction.options.getString('text');
        if (!raw?.trim()) throw new TitanBotError('Empty text', ErrorTypes.USER_INPUT, 'Please provide some text to mock!');
        const clean  = sanitizeInput(raw, 1000);
        const mocked = [...clean].map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase())).join('');
        await InteractionHelper.safeReply(interaction, { embeds: [successEmbed('sPoNgEbOb cAsE', `"${mocked}"`)] });
      }

      // ── REVERSE ───────────────────────────────────────────────────────────
      else if (sub === 'reverse') {
        const raw = interaction.options.getString('text');
        if (!raw?.trim()) throw new TitanBotError('Empty text', ErrorTypes.USER_INPUT, 'Please provide some text to reverse!');
        const clean    = sanitizeInput(raw, 1000);
        const reversed = [...clean].reverse().join('');
        await InteractionHelper.safeReply(interaction, {
          embeds: [successEmbed('Backwards Text', `Original: **${clean}**\nReversed: **${reversed}**`)],
        });
      }

      // ── ROLL ──────────────────────────────────────────────────────────────
      else if (sub === 'roll') {
        await InteractionHelper.safeDefer(interaction);
        const notation = interaction.options.getString('notation').toLowerCase().replace(/\s/g, '');
        const match    = notation.match(/^(\d*)d(\d+)([\+\-]\d+)?$/);
        if (!match) throw new TitanBotError(`Invalid notation: ${notation}`, ErrorTypes.USER_INPUT, 'Invalid notation. Use format like `1d20` or `3d6+5`.');

        const numDice  = parseInt(match[1] || '1', 10);
        const numSides = parseInt(match[2], 10);
        const modifier = parseInt(match[3] || '0', 10);

        if (numDice < 1 || numDice > 20)   throw new TitanBotError('Too many dice', ErrorTypes.VALIDATION, 'Keep the number of dice between 1 and 20.');
        if (numSides < 1 || numSides > 1000) throw new TitanBotError('Invalid sides', ErrorTypes.VALIDATION, 'Keep the number of sides between 1 and 1000.');

        const rolls = Array.from({ length: numDice }, () => Math.floor(Math.random() * numSides) + 1);
        const total = rolls.reduce((a, b) => a + b, 0);
        const final = total + modifier;
        const detail = numDice > 1 ? `**Rolls:** ${rolls.join(' + ')}\n` : '';
        const modTxt = modifier !== 0 ? ` + (${modifier})` : '';
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [successEmbed(`🎲 Rolling ${numDice}d${numSides}${modifier !== 0 ? match[3] : ''}`, `${detail}**Total Roll:** ${total}${modTxt} = **${final}**`)],
        });
      }

      // ── SHIP ──────────────────────────────────────────────────────────────
      else if (sub === 'ship') {
        await InteractionHelper.safeDefer(interaction);
        const n1 = sanitizeInput((interaction.options.getString('name1') || '').trim(), 100);
        const n2 = sanitizeInput((interaction.options.getString('name2') || '').trim(), 100);
        if (!n1 || !n2) throw new TitanBotError('Empty names', ErrorTypes.USER_INPUT, 'Please provide valid names for both people!');
        if (n1.toLowerCase() === n2.toLowerCase())
          return InteractionHelper.safeEditReply(interaction, { embeds: [warningEmbed('💖 Ship Score', `**${n1}** can't be shipped with themselves!`)] });

        const score = stringToHash([n1, n2].sort().join('-').toLowerCase()) % 101;
        const desc  = score === 100 ? "Soulmates! It's destiny!"
          : score >= 80 ? "A perfect match! Get the wedding bells ready!"
          : score >= 60 ? "Solid chemistry. Definitely worth exploring!"
          : score >= 40 ? "Just friends status. Maybe with time?"
          : score >= 20 ? "It's a struggle. They might need space."
          : "Zero compatibility. Run for the hills!";
        const bar = '█'.repeat(Math.floor(score / 10)) + '░'.repeat(10 - Math.floor(score / 10));
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [successEmbed(`💖 Ship Score: ${n1} vs ${n2}`, `Compatibility: **${score}%**\n\n\`${bar}\`\n\n*${desc}*`)],
        });
      }

      // ── WANTED ────────────────────────────────────────────────────────────
      else if (sub === 'wanted') {
        await InteractionHelper.safeDefer(interaction);
        const target = interaction.options.getUser('user');
        if (!target) throw new TitanBotError('User not found', ErrorTypes.USER_INPUT, 'Could not find the specified user.');

        const crimeRaw = interaction.options.getString('crime');
        const crime    = crimeRaw ? sanitizeInput(crimeRaw.trim(), 100) || 'Too adorable for this server.' : 'Too adorable for this server.';
        const bounty   = `$${(Math.floor(Math.random() * (100000000 - 1000000) + 1000000)).toLocaleString()} USD`;

        await InteractionHelper.safeEditReply(interaction, {
          embeds: [createEmbed({
            color: 'primary',
            title: '💥 BIG BOUNTY: WANTED! 💥',
            description: `**CRIMINAL:** ${target.tag}\n**CRIME:** ${crime}`,
            fields: [{ name: 'DEAD OR ALIVE', value: `**BOUNTY:** ${bounty}`, inline: false }],
            image: { url: target.displayAvatarURL({ size: 1024, extension: 'png' }) },
            footer: { text: `Last seen in ${interaction.guild.name}` },
          })],
        });
      }

    } catch (error) {
      logger.error(`Fun/${sub} error:`, error);
      await handleInteractionError(interaction, error, { commandName: `fun ${sub}`, source: 'fun_command' });
    }
  },
};
