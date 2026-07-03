import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitMessage, chunkForSpeech, extractSentences, stripFormatting } from '../src/text';
import { trimHistory, normalizeForAnthropic, estimateTokens, ChatMessage } from '../src/llm';

test('splitMessage keeps every part under the limit and loses nothing', () => {
  const long = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
  const parts = splitMessage(long, 100);
  for (const p of parts) assert.ok(p.length <= 100, `part too long: ${p.length}`);
  assert.equal(parts.join(' '), long);
});

test('extractSentences pulls complete sentences and buffers the rest', () => {
  const { sentences, rest } = extractSentences('Hello there. How are you? I am fi');
  assert.deepEqual(sentences, ['Hello there.', 'How are you?']);
  assert.equal(rest, 'I am fi');
});

test('extractSentences buffers an unfinished sentence', () => {
  const { sentences, rest } = extractSentences('no punctuation yet');
  assert.deepEqual(sentences, []);
  assert.equal(rest, 'no punctuation yet');
});

test('extractSentences keeps decimals intact', () => {
  const { sentences, rest } = extractSentences('Pi is 3.14 and ');
  assert.deepEqual(sentences, []);
  assert.equal(rest, 'Pi is 3.14 and ');
});

test('chunkForSpeech splits long text on punctuation', () => {
  const chunks = chunkForSpeech('one two three. four five six.', 3);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join(' '), 'one two three. four five six.');
});

test('trimHistory batch-trims once past the high watermark, keeping the newest', () => {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 60; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
  const trimmed = trimHistory(msgs);
  assert.ok(trimmed.length <= 50, `expected <=50, got ${trimmed.length}`);
  assert.equal(trimmed[trimmed.length - 1].content, 'm59');
});

test('trimHistory leaves small histories untouched', () => {
  const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }];
  assert.deepEqual(trimHistory(msgs), msgs);
});

test('normalizeForAnthropic drops leading assistant turns and merges same-role', () => {
  const msgs: ChatMessage[] = [
    { role: 'assistant', content: 'lead' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
  ];
  const out = normalizeForAnthropic(msgs);
  assert.deepEqual(out, [
    { role: 'user', content: 'a\nb' },
    { role: 'assistant', content: 'c' },
  ]);
});

test('estimateTokens approximates ~4 characters per token', () => {
  assert.equal(estimateTokens([{ role: 'user', content: 'x'.repeat(400) }]), 100);
});

test('stripFormatting removes markdown so the TTS reads clean text', () => {
  assert.equal(stripFormatting('**Hello** _there_'), 'Hello there');
  assert.equal(stripFormatting('See [OpenAI](https://openai.com) docs'), 'See OpenAI docs');
  assert.equal(stripFormatting('# Title'), 'Title');
  assert.equal(stripFormatting('- one\n- two'), 'one\ntwo');
  assert.equal(stripFormatting('1. first\n2. second'), 'first\nsecond');
  assert.equal(stripFormatting('Run `npm start` now'), 'Run npm start now');
  assert.equal(stripFormatting('just a plain sentence.'), 'just a plain sentence.');
});
