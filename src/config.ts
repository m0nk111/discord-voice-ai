// Central configuration. Every setting has a sensible default, so the only
// values that MUST appear in .env are the Discord credentials and the API key
// for the selected provider.

import 'dotenv/config';

export type Provider = 'openai' | 'anthropic';

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful, friendly assistant. If you do not know the answer, just say so.';

// Mode-specific style, appended to the base prompt automatically so the user
// only ever maintains one personality line.
const VOICE_STYLE =
  ' Your reply is read aloud by a text-to-speech engine, so it MUST be plain spoken '
  + 'text only. NEVER use Markdown or symbols of any kind: no asterisks, no bold or '
  + 'italics, no bullet points, no numbered lists, no headings or hashes, no backticks '
  + 'or code blocks, no emoji. Write exactly as you would say it out loud, in ordinary '
  + 'sentences. If you list things, say them in a sentence (for example "first... '
  + 'second..."), never as a formatted list.';
const FREE_STYLE =
  ' You are in a group voice call. If a message clearly is not meant for you, '
  + 'reply with exactly "[IGNORING]" and nothing else.';
const TEXT_STYLE =
  ' You are replying in a text chat, so you can use Markdown formatting when it helps.';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length ? v : fallback;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true';
}

function list(name: string, fallback: string): string[] {
  return str(name, fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN ?? '',
    appId: process.env.DISCORD_ID ?? '',
  },
  provider: str('LLM_PROVIDER', 'openai').toLowerCase() as Provider,
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    model: str('OPENAI_MODEL', 'gpt-4o-mini'),
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    baseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
    model: str('ANTHROPIC_MODEL', 'claude-haiku-4-5'),
    version: str('ANTHROPIC_VERSION', '2023-06-01'),
    maxTokens: int('ANTHROPIC_MAX_TOKENS', 1024),
  },
  speech: {
    sttModel: str('STT_MODEL', 'whisper-1'),
    // Optional dedicated STT endpoint. Defaults to OPENAI_BASE_URL/apiKey
    // (the guardian gateway). Point these at a cloud STT provider to use a
    // different engine for transcription only, e.g. a Groq or Deepgram
    // OpenAI-compatible audio endpoint.
    sttBaseUrl: str('STT_BASE_URL', ''),
    sttApiKey: str('STT_API_KEY', ''),
    // Optional language hint for STT, e.g. "nl" or "en" (ISO-639-1). The
    // guardian gateway maps these; empty means auto-detect.
    sttLang: str('STT_LANG', ''),
    ttsModel: str('TTS_MODEL', 'tts-1'),
    ttsVoice: str('TTS_VOICE', 'alloy'),
    // Optional dedicated TTS endpoint (OpenAI-compatible /audio/speech).
    // Defaults to OPENAI_BASE_URL/apiKey (the guardian gateway). Point these
    // at e.g. Groq or OpenAI cloud to use a different TTS engine.
    ttsBaseUrl: str('TTS_BASE_URL', ''),
    ttsApiKey: str('TTS_API_KEY', ''),
    // Named voice profile from voices/<id>.json (persona + zero-shot clone
    // fields). Overrides TTS_VOICE when set.
    ttsVoiceProfile: str('TTS_VOICE_PROFILE', ''),
    // TTS response format. The guardian gateway serves "wav" or "pcm";
    // OpenAI also accepts "mp3".
    ttsFormat: str('TTS_FORMAT', 'wav'),
  },
  triggers: list('BOT_TRIGGERS', 'Assistant,Bot'),
  stopWords: list('STOP_WORDS', 'stop'),
  waitTime: int('WAIT_TIME', 1500),
  memoryTrimAt: int('MEMORY_TRIM_AT', 50),
  memoryKeep: int('MEMORY_KEEP', 20),
  memoryMaxTokens: int('MEMORY_MAX_TOKENS', 100000),
  vision: bool('VISION', true),
  // Verbose @discordjs/voice connection logging (voice join/UDP diagnostics).
  voiceDebug: bool('VOICE_DEBUG', false),
  // Pre-upload audio gate: drop segments that carry too little speech before
  // they reach the STT gateway (saves uploads and hallucinated transcripts).
  audioGate: {
    enabled: bool('AUDIO_GATE', true),
    noiseDb: int('VAD_NOISE_DB', -35),
    minSpeechMs: int('VAD_MIN_SPEECH_MS', 600),
    minSpeechRatio: int('VAD_MIN_SPEECH_RATIO', 25) / 100,
  },
  // Realtime activity dashboard (SSE + JSON) served by the bot process.
  dashboard: {
    port: int('DASHBOARD_PORT', 3141),
    token: str('DASHBOARD_TOKEN', ''),
  },
  systemPrompt: str('SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT),
};

// Build the full system prompt for a mode by appending that mode's style.
export function buildSystemPrompt(mode: 'voice' | 'voiceFree' | 'text'): string {
  const base = config.systemPrompt;
  if (mode === 'text') return base + TEXT_STYLE;
  if (mode === 'voiceFree') return base + VOICE_STYLE + FREE_STYLE;
  return base + VOICE_STYLE;
}

// Throws if the essentials are missing. Called once at startup.
export function validateConfig(): void {
  const missing: string[] = [];
  if (!config.discord.token) missing.push('DISCORD_TOKEN');
  if (!config.discord.appId) missing.push('DISCORD_ID');
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  }
  if (config.provider === 'anthropic' && !config.anthropic.apiKey) {
    throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.');
  }
  if (config.provider === 'openai' && !config.openai.apiKey) {
    throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY is not set.');
  }
}

// Voice always needs OpenAI for STT/TTS; warn (don't crash) if the key is absent.
export function speechConfigWarning(): string | null {
  if (!config.openai.apiKey) {
    return 'OPENAI_API_KEY is not set, so voice transcription and speech will fail.';
  }
  return null;
}
