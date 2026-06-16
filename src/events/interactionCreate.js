// Goes in: interactionCreate.js — wherever it already routes other
// component interactions (buttons, modals, etc). Either add the customId
// check below into your existing StringSelectMenu branch, or call
// handleVoiceSelectMenu(interaction) directly from there.
//
// The require paths below assume this code lives in the SAME file as your
// interactionCreate router. I don't know its actual location or depth —
// adjust accordingly (e.g. if interactionCreate.js sits at src/events/,
// these would become '../utils/voiceCatalog', etc).

const { isVoiceAllowedForTier } = require('./utils/voiceCatalog'); // <- adjust path
const { getGuildTier } = require('./utils/checkTier'); // <- adjust path
const { saveGuildTTSVoice } = require('./utils/guildSettings'); // <- adjust path

async function handleVoiceSelectMenu(interaction) {
  if (interaction.customId !== 'tts_voice_select') return; // not ours — let other handlers run

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

module.exports = { handleVoiceSelectMenu };
