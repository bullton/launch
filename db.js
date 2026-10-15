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
  `);
  return db;
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
  DB_PATH,
};
