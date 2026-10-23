/* =====================================================================
   db.js — SQLite layer for rocket launches
   Uses Node.js built-in `node:sqlite` (DatabaseSync, Node 22.5+).
   No external native dependencies.
   ===================================================================== */

const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'launches.db');

/* -------- open + migrate -------- */
function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;

    CREATE TABLE IF NOT EXISTS launches (
      id        TEXT PRIMARY KEY,
      net       TEXT NOT NULL,
      category  TEXT,
      status_id INTEGER,
      name      TEXT,
      image     TEXT,
      data      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_net        ON launches(net);
    CREATE INDEX IF NOT EXISTS idx_cat_net    ON launches(category, net);
    CREATE INDEX IF NOT EXISTS idx_status_id  ON launches(status_id);

    CREATE TABLE IF NOT EXISTS cache_state (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    /* NOTAM lookups are cached per launch: they are only meaningful in the
       last ~48 h before liftoff, and the FAA scraper is expensive to run.

       IMPORTANT: a successful lookup is kept PERMANENTLY. LL2 rewrites the
       mission record after liftoff (name, orbit class, …) and the FAA
       withdraws the launch-window NOTAMs shortly after T-0, so a re-query
       would come back empty and would destroy the only evidence of the real
       flight direction. The first result that carries a usable bearing wins
       and is never overwritten by a later empty/poorer one. */
    CREATE TABLE IF NOT EXISTS notam_cache (
      launch_id TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      azimuth_deg REAL,
      payload     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notam_azimuth ON notam_cache(azimuth_deg);
  `);
  return db;
}

/* -------- notam cache -------- */
/**
 * Store a NOTAM lookup result.
 *
 * A row that already holds a usable bearing is treated as authoritative and
 * is never downgraded: a later failed lookup (found:false, null azimuth, or
 * a bare "0 zones" response) will not clobber it. Only `force: true` bypasses
 * that guard, for the rare case of a stale/corrupt row that must be replaced.
 */
function putNotam(db, launchId, azimuthDeg, payload, opts = {}) {
  const existing = db.prepare('SELECT azimuth_deg FROM notam_cache WHERE launch_id = ?')
    .get(launchId);
  const hasUsable = existing && existing.azimuth_deg != null;
  const incomingUsable = azimuthDeg != null && Number.isFinite(azimuthDeg);

  if (hasUsable && !incomingUsable && !opts.force) {
    /* keep the original result, but note that we looked again */
    db.prepare(`UPDATE notam_cache
                SET payload = json_set(payload, '$.last_recheck_at', ?)
                WHERE launch_id = ?`)
      .run(Date.now(), launchId);
    return false;
  }

  db.prepare(`INSERT INTO notam_cache (launch_id, fetched_at, azimuth_deg, payload)
              VALUES (?,?,?,?)
              ON CONFLICT(launch_id) DO UPDATE SET
                fetched_at = excluded.fetched_at,
                azimuth_deg = excluded.azimuth_deg,
                payload     = excluded.payload`)
    .run(launchId, Date.now(), azimuthDeg == null ? null : azimuthDeg, JSON.stringify(payload));
  return true;
}
function getNotam(db, launchId) {
  const r = db.prepare('SELECT fetched_at, azimuth_deg, payload FROM notam_cache WHERE launch_id = ?')
    .get(launchId);
  if (!r) return null;
  try { return { fetchedAt: r.fetched_at, azimuth: r.azimuth_deg, ...JSON.parse(r.payload) }; }
  catch { return null; }
}

/**
 * All stored NOTAM results that carry a usable launch bearing.
 * Used to enrich launch payloads with a permanent direction cue.
 */
function getAllNotamAzimuths(db) {
  const rows = db.prepare(`SELECT launch_id, azimuth_deg, fetched_at, payload
                            FROM notam_cache WHERE azimuth_deg IS NOT NULL`).all();
  const out = {};
  for (const r of rows) {
    let p = {};
    try { p = JSON.parse(r.payload); } catch { /* ignore */ }
    out[r.launch_id] = {
      azimuth_deg: r.azimuth_deg,
      fetched_at: r.fetched_at,
      drop_zones: p.drop_zones || [],
      launch_zone: p.launch_zone || [],
      implied_inclination_deg: p.implied_inclination_deg ?? null,
    };
  }
  return out;
}

/* -------- upsert a list of launches -------- */
function upsertLaunches(db, list, category) {
  if (!list || !list.length) return;
  const stmt = db.prepare(`
    INSERT INTO launches (id, net, category, status_id, name, image, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      net        = excluded.net,
      category   = excluded.category,
      status_id  = excluded.status_id,
      name       = excluded.name,
      image      = excluded.image,
      data       = excluded.data,
      updated_at = excluded.updated_at
  `);
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const l of list) {
      stmt.run(
        l.id,
        l.net,
        category,
        l.status?.id ?? null,
        l.name ?? null,
        l.image ?? null,
        JSON.stringify(l),
        now,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* -------- cache state -------- */
function setState(db, k, v) {
  db.prepare(`INSERT INTO cache_state (k,v) VALUES (?,?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .run(k, String(v));
}
function getState(db, k) {
  const r = db.prepare(`SELECT v FROM cache_state WHERE k=?`).get(k);
  return r ? r.v : null;
}
function getCacheMeta(db) {
  const last = getState(db, 'last_refresh');
  return {
    lastRefresh:    last ? Number(last) : null,
    upcomingCount:  Number(getState(db, 'upcoming_count') || 0),
    pastCount:      Number(getState(db, 'past_count')     || 0),
    totalRows:      db.prepare('SELECT COUNT(*) AS c FROM launches').get().c,
  };
}

/* -------- reads -------- */
function getUpcoming(db, limit, nowISO) {
  const rows = db.prepare(`
    SELECT data FROM launches
    WHERE net >= ?
    ORDER BY net ASC
    LIMIT ?
  `).all(nowISO, limit);
  return rows.map((r) => JSON.parse(r.data));
}
function getPast(db, limit, nowISO) {
  const rows = db.prepare(`
    SELECT data FROM launches
    WHERE net < ?
    ORDER BY net DESC
    LIMIT ?
  `).all(nowISO, limit);
  return rows.map((r) => JSON.parse(r.data));
}

module.exports = {
  openDb,
  upsertLaunches,
  setState,
  getState,
  getCacheMeta,
  getUpcoming,
  getPast,
  putNotam,
  getNotam,
  getAllNotamAzimuths,
  getLaunch: (db, id) => {
    const r = db.prepare('SELECT data FROM launches WHERE id = ?').get(id);
    return r ? JSON.parse(r.data) : null;
  },
  DB_PATH,
};
