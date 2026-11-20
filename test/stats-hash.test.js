'use strict';

// Хэш-режим /stats: сервер принимает STATS_KEY_SHA256 (sha256-хэш ключа)
// без самого ключа — для облаков, куда секреты не загружаются.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-stats-hash-'));
const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-hash-mode-key';
const KEY_SHA256 = crypto.createHash('sha256').update(KEY).digest('hex');

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
      STATS_KEY: '',
      STATS_KEY_SHA256: KEY_SHA256,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: ''
    }
  });
  await waitReady();
});

after(() => {
  if (child) child.kill();
});

test('/stats в хэш-режиме: без ключа и с неверным — 404, с верным — 200', async () => {
  const denied = await fetch(`${BASE}/stats`);
  assert.strictEqual(denied.status, 404);

  const wrong = await fetch(`${BASE}/stats?key=not-the-key`);
  assert.strictEqual(wrong.status, 404);

  const ok = await fetch(`${BASE}/stats?key=${KEY}`);
  assert.strictEqual(ok.status, 200);
  const html = await ok.text();
  assert.ok(html.includes('Статистика посещений'));
  assert.ok(!html.includes(KEY), 'ключ не должен попадать на страницу');
});
