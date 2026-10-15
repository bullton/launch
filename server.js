const express = require('express');
const path = require('path');
const dbMod  = require('./db');

const app = express();
const API_BASE = 'https://ll.thespacedevs.com/2.2.0';
const UA       = 'rocket-tracker/1.0 (https://thespacedevs.com)';

/* ────────  CLI / env parsing  ──────── */
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--port' || a === '-p')         opts.port = argv[++i];
    else if (a.startsWith('--port='))              opts.port = a.slice(7);
    else if (a === '--host')                       opts.host = argv[++i];
    else if (a.startsWith('--host='))              opts.host = a.slice(7);
    else if (a === '--refresh-ms')                 opts.refreshMs = argv[++i];
    else if (a.startsWith('--refresh-ms='))        opts.refreshMs = a.slice(13);
    else if (a === '--help' || a === '-h')         opts.help = true;
  }
  return opts;
}
function showHelp() {
  console.log(`
rocket-tracker — SpaceX-style launch tracker (SQLite-backed)

Usage:
  node server.js [options]

Options:
  -p, --port <number>      Port to listen on          (env: PORT,                default: 3000)
      --host <addr>        Bind interface             (env: HOST,                default: 0.0.0.0)
      --refresh-ms <ms>    Background refresh rate    (env: REFRESH_INTERVAL_MS, default: 60000)
  -h, --help               Show this help

Data:
  SQLite DB at    data/launches.db  (built-in node:sqlite, no native deps)
  Auto-refreshes  every REFRESH_INTERVAL_MS. Manual refresh via POST /api/ll/refresh.

Examples:
  node server.js
  node server.js --port 4000 --refresh-ms 30000
  PORT=8080 REFRESH_INTERVAL_MS=120000 node server.js
`);
}
const argv = parseArgs(process.argv.slice(2));
if (argv.help) { showHelp(); process.exit(0); }

const PORT               = Number(argv.port        || process.env.PORT)               || 3000;
const HOST               = argv.host                || process.env.HOST               || '0.0.0.0';
const REFRESH_MS         = Number(argv.refreshMs    || process.env.REFRESH_INTERVAL_MS) || 60_000;

/* ────────  static assets  ──────── */
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ────────  DB  ──────── */
const db = dbMod.openDb();

/* ────────  upstream fetcher  ──────── */
async function fetchUpstream() {
  const nowISO = new Date().toISOString();
  const u = await fetch(
    `${API_BASE}/launch/upcoming/?limit=60&mode=detailed&ordering=net&net__gte=${encodeURIComponent(nowISO)}`,
    { headers: { 'User-Agent': UA } },
  );
  const p = await fetch(
    `${API_BASE}/launch/previous/?limit=24&mode=detailed&ordering=-net`,
    { headers: { 'User-Agent': UA } },
  );
  if (!u.ok || !p.ok) throw new Error(`upstream ${u.status}/${p.status}`);
  return { upcoming: await u.json(), past: await p.json() };
}

/* ────────  refresh DB from upstream  ──────── */
async function refresh() {
  const { upcoming, past } = await fetchUpstream();
  dbMod.upsertLaunches(db, upcoming.results, 'upcoming');
  dbMod.upsertLaunches(db, past.results,     'past');
  dbMod.setState(db, 'last_refresh',     Date.now());
  dbMod.setState(db, 'upcoming_count',    upcoming.count);
  dbMod.setState(db, 'past_count',        past.count);
  const meta = dbMod.getCacheMeta(db);
  console.log(`  ✓ DB refreshed · upcoming=${upcoming.count}, past=${past.count}, total=${meta.totalRows}`);
  return true;
}

/* ────────  cache payload  ──────── */
function payload() {
  const nowISO = new Date().toISOString();
  const meta   = dbMod.getCacheMeta(db);
  return {
    updated:       meta.lastRefresh ? new Date(meta.lastRefresh).toISOString() : null,
    updatedMs:     meta.lastRefresh,
    upcomingCount: meta.upcomingCount,
    pastCount:     meta.pastCount,
    upcoming:      { count: meta.upcomingCount, results: dbMod.getUpcoming(db, 60, nowISO) },
    past:          { count: meta.pastCount,     results: dbMod.getPast    (db, 12, nowISO) },
  };
}

/* ────────  API  ──────── */
app.get('/api/ll/cache', (req, res) => {
  const meta = dbMod.getCacheMeta(db);
  if (!meta.lastRefresh) {
    return res.status(404).json({ error: 'cache empty', hint: 'POST /api/ll/refresh to warm it' });
  }
  res.json(payload());
});

app.post('/api/ll/refresh', async (req, res) => {
  try {
    await refresh();
    res.json(payload());
  } catch (e) {
    res.status(502).json({ error: 'refresh failed', detail: String(e) });
  }
});

app.get('/api/ll/stats', (req, res) => {
  const m = dbMod.getCacheMeta(db);
  res.json({
    dbFile:        dbMod.DB_PATH,
    lastRefresh:   m.lastRefresh ? new Date(m.lastRefresh).toISOString() : null,
    totalRows:     m.totalRows,
    upcomingCount: m.upcomingCount,
    pastCount:     m.pastCount,
    nowISO:        new Date().toISOString(),
  });
});

/* ────────  startup banner  ──────── */
function logBanner(prefix = '') {
  const netUrl = (HOST === '0.0.0.0' || HOST === '::') ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`${prefix}\n  🚀 ROCKET — Launch Tracker`);
  console.log('  ─────────────────────────────────');
  console.log(`  Listening on  ${HOST}:${PORT}`);
  console.log(`  Open          ${netUrl}`);
  console.log(`  DB file       ${dbMod.DB_PATH}`);
  console.log(`  Refresh rate  every ${REFRESH_MS} ms`);
  console.log('  ─────────────────────────────────\n');
}

/* ────────  startup: warm cache if empty, log banner  ──────── */
const metaAtBoot = dbMod.getCacheMeta(db);
if (!metaAtBoot.lastRefresh) {
  console.log('  ⏳ cache empty — warming…');
  refresh()
    .then(() => logBanner())
    .catch((e) => { console.error('  ✗ initial refresh failed:', String(e)); logBanner(); });
} else {
  console.log(`  ✓ cache loaded from disk — ${metaAtBoot.totalRows} rows, last ${new Date(metaAtBoot.lastRefresh).toISOString()}`);
  logBanner();
}

let refreshing = false;
setInterval(async () => {
  if (refreshing) return;
  refreshing = true;
  try { await refresh(); }
  catch (e) { console.error('  ✗ bg refresh failed:', String(e)); }
  refreshing = false;
}, REFRESH_MS);

/* ────────  start listening  ──────── */
const server = app.listen(PORT, HOST, () => {
  /* Banner already printed above. Silent here to avoid double output. */
});

function shutdown(sig) {
  console.log(`\n  Caught ${sig}, shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
