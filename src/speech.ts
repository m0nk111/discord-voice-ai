// Speech-to-text and text-to-speech via any OpenAI-compatible API. By default
// this points at the self-hosted guardian gateway (OPENAI_BASE_URL), but any
// endpoint implementing OpenAI's audio routes works.
// Plain HTTP via axios, with the Authorization header the original code omitted.

import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import { config } from './config';
import { activeVoiceProfile } from './voices';

// transcribe(filePath) -> text (Whisper-compatible). Uses the dedicated
// STT endpoint when configured (STT_BASE_URL/STT_API_KEY), else the shared
// OpenAI-compatible base (guardian gateway).
export async function transcribe(filePath: string): Promise<string> {
  const baseUrl = config.speech.sttBaseUrl || config.openai.baseUrl;
  const apiKey = config.speech.sttApiKey || config.openai.apiKey;
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
  return res.data.text;
}

// synthesize(text) -> audio Buffer in config.speech.ttsFormat ("wav" by default).
// When a voice profile is active, its design instruct and optional zero-shot
// clone fields (ref_audio/ref_text/language) ride along; the guardian engine
// ignores unknown/empty fields, and OpenAI cloud tolerates the extra keys.
export async function synthesize(text: string): Promise<Buffer> {
  const profile = activeVoiceProfile();
  const baseUrl = config.speech.ttsBaseUrl || config.openai.baseUrl;
  const apiKey = config.speech.ttsApiKey || config.openai.apiKey;
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
  return Buffer.from(res.data);
}
