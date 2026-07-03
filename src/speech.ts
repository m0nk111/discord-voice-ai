// Speech-to-text and text-to-speech, always via OpenAI's hosted API.
// Plain HTTP via axios, with the Authorization header the original code omitted.

import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import { config } from './config';

// transcribe(filePath) -> text (Whisper)
export async function transcribe(filePath: string): Promise<string> {
  const form = new FormData();
  form.append('model', config.speech.sttModel);
  form.append('file', fs.createReadStream(filePath));

  const res = await axios.post(`${config.openai.baseUrl}/audio/transcriptions`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${config.openai.apiKey}`,
    },
  });
  return res.data.text;
}

// synthesize(text) -> mp3 Buffer (OpenAI TTS)
export async function synthesize(text: string): Promise<Buffer> {
  const res = await axios.post(
    `${config.openai.baseUrl}/audio/speech`,
    {
      model: config.speech.ttsModel,
      input: text,
      voice: config.speech.ttsVoice,
      response_format: 'mp3',
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
