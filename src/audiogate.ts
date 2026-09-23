// Audio gate — pre-upload filtering so only speech-bearing segments reach the
// STT gateway. Uses ffmpeg's silencedetect filter to find speech intervals in
// the recorded PCM, then decides: drop (noise/silence only) or trim-to-speech
// (smaller upload). Zero extra dependencies: ffmpeg is already required.

import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

import { config } from './config';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

export interface SpeechInterval {
  startMs: number;
  endMs: number;
}

export interface GateResult {
  kept: boolean;
  totalMs: number;
  speechMs: number;
  ratio: number;
  speechIntervals: SpeechInterval[];
  // Trim window to convert+upload (null = whole file, only when kept untrimmed)
  trimStartMs: number | null;
  trimEndMs: number | null;
  reason: string;
}

// parseSilencedetect(stderr: string) -> silence intervals in ms. Pure function
// so the noisy ffmpeg output contract is pinned by tests.
export function parseSilencedetect(stderr: string): SpeechInterval[] {
  const silences: SpeechInterval[] = [];
  let start: number | null = null;
  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (startMatch) {
      start = Math.max(0, parseFloat(startMatch[1]) * 1000);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);
    if (endMatch && start !== null) {
      silences.push({ startMs: start, endMs: Math.round(parseFloat(endMatch[1]) * 1000) });
      start = null;
    }
  }
  // Unterminated silence (runs to end of file) — keep the open start so the
  // caller's speech math treats the tail as silent.
  if (start !== null) silences.push({ startMs: start, endMs: Infinity });
  return silences;
}

// speechIntervals(totalMs, silences) -> the complement: where sound happened.
export function speechIntervals(totalMs: number, silences: SpeechInterval[]): SpeechInterval[] {
  const speech: SpeechInterval[] = [];
  let cursor = 0;
  for (const s of silences.sort((a, b) => a.startMs - b.startMs)) {
    if (s.startMs > cursor) speech.push({ startMs: cursor, endMs: Math.min(s.startMs, totalMs) });
    cursor = Math.max(cursor, s.endMs === Infinity ? totalMs : s.endMs);
    if (cursor >= totalMs) break;
  }
  if (cursor < totalMs) speech.push({ startMs: cursor, endMs: totalMs });
  return speech.filter((i) => i.endMs - i.startMs > 0);
}

export function sumDurationMs(intervals: SpeechInterval[]): number {
  return intervals.reduce((sum, i) => sum + (i.endMs - i.startMs), 0);
}

// runGate(pcmPath, totalMs) -> keep/drop decision for one recorded segment.
// The gate is pure config: noise floor (dB), minimum speech duration and a
// minimum speech ratio; all tunable from .env without code changes.
export async function runGate(pcmPath: string, totalMs: number): Promise<GateResult> {
  const noiseDb = config.audioGate.noiseDb;
  const minSpeechMs = config.audioGate.minSpeechMs;
  const minRatio = config.audioGate.minSpeechRatio;

  const stderr = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    // Raw PCM has no header: the sample format must be stated explicitly or
    // ffmpeg fails before silencedetect runs. On error we still resolve with
    // whatever silencedetect produced (fail-open: the gate degrades to
    // pass-all, never to a stuck pipeline) and log the failure.
    ffmpeg(pcmPath)
      .inputFormat('s16le')
      .audioChannels(1)
      .audioFrequency(48000)
      .audioFilters([`silencedetect=noise=${noiseDb}dB:d=0.3`])
      .format('null')
      .output('-')
      .on('error', (err) => {
        chunks.push(Buffer.from(`[gate-ffmpeg-error] ${err.message}\n`));
        resolve(Buffer.concat(chunks).toString('utf8'));
      })
      .on('stderr', (line) => chunks.push(Buffer.from(`${line}\n`)))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .run();
  });

  const silences = parseSilencedetect(stderr);
  if (stderr.includes('[gate-ffmpeg-error]')) {
    console.warn(`[gate] ffmpeg analysis failed, failing open: ${stderr.split('\n').find((l) => l.includes('[gate-ffmpeg-error]'))}`);
  }
  const speech = speechIntervals(totalMs, silences);
  const speechMs = sumDurationMs(speech);
  const ratio = totalMs > 0 ? speechMs / totalMs : 0;

  if (speechMs < minSpeechMs) {
    return {
      kept: false, totalMs, speechMs, ratio, speechIntervals: speech,
      trimStartMs: null, trimEndMs: null,
      reason: `speech ${Math.round(speechMs)}ms < min ${minSpeechMs}ms`,
    };
  }
  if (ratio < minRatio) {
    return {
      kept: false, totalMs, speechMs, ratio, speechIntervals: speech,
      trimStartMs: null, trimEndMs: null,
      reason: `speech ratio ${(ratio * 100).toFixed(0)}% < min ${(minRatio * 100).toFixed(0)}%`,
    };
  }

  // Trim to the speech span (pad 250ms each side, clamped to the file) so the
  // upload carries only the useful region.
  const pad = 250;
  const trimStartMs = Math.max(0, speech[0].startMs - pad);
  const trimEndMs = Math.min(totalMs, speech[speech.length - 1].endMs + pad);
  return {
    kept: true, totalMs, speechMs, ratio, speechIntervals: speech,
    trimStartMs, trimEndMs, reason: 'ok',
  };
}
