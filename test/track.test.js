'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-track-'));
const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const STATS_KEY = 'test-stats-key';

let child;

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* сервер ещё поднимается */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      STATS_KEY,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: ''
    }
  });
  await waitReady();
});

after(() => {
  if (child) child.kill();
});

test('POST /track принимает визит, отвечает 204 и пишет строку в visits.jsonl', async () => {
  const res = await fetch(`${BASE}/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'TestAgent/1.0' },
    body: JSON.stringify({
      path: '/',
      ref: 'https://example.com/source',
      screen: '1920x1080',
      lang: 'ru-RU',
      tz: 'Europe/Moscow'
    })
  });
  assert.strictEqual(res.status, 204);

  const file = path.join(DATA_DIR, 'visits.jsonl');
  await new Promise((r) => setTimeout(r, 300));
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const row = rows[rows.length - 1];
  assert.strictEqual(row.path, '/');
  assert.strictEqual(row.ref, 'https://example.com/source');
  assert.strictEqual(row.lang, 'ru-RU');
  assert.ok(row.ip, 'ip записан');
  assert.strictEqual(row.ua, 'TestAgent/1.0');
});

test('POST /track отбивает тело больше лимита кодом 413', async () => {
  const res = await fetch(`${BASE}/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'x'.repeat(8000) })
  });
  assert.strictEqual(res.status, 413);
});

test('POST /track отклоняет чужой Origin', async () => {
  const res = await fetch(`${BASE}/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: '{}'
  });
  assert.strictEqual(res.status, 403);
});

test('GET /track — 405', async () => {
  const res = await fetch(`${BASE}/track`);
  assert.strictEqual(res.status, 405);
});

test('/stats без ключа — 404, с ключом — 200 и экранированный список', async () => {
  const denied = await fetch(`${BASE}/stats`);
  assert.strictEqual(denied.status, 404);

  const wrong = await fetch(`${BASE}/stats?key=nope`);
  assert.strictEqual(wrong.status, 404);

  const ok = await fetch(`${BASE}/stats?key=${STATS_KEY}`);
  assert.strictEqual(ok.status, 200);
  const html = await ok.text();
  assert.ok(html.includes('TestAgent/1.0'));
  assert.ok(html.includes('example.com'));
});
