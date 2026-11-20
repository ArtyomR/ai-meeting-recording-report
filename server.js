'use strict';

// Сервер одностраничного отчёта + модуль логирования посещений.
// - отдаёт только файлы из allowlist (никаких путей от пользователя)
// - POST /track  — принимает событие от страницы, пишет его в visits.jsonl
//                  и отправляет уведомление в Telegram (если заданы токены)
// - GET  /stats  — скрытая страница статистики, доступна только по STATS_KEY
// - GET  /health — проверка живости для платформы

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

// --- локальные секреты ---------------------------------------------------
// .env рядом с сервером (в деплой-пакет не входит). На сервере переменные
// приходят из окружения и имеют приоритет.
function loadEnvFile() {
  let src;
  try {
    src = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const MAX_BODY = 4096;
const STATS_KEY = String(process.env.STATS_KEY || '');
// Хэш ключа вместо самого ключа: для облака, куда секреты не загружаются.
const STATS_KEY_SHA256 = String(process.env.STATS_KEY_SHA256 || '');
const TELEGRAM_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '');
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const TRACK_WINDOW_MS = 60 * 1000;
const TRACK_MAX_PER_WINDOW = 30;
const NOTIFY_COOLDOWN_MS = 60 * 1000;
const GEO_TIMEOUT_MS = 5000;
const TELEGRAM_TIMEOUT_MS = 8000;

// Данные о визитах переживают передеплой только на томе /data.
function resolveDataDir() {
  const candidates = [process.env.DATA_DIR, '/data', path.join(ROOT, 'data')].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* пробуем следующий вариант */ }
  }
  return path.join(ROOT, 'data');
}

const DATA_DIR = resolveDataDir();
const VISITS_FILE = path.join(DATA_DIR, 'visits.jsonl');
const MAX_VISITS_BYTES = 5 * 1024 * 1024;
const VISITS_KEEP_LINES = 2000;

// Explicit allowlist: only these paths are ever served. No user-supplied path
// reaches the filesystem, so traversal is impossible by construction.
const FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' }
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self' https://*.bitrix24.tech"
].join('; ');

const HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Cross-Origin-Opener-Policy': 'same-origin'
};

function reply(res, code, body, type, extra) {
  res.writeHead(code, {
    ...HEADERS,
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extra || {})
  });
  res.end(body);
}

// --- утилиты -------------------------------------------------------------

function clip(value, limit) {
  return String(value === undefined || value === null ? '' : value).slice(0, limit);
}

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const isPrivateIp = (ip) => !ip || ip === '—'
  || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd]|fe80)/i.test(ip);
const isLoopback = (ip) => /^(127\.|::1$)/i.test(ip || '');

// Реальный IP посетителя: первый публичный адрес из прокси-заголовков, иначе сокет.
function clientIp(req) {
  const candidates = [];
  if (req.headers['x-forwarded-for']) candidates.push(...String(req.headers['x-forwarded-for']).split(','));
  for (const h of ['x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'fly-client-ip', 'x-client-ip']) {
    if (req.headers[h]) candidates.push(String(req.headers[h]));
  }
  candidates.push(req.socket.remoteAddress || '');
  const ips = candidates
    .map((s) => String(s).trim().replace(/^::ffff:/, ''))
    .filter((ip) => net.isIP(ip) === 4 || net.isIP(ip) === 6);
  return ips.find((ip) => !isPrivateIp(ip)) || ips[0] || '—';
}

// Гео по IP. Во внешний сервис уходит только валидный публичный IPv4 —
// это исключает SSRF через подменённые заголовки.
async function geoLookup(ip) {
  if (isLoopback(ip)) return { country: 'локально', city: '', flag: '🏠' };
  if (net.isIP(ip) !== 4 || isPrivateIp(ip)) return null;
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(GEO_TIMEOUT_MS)
    });
    const j = await r.json();
    if (j && j.success) {
      return {
        country: clip(j.country, 60),
        city: clip(j.city, 60),
        flag: clip(j.flag && j.flag.emoji, 8)
      };
    }
  } catch { /* гео не критично */ }
  return null;
}

function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
  }).catch(() => { /* сеть недоступна — визит всё равно записан */ });
}

function deviceInfo(ua) {
  const device = /Mobile|Android|iPhone|iPad/i.test(ua) ? '📱 мобильный' : '💻 компьютер';
  let os = '—';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { device, os };
}

// --- статистика ----------------------------------------------------------

function readVisits() {
  let raw = '';
  try {
    raw = fs.readFileSync(VISITS_FILE, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch { /* битую строку пропускаем */ }
  }
  return rows;
}

// Ротация: не даём журналу расти бесконечно, оставляем последние записи.
function rotateVisits() {
  try {
    const keep = readVisits().slice(-VISITS_KEEP_LINES);
    fs.writeFileSync(VISITS_FILE, keep.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch (err) {
    console.error('[track] ротация журнала не удалась:', err.code || 'error');
  }
}

function appendVisit(row) {
  fs.appendFileSync(VISITS_FILE, JSON.stringify(row) + '\n');
  if (fs.statSync(VISITS_FILE).size > MAX_VISITS_BYTES) rotateVisits();
}

function statsPage() {
  const visits = readVisits();
  const rows = visits.slice(-500).reverse().map((v) => {
    const geo = [v.city, v.country].filter(Boolean).join(', ');
    return `
    <tr>
      <td>${esc(v.ts)}</td>
      <td>${esc(v.ip)}</td>
      <td>${esc(geo || '—')}</td>
      <td>${esc(v.path || '/')}</td>
      <td>${esc(v.ua)}</td>
      <td>${esc(v.ref || '—')}</td>
      <td>${esc(v.screen || '—')} / ${esc(v.lang || '—')} / ${esc(v.tz || '—')}</td>
    </tr>`;
  }).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="robots" content="noindex, nofollow"><title>Статистика посещений</title>
<style>
  body{font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;color:#1c2534;background:#f6f7f9;margin:0;padding:32px 20px 60px}
  .wrap{max-width:1200px;margin:0 auto}
  h1{font-size:24px;margin:0 0 4px} .n{color:#b45309;font-weight:700}
  p{color:#5b6572;font-size:14px;margin:0 0 22px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.06)}
  th{background:#eef1f6;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5b6572;padding:10px 12px}
  td{padding:10px 12px;border-top:1px solid #eceff4;font-size:13px;vertical-align:top;word-break:break-word}
</style></head><body><div class="wrap">
<h1>Статистика посещений</h1>
<p>Всего визитов: <span class="n">${visits.length}</span> (показаны последние ${Math.min(visits.length, 500)}).</p>
<table><tr><th>Время</th><th>IP</th><th>Гео</th><th>Страница</th><th>Устройство (User-Agent)</th><th>Откуда пришёл</th><th>Экран / язык / часовой пояс</th></tr>
${rows || '<tr><td colspan="7" style="color:#8a93a1">Пока никто не открывал отчёт</td></tr>'}
</table></div></body></html>`;
}

// --- защита статистики ---------------------------------------------------

function safeEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(String(a)).digest();
  const bufB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

function statsAllowed(key) {
  // Хэш-режим: сравниваем sha256-дайджест переданного ключа с заданным хэшем.
  if (STATS_KEY_SHA256) {
    const digest = crypto.createHash('sha256').update(String(key || '')).digest('hex');
    return safeEqual(digest, STATS_KEY_SHA256);
  }
  if (!STATS_KEY) return false; // без ключа страница выключена
  return safeEqual(key || '', STATS_KEY);
}

// --- приём событий -------------------------------------------------------

const rateBuckets = new Map(); // ip -> { count, resetAt }
const lastNotify = new Map();  // ip -> timestamp

function rateLimited(ip) {
  const now = Date.now();
  if (rateBuckets.size > 5000) {
    for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + TRACK_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > TRACK_MAX_PER_WINDOW;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetch без Origin (старые браузеры)
  // За обратным прокси реальный домен приходит в X-Forwarded-Host (Host — внутренний).
  const host = String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0].trim();
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function handleTrack(req, res) {
  if (!sameOrigin(req)) return reply(res, 403, 'Forbidden');

  const ip = clientIp(req);
  if (rateLimited(ip)) return reply(res, 429, 'Too Many Requests');

  let size = 0;
  let finished = false;
  const chunks = [];

  req.on('data', (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      finished = true;
      reply(res, 413, 'Payload Too Large');
      req.resume();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (finished) return;
    finished = true;

    let payload = {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
    } catch { /* некорректный JSON считаем пустым событием */ }

    const ua = clip(req.headers['user-agent'] || '', 300);
    const row = {
      ts: new Date().toISOString().replace('T', ' ').slice(0, 19),
      ip,
      path: clip(payload.path || '/', 200) || '/',
      ua,
      ref: clip(payload.ref || '', 300),
      screen: clip(payload.screen || '', 30),
      lang: clip(payload.lang || '', 30),
      tz: clip(payload.tz || '', 60)
    };

    res.writeHead(204, { ...HEADERS, 'Cache-Control': 'no-store' });
    res.end();

    // Гео и уведомление — после ответа клиенту, чтобы не тормозить страницу.
    (async () => {
      const geo = await geoLookup(row.ip);
      if (geo) {
        row.country = geo.country || '';
        row.city = geo.city || '';
      }
      try {
        appendVisit(row);
      } catch (err) {
        console.error('[track] не удалось записать визит:', err.code || 'error');
        return;
      }
      console.log(`[track] ${row.ts} ip=${row.ip} path=${row.path}`);

      const now = Date.now();
      if (lastNotify.size > 5000) {
        for (const [key, ts] of lastNotify) if (now - ts > NOTIFY_COOLDOWN_MS) lastNotify.delete(key);
      }
      const prev = lastNotify.get(row.ip) || 0;
      if (now - prev < NOTIFY_COOLDOWN_MS) return; // не спамим при перезагрузке
      lastNotify.set(row.ip, now);

      const geoText = geo && (geo.city || geo.country)
        ? `${geo.flag ? geo.flag + ' ' : ''}${[geo.city, geo.country].filter(Boolean).join(', ')}`
        : 'не определено';
      const { device, os } = deviceInfo(ua);
      sendTelegram(
        '👁 <b>Отчёт открыли</b>\n' +
        `🕒 ${esc(row.ts)} (UTC)\n` +
        `📍 ${esc(geoText)}\n` +
        `🌐 IP: <code>${esc(row.ip)}</code>\n` +
        `📄 Страница: ${esc(row.path)}\n` +
        `${device} · ${os}\n` +
        `🔗 Источник: ${esc(row.ref) || 'прямая ссылка'}`
      );
    })().catch(() => { /* фоновые ошибки не трогают ответ */ });
  });
}

// --- HTTP ---------------------------------------------------------------

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return reply(res, 400, 'Bad Request');
  }
  const pathname = url.pathname;

  if (pathname === '/track') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, 'Method Not Allowed');
    }
    return handleTrack(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return reply(res, 405, 'Method Not Allowed');
  }

  if (pathname === '/health') {
    res.writeHead(200, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/stats') {
    if (!statsAllowed(url.searchParams.get('key'))) return reply(res, 404, 'Not Found');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
    });
    return res.end(statsPage());
  }

  const entry = Object.prototype.hasOwnProperty.call(FILES, pathname) ? FILES[pathname] : null;
  if (!entry) return reply(res, 404, 'Not Found');

  const filePath = path.join(ROOT, entry.file);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return reply(res, 404, 'Not Found');

    res.writeHead(200, {
      ...HEADERS,
      'Content-Type': entry.type,
      'Content-Length': stat.size,
      'Cache-Control': entry.type.startsWith('text/html') ? 'no-store' : 'public, max-age=3600'
    });

    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res).on('error', () => res.destroy());
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('report listening on ' + PORT);
  console.log(`Данные визитов: ${VISITS_FILE}`);
  console.log(`Статистика: ${STATS_KEY || STATS_KEY_SHA256 ? '/stats?key=***' : 'выключена (нет STATS_KEY)'}`);
  console.log(`Telegram-уведомления: ${TELEGRAM_TOKEN && TELEGRAM_CHAT_ID ? 'включены' : 'выключены (нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID)'}`);
});
