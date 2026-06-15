// src/services/ttsService.js
//
// Offline Text-to-Speech service using SVOX Pico TTS (pico-tts npm package).
//
// No API keys, no billing, no network calls — runs entirely on-device.
// Requires the libttspico system packages installed in the container/host
// (libttspico0, libttspico-data, libttspico-utils).
//
// pico2wave produces a WAV file which discord.js can play directly via ffmpeg.

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

// ── Synthesise text → WAV temp file path ─────────────────────────────────────
/**
 * Synthesises `text` using SVOX Pico TTS (offline, no API key required) and
 * writes the resulting WAV to a temporary file.  Returns the file path so the
 * caller can stream it to Discord and delete it afterwards.
 *
 * @param {string} text  Plain text to synthesise.
 * @returns {Promise<string>}  Absolute path to the temporary WAV file.
 */
export async function synthesizeSpeech(text) {
  const { default: pico } = await import('pico-tts');

  const tmpFile = join('/tmp', `phantom_tts_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);

  // pico-tts wraps pico2wave; it returns a Buffer containing WAV audio.
  const wavBuffer = await pico(text, { lang: 'en-US' });

  if (!wavBuffer || wavBuffer.length < 50) {
    throw new Error('pico-tts returned empty audio');
  }

  const { writeFileSync } = await import('fs');
  writeFileSync(tmpFile, wavBuffer);
  logger.debug(`[TTS_SERVICE] Wrote ${wavBuffer.length} bytes → ${tmpFile}`);
  return tmpFile;
}

// ── Split long text into sentence-aware chunks ────────────────────────────────
/**
 * Splits `text` into sentence-aware chunks (pico2wave handles up to ~32 KB of
 * text, but shorter chunks produce more natural pauses), synthesises each chunk
 * in order, and returns an array of temp WAV file paths.
 *
 * @param {string} text
 * @returns {Promise<string[]>}
 */
export async function synthesizeSpeechChunked(text) {
  // pico2wave can handle long text natively, but we chunk at sentence
  // boundaries so each segment plays as a natural speech unit.
  const MAX_CHARS = 300;

  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];

  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence.trim()}` : sentence.trim();
    if (candidate.length <= MAX_CHARS) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // If a single sentence is still too long, hard-split by words.
      if (sentence.trim().length > MAX_CHARS) {
        const words = sentence.trim().split(/\s+/);
        let wordChunk = '';
        for (const word of words) {
          const wc = wordChunk ? `${wordChunk} ${word}` : word;
          if (wc.length <= MAX_CHARS) {
            wordChunk = wc;
          } else {
            if (wordChunk) chunks.push(wordChunk);
            wordChunk = word;
          }
        }
        current = wordChunk;
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
