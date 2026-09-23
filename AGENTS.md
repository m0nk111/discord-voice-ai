# AGENTS.md — discord_ai_person (discord-voice-ai fork)

## Purpose and scope

Discord voice bot that listens in a voice channel (STT), thinks via an LLM and
replies with TTS — the classic voice loop. This repo is a fork of
`JonasNordlander/discord-voice-ai` (MIT), adapted to run against the operator's
self-hosted **guardian-llmprovider-gateway** (`~/guardian-llmprovider-gateway`,
proxy on `:11434`) instead of OpenAI cloud. Scope: this repository only.

## Stack and layout

- TypeScript, Node ≥ 20 (dev machine: Node 25). `discord.js` 14,
  `@discordjs/voice`, `prism-media`, `axios`, `ffmpeg-static`, `dotenv`.
- `src/` — all source: `bot.ts` (Discord client, voice join/receive, pipeline
  wiring), `config.ts` (env-driven config, single source), `speech.ts` (STT/TTS
  HTTP calls), `audiogate.ts` (pre-upload noise gate via ffmpeg silencedetect),
  `telemetry.ts` + `dashboard.ts` (in-process realtime SSE dashboard,
  `DASHBOARD_PORT` default 3141), `llm.ts` (chat completions, SSE streaming),
  `text.ts`.
- `test/unit.test.ts` — node:test suite (runs via tsx, no separate test runner).
- Config comes from `.env` (see `.env.example`); required: `DISCORD_TOKEN`,
  `DISCORD_ID`, `OPENAI_API_KEY` (the guardian key). `OPENAI_BASE_URL` points
  STT + TTS + LLM at one OpenAI-compatible base.

## Working rules

- English code/comments/docs. No secrets in source: keys live in `.env`
  (gitignored) or guardian's `config/guardian.keys.yaml` — never commit them.
- Guardian speech contract (route-oriented, PR #24, verified 2026-09-23): a
speech `model` is an ADDRESS `[guardian/]{provider}/{brand}/{model}` resolving
via the provider file alone (stt_url/tts_url -> local engine, base_url+api_key
-> cloud); an explicit address is EXACT (failures never fall back); no address
-> default failover chain. Gap: single-segment upstream ids (whisper-large-v3)
are not addressable — guardian issue filed, Sjonnie STT runs the default local
chain until fixed. Older verified details: TTS `POST /v1/audio/speech` accepts
  `response_format` `wav`/`pcm` only (16-bit mono 24 kHz WAV out), extra fields
  (`model`, `speed`) are ignored, `voice` maps to a VoiceDesign instruction
  (unknown strings pass through verbatim). STT `POST /v1/audio/transcriptions`
  expects multipart `file` (wav 16-bit PCM mono preferred), optional `model` and
  `language` (`nl`/`en`). Chat: OpenAI-compatible `/v1/chat/completions` with SSE.
- Keep upstream structure; adapt, don't rewrite. Small, testable changes with
  clear commit messages.
- Voice receive is an undocumented Discord surface: never join self-deaf
  (`selfDeaf: false`), keep `@discordjs/voice` current.

## Verification

- `npm run typecheck` — tsc --noEmit (found in package.json scripts).
- `npm test` — node:test via tsx (found in package.json scripts).
- `npm run build` — tsc emit to dist/ (found in package.json scripts).
- Run: `npm start` (build + node dist/bot.js) or `npm run dev` (tsx).
  A live run needs a Discord bot token + a reachable guardian on `:11434`.

## Maintenance

Stable rules only here; dated progress and findings go to the git history and,
when a handoff is needed, `docs/HANDOFF.md` (create on demand, archive-first).
