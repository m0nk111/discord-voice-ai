// Realtime activity dashboard — plain Node http (zero extra deps): one HTML
// page (inline), an SSE stream for live events, and JSON endpoints for
// counters/history. Served by the bot process itself; DASHBOARD_PORT=0
// disables it. Optional DASHBOARD_TOKEN gates both page and JSON endpoints.

import http from 'http';

import { config } from './config';
import * as telemetry from './telemetry';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Sjonnie — voice activity</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  h1 .dot { color: #3fb950; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px; min-width: 140px; }
  .card .v { font-size: 22px; font-weight: 700; color: #58a6ff; }
  .card .l { font-size: 11px; color: #8b949e; text-transform: uppercase; }
  table { border-collapse: collapse; width: 100%; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
  td, th { padding: 5px 10px; text-align: left; border-bottom: 1px solid #21262d; font-size: 12.5px; }
  th { color: #8b949e; position: sticky; top: 0; background: #161b22; }
  .t-stt_result { color: #58a6ff; }
  .t-llm_reply { color: #d2a8ff; }
  .t-tts_done { color: #3fb950; }
  .t-gate_skip { color: #f85149; }
  .t-gate_pass { color: #7ee787; }
  .t-recording_start { color: #e3b341; }
  .badge { display: inline-block; padding: 0 6px; border-radius: 10px; background: #30363d; font-size: 11px; }
</style></head>
<body>
<h1><span class="dot">&#9679;</span> Sjonnie voice activity</h1>
<div class="cards" id="cards"></div>
<table><thead><tr><th style="width:90px">time</th><th style="width:110px">event</th><th>detail</th></tr></thead>
<tbody id="feed"></tbody></table>
<script>
const LABELS = {
  recording_start: 'rec start', recording_end: 'rec end',
  gate_skip: 'GATE SKIP', gate_pass: 'gate pass',
  stt_request: 'STT →', stt_result: 'STT ✓', stt_done: 'STT latency',
  llm_start: 'LLM →', llm_reply: 'LLM ✓',
  tts_request: 'TTS →', tts_done: 'TTS ✓', info: 'info',
};
const CARDS = [
  ['stt_requests', 'STT requests'], ['gate_skipped', 'gated (noise)'],
  ['stt_audio_ms', 'audio sent (s)'], ['llm_replies', 'LLM replies'],
  ['tts_requests', 'TTS requests'], ['tts_audio_bytes', 'TTS bytes'],
];
function fmt(ev) {
  const d = ev.data || {};
  if (ev.type === 'recording_start') return 'user ' + (d.user ?? '?') + ' — capturing';
  if (ev.type === 'recording_end') return 'user ' + (d.user ?? '?') + ' — ' + Math.round((d.ms ?? 0) / 100) / 10 + 's captured';
  if (ev.type === 'gate_skip') return 'user ' + (d.user ?? '?') + ' — ' + d.reason + ' (no upload)';
  if (ev.type === 'gate_pass') return 'user ' + (d.user ?? '?') + ' — speech ' + Math.round((d.speechMs ?? 0) / 100) / 10 + 's / ' + Math.round((d.totalMs ?? 0) / 100) / 10 + 's (' + Math.round((d.ratio ?? 0) * 100) + '%), trim ' + Math.round((d.trimmedMs ?? 0) / 100) / 10 + 's';
  if (ev.type === 'stt_request') return (d.engine ?? '?') + ' — ' + Math.round((d.ms ?? 0) / 100) / 10 + 's audio';
  if (ev.type === 'stt_done') return Math.round(d.latencyMs ?? 0) + 'ms, ' + (d.chars ?? 0) + ' chars';
  if (ev.type === 'stt_result') return '"' + (d.text ?? '').slice(0, 120) + '" (' + Math.round(d.latencyMs ?? 0) + 'ms)';
  if (ev.type === 'llm_reply') return '"' + (d.text ?? '').slice(0, 120) + '"';
  if (ev.type === 'tts_request') return (d.engine ?? '?') + ' — ' + (d.chars ?? 0) + ' chars';
  if (ev.type === 'tts_done') return Math.round((d.bytes ?? 0) / 1024) + ' KiB in ' + Math.round(d.latencyMs ?? 0) + 'ms';
  return JSON.stringify(d).slice(0, 140);
}
function row(ev) {
  const tr = document.createElement('tr');
  const t = new Date(ev.ts).toLocaleTimeString();
  tr.innerHTML = '<td>' + t + '</td><td class="t-' + ev.type + '"><span class="badge">' + (LABELS[ev.type] ?? ev.type) + '</span></td><td class="t-' + ev.type + '"></td>';
  tr.children[2].textContent = fmt(ev);
  return tr;
}
function renderStats(c) {
  const el = document.getElementById('cards');
  el.innerHTML = '';
  for (const [key, label] of CARDS) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = '<div class="v"></div><div class="l">' + label + '</div>';
    div.children[0].textContent = c[key] ?? 0;
    el.appendChild(div);
  }
}
fetch('/api/stats' + location.search).then(r => r.json()).then(s => {
  renderStats(s.counters);
  for (const ev of s.events.slice(-80).reverse()) document.getElementById('feed').appendChild(row(ev));
});
const es = new EventSource('/events' + location.search);
es.addEventListener('stats', e => renderStats(JSON.parse(e.data)));
es.addEventListener('event', e => {
  const ev = JSON.parse(e.data);
  const feed = document.getElementById('feed');
  feed.insertBefore(row(ev), feed.firstChild);
  while (feed.children.length > 150) feed.removeChild(feed.lastChild);
});
es.onerror = () => { document.querySelector('h1 .dot').style.color = '#f85149'; };
</script>
</body></html>`;

function authorized(req: http.IncomingMessage): boolean {
  const expected = config.dashboard.token;
  if (!expected) return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const header = req.headers.authorization ?? '';
  return url.searchParams.get('token') === expected
    || header === `Bearer ${expected}`;
}

export function startDashboard(): http.Server | null {
  const port = config.dashboard.port;
  if (!port) return null;
  const server = http.createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (url.pathname === '/api/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(telemetry.snapshot()));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      const sendStats = () => res.write(`event: stats\ndata: ${JSON.stringify(telemetry.snapshot().counters)}\n\n`);
      sendStats();
      const statsTimer = setInterval(sendStats, 5000);
      const unsub = telemetry.subscribe((event) => {
        res.write(`event: event\ndata: ${JSON.stringify(event)}\n\n`);
      });
      req.on('close', () => {
        clearInterval(statsTimer);
        unsub();
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.listen(port, () => {
    console.info(`[dashboard] http://0.0.0.0:${port}/ (token: ${config.dashboard.token ? 'on' : 'off'})`);
  });
  return server;
}
