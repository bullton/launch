/* =====================================================================
   logs.js — process log ring buffer + daily JSONL archive
   ---------------------------------------------------------------------
   Every interesting event (LL2 data fetch, NOTAM lookup, server boot,
   raw console output) is kept twice:
     • in memory — the most recent MAX_MEMORY entries, served to /admin
     • on disk   — data/logs/YYYY-MM-DD.jsonl, pruned after KEEP_DAYS
   ===================================================================== */

const fs   = require('fs');
const path = require('path');

const LOG_DIR    = path.join(__dirname, 'data', 'logs');
const MAX_MEMORY = 1000;
const KEEP_DAYS  = 7;

let seq      = 0;
let dirReady = false;
const buffer = [];

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ensureDir() {
  if (dirReady) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirReady = true;
    return true;
  } catch {
    return false;
  }
}

function prune() {
  if (!ensureDir()) return;
  const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
  let names = [];
  try { names = fs.readdirSync(LOG_DIR); } catch { return; }
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(LOG_DIR, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch { /* ignore */ }
  }
}

function append(entry) {
  if (!ensureDir()) return;
  try {
    fs.appendFileSync(
      path.join(LOG_DIR, `${dayKey(entry.ts)}.jsonl`),
      JSON.stringify(entry) + '\n',
    );
  } catch { /* disk problem must never break a request */ }
}

/**
 * Record one entry.
 * kind  — api | notam | server | admin
 * level — info | warn | error
 * extra — { durationMs, status, meta }
 */
function log(kind, level, msg, extra = {}) {
  const entry = {
    id: ++seq,
    ts: Date.now(),
    kind,
    level,
    msg: String(msg ?? ''),
    ...extra,
  };
  buffer.push(entry);
  if (buffer.length > MAX_MEMORY) buffer.splice(0, buffer.length - MAX_MEMORY);
  append(entry);
  return entry;
}

function query({ kind, level, q, limit } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 200, 1), MAX_MEMORY);
  const match = (r) => {
    if (kind && kind !== 'all' && r.kind !== kind) return false;
    if (level && level !== 'all' && r.level !== level) return false;
    if (q) {
      const s = String(q).toLowerCase();
      if (!`${r.msg} ${JSON.stringify(r.meta ?? '')}`.toLowerCase().includes(s)) return false;
    }
    return true;
  };

  let rows = buffer.filter(match);
  /* After a restart the memory buffer only holds the boot lines, so top the
     result up from today's/yesterday's archive instead of showing an empty
     console. Memory stays authoritative for entries still alive there. */
  if (rows.length < n) {
    const seen = new Set(buffer.map((r) => `${r.ts}|${r.kind}|${r.msg}`));
    const disk = readRecentFromDisk(n - rows.length, match, seen);
    rows = rows.concat(disk);
  }
  rows.sort((a, b) => b.ts - a.ts || b.id - a.id);
  return rows.slice(0, n);
}

function readRecentFromDisk(want, match, seen) {
  if (want <= 0 || !ensureDir()) return [];
  const now = Date.now();
  const files = [`${dayKey(now)}.jsonl`, `${dayKey(now - 86400 * 1000)}.jsonl`];
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(LOG_DIR, f), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < want; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry.ts !== 'number') continue;
      const key = `${entry.ts}|${entry.kind}|${entry.msg}`;
      if (seen.has(key) || !match(entry)) continue;
      seen.add(key);
      out.push(entry);
    }
    if (out.length >= want) break;
  }
  return out;
}

/** Mirror console output into the buffer/archive without changing stdout. */
function teeConsole() {
  const native = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };
  const asText = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const wrap = (level, mapped) => (...args) => {
    native[level](...args);
    const msg = args.map(asText).join(' ').trim();
    if (msg) log('server', mapped, msg);
  };
  console.log   = wrap('log',   'info');
  console.warn  = wrap('warn',  'warn');
  console.error = wrap('error', 'error');
}

function init() {
  ensureDir();
  prune();
  setInterval(prune, 6 * 3600 * 1000).unref?.();
}

module.exports = { LOG_DIR, MAX_MEMORY, KEEP_DAYS, init, log, query, teeConsole, prune };
