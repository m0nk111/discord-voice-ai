// Speech-to-text and text-to-speech via any OpenAI-compatible API. By default
// this points at the self-hosted guardian gateway (OPENAI_BASE_URL), but any
// endpoint implementing OpenAI's audio routes works.
// Plain HTTP via axios, with the Authorization header the original code omitted.

import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import { config } from './config';
import { activeVoiceProfile } from './voices';
import * as telemetry from './telemetry';

function sttEngineLabel(): string {
  if (config.speech.sttBaseUrl) return `direct:${new URL(config.speech.sttBaseUrl).host}`;
  return config.speech.sttModel.includes('/')
    ? `guardian→${config.speech.sttModel.split('/')[0]}`
    : 'guardian→local';
}

function ttsEngineLabel(): string {
  if (config.speech.ttsBaseUrl) return `direct:${new URL(config.speech.ttsBaseUrl).host}`;
  return config.speech.ttsModel.includes('/')
    ? `guardian→${config.speech.ttsModel.split('/')[0]}`
    : 'guardian→local';
}

// transcribe(filePath) -> text (Whisper-compatible). Uses the dedicated
// STT endpoint when configured (STT_BASE_URL/STT_API_KEY), else the shared
// OpenAI-compatible base (guardian gateway).
export async function transcribe(filePath: string): Promise<string> {
  const baseUrl = config.speech.sttBaseUrl || config.openai.baseUrl;
  const apiKey = config.speech.sttApiKey || config.openai.apiKey;
  const started = Date.now();
  const engine = sttEngineLabel();
  telemetry.emit('stt_request', { engine });
  telemetry.bump('stt_requests');
  const form = new FormData();
  form.append('model', config.speech.sttModel);
  if (config.speech.sttLang) form.append('language', config.speech.sttLang);
  form.append('file', fs.createReadStream(filePath));

  const res = await axios.post(`${baseUrl}/audio/transcriptions`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const text: string = res.data.text;
  telemetry.emit('stt_done', { engine, latencyMs: Date.now() - started, chars: text.length });
  return text;
}

// synthesize(text) -> audio Buffer in config.speech.ttsFormat ("wav" by default).
// When a voice profile is active, its design instruct and optional zero-shot
// clone fields (ref_audio/ref_text/language) ride along; the guardian engine
// ignores unknown/empty fields, and OpenAI cloud tolerates the extra keys.
export async function synthesize(text: string): Promise<Buffer> {
  const profile = activeVoiceProfile();
  const baseUrl = config.speech.ttsBaseUrl || config.openai.baseUrl;
  const apiKey = config.speech.ttsApiKey || config.openai.apiKey;
  const started = Date.now();
  const engine = ttsEngineLabel();
  telemetry.emit('tts_request', { engine, chars: text.length });
  telemetry.bump('tts_requests');
  const res = await axios.post(
    `${baseUrl}/audio/speech`,
    {
      model: config.speech.ttsModel,
      input: text,
      voice: profile?.instruct ?? config.speech.ttsVoice,
      response_format: config.speech.ttsFormat,
      speed: 1.0,
      ...(profile
        ? {
            ref_audio: profile.ref_audio,
            ref_text: profile.ref_text,
            language: profile.language,
            zero_shot: profile.zero_shot,
            seed: profile.seed ?? undefined,
          }
        : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
    },
  );
  const buffer = Buffer.from(res.data);
  telemetry.emit('tts_done', { engine, bytes: buffer.length, latencyMs: Date.now() - started });
  telemetry.bump('tts_audio_bytes', buffer.length);
  return buffer;
}
