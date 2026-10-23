/* =====================================================================
   notam.js — Launch drop-zone retrieval from FAA NOTAM Search
   ---------------------------------------------------------------------
   Why this exists
   --------------
   LL2 exposes orbit type/abbrev but never inclination, so the trajectory
   engine has to *guess* the launch azimuth. For classified Chinese
   launches (payload "Unknown", orbit "N/A") that guess is the only input
   we have, and it is often wrong.

   A launch NOTAM solves it: the danger areas / debris corridors published
   before a launch are laid out ALONG the rocket's ground track. Joining
   the pad to those polygons gives the launch bearing directly — a pure
   inverse problem with no orbit data required.

   Access
   ------
   notams.aim.faa.gov sits behind Akamai. Plain HTTP gets 403, and so
   does Playwright's bundled headless Chromium. The bundled `chrome`
   channel (the real browser already installed on the machine) passes.
   One session is started lazily and reused; it closes on idle.

   Graceful degradation: if Playwright or a usable browser is missing,
   every entry point returns null instead of throwing, and the trajectory
   engine falls back to its inclination heuristics.
   ===================================================================== */

'use strict';

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional dep */ }

/* ---------- small geo helpers ---------- */
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const R_E = 6371.0;

function gcDistanceKm(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = p2 - p1, dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_E * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** initial great-circle bearing, degrees 0..360 (0=N, 90=E) */
function initialBearing(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/* ---------- NOTAM field parsing ---------- */

/** FAA NOTAM timestamps look like "10/22/2026 1800" (UTC, MM/DD/YYYY HHMM). */
function parseFaaDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})(\d{2})/);
  if (!m) return null;
  const [, mm, dd, yyyy, hh, mi] = m;
  const t = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi);
  return Number.isFinite(t) ? t : null;
}

/**
 * notamGeometry arrives as a string of "[lon,lat]" pairs, either a single
 * pair (POINT) or a long list (POLYGON). Returns [[lat,lon], ...].
 */
function parseNotamGeometry(s) {
  if (!s) return [];
  const out = [];
  const re = /\[(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const lon = parseFloat(m[1]);
    const lat = parseFloat(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lat, lon]);
  }
  return out;
}

/** Mean point of a polygon (area-weighted would be nicer; centroid is fine at this scale). */
function polygonCentroid(pts) {
  if (!pts.length) return null;
  if (pts.length === 1) return pts[0];
  let x = 0, y = 0, z = 0;
  for (const [lat, lon] of pts) {
    const p = toRad(lat), l = toRad(lon);
    x += Math.cos(p) * Math.cos(l);
    y += Math.cos(p) * Math.sin(l);
    z += Math.sin(p);
  }
  const n = pts.length;
  return [toDeg(Math.atan2(z / n, Math.hypot(x / n, y / n))), toDeg(Math.atan2(y / n, x / n))];
}

/* ---------- DMS parsing (the launch NOTAMs carry no API geometry) ---------- */

/* Three DMS spellings show up in launch NOTAMs:
     B) [N|S]DDMMSS [E|W]DDDMMSS   "N380200E1072900"   — E) BOUNDED BY clauses (CAAC)
     A) DDMMSS[N|S] DDDMMSS[E|W]   "375913N1072900E"   — ICAO Q) line, full seconds
     C) DDMM[N|S]   DDDMM[E|W]     "3759N10744E"       — ICAO Q) line, minutes only
   They do not overlap, so all three can be scanned independently. */
const DMS_PATTERNS = [
  { re: /([NS])(\d{2})(\d{2})(\d{2})([EW])(\d{3})(\d{2})(\d{2})/g, lat: [2, 3, 4], lon: [6, 7, 8], latNeg: 1, lonNeg: -1 },
  { re: /(\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])/g, lat: [1, 2, 3], lon: [5, 6, 7], latNeg: -1, lonNeg: 4 },
  { re: /(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])/g,               lat: [1, 2, 0], lon: [4, 5, 0], latNeg: -1, lonNeg: 3 },
];

/**
 * Pull every DMS coordinate out of a NOTAM body, in source order.
 * Returns [[lat, lon], ...].
 */
function parseDmsCoords(text) {
  const out = [];
  if (!text) return out;
  for (const p of DMS_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const parts = p.lat.map((i) => (i === 0 ? 0 : +m[i]));
      const lparts = p.lon.map((i) => (i === 0 ? 0 : +m[i]));
      const lat = (parts[0] + parts[1] / 60 + parts[2] / 3600) * (m[p.latNeg] === 'S' ? -1 : 1);
      const lon = (lparts[0] + lparts[1] / 60 + lparts[2] / 3600) * (m[p.lonNeg] === 'W' ? -1 : 1);
      if (Number.isFinite(lat) && Number.isFinite(lon) &&
          Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        out.push([lat, lon]);
      }
    }
  }
  return out;
}

/**
 * Geometry for one NOTAM, preferring what the API already gave us.
 * Falls back to DMS out of the text because notamGeometry is empty for
 * essentially every launch-related NOTAM.
 */
function notamPolygon(n) {
  const fromApi = parseNotamGeometry(n.notamGeometry);
  if (fromApi.length >= 3) return fromApi;
  const fromText = parseDmsCoords(notamText(n));
  if (fromText.length >= 3) return fromText;
  if (fromApi.length === 1) return fromApi;
  if (fromText.length) return fromText;
  return [];
}

/** Approx great-circle width of a polygon across its short axis, km. */
function polygonWidthKm(pts) {
  if (pts.length < 2) return 0;
  let maxD = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = gcDistanceKm(pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
      if (d > maxD) maxD = d;
    }
  }
  return maxD;
}

/* ---------- browser session (lazy, reused) ---------- */

const SESSION = {
  browser: null, ctx: null, page: null,
  ready: false, failed: false,
  lastUse: 0,
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const BOOT_WAIT_MS = 9000;   // let the Akamai challenge settle
const IDLE_MS = 180000;      // close the browser after 3 min unused

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Launch a real Chrome (channel) with light anti-automation masking.
 * Bundled headless Chromium is detected and 403'd, so the channel is not
 * optional here.
 */
async function openSession() {
  if (!chromium) { SESSION.failed = true; throw new Error('playwright not installed'); }
  if (SESSION.ready && SESSION.page && !SESSION.page.isClosed()) return SESSION;

  const channels = ['chrome', 'msedge', null];
  let lastErr = null;

  for (const channel of channels) {
    try {
      const browser = await chromium.launch({
        headless: true,
        channel: channel || undefined,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--no-first-run', '--no-default-browser-check',
        ],
      });
      const ctx = await browser.newContext({
        userAgent: UA,
        locale: 'en-US',
        timezoneId: 'America/New_York',   // FAA is a US agency; matches its own sessions
        viewport: { width: 1366, height: 900 },
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        window.chrome = { runtime: {} };
      });
      const page = await ctx.newPage();

      const resp = await page.goto('https://notams.aim.faa.gov/notamSearch/', {
        waitUntil: 'domcontentloaded', timeout: 60000,
      });
      if (!resp || resp.status() !== 200) {
        throw new Error('notamSearch HTTP ' + (resp && resp.status()));
      }
      await sleep(BOOT_WAIT_MS);

      SESSION.browser = browser; SESSION.ctx = ctx; SESSION.page = page;
      SESSION.ready = true; SESSION.failed = false; SESSION.lastUse = Date.now();
      console.log('[notam] session ready (channel=' + (channel || 'bundled') + ')');
      return SESSION;
    } catch (e) {
      lastErr = e;
      SESSION.failed = true;
    }
  }
  throw lastErr || new Error('could not open NOTAM session');
}

async function closeSession() {
  try { if (SESSION.browser) await SESSION.browser.close(); } catch { /* ignore */ }
  SESSION.browser = SESSION.ctx = SESSION.page = null;
  SESSION.ready = false;
  SESSION.lastUse = 0;
}

/* ---------- search ---------- */

const PAGE_SIZE = 30;

/** POST /notamSearch/search inside the page context (keeps the Akamai cookie).
 *  A bare FIR/ICAO code is sent as searchType=0 (location); anything else as a
 *  searchType=4 free-text query. */
async function searchOnce(target, offset) {
  return SESSION.page.evaluate(async ({ tgt, off }) => {
    const isLocation = /^[A-Z]{4}$/.test(tgt);
    const b = new URLSearchParams();
    b.append('searchType', isLocation ? '0' : '4');
    if (isLocation) b.append('designatorsForLocation', tgt);
    else b.append('freeFormText', tgt);
    b.append('notamsOnly', 'false');
    if (off) b.append('offset', String(off));
    const r = await fetch('/notamSearch/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: b.toString(),
    });
    if (r.status !== 200) return { status: r.status, notamList: [], total: 0 };
    let j = null;
    try { j = await r.json(); } catch { return { status: r.status, notamList: [], total: 0 }; }
    return {
      status: 200,
      notamList: j.notamList || [],
      total: Number(j.totalNotamCount || j.filteredResultCount || 0),
    };
  }, { tgt: target, off: offset });
}

/** Sweep every target with pagination, de-duplicating by NOTAM number. */
async function searchNotams(targets, maxPages = 3) {
  const out = new Map();
  for (const tgt of targets) {
    for (let p = 0; p < maxPages; p++) {
      let r;
      try {
        r = await searchOnce(tgt, p * PAGE_SIZE);
      } catch (e) {
        // session died — drop it so the next call re-boots
        await closeSession();
        throw e;
      }
      if (r.status !== 200) break;
      for (const n of r.notamList) {
        const key = n.notamNumber || `${n.icaoId}:${n.transactionID}`;
        if (key && !out.has(key)) out.set(key, n);
      }
      if (r.notamList.length < PAGE_SIZE) break;
      if (out.size > 500) break;
    }
  }
  SESSION.lastUse = Date.now();
  return [...out.values()];
}

/* ---------- launch matching ---------- */

const DEFAULT_PHRASES = ['AEROSPACE', 'ROCKET LAUNCH', 'DNG ZONE'];

/* Chinese FIRs. A launch NOTAM is filed against whichever FIR owns the pad,
   and for Taiyuan that turned out to be Lanzhou (ZLHW), not Beijing —
   so we ask every plausible FIR rather than guessing one. */
const CN_FIRS = [
  'ZBPE', // Beijing
  'ZYSH', // Shenyang
  'ZLHW', // Lanzhou
  'ZWUQ', // Urumqi
  'ZHWH', // Wuhan
  'ZGZU', // Guangzhou
  'ZPKM', // Kunming
  'ZSHA', // Shanghai
];

/** Queries to run for a pad: its FIRs by location, plus a global rocket sweep
    as a safety net for non-Chinese pads (Vandenberg, Cape, Kourou, ...). */
function defaultTargetsFor(lat, lon) {
  const targets = [];
  if (lat > 15 && lat < 56 && lon > 70 && lon < 140) {
    targets.push(...CN_FIRS);                       // query form differs, see searchNotams
  }
  targets.push('ROCKET', 'AEROSPACE');
  return targets;
}

/**
 * Find published danger areas that belong to a specific launch and turn
 * them into a ground-track bearing.
 *
 * Matching rule:
 *   - the NOTAM must be valid across the launch instant, and
 *   - its polygon must sit within reach of the pad.
 * Polygons hugging the pad (< ~120 km) are the launch danger area proper
 * and are reported separately; the ones further downrange define the
 * ground track and are what we average the bearing from.
 */
/* A NOTAM only counts if its body actually describes a launch hazard.
   Without this the FIR sweep pulls in every military airspace restriction
   that happens to be valid at the same instant. */
const LAUNCH_KEYWORDS =
  /\b(TEMPORARY DANGER AREA|DANGER AREA|DNG|RESTRICTED AREA|UNMANNED ROCKET|ROCKET LAUNCH|LAUNCH ACTIVITY|SPACEFLIGHT|SPACE LAUNCH|MISSILE (?:LAUNCH|ACTIVITY)|AEROSPACE FLIGHT ACTIVITY)\b/i;

/** Fraction of the launch window covered by [from,to] — the strongest signal
 *  that a NOTAM belongs to a specific launch. */
function windowOverlap(from, to, ws, we) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  if (!Number.isFinite(ws) || !Number.isFinite(we)) return 0;
  const lo = Math.max(from, ws), hi = Math.min(to, we);
  if (hi <= lo) return 0;
  const union = Math.max(to, we) - Math.min(from, ws);
  return union > 0 ? (hi - lo) / union : 0;
}

/**
 * What orbit inclination a bearing would imply from this pad.
 * sin(A_inertial) = cos(i) / cos(lat0)  ->  i = acos(sin(A) * cos(lat0))
 *
 * Reported for the operator's benefit only — it is NOT used to reject a
 * zone. Classified and test flights (ASAT interceptors, steep re-entry
 * demos) really do fly extreme inclinations, and the drop zone is still
 * the best available direction evidence when LL2 publishes no orbit.
 */
function impliedInclination(bearingDeg, padLat) {
  const s = Math.sin(toRad(bearingDeg)) * Math.cos(toRad(padLat));
  return round2((toDeg(Math.acos(clamp(s, -1, 1)))));
}

/** True when the implied inclination sits in the usual launch range. */
const CONVENTIONAL_INC_MIN = 55;
const CONVENTIONAL_INC_MAX = 105;
function isConventionalOrbit(bearingDeg, padLat) {
  const inc = impliedInclination(bearingDeg, padLat);
  return inc >= CONVENTIONAL_INC_MIN && inc <= CONVENTIONAL_INC_MAX;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function findLaunchNotams(launch, opts = {}) {
  if (!SESSION.ready || !SESSION.page) return null;   // caller must boot() first
  const pad = launch.pad || {};
  const padLat = parseFloat(pad.latitude);
  const padLon = parseFloat(pad.longitude);
  if (!Number.isFinite(padLat) || !Number.isFinite(padLon)) return null;

  const netMs = Date.parse(launch.net);
  if (!Number.isFinite(netMs)) return null;

  const t0 = netMs - (opts.beforeMs ?? 6 * 3600e3);
  const t1 = netMs + (opts.afterMs  ?? 3 * 3600e3);

  /* prefer the published launch window when we have one — it is a far
     tighter anchor than the single NET instant */
  const ws = Date.parse(launch.window_start);
  const we = Date.parse(launch.window_end);
  const useWindow = Number.isFinite(ws) && Number.isFinite(we) && we > ws;

  const raw = await searchNotams(opts.phrases || defaultTargetsFor(padLat, padLon), opts.maxPages ?? 3);
  if (!raw.length) return null;

  const launchZone = [], dropZones = [];

  for (const n of raw) {
    const from = parseFaaDate(n.startDate);
    const to   = parseFaaDate(n.endDate);
    if (!from || !to) continue;
    if (n.cancelledOrExpired) continue;
    if (to < t0 || from > t1) continue;

    const text = notamText(n);
    if (!LAUNCH_KEYWORDS.test(text)) continue;

    const pts = notamPolygon(n);
    if (pts.length < 3) continue;               // need a real area, not a stray point

    const c = polygonCentroid(pts);
    if (!c) continue;
    const distKm = gcDistanceKm(padLat, padLon, c[0], c[1]);
    if (distKm > (opts.maxRangeKm ?? 4000)) continue;
    if (distKm < (opts.minRangeKm ?? 5)) continue;

    const rec = {
      notamNumber: n.notamNumber,
      icao: n.icaoId,
      startDate: n.startDate,
      endDate: n.endDate,
      centroid: [round4(c[0]), round4(c[1])],
      rangeKm: Math.round(distKm),
      widthKm: Math.round(polygonWidthKm(pts)),
      bearingDeg: round2(initialBearing(padLat, padLon, c[0], c[1])),
      overlap: round2(useWindow ? windowOverlap(from, to, ws, we) : 0),
      implied_incl_deg: impliedInclination(round2(initialBearing(padLat, padLon, c[0], c[1])), padLat),
      polygon: pts.map(([la, lo]) => [round4(la), round4(lo)]),
      text: text.replace(/\s+/g, ' ').trim().slice(0, 400),
    };

    if (distKm < 120) launchZone.push(rec);
    else dropZones.push(rec);
  }

  for (const z of dropZones) z.conventional_orbit = isConventionalOrbit(z.bearingDeg, padLat);

  /* A zone is usable when it is valid across the launch window and sits
     within reach of the pad. How exotic the implied orbit looks is noted
     but never disqualifies it — the drop zone is real airspace either way,
     and a steep trajectory is a legitimate thing for a mission to fly. */
  const eligible = useWindow
    ? dropZones.filter((z) => z.overlap >= (opts.minOverlap ?? 0.25))
    : dropZones.slice();

  if (!launchZone.length && !dropZones.length) return null;

  /* Ground track = circular mean of the bearing to each downrange polygon.
     Debris corridors are collinear with the pad, so averaging beats trusting
     any single zone. */
  let azimuthDeg = null, spreadDeg = null;
  if (eligible.length) {
    const sorted = [...eligible].sort((a, b) => a.rangeKm - b.rangeKm);
    // nearer zones get more weight: boosters fall first, so they sit closest
    // to the pad and are least perturbed by crossrange drift
    const w = sorted.map((z) => 1 / Math.max(120, z.rangeKm));
    let sx = 0, sy = 0, wt = 0;
    sorted.forEach((z, i) => {
      const a = toRad(z.bearingDeg);
      sx += w[i] * Math.cos(a); sy += w[i] * Math.sin(a); wt += w[i];
    });
    sx /= wt; sy /= wt;
    azimuthDeg = round2((toDeg(Math.atan2(sy, sx)) + 360) % 360);
    spreadDeg = round2(angularSpread(sorted.map((z) => z.bearingDeg), azimuthDeg));
  }

  return {
    source: 'FAA NOTAM Search',
    fetched_at: new Date().toISOString(),
    pad: [padLat, padLon],
    azimuth_deg: azimuthDeg,
    bearing_spread_deg: spreadDeg,
    launch_window_known: useWindow,
    launch_zone: launchZone.sort((a, b) => a.rangeKm - b.rangeKm),
    drop_zones: eligible.sort((a, b) => a.rangeKm - b.rangeKm),
  };
}

/** Largest absolute deviation of a set of bearings from their circular mean. */
function angularSpread(anglesDeg, meanDeg) {
  const mean = toRad(meanDeg);
  let maxDev = 0;
  for (const a of anglesDeg) {
    let d = toRad(a) - mean;
    d = (((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const dev = Math.abs(toDeg(d));
    if (dev > maxDev) maxDev = dev;
  }
  return maxDev;
}

/**
 * NOTAM body text.
 *
 * Careful: for A-series (CAAC/China) NOTAMs the FAA API returns
 * traditionalMessage as a single space " " — which is truthy — so a naive
 * `traditionalMessage || icaoMessage` silently discards the only field
 * that actually carries the text. Treat whitespace-only as absent.
 */
function notamText(n) {
  const pick = (s) => (typeof s === 'string' && s.trim() ? s : null);
  return pick(n.icaoMessage)
      || pick(n.traditionalMessage)
      || pick(n.traditionalMessageFrom4thWord)
      || pick(n.plainLanguageMessage)
      || '';
}

const firstLine = (n) => notamText(n).replace(/\s+/g, ' ').trim().slice(0, 400);

const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;

/* ---------- idle reaper ---------- */
const reaper = setInterval(() => {
  if (SESSION.ready && SESSION.lastUse && Date.now() - SESSION.lastUse > IDLE_MS) {
    closeSession().catch(() => {});
  }
}, 60000);
if (reaper.unref) reaper.unref();

/* ---------- public API ---------- */

module.exports = {
  /** Boot the browser session. Returns false if unavailable (no throw). */
  async boot() {
    if (SESSION.ready && SESSION.page && !SESSION.page.isClosed()) return true;
    try { await openSession(); return true; }
    catch (e) {
      console.warn('[notam] session unavailable:', e.message);
      return false;
    }
  },

  /**
   * End-to-end: boot if needed, search, match against the launch.
   * Returns null when NOTAM data is unavailable for this launch — the
   * caller is expected to fall back to inclination heuristics.
   */
  async getLaunchDropZones(launch, opts = {}) {
    if (!(await this.boot())) return null;
    try { return await findLaunchNotams(launch, opts); }
    catch (e) {
      console.warn('[notam] lookup failed:', e.message);
      return null;
    }
  },

  close: closeSession,
  gcDistanceKm, initialBearing, polygonCentroid, angularSpread,
  parseNotamGeometry, parseFaaDate, parseDmsCoords, notamPolygon, notamText,
  impliedInclination, isConventionalOrbit,
  CONVENTIONAL_INC_MIN, CONVENTIONAL_INC_MAX,
  defaultTargetsFor, CN_FIRS,
  _search: searchNotams, _session: SESSION,
};