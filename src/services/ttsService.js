// src/services/ttsService.js
//
// Google Cloud Text-to-Speech service.
//
// Authentication:
//   Set GOOGLE_APPLICATION_CREDENTIALS to the path of your service-account JSON
//   key file, or set GOOGLE_TTS_CREDENTIALS_JSON to the raw JSON string (useful
//   for Railway environment variables).
//
// Free tier: 1 million WaveNet characters / month.
// Docs: https://cloud.google.com/text-to-speech/docs

import { Readable } from 'stream';
import { writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

// ── Lazy-initialise the Google Cloud TTS client ───────────────────────────────
let _client = null;
let _clientError = null;

async function getClient() {
  if (_client) return _client;
  if (_clientError) throw _clientError;

  try {
    // Support raw JSON credentials supplied as an env-var string (Railway-friendly)
    if (process.env.GOOGLE_TTS_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const creds = JSON.parse(process.env.GOOGLE_TTS_CREDENTIALS_JSON);
      const tmpPath = join('/tmp', 'phantom_gcp_creds.json');
      writeFileSync(tmpPath, JSON.stringify(creds));
      process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
      logger.info('[TTS_SERVICE] Loaded GCP credentials from GOOGLE_TTS_CREDENTIALS_JSON');
    }

    const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
    _client = new TextToSpeechClient();
    logger.info('[TTS_SERVICE] Google Cloud TTS client initialised');
    return _client;
  } catch (err) {
    _clientError = err;
    logger.error('[TTS_SERVICE] Failed to initialise Google Cloud TTS client:', err.message);
    throw err;
  }
}

// ── Synthesise text → MP3 temp file path ─────────────────────────────────────
/**
 * Synthesises `text` using Google Cloud TTS and writes the resulting MP3 to a
 * temporary file.  Returns the file path so the caller can stream it to Discord
 * and delete it afterwards.
 *
 * @param {string} text  Plain text to synthesise (max ~5 000 bytes per request).
 * @returns {Promise<string>}  Absolute path to the temporary MP3 file.
 */
export async function synthesizeSpeech(text) {
  const client = await getClient();

  const [response] = await client.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: 'en-US',
      ssmlGender: 'NEUTRAL',
      // Standard voice — no cost against the WaveNet quota.
      // Swap to 'en-US-Wavenet-D' for higher quality (counts against WaveNet quota).
      name: 'en-US-Standard-C',
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 1.0,
      pitch: 0.0,
    },
  });

  const audioContent = response.audioContent;
  if (!audioContent || audioContent.length < 50) {
    throw new Error('Google Cloud TTS returned empty audio');
  }

  const tmpFile = join('/tmp', `phantom_tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  writeFileSync(tmpFile, audioContent, 'binary');
  logger.debug(`[TTS_SERVICE] Wrote ${audioContent.length} bytes → ${tmpFile}`);
  return tmpFile;
}

// ── Split long text into ≤ 4 500-byte chunks (API limit is 5 000 bytes) ───────
/**
 * Splits `text` into sentence-aware chunks that each fit within the Google
 * Cloud TTS byte limit, then synthesises each chunk and returns an ordered
 * array of temp-file paths.
 *
 * @param {string} text
 * @returns {Promise<string[]>}
 */
export async function synthesizeSpeechChunked(text) {
  const MAX_BYTES = 4_500;
  const encoder = new TextEncoder();

  // Split on sentence boundaries first, then hard-split any remaining giants.
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];

  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence.trim()}` : sentence.trim();
    if (encoder.encode(candidate).length <= MAX_BYTES) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // If a single sentence is still too long, hard-split by words.
      if (encoder.encode(sentence).length > MAX_BYTES) {
        const words = sentence.trim().split(/\s+/);
        let wordChunk = '';
        for (const word of words) {
          const wc = wordChunk ? `${wordChunk} ${word}` : word;
          if (encoder.encode(wc).length <= MAX_BYTES) {
            wordChunk = wc;
          } else {
            if (wordChunk) chunks.push(wordChunk);
            wordChunk = word;
          }
        }
        if (wordChunk) current = wordChunk;
        else current = '';
      } else {
        current = sentence.trim();
      }
    }
  }
  if (current) chunks.push(current);

  const files = [];
  for (const chunk of chunks) {
    const file = await synthesizeSpeech(chunk);
    files.push(file);
  }
  return files;
}

// ── Cleanup helper ────────────────────────────────────────────────────────────
export function cleanupTempFile(filePath) {
  try {
    if (filePath && existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best-effort — ignore errors.
  }
}
