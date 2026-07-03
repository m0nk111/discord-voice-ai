// LLM provider abstraction over plain HTTP (no SDKs).
//
//   - "openai"    -> OpenAI-compatible /chat/completions
//   - "anthropic" -> Anthropic's native /v1/messages API
//
// Callers pass a normalized { system, messages } where messages are
// user/assistant turns only. The two providers' request/response shapes are
// hidden behind chat() and vision().

import axios from 'axios';
import { Readable } from 'stream';
import { config } from './config';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function openaiHeaders() {
  return {
    Authorization: `Bearer ${config.openai.apiKey}`,
    'Content-Type': 'application/json',
  };
}

function anthropicHeaders() {
  return {
    'x-api-key': config.anthropic.apiKey,
    'anthropic-version': config.anthropic.version,
    'Content-Type': 'application/json',
  };
}

// Anthropic requires messages to start with a user turn and alternate roles.
// Drop leading assistant turns and merge consecutive same-role turns.
export function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const clean = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  while (clean.length && clean[0].role === 'assistant') clean.shift();

  const merged: ChatMessage[] = [];
  for (const m of clean) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n${m.content}`;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  return merged;
}

export function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 4); // ~4 chars per token — a rough safety-net estimate
}

// Bounds conversation history for cost and focus. History grows to a high
// watermark, then is trimmed back to a low watermark in one batch. Trimming in
// batches (rather than dropping the oldest message every turn) keeps the prompt
// prefix stable between trims, so prompt caching stays valid. The token ceiling
// is a final safety net that rarely fires for short voice messages.
export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  let trimmed = messages;
  if (trimmed.length > config.memoryTrimAt) {
    trimmed = trimmed.slice(-config.memoryKeep);
  }
  while (trimmed.length > 2 && estimateTokens(trimmed) > config.memoryMaxTokens) {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

async function openaiChat(system: string, messages: ChatMessage[]): Promise<string> {
  const finalMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const res = await axios.post(
    `${config.openai.baseUrl}/chat/completions`,
    { model: config.openai.model, messages: finalMessages },
    { headers: openaiHeaders() },
  );
  return res.data.choices[0].message.content;
}

async function anthropicChat(system: string, messages: ChatMessage[]): Promise<string> {
  const normalized = normalizeForAnthropic(messages);

  // Prompt caching: mark the system prompt and the last message as cache
  // breakpoints so the repeated system + conversation-history prefix is billed
  // at the cheap cache-read rate on later turns. Anthropic only caches prefixes
  // above a minimum size, so this is a harmless no-op for short chats and a real
  // saving once the history grows. (OpenAI caches automatically — nothing to do.)
  const cachedMessages = normalized.map((m, i) => {
    if (i !== normalized.length - 1) return m;
    return {
      role: m.role,
      content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
    };
  });

  const res = await axios.post(
    `${config.anthropic.baseUrl}/v1/messages`,
    {
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: system
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : undefined,
      messages: cachedMessages,
    },
    { headers: anthropicHeaders() },
  );
  const textBlock = res.data.content.find((b: { type: string }) => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

async function openaiVision(system: string, prompt: string, imageUrl: string): Promise<string> {
  const messages: unknown[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: imageUrl } },
    ],
  });
  const res = await axios.post(
    `${config.openai.baseUrl}/chat/completions`,
    { model: config.openai.model, messages },
    { headers: openaiHeaders() },
  );
  return res.data.choices[0].message.content;
}

async function anthropicVision(system: string, prompt: string, imageUrl: string): Promise<string> {
  const res = await axios.post(
    `${config.anthropic.baseUrl}/v1/messages`,
    {
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: system || undefined,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image', source: { type: 'url', url: imageUrl } },
          ],
        },
      ],
    },
    { headers: anthropicHeaders() },
  );
  const textBlock = res.data.content.find((b: { type: string }) => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

export async function chat(system: string, messages: ChatMessage[]): Promise<string> {
  if (config.provider === 'anthropic') return anthropicChat(system, messages);
  return openaiChat(system, messages);
}

// Read a Server-Sent-Events stream line by line, handing each `data:` payload
// to the callback.
async function readSSE(stream: Readable, onData: (data: string) => void): Promise<void> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) onData(line.slice(5).trim());
    }
  }
}

async function openaiChatStream(system: string, messages: ChatMessage[], onText: (delta: string) => void, signal?: AbortSignal): Promise<string> {
  const finalMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const res = await axios.post(
    `${config.openai.baseUrl}/chat/completions`,
    { model: config.openai.model, messages: finalMessages, stream: true },
    { headers: openaiHeaders(), responseType: 'stream', signal },
  );
  let full = '';
  await readSSE(res.data as Readable, (data) => {
    if (data === '[DONE]') return;
    try {
      const delta = JSON.parse(data).choices?.[0]?.delta?.content;
      if (delta) { full += delta; onText(delta); }
    } catch { /* ignore keep-alive / partial frames */ }
  });
  return full;
}

async function anthropicChatStream(system: string, messages: ChatMessage[], onText: (delta: string) => void, signal?: AbortSignal): Promise<string> {
  const normalized = normalizeForAnthropic(messages);
  const cachedMessages = normalized.map((m, i) => (i !== normalized.length - 1 ? m : {
    role: m.role,
    content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
  }));
  const res = await axios.post(
    `${config.anthropic.baseUrl}/v1/messages`,
    {
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
      messages: cachedMessages,
      stream: true,
    },
    { headers: anthropicHeaders(), responseType: 'stream', signal },
  );
  let full = '';
  await readSSE(res.data as Readable, (data) => {
    try {
      const json = JSON.parse(data);
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
        full += json.delta.text;
        onText(json.delta.text);
      }
    } catch { /* ignore non-delta events */ }
  });
  return full;
}

// Streams the reply, calling onText for each text delta, and returns the full text.
export async function chatStream(system: string, messages: ChatMessage[], onText: (delta: string) => void, signal?: AbortSignal): Promise<string> {
  if (config.provider === 'anthropic') return anthropicChatStream(system, messages, onText, signal);
  return openaiChatStream(system, messages, onText, signal);
}

export async function vision(system: string, prompt: string, imageUrl: string): Promise<string> {
  if (config.provider === 'anthropic') return anthropicVision(system, prompt, imageUrl);
  return openaiVision(system, prompt, imageUrl);
}

export const activeModel = config.provider === 'anthropic' ? config.anthropic.model : config.openai.model;
