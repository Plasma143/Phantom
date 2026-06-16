// src/utils/edgeTTS.js
//
// Thin wrapper around @andresaya/edge-tts.
//
// Asks Edge TTS for WebM/Opus directly so the result can go straight into
// @discordjs/voice via StreamType.WebmOpus — no ffmpeg re-encode step needed,
// which simplifies the pipeline vs. the old espeak/Google-Translate path.
//
// npm install @andresaya/edge-tts

import { EdgeTTS, Constants } from '@andresaya/edge-tts';

/**
 * @param {string} text
 * @param {string} voiceId - an Edge TTS ShortName, e.g. 'en-US-AriaNeural'
 * @param {{rate?: string|number, pitch?: string|number, volume?: string|number}} [opts]
 * @returns {Promise<Buffer>} WebM/Opus audio buffer
 */
export async function synthesizeSpeech(text, voiceId, opts = {}) {
  const tts = new EdgeTTS();
  await tts.synthesize(text, voiceId, {
    outputFormat: Constants.OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS,
    ...opts,
  });
  return tts.toBuffer();
}
