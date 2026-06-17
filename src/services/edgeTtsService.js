// src/services/edgeTtsService.js
//
// Edge TTS equivalent of ttsService.js's synthesizeSpeechChunked — same
// return contract (Promise<string[]> of temp file paths) so it's a drop-in
// swap at the call sites in tts.js. No chunking needed: unlike espeak-ng,
// Edge TTS handles a full Discord-message-length string in a single request,
// so this always resolves to a one-element array.

import { writeFileSync } from 'fs';
import { join } from 'path';
import { synthesizeSpeech } from '../utils/edgeTTS.js';
import { cleanupTempFile } from './ttsService.js';
import { logger } from '../utils/logger.js';

function uniqueTmpPath() {
  const [sec, nano] = process.hrtime();
  return join('/tmp', `phantom_tts_edge_${sec}_${nano}.webm`);
}

/**
 * Synthesises `text` with the given Edge TTS voice and writes the result to
 * a temp WebM/Opus file.
 *
 * @param {string} text
 * @param {string} voiceId  Edge TTS ShortName, e.g. 'en-US-AriaNeural'
 * @returns {Promise<string[]>}  Array with one file path, or [] for empty text
 */
export async function synthesizeSpeechEdgeChunked(text, voiceId) {
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (!normalised) return [];

  const tmpFile = uniqueTmpPath();

  try {
    const buffer = await synthesizeSpeech(normalised, voiceId);

    // Mirrors the size-validation pattern already used in ttsService.js —
    // a near-empty buffer means synthesis silently produced nothing.
    if (!buffer || buffer.length < 100) {
      throw new Error(`Edge TTS returned ${buffer?.length ?? 0} bytes — synthesis likely failed silently`);
    }

    writeFileSync(tmpFile, buffer);
  } catch (err) {
    logger.error('[EDGE_TTS_SERVICE] synthesis failed:', err.message);
    cleanupTempFile(tmpFile);
    throw new Error(`Edge TTS synthesis failed: ${err.message}`);
  }

  return [tmpFile];
}
