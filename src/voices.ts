// Voice profiles: named TTS persona configs compatible with the
// councelofdicksv2 voices/*.json format. A profile sets the VoiceDesign
// instruction and optionally carries zero-shot clone fields (ref_audio/
// ref_text/language) that the guardian TTS engine resolves from its own
// voice_samples directory. See voices/trump.json.

import fs from 'fs';
import path from 'path';

import { config } from './config';

export interface VoiceProfile {
  id: string;
  name?: string;
  instruct?: string;
  ref_audio?: string;
  ref_text?: string;
  language?: string;
  zero_shot?: boolean;
  seed?: number | null;
}

let cached: VoiceProfile | null | undefined;

// activeVoiceProfile() -> the configured profile or null. Loaded once and
// cached; a missing or malformed file logs a warning and falls back to the
// plain TTS_VOICE setting instead of failing the bot.
export function activeVoiceProfile(): VoiceProfile | null {
  if (cached !== undefined) return cached;
  const id = config.speech.ttsVoiceProfile;
  if (!id) {
    cached = null;
    return cached;
  }
  const file = path.join('voices', `${id}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as VoiceProfile;
    cached = { ...parsed, id: parsed.id ?? id };
  } catch (error) {
    console.warn(`Voice profile '${id}' could not be loaded from ${file}: ${(error as Error).message}. Using plain voice.`);
    cached = null;
  }
  return cached;
}
