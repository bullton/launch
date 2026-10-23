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
  -p, --port <number>      Port to listen on          (env: PORT,      default: 3000)
      --host <addr>        Bind interface             (env: HOST,      default: 0.0.0.0)
  -h, --help               Show this help

Data:
  SQLite DB at    data/launches.db  (built-in node:sqlite, no native deps)
  Refresh        MANUAL only — click FETCH DATA in the page, or POST /api/ll/refresh.
                 No background timer. This keeps upstream request count minimal
                 and avoids 429 throttling from the Launch Library 2 API.

Examples:
  node server.js
  node server.js --port 4000
  PORT=8080 node server.js
`);
}
const argv = parseArgs(process.argv.slice(2));
if (argv.help) { showHelp(); process.exit(0); }

  const PORT               = Number(argv.port        || process.env.PORT)               || 3000;
  const HOST               = argv.host                || process.env.HOST               || '0.0.0.0';

/* ────────  country code → name (3-letter ISO 3166-1 alpha-3)  ──────── */
const COUNTRY_NAMES = {
  USA:'United States', RUS:'Russia', CHN:'China', JPN:'Japan', KOR:'South Korea',
  PRK:'North Korea', IND:'India', ISR:'Israel', IRN:'Iran', SAU:'Saudi Arabia',
  ARE:'United Arab Emirates', TUR:'Turkey', EGY:'Egypt', KAZ:'Kazakhstan',
  AUS:'Australia', NZL:'New Zealand', CAN:'Canada', MEX:'Mexico', BRA:'Brazil',
  ARG:'Argentina', GBR:'United Kingdom', FRA:'France', DEU:'Germany', ITA:'Italy',
  ESP:'Spain', NLD:'Netherlands', BEL:'Belgium', CHE:'Switzerland', SWE:'Sweden',
  NOR:'Norway', FIN:'Finland', DNK:'Denmark', POL:'Poland', UKR:'Ukraine',
  IDN:'Indonesia', MYS:'Malaysia', THA:'Thailand', VNM:'Vietnam', PHL:'Philippines',
  SGP:'Singapore', PAK:'Pakistan', BGD:'Bangladesh', TWN:'Taiwan', HKG:'Hong Kong',
  ZAF:'South Africa', NGA:'Nigeria', KEN:'Kenya', ETH:'Ethiopia', MAR:'Morocco',
  DZA:'Algeria', TUN:'Tunisia', AGO:'Angola', VEN:'Venezuela', CHL:'Chile',
  COL:'Colombia', PER:'Peru', ECU:'Ecuador', CUB:'Cuba', ROU:'Romania',
  GRC:'Greece', PRT:'Portugal', IRL:'Ireland', AUT:'Austria', HUN:'Hungary',
  BGR:'Bulgaria', CZE:'Czech Republic', LKA:'Sri Lanka', NPL:'Nepal', MNG:'Mongolia',
};

/* ────────  public launch summary  ──────── */
function summarize(l) {
  if (!l) return null;
  const target = new Date(l.net).getTime();
  const now    = Date.now();
  const cc     = l.pad?.location?.country_code || l.pad?.country_code || l.launch_service_provider?.country_code || null;
  return {
    id:           l.id,
    slug:         l.slug,
    name:         l.name,
    url:          l.url,
    image:        l.image || l.mission?.infographic || null,
    status:       l.status ? { id: l.status.id, name: l.status.name, abbrev: l.status.abbrev } : null,
    net:          l.net,
    net_precision: l.net_precision?.abbrev || null,
    window_start: l.window_start || null,
    window_end:   l.window_end || null,
    probability:  l.probability,
    rocket: {
      name:         l.rocket?.configuration?.full_name || null,
      family:       l.rocket?.configuration?.family || null,
      variant:      l.rocket?.configuration?.variant || null,
      manufacturer: l.rocket?.configuration?.manufacturer?.name || null,
    },
    payload: {
      name:        l.mission?.name || null,
      type:        l.mission?.type || null,
      orbit:       l.mission?.orbit?.name || null,
      orbit_abbrev:l.mission?.orbit?.abbrev || null,
      description: l.mission?.description || null,
      customers:   (l.mission?.agencies || []).map((a) => a.name),
    },
    location: {
      country_code: cc,
      country_name: cc ? (COUNTRY_NAMES[cc] || cc) : null,
      site:         l.pad?.location?.name || null,
      pad:          l.pad?.name || null,
      region:       l.pad?.location?.timezone_name || null,
      latitude:     l.pad?.latitude || null,
      longitude:    l.pad?.longitude || null,
    },
    operator:  l.launch_service_provider?.name || null,
    countdown: {
      server_time:      new Date(now).toISOString(),
      remaining_ms:     target - now,
      remaining_seconds: Math.floor((target - now) / 1000),
      is_future:        target > now,
    },
    /* Archived NOTAM drop-zone bearing — the measured ground direction of
       the launch, when it was ever published. Null if we have none. */
    notam: l.notam ?? null,
    last_updated: l.last_updated || null,
  };
}

/* ────────  static assets  ──────── */
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ────────  CORS for public API  ──────── */
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
  if (!u.ok || !p.ok) {
    const err = new Error(`upstream ${u.status}/${p.status}`);
    err.upcomingStatus = u.status;
    err.pastStatus     = p.status;
    /* LL2 returns a JSON body like {"detail":"... Expected available in N seconds."}
       on 429; we surface it to the client so the UI can show a precise wait time. */
    err.retryAfter = parseRetryAfter(u.headers.get('retry-after'), u);
    throw err;
  }
  return { upcoming: await u.json(), past: await p.json() };
}

/* Parse Retry-After. May be either an HTTP-date or a seconds value.
   If absent, attempt to extract seconds from the JSON body. */
function parseRetryAfter(header, response) {
  if (header) {
    const asInt = parseInt(header, 10);
    if (!Number.isNaN(asInt)) return asInt;
  }
  return null;
}

/* ────────  refresh DB from upstream  ──────── */
async function refresh() {
  const { upcoming, past } = await fetchUpstream();
  dbMod.upsertLaunches(db, upcoming.results, 'upcoming');
  dbMod.upsertLaunches(db, past.results,     'past');
  dbMod.setState(db, 'last_refresh',     Date.now());
  dbMod.setState(db, 'upcoming_count',    upcoming.count);
  dbMod.setState(db, 'past_count',        past.count);
  invalidateIcsCache();
  const meta = dbMod.getCacheMeta(db);
  console.log(`  ✓ DB refreshed · upcoming=${upcoming.count}, past=${past.count}, total=${meta.totalRows} (ICS cache invalidated)`);
  return true;
}

/* ────────  cache payload  ──────── */
/**
 * Attach the archived NOTAM drop-zone bearing to a launch record.
 * The bearing is measured from the FAA hazard areas laid out along the real
 * ground track, so it is the only ground truth for missions whose orbital
 * inclination LL2 never publishes. It is kept forever, so a mission that
 * has already flown still carries its real direction.
 */
function withNotam(l) {
  if (!l) return l;
  const n = dbMod.getNotam(db, l.id);
  if (!n || n.azimuth == null) return l;
  /* Backfill the implied inclination for rows stored before notam.js
     started reporting it: i = acos(sin(A_ground) · cos(lat0)). */
  let inc = n.implied_inclination_deg;
  if (inc == null && Number.isFinite(Number(n.azimuth))) {
    const padLat = parseFloat(l.pad?.latitude);
    if (Number.isFinite(padLat)) {
      const s = Math.sin(Number(n.azimuth) * Math.PI / 180) * Math.cos(padLat * Math.PI / 180);
      inc = Math.round((Math.acos(Math.max(-1, Math.min(1, s))) * 180 / Math.PI) * 100) / 100;
    }
  }
  return {
    ...l,
    notam: {
      azimuth_deg: n.azimuth,
      implied_inclination_deg: inc ?? null,
      source: 'FAA NOTAM Search',
      fetched_at: n.fetchedAt ? new Date(n.fetchedAt).toISOString() : null,
    },
  };
}

function payload() {
  const nowISO = new Date().toISOString();
  const meta   = dbMod.getCacheMeta(db);
  return {
    updated:       meta.lastRefresh ? new Date(meta.lastRefresh).toISOString() : null,
    updatedMs:     meta.lastRefresh,
    upcomingCount: meta.upcomingCount,
    pastCount:     meta.pastCount,
    upcoming:      { count: meta.upcomingCount, results: dbMod.getUpcoming(db, 60, nowISO).map(withNotam) },
    past:          { count: meta.pastCount,     results: dbMod.getPast    (db, 12, nowISO).map(withNotam) },
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
    const rateLimited = e.upcomingStatus === 429 || e.pastStatus === 429;
    res.status(rateLimited ? 429 : 502).json({
      error:     rateLimited ? 'rate_limited' : 'refresh_failed',
      detail:    String(e?.message || e),
      retryAfter: e.retryAfter || null,
    });
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

/* ────────  PUBLIC API  ──────── */

/* GET /api/ll/next  — closest upcoming launch (full summary) */
app.get('/api/ll/next', (req, res) => {
  const nowISO = new Date().toISOString();
  const list = dbMod.getUpcoming(db, 1, nowISO);
  if (!list.length) return res.status(404).json({ error: 'no upcoming launch' });
  res.json(summarize(withNotam(list[0])));
});

/* GET /api/ll/latest — most recent past launch */
app.get('/api/ll/latest', (req, res) => {
  const nowISO = new Date().toISOString();
  const list = dbMod.getPast(db, 1, nowISO);
  if (!list.length) return res.status(404).json({ error: 'no past launch' });
  res.json(summarize(withNotam(list[0])));
});

/* GET /api/ll/upcoming?limit=N — list of upcoming launches (summaries) */
app.get('/api/ll/upcoming', (req, res) => {
  const nowISO = new Date().toISOString();
  const limit  = Math.min(parseInt(req.query.limit, 10) || 10, 60);
  const list   = dbMod.getUpcoming(db, limit, nowISO);
  res.json({ count: list.length, results: list.map((l) => summarize(withNotam(l))) });
});

/* GET /api/ll/past?limit=N — list of recent past launches (summaries) */
app.get('/api/ll/past', (req, res) => {
  const nowISO = new Date().toISOString();
  const limit  = Math.min(parseInt(req.query.limit, 10) || 10, 60);
  const list   = dbMod.getPast(db, limit, nowISO);
  res.json({ count: list.length, results: list.map((l) => summarize(withNotam(l))) });
});

/* GET /api/ll/launch/:id — full launch record by id (or slug) */
app.get('/api/ll/launch/:id', (req, res) => {
  const id = req.params.id;
  let row;
  try {
    row = db.prepare('SELECT data FROM launches WHERE id=?').get(id);
  } catch {
    return res.status(404).json({ error: 'not found' });
  }
  if (!row) {
    const all = db.prepare('SELECT data FROM launches').all();
    for (const r of all) {
      try {
        const d = JSON.parse(r.data);
        if (d.slug === id) { row = r; break; }
      } catch { /* skip */ }
    }
  }
  if (!row) return res.status(404).json({ error: 'not found' });
  try { res.json(withNotam(JSON.parse(row.data))); }
  catch { res.status(500).json({ error: 'corrupt data' }); }
});

/* GET /api/ll/health — health check */
app.get('/api/ll/health', (req, res) => {
  const m = dbMod.getCacheMeta(db);
  res.json({
    ok: !!m.lastRefresh,
    lastRefresh: m.lastRefresh ? new Date(m.lastRefresh).toISOString() : null,
    totalRows:   m.totalRows,
    serverTime:  new Date().toISOString(),
  });
});

/* ────────  ICS (iCalendar / RFC 5545) feed  ────────
   Subscribable by Google Calendar, Apple Calendar, Outlook, etc.
   Each VEVENT = one future launch (next ~200).  The feed is
   regenerated on every refresh() (cache invalidated), so calendar
   clients see updates within their polling window (Google: ~6-12h). */
const ICS_HOST_TAG = (process.env.ICS_HOST || "rocket-tracker").replace(/[^a-z0-9.-]/gi, "");
let _icsCache = null;        // { body, ts }
let _icsCacheAt = 0;
const ICS_TTL_MS = 5 * 60 * 1000;  // 5 min soft TTL; invalidated on refresh

function _icsEscape(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}
function _icsFold(line) {
  /* RFC 5545 §3.1: lines > 75 octets must be folded with CRLF + space */
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const out = [];
  let buf = "";
  for (const ch of line) {
    const test = buf + ch;
    if (Buffer.byteLength(test, "utf8") > 74) { out.push(buf); buf = " " + ch; }
    else buf = test;
  }
  if (buf) out.push(buf);
  return out.join("\r\n");
}
function _icsDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
const STATUS_ICS = {
  1: "CONFIRMED", 2: "TENTATIVE", 3: "CANCELLED", 4: "CANCELLED",
  5: "TENTATIVE", 6: "CONFIRMED", 7: "CANCELLED", 8: "TENTATIVE",
};

function _vEvent(launch) {
  const net = _icsDate(launch.net);
  if (!net) return null;
  const end = _icsDate(launch.window_end)
           || _icsDate(new Date(new Date(launch.net).getTime() + 60*60*1000).toISOString());
  const stamp = _icsDate(new Date().toISOString());
  const lsp    = launch.launch_service_provider?.name || "";
  const rocket = launch.rocket?.configuration?.full_name || "";
  const orbit  = launch.mission?.orbit?.name || "";
  const pad    = launch.pad?.name || "";
  const loc    = launch.pad?.location?.name || "";
  const desc   = [
    `Provider: ${lsp}`,
    `Rocket: ${rocket}`,
    `Orbit: ${orbit}`,
    launch.flightclub_url ? `3D: ${launch.flightclub_url}` : null,
    launch.url ? `Details: ${launch.url}` : null,
  ].filter(Boolean).join("\n");

  const lines = [
    "BEGIN:VEVENT",
    `UID:${launch.id}@${ICS_HOST_TAG}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${net}`,
    `DTEND:${end}`,
    `SUMMARY:${_icsEscape(launch.name || "Rocket Launch")}`,
    `DESCRIPTION:${_icsEscape(desc)}`,
    `LOCATION:${_icsEscape([pad, loc].filter(Boolean).join(", "))}`,
    `STATUS:${STATUS_ICS[launch.status?.id] || "TENTATIVE"}`,
  ];
  const lat = parseFloat(launch.pad?.latitude);
  const lon = parseFloat(launch.pad?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) lines.push(`GEO:${lat.toFixed(4)};${lon.toFixed(4)}`);
  if (launch.url) lines.push(`URL:${_icsEscape(launch.url)}`);
  lines.push("END:VEVENT");
  return lines.map(_icsFold).join("\r\n");
}

function buildIcs() {
  const nowISO = new Date().toISOString();
  const upcoming = dbMod.getUpcoming(db, 200, nowISO);
  const events = upcoming.map(_vEvent).filter(Boolean);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${ICS_HOST_TAG}//launches//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Rocket Launches",
    "X-WR-TIMEZONE:UTC",
    "X-PUBLISHED-TTL:PT6H",
    "X-WR-CALDESC:Upcoming rocket launches (Launch Library 2)",
  ];
  for (const ev of events) lines.push(ev);
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function getIcsBody() {
  const now = Date.now();
  if (_icsCache && now - _icsCacheAt < ICS_TTL_MS) return _icsCache;
  _icsCache = buildIcs();
  _icsCacheAt = now;
  return _icsCache;
}
function invalidateIcsCache() { _icsCache = null; _icsCacheAt = 0; }

/* Expose a hint to clients so the UI can build the right subscribe URL */
app.get('/api/ll/feed-info', (req, res) => {
  res.json({
    icsUrl: `${req.protocol}://${req.get("host")}/api/ll/calendar.ics`,
    ttl:    "PT6H",
  });
});

/* GET /api/ll/calendar.ics — iCalendar feed */
app.get("/api/ll/calendar.ics", (req, res) => {
  const body = getIcsBody();
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="rocket-launches.ics"');
  /* Google Calendar uses Last-Modified for efficient re-polling */
  res.setHeader("Cache-Control", "public, max-age=21600, stale-while-revalidate=60");
  res.send(body);
});

/* ────────  NOTAM drop-zone lookup  ────────
   Drop-zone geometry is the only reliable direction cue when LL2 leaves the
   orbit unpublished: the hazard areas for a launch are laid out along its
   ground track, so joining the pad to them back-solves the launch bearing.

   Results are cached per launch because the scraper needs a real browser
   session (Akamai) and NOTAMs only matter in the last ~48 h before T-0.

   The first lookup that yields a usable bearing is kept PERMANENTLY (see
   db.putNotam). LL2 rewrites a mission record after liftoff and the FAA
   withdraws the launch-window NOTAMs shortly after T-0, so re-querying a
   flown mission returns nothing — the archived bearing is the only surviving
   evidence of the real flight direction.
   `?force=1` bypasses the cache. */
const NOTAM_TTL_MS = 6 * 60 * 60 * 1000;
/* How far ahead of T-0 we proactively pull NOTAMs. */
const NOTAM_PREPULL_WINDOW_MS = 48 * 3600 * 1000;
let notamMod = null;
try { notamMod = require('./notam'); }
catch (e) { console.warn('  ⚠ notam module unavailable:', e.message); }

app.get('/api/ll/notam', async (req, res) => {
  if (!notamMod) {
    return res.status(503).json({ error: 'notam_unavailable', detail: 'playwright / notam.js not installed' });
  }
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'missing id' });

  const launch = dbMod.getLaunch(db, id);
  if (!launch) return res.status(404).json({ error: 'launch not found' });

  const force = req.query.force === '1' || req.query.force === 'true';

  if (!force) {
    const hit = dbMod.getNotam(db, id);
    /* A stored bearing is authoritative forever — serve it regardless of age. */
    if (hit && hit.azimuth != null) {
      return res.json({ ...hit, cached: true, permanent: true });
    }
    if (hit && Date.now() - hit.fetchedAt < NOTAM_TTL_MS) {
      return res.json({ ...hit, cached: true });
    }
  }

  const t0 = Date.now();
  let result = null;
  try {
    result = await notamMod.getLaunchDropZones(launch);
  } catch (e) {
    console.warn('  ✗ notam lookup failed:', e.message);
    return res.status(502).json({ error: 'notam_lookup_failed', detail: e.message });
  }

  if (!result) {
    dbMod.putNotam(db, id, null, { found: false });
    return res.json({ found: false, launch_name: launch.name, cached: false });
  }

  const stored = dbMod.putNotam(db, id, result.azimuth_deg ?? null, { found: true, ...result },
                                { force: force && result.azimuth_deg != null });
  console.log(`  ✓ NOTAM ${launch.name}: ${result.drop_zones?.length || 0} zone(s)` +
    (result.azimuth_deg != null ? `, bearing ${result.azimuth_deg}°` : ', no usable bearing') +
    (stored ? '' : ' (kept earlier archive)') +
    ` (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  res.json({ found: true, cached: false, ...result });
});

/* ────────  NOTAM pre-pull (background)  ────────
   NOTAMs only exist in the ~48 h before T-0 and they are withdrawn right
   after the launch, so we pull them eagerly for anything inside that window
   and archive the bearing permanently. That way a mission that has already
   flown still has its real launch direction. */
async function prepullNotams() {
  if (!notamMod) return;
  const nowISO = new Date().toISOString();
  const horizon = new Date(Date.now() + NOTAM_PREPULL_WINDOW_MS).toISOString();
  /* launches from a day ago through the next 48 h */
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = db.prepare(`SELECT data FROM launches
                            WHERE net >= ? AND net <= ?
                            ORDER BY net ASC LIMIT 12`).all(since, horizon);

  for (const r of rows) {
    let launch;
    try { launch = JSON.parse(r.data); } catch { continue; }
    const id = launch.id;
    if (!id) continue;

    const hit = dbMod.getNotam(db, id);
    /* already have a permanent bearing → nothing to do */
    if (hit && hit.azimuth != null) continue;
    /* looked up recently and found nothing → don't hammer FAA */
    if (hit && Date.now() - hit.fetchedAt < NOTAM_TTL_MS) continue;

    try {
      const result = await notamMod.getLaunchDropZones(launch);
      if (!result) { dbMod.putNotam(db, id, null, { found: false }); continue; }
      dbMod.putNotam(db, id, result.azimuth_deg ?? null, { found: true, ...result });
      if (result.azimuth_deg != null) {
        console.log(`  ✓ NOTAM pre-pull ${launch.name}: bearing ${result.azimuth_deg}° ` +
                    `(implied i ≈ ${result.implied_inclination_deg}°)`);
      }
    } catch (e) {
      console.warn(`  ✗ notam pre-pull failed for ${launch.name}:`, e.message);
    }
  }
}

/* ────────  startup banner  ──────── */
function logBanner(prefix = '') {
  const netUrl = (HOST === '0.0.0.0' || HOST === '::') ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`${prefix}\n  🚀 ROCKET — Launch Tracker`);
  console.log('  ─────────────────────────────────');
  console.log(`  Listening on  ${HOST}:${PORT}`);
  console.log(`  Open          ${netUrl}`);
  console.log(`  DB file       ${dbMod.DB_PATH}`);
  console.log(`  Refresh       manual only (button)`);
  console.log('  ─────────────────────────────────\n');
}

/* ────────  startup: warm cache if empty, log banner  ────────
   No background refresh — manual via POST /api/ll/refresh only.
   This keeps upstream request count at exactly the number of button
   clicks, avoiding 429 throttling from the Launch Library 2 API. */
const metaAtBoot = dbMod.getCacheMeta(db);
if (!metaAtBoot.lastRefresh) {
  console.log('  ⏳ cache empty — warming once on startup (no recurring refresh)…');
  refresh()
    .then(() => logBanner())
    .catch((e) => { console.error('  ✗ initial refresh failed:', String(e?.message || e)); logBanner(); });
} else {
  console.log(`  ✓ cache loaded from disk — ${metaAtBoot.totalRows} rows, last ${new Date(metaAtBoot.lastRefresh).toISOString()}`);
  logBanner();
}

/* ────────  NOTAM pre-pull scheduler  ────────
   Runs on its own timer (NOTAM scraping is slow and browser-backed, so it
   must not ride along with the manual LL2 refresh). It archives the launch
   bearing for every mission inside the T-48 h window, so the direction
   survives the FAA withdrawing the NOTAMs and LL2 rewriting the record. */
const NOTAM_PREPULL_INTERVAL_MS = 3 * 60 * 60 * 1000;   // every 3 h
if (notamMod) {
  setTimeout(() => {
    prepullNotams()
      .catch((e) => console.warn('  ✗ notam pre-pull failed:', e.message))
      .finally(() => setInterval(() => {
        prepullNotams().catch((e) => console.warn('  ✗ notam pre-pull failed:', e.message));
      }, NOTAM_PREPULL_INTERVAL_MS));
  }, 20_000);   // let the server come up first
}

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
