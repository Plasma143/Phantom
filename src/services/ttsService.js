// src/services/ttsService.js
//
// Offline Text-to-Speech service using SVOX Pico TTS (pico2wave CLI).
//
// No API keys, no billing, no network calls — runs entirely on-device.
// Requires the libttspico system packages installed in the container/host
// (libttspico0, libttspico-data, libttspico-utils).
//
// pico2wave produces a WAV file which discord.js can play directly via ffmpeg.

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execFile = promisify(execFileCb);

// ── Synthesise text → WAV temp file path ─────────────────────────────────────
/**
 * Synthesises `text` using SVOX Pico TTS (pico2wave CLI, offline, no API key
 * required) and writes the resulting WAV to a temporary file. Returns the file
 * path so the caller can stream it to Discord and delete it afterwards.
 *
 * @param {string} text  Plain text to synthesise.
 * @returns {Promise<string>}  Absolute path to the temporary WAV file.
 */
export async function synthesizeSpeech(text) {
  const tmpFile = join('/tmp', `phantom_tts_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);

  await execFile('pico2wave', ['-l', 'en-US', '-w', tmpFile, text]);

  if (!existsSync(tmpFile)) {
    throw new Error('pico2wave did not produce an output file');
  }

  logger.debug(`[TTS_SERVICE] pico2wave wrote → ${tmpFile}`);
  return tmpFile;
}

// ── Split long text into sentence-aware chunks ────────────────────────────────
/**
 * Splits `text` into sentence-aware chunks, synthesises each chunk in order,
 * and returns an array of temp WAV file paths.
 *
 * @param {string} text
 * @returns {Promise<string[]>}
 */
export async function synthesizeSpeechChunked(text) {
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
