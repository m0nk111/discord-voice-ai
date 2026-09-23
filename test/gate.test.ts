// Pins for the audio gate parser (ffmpeg silencedetect contract) and the
// telemetry bus (ring buffer, counters, subscriber isolation).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSilencedetect, speechIntervals, sumDurationMs } from '../src/audiogate';
import * as telemetry from '../src/telemetry';

const FFMPEG_STDERR = [
  '[silencedetect @ 0x55] silence_start: 0.9',
  '[silencedetect @ 0x55] silence_end: 1.35 | silence_duration: 0.45',
  '[silencedetect @ 0x55] silence_start: 2.1',
  '[silencedetect @ 0x55] silence_end: 3.05 | silence_duration: 0.95',
].join('\n');

test('parseSilencedetect extracts silence intervals in ms', () => {
  assert.deepEqual(parseSilencedetect(FFMPEG_STDERR), [
    { startMs: 900, endMs: 1350 },
    { startMs: 2100, endMs: 3050 },
  ]);
});

test('parseSilencedetect keeps an unterminated silence as open interval', () => {
  const out = parseSilencedetect('[x] silence_start: 1.0');
  assert.deepEqual(out, [{ startMs: 1000, endMs: Infinity }]);
});

test('parseSilencedetect returns empty for all-speech audio', () => {
  assert.deepEqual(parseSilencedetect('no silence markers here'), []);
});

test('speechIntervals computes the complement of silence', () => {
  const speech = speechIntervals(5000, [
    { startMs: 900, endMs: 1350 },
    { startMs: 2100, endMs: 3050 },
  ]);
  assert.deepEqual(speech, [
    { startMs: 0, endMs: 900 },
    { startMs: 1350, endMs: 2100 },
    { startMs: 3050, endMs: 5000 },
  ]);
  assert.equal(sumDurationMs(speech), 3600);
});

test('speechIntervals clamps trailing open silence to the total length', () => {
  const speech = speechIntervals(4000, [{ startMs: 1000, endMs: Infinity }]);
  assert.deepEqual(speech, [{ startMs: 0, endMs: 1000 }]);
});

test('telemetry ring buffer caps and counters accumulate', () => {
  for (let i = 0; i < 300; i++) telemetry.emit('info', { i });
  assert.equal(telemetry.recentEvents(1000).length, 250);
  assert.equal(telemetry.getCounter('info.total'), 300);
});

test('telemetry subscribers receive events; throwing subscribers do not break emit', () => {
  const seen: unknown[] = [];
  const unsub = telemetry.subscribe((e) => seen.push(e.data));
  telemetry.subscribe(() => {
    throw new Error('broken subscriber');
  });
  telemetry.emit('info', { hello: 1 });
  assert.equal((seen[0] as { hello: number }).hello, 1);
  unsub();
  assert.equal(telemetry.getCounter('info.total') > 0, true);
});
