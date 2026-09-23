// Telemetry — in-memory event bus feeding the realtime dashboard. One ring
// buffer of recent events plus lifetime counters; SSE clients subscribe via
// dashboard.ts. Everything is per-process memory: a bot restart resets it.

export type TelemetryType =
  | 'recording_start'
  | 'recording_end'
  | 'gate_skip'
  | 'gate_pass'
  | 'stt_request'
  | 'stt_result'
  | 'stt_done'
  | 'llm_start'
  | 'llm_reply'
  | 'tts_request'
  | 'tts_done'
  | 'info';

export interface TelemetryEvent {
  ts: number;
  type: TelemetryType;
  data: Record<string, unknown>;
}

const MAX_EVENTS = 250;

const events: TelemetryEvent[] = [];
const counters: Record<string, number> = {};
const subscribers = new Set<(event: TelemetryEvent) => void>();

export function emit(type: TelemetryType, data: Record<string, unknown> = {}): void {
  const event: TelemetryEvent = { ts: Date.now(), type, data };
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
  bump(`${type}.total`);
  for (const sub of subscribers) {
    try {
      sub(event);
    } catch {
      // a broken subscriber must never disturb the bot pipeline
    }
  }
}

export function bump(counter: string, amount = 1): void {
  counters[counter] = (counters[counter] ?? 0) + amount;
}

export function getCounter(counter: string): number {
  return counters[counter] ?? 0;
}

export function recentEvents(limit = 100): TelemetryEvent[] {
  return events.slice(-limit);
}

export function snapshot(): {
  counters: Record<string, number>;
  events: TelemetryEvent[];
} {
  return { counters: { ...counters }, events: recentEvents(MAX_EVENTS) };
}

export function subscribe(handler: (event: TelemetryEvent) => void): () => void {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}
