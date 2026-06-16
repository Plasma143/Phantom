// Reference: /tts voice subcommand + its select-menu handler.
//
// This is self-contained logic to slot into wherever your existing tts.js
// already routes the join/leave/clear/test subcommands, and wherever your
// interactionCreate router already dispatches component interactions.
// Wiring (imports, the checkTier-equivalent call, and the DB save call)
// will need adjusting to match your actual structure — flagged below.

const {
  SlashCommandSubcommandBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
} = require('discord.js');
const {
  getVoiceChoicesForTier,
  isVoiceAllowedForTier,
  DEFAULT_VOICE,
} = require('../utils/voiceCatalog');

// TODO: point this at whatever your bot-side equivalent of checkTier() is.
// The dashboard's checkTier() validates Express routes against the DB —
// confirm whether commands already have their own version of this, or if
// this should call the same DB lookup directly.
const { getGuildTier } = require('../utils/checkTier');

// TODO: point this at however guild TTS settings actually get persisted
// (raw query, ORM model, or a JSON settings blob like ticketSettings).
const { saveGuildTTSVoice } = require('../utils/guildSettings');

// --- 1. Subcommand definition — add alongside join/leave/clear/test ---
function buildVoiceSubcommand() {
  return new SlashCommandSubcommandBuilder()
    .setName('voice')
    .setDescription('Choose the TTS voice for this server');
}

// --- 2. Handler for `/tts voice` ---
async function handleVoiceSubcommand(interaction) {
  const tier = await getGuildTier(interaction.guild.id); // 'free' | 'premium' | 'enterprise'
  const choices = getVoiceChoicesForTier(tier);

  if (choices.length === 0) {
    return interaction.reply({
      content: `Voice selection is a Premium feature. This server currently uses the default voice (${DEFAULT_VOICE}). Upgrade to unlock more options.`,
      ephemeral: true,
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('tts_voice_select')
    .setPlaceholder('Choose a voice')
    .addOptions(choices.map((v) => ({ label: v.label, value: v.id })));

  const row = new ActionRowBuilder().addComponents(menu);

  await interaction.reply({
    content: `Pick a voice (${choices.length} available on your **${tier}** plan):`,
    components: [row],
    ephemeral: true,
  });
}

// --- 3. Handler for the select-menu interaction — goes alongside your
//        other component handlers in interactionCreate ---
async function handleVoiceSelectMenu(interaction) {
  if (interaction.customId !== 'tts_voice_select') return; // not ours, let it fall through

  const tier = await getGuildTier(interaction.guild.id);
  const chosenVoice = interaction.values[0];

  if (!isVoiceAllowedForTier(chosenVoice, tier)) {
    return interaction.update({
      content: 'That voice is no longer available on your current plan.',
      components: [],
    });
  }

  await saveGuildTTSVoice(interaction.guild.id, chosenVoice);

  await interaction.update({
    content: `TTS voice set to **${chosenVoice}**.`,
    components: [],
  });
}

module.exports = {
  buildVoiceSubcommand,
  handleVoiceSubcommand,
  handleVoiceSelectMenu,
};
