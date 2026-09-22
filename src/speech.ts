// Speech-to-text and text-to-speech via any OpenAI-compatible API. By default
// this points at the self-hosted guardian gateway (OPENAI_BASE_URL), but any
// endpoint implementing OpenAI's audio routes works.
// Plain HTTP via axios, with the Authorization header the original code omitted.

import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import { config } from './config';

// transcribe(filePath) -> text (Whisper-compatible)
export async function transcribe(filePath: string): Promise<string> {
  const form = new FormData();
  form.append('model', config.speech.sttModel);
  if (config.speech.sttLang) form.append('language', config.speech.sttLang);
  form.append('file', fs.createReadStream(filePath));

  const res = await axios.post(`${config.openai.baseUrl}/audio/transcriptions`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${config.openai.apiKey}`,
    },
  });
  return res.data.text;
}

// synthesize(text) -> audio Buffer in config.speech.ttsFormat ("wav" by default)
export async function synthesize(text: string): Promise<Buffer> {
  const res = await axios.post(
    `${config.openai.baseUrl}/audio/speech`,
    {
      model: config.speech.ttsModel,
      input: text,
      voice: config.speech.ttsVoice,
      response_format: config.speech.ttsFormat,
      speed: 1.0,
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
    },
  );
  return Buffer.from(res.data);
}
