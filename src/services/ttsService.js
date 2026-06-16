// src/services/ttsService.js
//
// Offline Text-to-Speech service using espeak-ng CLI.
//
// No API keys, no billing, no network calls — runs entirely on-device.
// Requires espeak-ng to be installed: apt-get install -y espeak-ng
//
// Bug fixes applied:
//   - Added espeak-ng availability check on startup with clear error message
//   - Fixed race condition: unique filenames now use process.hrtime for guaranteed uniqueness
//   - Added minimum file size validation with better threshold (44 bytes = WAV header only)
//   - Chunking now trims and deduplicates whitespace before synthesis
//   - cleanupTempFile now handles null/undefined safely
//   - All synthesised files are WAV (consistent with tts.js expectations)

import { existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execFile = promisify(execFileCb);

// WAV header is 44 bytes — anything at or below this means no audio was written
const MIN_WAV_BYTES = 100;

// ── Verify espeak-ng is available on startup ──────────────────────────────────
let espeakAvailable = null;

async function checkEspeakAvailable() {
  if (espeakAvailable !== null) return espeakAvailable;
  try {
    await execFile('espeak-ng', ['--version']);
    espeakAvailable = true;
    logger.info('[TTS_SERVICE] espeak-ng is available ✓');
  } catch {
    espeakAvailable = false;
    logger.error(
      '[TTS_SERVICE] espeak-ng is NOT installed or not in PATH.\n' +
      '  Fix: apt-get install -y espeak-ng\n' +
      '  Or add to Dockerfile: RUN apt-get update && apt-get install -y espeak-ng'
    );
  }
  return espeakAvailable;
}

// Run the check immediately when the module loads
checkEspeakAvailable();

// ── Generate a guaranteed-unique temp file path ───────────────────────────────
function uniqueTmpPath() {
  const [sec, nano] = process.hrtime();
  return join('/tmp', `phantom_tts_${sec}_${nano}.wav`);
}

// ── Synthesise text → WAV temp file path ─────────────────────────────────────
/**
 * Synthesises `text` using espeak-ng (offline, no API key required) and writes
 * the resulting WAV to a temporary file. Returns the file path so the caller
 * can stream it to Discord and delete it afterwards.
 *
 * @param {string} text  Plain text to synthesise.
 * @returns {Promise<string>}  Absolute path to the temporary WAV file.
 */
export async function synthesizeSpeech(text) {
  // Guard: make sure espeak-ng is installed before attempting synthesis
  const available = await checkEspeakAvailable();
  if (!available) {
    throw new Error(
      'espeak-ng is not installed. Run: apt-get install -y espeak-ng'
    );
  }

  const tmpFile = uniqueTmpPath();

  // espeak-ng flags:
  //   -w <file>   write WAV output to file
  //   -s 150      words per minute (slightly slower = clearer in Discord)
  //   -a 100      amplitude 0-200 (default 100)
  const args = ['-w', tmpFile, '-s', '150', '-a', '100', text];

  logger.debug(`[TTS_SERVICE] espeak-ng ${args.map(a => JSON.stringify(a)).join(' ')}`);

  try {
    const { stderr } = await execFile('espeak-ng', args);
    if (stderr) logger.warn(`[TTS_SERVICE] espeak-ng stderr: ${stderr}`);
  } catch (err) {
    logger.error('[TTS_SERVICE] espeak-ng failed:', {
      message: err.message,
      exitCode: err.code,
      stderr: err.stderr ?? '(none)',
    });
    // Clean up any partial file before re-throwing
    cleanupTempFile(tmpFile);
    throw new Error(`espeak-ng synthesis failed: ${err.stderr || err.message}`);
  }

  // Validate output file
  if (!existsSync(tmpFile)) {
    throw new Error('espeak-ng did not produce an output file');
  }

  const { size } = statSync(tmpFile);
  logger.debug(`[TTS_SERVICE] Output: ${tmpFile} (${size} bytes)`);

  if (size <= MIN_WAV_BYTES) {
    cleanupTempFile(tmpFile);
    throw new Error(
      `espeak-ng output is too small (${size} bytes) — synthesis likely failed silently`
    );
  }

  return tmpFile;
}

// ── Split long text into sentence-aware chunks and synthesise each ────────────
/**
 * Splits `text` into sentence-aware chunks (≤ MAX_CHARS each), synthesises
 * each chunk, and returns an array of temp WAV file paths in order.
 *
 * @param {string} text
 * @returns {Promise<string[]>}
 */
export async function synthesizeSpeechChunked(text) {
  const MAX_CHARS = 300;

  // Normalise whitespace before chunking
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (!normalised) return [];

  // Split on sentence boundaries, keeping the delimiter attached
  const sentences = normalised.match(/[^.!?]+[.!?]*/g) ?? [normalised];

  const chunks = [];
  let current = '';

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    const candidate = current ? `${current} ${sentence}` : sentence;

    if (candidate.length <= MAX_CHARS) {
      current = candidate;
    } else {
      if (current) chunks.push(current);

      if (sentence.length > MAX_CHARS) {
        // Sentence itself is too long — split on words
        const words = sentence.split(/\s+/);
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
        current = sentence;
      }
    }
  }
  if (current) chunks.push(current);

  // Synthesise each chunk sequentially
  const files = [];
  for (const chunk of chunks) {
    try {
      const file = await synthesizeSpeech(chunk);
      files.push(file);
    } catch (err) {
      // Clean up already-synthesised files before propagating
      files.forEach(cleanupTempFile);
      throw err;
    }
  }

  return files;
}

// ── Cleanup helper ────────────────────────────────────────────────────────────
/**
 * Deletes a temp file. Safe to call with null/undefined or missing paths.
 *
 * @param {string|null|undefined} filePath
 */
export function cleanupTempFile(filePath) {
  if (!filePath) return;
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch (err) {
    logger.debug(`[TTS_SERVICE] Could not clean up ${filePath}: ${err.message}`);
  }
}
