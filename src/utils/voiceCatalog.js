// src/utils/voiceCatalog.js
//
// Tier-gated catalog of Edge TTS voices.
//   - Free:       always DEFAULT_VOICE, no picker shown.
//   - Premium:    can choose from PREMIUM_VOICES.
//   - Enterprise: can choose from PREMIUM_VOICES + ENTERPRISE_EXTRA_VOICES.
//
// IMPORTANT: verify these ShortNames are still current before shipping —
// Microsoft's voice catalog does change over time. Quick way to check:
//
//   const { EdgeTTS } = require('@andresaya/edge-tts');
//   const voices = await new EdgeTTS().getVoicesByLanguage('en');
//   console.log(voices.map(v => v.ShortName));
//
// and cross-reference against the ids below.

const DEFAULT_VOICE = 'en-US-AriaNeural';

const PREMIUM_VOICES = [
  { id: 'en-US-AriaNeural', label: 'Aria — US, Female' },
  { id: 'en-US-GuyNeural', label: 'Guy — US, Male' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia — UK, Female' },
  { id: 'en-GB-RyanNeural', label: 'Ryan — UK, Male' },
];

const ENTERPRISE_EXTRA_VOICES = [
  { id: 'en-AU-NatashaNeural', label: 'Natasha — Australian, Female' },
  { id: 'en-AU-WilliamNeural', label: 'William — Australian, Male' },
  { id: 'en-US-EmmaMultilingualNeural', label: 'Emma — US, Female (Multilingual)' },
  { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew — US, Male (Multilingual)' },
  { id: 'en-IE-ConnorNeural', label: 'Connor — Irish, Male' },
  { id: 'en-IN-NeerjaNeural', label: 'Neerja — Indian, Female' },
];

const ENTERPRISE_VOICES = [...PREMIUM_VOICES, ...ENTERPRISE_EXTRA_VOICES];

/**
 * @param {'free'|'premium'|'enterprise'} tier
 * @returns {{id: string, label: string}[]} voices selectable on that tier (empty for free)
 */
function getVoiceChoicesForTier(tier) {
  if (tier === 'enterprise') return ENTERPRISE_VOICES;
  if (tier === 'premium') return PREMIUM_VOICES;
  return [];
}

/**
 * @param {string} voiceId
 * @param {'free'|'premium'|'enterprise'} tier
 */
function isVoiceAllowedForTier(voiceId, tier) {
  if (!voiceId || tier === 'free') return !voiceId || voiceId === DEFAULT_VOICE;
  return getVoiceChoicesForTier(tier).some((v) => v.id === voiceId);
}

/**
 * Resolves the voice a guild should actually hear, falling back safely if
 * a tier downgrade (Enterprise -> Premium, Premium -> Free) left a now-invalid
 * voice saved in the DB.
 *
 * @param {{tier: 'free'|'premium'|'enterprise', savedVoiceId?: string|null}} args
 */
function resolveVoiceForGuild({ tier, savedVoiceId }) {
  if (savedVoiceId && isVoiceAllowedForTier(savedVoiceId, tier)) return savedVoiceId;
  return DEFAULT_VOICE;
}

module.exports = {
  DEFAULT_VOICE,
  PREMIUM_VOICES,
  ENTERPRISE_VOICES,
  getVoiceChoicesForTier,
  isVoiceAllowedForTier,
  resolveVoiceForGuild,
};
