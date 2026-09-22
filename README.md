# Discord Voice AI

A self hosted Discord bot for talking to an AI by voice. In a voice channel it transcribes what you say with OpenAI Whisper, sends it to an LLM (OpenAI GPT or Anthropic Claude), and speaks the reply back with text to speech. It also answers text messages.

It runs on your own OpenAI or Anthropic key. Setup is three values in a `.env` file and one command.

It is built in TypeScript on discord.js, which can receive voice from a channel out of the box, something the common Python Discord libraries cannot do without extra work.

> Keywords: Discord, voice chat, VC, voice AI, LLM, bot, talk to AI, voice assistant, speech to text, text to speech, TTS, STT, OpenAI, GPT, Anthropic, Claude, Whisper, self hosted, API key, TypeScript.

## Features
- Voice conversation in a voice channel, using a wake word or a free mode with no wake word. Say "stop" to interrupt it.
- Works with either OpenAI (GPT) or Anthropic (Claude), chosen with one setting. Defaults to inexpensive models.
- Streams the reply, so it starts speaking before the whole answer is finished.
- Answers in text channels too: mention it, reply to it, or talk in a thread it started.
- Optional image reactions: post an image and it responds out loud using the model's vision.

## Requirements
- **Node.js 18 or newer.**
- **A Discord bot.** Create an application at the [Discord Developer Portal](https://discord.com/developers/applications), add a bot, enable the **Message Content** intent, and copy the bot **token** and the **application ID**.
- **An OpenAI API key** from [platform.openai.com](https://platform.openai.com). It powers speech to text (Whisper), text to speech, and the LLM when the provider is OpenAI.
- Optional: an **Anthropic API key** if you want Claude to be the brain.

## Setup (the whole thing)
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create your config. Copy `.env.example` to `.env` and fill in the three required values: `DISCORD_TOKEN`, `DISCORD_ID`, and `OPENAI_API_KEY`. Everything else has sensible defaults.
3. Start it:
   ```bash
   npm start
   ```

That is the entire setup. `npm start` builds the project, logs the bot in, and registers its slash commands automatically. Leave the terminal open to keep it running.

### Self-hosted gateway (e.g. guardian)

The bot talks to any OpenAI-compatible endpoint, so it can run fully self-hosted. Point `OPENAI_BASE_URL` at the gateway, use the gateway's API key as `OPENAI_API_KEY`, and pick a model the gateway serves:

```env
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
OPENAI_API_KEY=<gateway key>
OPENAI_MODEL=qwen3.5-9b
TTS_FORMAT=wav
```

One base URL then powers the whole voice loop: `/audio/transcriptions` (STT), `/chat/completions` (LLM) and `/audio/speech` (TTS). Notes: the guardian gateway serves TTS as `wav`/`pcm` only (16-bit mono 24 kHz WAV), STT accepts Whisper-style multipart uploads (wav or mp3, optional `STT_LANG=nl` hint), and unknown extra request fields such as `speed` are ignored.

## Using it
1. Invite the bot to your server with an OAuth2 URL from your Discord application (give it permission to join and speak in voice channels, and to read and send messages).
2. Join a voice channel, then run `/join`.
3. Say a wake word followed by your question, for example: **"Assistant, what is the tallest mountain on Mars?"**. It transcribes, thinks, and answers out loud. Say `stop` to interrupt it.

With `/join free` there is no wake word: it responds to everything you say, unless it decides a message was not meant for it and stays quiet.

### Voice profiles (persona voices)

`TTS_VOICE_PROFILE=<id>` loads `voices/<id>.json` — the same format the
councelofdicksv2 project uses. A profile carries a VoiceDesign `instruct`
passed through the gateway's TTS engine, plus optional zero-shot clone fields
(`ref_audio`, `ref_text`, `language`) resolved from the engine's own
`voice_samples/` directory. Example: `voices/trump.json`. Without a profile the
bot uses plain `TTS_VOICE`. Remember the bot replies in whatever language the
`SYSTEM_PROMPT` dictates — pick one that suits the voice.

## Commands
- `/join`: join your voice channel and listen for a wake word.
- `/join silent`: same, without the confirmation beeps.
- `/join free`: no wake word needed. It responds to everything you say, unless it decides a message was not meant for it.
- `/reset`: clear the conversation. You can also say "reset chat history" in voice.
- `/leave`: leave the channel. You can also say "leave voice chat" in voice.
- `/help`: show the commands.

## Configuration
All settings live in `.env`, documented in `.env.example`. Only the Discord credentials and one API key are required. Optional knobs include the models, the TTS voice, the wake words (`BOT_TRIGGERS`), the interrupt word (`STOP_WORDS`), and the personality (`SYSTEM_PROMPT`).

## Scripts
- `npm start`: build and run the bot (the only command you normally need).
- `npm run dev`: run from source via `tsx` (no build step).
- `npm run build`: type check and compile to `dist/`.
- `npm test`: run the unit tests.

## Acknowledgements
Inspired by [Eidenz/Discord-VC-LLM](https://github.com/Eidenz/Discord-VC-LLM). Thanks to Eidenz for the original project.
