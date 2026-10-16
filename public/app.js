/* =====================================================================
   ROCKET — Launch Tracker
   Data: SQLite cache served by this server, sourced from
         Launch Library 2 (https://thespacedevs.com)

   Flow:
     • Page load       → GET  /api/ll/cache   (read DB, zero upstream)
     • Manual refresh  → POST /api/ll/refresh  (force upstream fetch)
     • No background   → refreshes are 100% button-driven, no setInterval
                         in server.js. This keeps request count minimal
                         and avoids upstream 429 throttling.
   ===================================================================== */

const API = "/api/ll";

/* -------- status helpers -------- */
const STATUS_MAP = {
  1: { cls: "s-go",       label: "GO FOR LAUNCH" },
  2: { cls: "s-tbd",      label: "TO BE DETERMINED" },
  3: { cls: "s-success",  label: "LAUNCH SUCCESS" },
  4: { cls: "s-fail",     label: "LAUNCH FAILURE" },
  5: { cls: "s-hold",     label: "HOLD" },
  6: { cls: "s-inflight", label: "IN FLIGHT" },
  7: { cls: "s-partial",  label: "PARTIAL FAILURE" },
  8: { cls: "s-tbd",      label: "TO BE CONFIRMED" },
};
const statusOf = (st) => STATUS_MAP[st?.id] || { cls: "s-default", label: st?.abbrev || "—" };

/* -------- timezone (toggle: UTC ↔ Asia/Shanghai UTC+8) -------- */
let useBeijingTZ = (() => {
  try { return localStorage.getItem("rocket:tz") === "bjt"; }
  catch { return false; }
})();
let _tz = useBeijingTZ ? "Asia/Shanghai" : "UTC";
const setTimezone = (useBjt) => {
  useBeijingTZ = !!useBjt;
  _tz = useBjt ? "Asia/Shanghai" : "UTC";
  try { localStorage.setItem("rocket:tz", useBjt ? "bjt" : "utc"); } catch {}
};

/* extract calendar parts in a specific IANA timezone */
function _partsInTZ(d, tz) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const p = dtf.formatToParts(d);
  const get = (t) => (p.find((x) => x.type === t) || {}).value || "00";
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"),
  };
}

/* -------- formatters (TZ-aware) --------
   Output examples:
     UTC mode:    "2026-12-31 08:00 UTC" / "12/31 08:00Z" / "08:00 UTC"
     Beijing:     "2027-01-01 16:00 CST" / "01/01 16:00+8" / "16:00 CST" */
const pad2 = (n) => String(n).padStart(2, "0");

const fmtUTC = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  if (_tz === "UTC") {
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
  }
  const p = _partsInTZ(d, "Asia/Shanghai");
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} CST`;
};

const fmtUTCShort = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  if (_tz === "UTC") {
    return `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}Z`;
  }
  const p = _partsInTZ(d, "Asia/Shanghai");
  return `${p.month}/${p.day} ${p.hour}:${p.minute}+8`;
};

const fmtLocal = fmtUTC;  /* legacy alias — same output under current TZ */

const fmtUTCClock = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  if (_tz === "UTC") {
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
  }
  const p = _partsInTZ(d, "Asia/Shanghai");
  return `${p.hour}:${p.minute} CST`;
};
const fmtAge = (ms) => {
  if (ms == null) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60)        return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)        return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)        return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
};

function countdownParts(targetDate, now = new Date()) {
  let diff = Math.floor((targetDate - now) / 1000);
  const future = diff >= 0;
  diff = Math.abs(diff);
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return { d: pad2(d), h: pad2(h), m: pad2(m), s: pad2(s), future };
}

function imgOf(launch) {
  return launch.image || launch.mission?.infographic || null;
}

const COUNTRY_3TO2 = {
  USA:'US', RUS:'RU', CHN:'CN', JPN:'JP', KOR:'KR', PRK:'KP', IND:'IN', ISR:'IL',
  IRN:'IR', SAU:'SA', ARE:'AE', TUR:'TR', EGY:'EG', KAZ:'KZ', AUS:'AU', NZL:'NZ',
  CAN:'CA', MEX:'MX', BRA:'BR', ARG:'AR', GBR:'GB', FRA:'FR', DEU:'DE', ITA:'IT',
  ESP:'ES', NLD:'NL', BEL:'BE', CHE:'CH', SWE:'SE', NOR:'NO', FIN:'FI', DNK:'DK',
  POL:'PL', UKR:'UA', CZE:'CZ', GRC:'GR', PRT:'PT', IRL:'IE', AUT:'AT', ROU:'RO',
  HUN:'HU', BGR:'BG', IDN:'ID', MYS:'MY', THA:'TH', VNM:'VN', PHL:'PH', SGP:'SG',
  PAK:'PK', BGD:'BD', LKA:'LK', NPL:'NP', MNG:'MN', TWN:'TW', HKG:'HK', MAC:'MO',
  ZAF:'ZA', NGA:'NG', KEN:'KE', ETH:'ET', MAR:'MA', DZA:'DZ', TUN:'TN', LBY:'LY',
  AGO:'AO', VEN:'VE', CHL:'CL', COL:'CO', PER:'PE', ECU:'EC', CUB:'CU',
};
function toFlag(alpha) {
  if (!alpha) return '';
  let cc = String(alpha).toUpperCase();
  if (cc.length === 3) cc = COUNTRY_3TO2[cc] || '';
  if (cc.length !== 2) return '';
  const offset = (c) => c.charCodeAt(0) - 65 + 0x1F1E6;
  return String.fromCodePoint(offset(cc[0]), offset(cc[1]));
}
function countryFlag(launch) {
  const raw = launch.launch_service_provider?.country_code ||
              launch.pad?.location?.country_code ||
              launch.pad?.country_code || '';
  if (!raw) return '';
  let cc = String(raw).toUpperCase();
  if (cc.length === 3) cc = COUNTRY_3TO2[cc] || '';
  if (cc.length !== 2) return '';
  return `https://flagcdn.com/w80/${cc.toLowerCase()}.png`;
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* =====================================================================
   HERO
   ===================================================================== */
const hero = {
  launch: null,
  tick() {
    if (!this.launch) return;
    const target = new Date(this.launch.net);
    if (isNaN(target)) return;
    const p = countdownParts(target);
    document.querySelectorAll("#countdown .cd-num").forEach((el) => {
      const k = el.dataset.cd;
      el.textContent = p[k];
    });
    const net = document.querySelector("#heroNet");
    if (net) {
      net.textContent = (p.future ? "T- · " : "T+ · ") +
        `D:${p.d} H:${p.h} M:${p.m} S:${p.s}  ·  NET ${fmtUTC(this.launch.net)}`;
    }
  },
};

function renderHero(launch) {
  hero.launch = launch;
  document.querySelector("#heroName").textContent = launch.name;
  document.querySelector("#heroMeta").innerHTML = [
    `<span><b>${escapeHTML(launch.launch_service_provider?.name || "—")}</b></span>`,
    `<span><b>${escapeHTML(launch.rocket?.configuration?.full_name || "—")}</b></span>`,
    `<span>PAD: <b>${escapeHTML(launch.pad?.name || "—")}</b></span>`,
    `<span>LOC: <b>${escapeHTML(launch.pad?.location?.name || "—")}</b></span>`,
  ].join("");
  document.querySelector("#heroLink").href = "#";

  const bg = document.querySelector("#heroBg");
  const url = imgOf(launch);
  if (url) {
    bg.style.backgroundImage = `url("${url}")`;
    const img = new Image();
    img.onload = img.onerror = () => bg.classList.add("ready");
    img.src = url;
  } else {
    bg.style.backgroundImage =
      "radial-gradient(ellipse at 50% 100%, #1a1a1a 0%, #000 60%)";
    bg.classList.add("ready");
  }
  hero.tick();
}

/* =====================================================================
   CARDS
   ===================================================================== */
function makeCard(launch, { past } = {}) {
  const tpl = document.querySelector("#cardTpl");
  const node = tpl.content.firstElementChild.cloneNode(true);

  const imgEl    = node.querySelector(".card-img");
  const statusEl = node.querySelector(".status-badge");
  const timeEl   = node.querySelector(".card-time");
  const titleEl  = node.querySelector(".card-title");
  const rocketEl = node.querySelector(".card-rocket");
  const padEl    = node.querySelector(".card-pad");
  const cdEl     = node.querySelector(".card-cd");

  const st = statusOf(launch.status);
  statusEl.classList.add(st.cls);
  statusEl.textContent = st.label;
  timeEl.textContent = past ? fmtUTCShort(launch.net) : "T-…";
  titleEl.textContent = launch.name;
  rocketEl.innerHTML = `<b>${escapeHTML(launch.launch_service_provider?.name || "—")}</b> · ${escapeHTML(launch.rocket?.configuration?.full_name || "—")}`;
  padEl.innerHTML = `PAD <b>${escapeHTML(launch.pad?.name || "—")}</b> · ${escapeHTML(launch.pad?.location?.name || "—")}`;

  node.href = "#";
  node.dataset.net = launch.net;
  node.dataset.past = past ? "1" : "0";
  node.addEventListener("click", (e) => {
    e.preventDefault();
    openModal(launch);
  });

  const url = imgOf(launch);
  if (url) imgEl.style.backgroundImage = `url("${url}")`;

  const flag = countryFlag(launch);
  if (flag) {
    const img = document.createElement('img');
    img.src = flag;
    img.alt = '';
    img.className = 'card-flag';
    img.loading = 'lazy';
    imgEl.appendChild(img);
  }

  if (past) {
    cdEl.classList.add("past");
    cdEl.dataset.cd = "launched";
    cdEl.textContent = "LAUNCHED · " + fmtLocal(launch.net);
  } else {
    cdEl.dataset.cd = "tminus";
  }
  return node;
}
function tickCard(node) {
  const cdEl = node.querySelector(".card-cd");
  if (!cdEl || cdEl.dataset.cd === "launched") return;
  const target = new Date(node.dataset.net);
  if (isNaN(target)) { cdEl.textContent = "—"; return; }
  const p = countdownParts(target);
  cdEl.textContent = (p.future ? "T-  " : "T+  ") +
    `${p.d}:${p.h}:${p.m}:${p.s}`;
  const statusEl = node.querySelector(".status-badge");
  if (!p.future && statusEl.classList.contains("s-go")) {
    statusEl.classList.remove("s-go");
    statusEl.classList.add("s-success");
    statusEl.textContent = "LAUNCH SUCCESS";
  }
}

/* =====================================================================
   MODAL — detailed launch view
   ===================================================================== */
function fmtDur(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?|(\d+)D)/);
  if (!m) return iso;
  const [, h, mn, s, d] = m;
  if (d) return `${d}D`;
  if (h && mn && s) return `${h.padStart(2,'0')}:${mn.padStart(2,'0')}:${s.padStart(2,'0')}`;
  if (h && mn)      return `${h.padStart(2,'0')}:${mn.padStart(2,'0')}`;
  if (mn && s)      return `${mn.padStart(2,'0')}:${s.padStart(2,'0')}`;
  if (h)            return `${h}H`;
  if (mn)           return `${mn}M`;
  return `${s}S`;
}
const fmtRel = (iso) => iso && iso.startsWith('P') ? (iso.includes('T') && !iso.startsWith('PT') ? 'T+ ' : 'T- ') + fmtDur(iso) : 'T0';

function openModal(launch) {
  const root = document.querySelector("#modalRoot");
  const body = document.querySelector("#modalBody");

  const st = statusOf(launch.status);
  const lsp = launch.launch_service_provider || {};
  const rocket = launch.rocket || {};
  const cfg = rocket.configuration || {};
  const mfr = cfg.manufacturer || {};
  const pad = launch.pad || {};
  const loc = pad.location || {};
  const mission = launch.mission || {};
  const orbit = mission.orbit || {};
  const stage = rocket.launcher_stage?.[0];
  const stageLauncher = stage?.launcher || {};
  const stageLanding = stage?.landing || {};
  const stageLandingLoc = stageLanding.location || {};
  const stageLandingType = stageLanding.type || {};

  const flag = countryFlag(launch);

  /* ── landing zone coordinate lookup ── */
  const LANDING_ZONES = {
    // SpaceX droneships
    'OCISLY':           { lat: 31.0,  lon: -119.5 },
    'JRTI':             { lat: 33.0,  lon: -118.0 },
    'JRTI-2':           { lat: 35.0,  lon: -122.0 },
    'ASDS OCISLY':      { lat: 31.0,  lon: -119.5 },
    'ASDS JRTI':        { lat: 33.0,  lon: -118.0 },
    // SpaceX landing zones
    'LZ-1':             { lat: 28.485, lon: -80.544 },
    'LZ-2':             { lat: 28.485, lon: -80.544 },
    'LZ-4':             { lat: 34.750, lon: -120.572 },
    'LZ-40':            { lat: 40.407, lon: -74.412 },
    // Blue Origin
    'LP-1':             { lat: 31.0,   lon: -104.0 },
    'LS-1':             { lat: 31.0,   lon: -104.0 },
    'LD-1':             { lat: 31.0,   lon: -104.0 },
    // Rocket Lab
    'LC-1':             { lat: -39.0,  lon: -177.0 },
    'Launch Complex 1': { lat: -39.0,  lon: -177.0 },
    // Generic / partial names
    'Cape Canaveral':   { lat: 28.485, lon: -80.544 },
    'CCAFS':            { lat: 28.485, lon: -80.544 },
    'CCSFS':            { lat: 28.485, lon: -80.544 },
    'Vandenberg':       { lat: 34.750, lon: -120.572 },
    'VSFB':             { lat: 34.750, lon: -120.572 },
    'Boca Chica':       { lat: 25.997, lon: -97.156 },
    'Starbase':         { lat: 25.997, lon: -97.156 },
    'Wenchang':         { lat: 19.6,   lon: 110.9 },
    'Jiuquan':          { lat: 40.9,   lon: 100.5 },
    'Xichang':          { lat: 28.2,   lon: 102.0 },
    'Taiyuan':          { lat: 38.8,   lon: 111.6 },
    'Wenchang Satellite': { lat: 19.6, lon: 110.9 },
    'Baikonur':         { lat: 45.6,   lon: 63.3 },
    'Plesetsk':         { lat: 62.9,   lon: 40.4 },
    'Kourou':           { lat: 5.2,    lon: -52.8 },
    'Mahia':            { lat: -39.0,  lon: -177.0 },
    'Naro':             { lat: 28.2,   lon: 102.0 },
    'Tanegashima':      { lat: 30.4,   lon: 131.0 },
    'MHI':              { lat: 30.4,   lon: 131.0 },
    'KSLV':             { lat: 30.4,   lon: 131.0 },
  };
  const landZone = LANDING_ZONES[stageLandingLoc.name] || null;

  /* ── azimuth from point A to point B (utility for observation band) ── */
  function azimuthBetween(lat1, lon1, lat2, lon2) {
    const toRad = (d) => d * Math.PI / 180;
    const toDeg = (r) => r * 180 / Math.PI;
    const phi1 = toRad(lat1), lam1 = toRad(lon1);
    const phi2 = toRad(lat2), lam2 = toRad(lon2);
    const dLam = lam2 - lam1;
    const y = Math.sin(dLam) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /* ── rhumb-line endpoint (constant-bearing great-circle approximation) ── */
  function rhumbEndpoint(lat1, lon1, bearing, distKm) {
    const R = 6371;
    const toRad = (d) => d * Math.PI / 180;
    const toDeg = (r) => r * 180 / Math.PI;
    const d   = distKm / R;
    const p1  = toRad(lat1), l1 = toRad(lon1), th = toRad(bearing);
    const dp  = d * Math.cos(th);
    const p2  = p1 + dp;
    const dps = Math.log(Math.tan(Math.PI/4 + p2/2) / Math.tan(Math.PI/4 + p1/2));
    const q   = Math.abs(dps) > 1e-10 ? dp / dps : Math.cos(p1);
    const dl  = d * Math.sin(th) / q;
    return [toDeg(p2), lon1 + toDeg(dl)];
  }

  /* ── observation band: visibility range based on flight altitude ──
     Physical model: an observer at sea level can see a target at altitude h
     up to the horizon distance d = √(2·R·h).  We apply the standard 4/3·R
     atmospheric-refraction correction (k-factor), giving roughly 1.15× the
     geometric horizon.  The band is the strip 2d wide, centered on the
     ground track; capped at maxWidthKm for UI sanity (real ISS-horizon
     is ~2600 km). */
  const OBSERVATION_R = 6371;                    // Earth mean radius (km)
  const OBSERVATION_K = 4 / 3;                   // standard refraction k-factor
  const OBSERVATION_CAP_KM = 2200;               // UI cap (≈ ISS horizon)
  function observationBand(pts, maxWidthKm = OBSERVATION_CAP_KM) {
    if (!pts || pts.length < 2) return null;
    const cap = Math.min(maxWidthKm, OBSERVATION_CAP_KM);
    const N = pts.length;
    const left = [], right = [];
    for (let i = 0; i < N; i++) {
      const [lat, lon, alt] = pts[i];
      const bearing = (i < N - 1)
        ? azimuthBetween(lat, lon, pts[i+1][0], pts[i+1][1])
        : azimuthBetween(pts[i-1][0], pts[i-1][1], lat, lon);
      /* horizon distance with standard atmospheric refraction */
      const h = Math.max(0, alt || 0);
      const dHorizon = h > 0 ? Math.sqrt(2 * OBSERVATION_K * OBSERVATION_R * h) : 0;
      /* width = 2·dHorizon, capped */
      const width = Math.min(cap, 2 * dHorizon);
      const halfW = width / 2;
      if (halfW < 1) {
        /* skip degenerate points (still on the pad) to avoid noisy band */
        const last = left.length ? left[left.length - 1] : [lat, lon];
        left.push(last);
        right.push(last);
        continue;
      }
      const [lLat, lLon] = rhumbEndpoint(lat, lon, (bearing - 90 + 360) % 360, halfW);
      const [rLat, rLon] = rhumbEndpoint(lat, lon, (bearing + 90) % 360, halfW);
      left.push([lLat, lLon]);
      right.push([rLat, rLon]);
    }
    return [...left, ...right.reverse()];
  }

  /* =====================================================================
     Build trajectory with the physics-based engine.
     Replaces the old heuristic `launchAzimuth` + straight rhumb line.
     ===================================================================== */
  const padLat = parseFloat(pad.latitude);
  const padLon = parseFloat(pad.longitude);
  const orbitName = orbit.name || '';

  let trajLine = null, trajEndpoint = null;
  let orbitLine = null, orbitEndpoint = null;
  let engResult = null;
  let trajectoryPts = null;     // [[lat, lon, alt], ...] for band
  let dropZones = [];          // [{ lat, lon, label, sep_time_s }]
  let flightEvents = [];       // [{ lat, lon, label, t }]
  let az = null;                // ground-effective azimuth in degrees

  if (!isNaN(padLat) && !isNaN(padLon)) {
    try {
      engResult = GlobalLaunchTrajectoryEngine.generatePrediction(launch, 600, 30);
      az = engResult.metadata.azimuth_ground_eff_deg;

      /* ground-track polyline from engine's kinematic trajectory */
      trajLine = engResult.trajectory.map((p) => [p.lat, p.lon]);
      trajEndpoint = trajLine[trajLine.length - 1];

      /* rich point array (with altitude) for the observation band */
      trajectoryPts = engResult.trajectory.map((p) => [p.lat, p.lon, p.alt_km]);

      /* draw the orbit-insertion line out to a reasonable endpoint:
         if the trajectory already reaches insertion we use its last point;
         otherwise extend along the inertial azimuth. */
      const lastT = engResult.trajectory[engResult.trajectory.length - 1];
      if (lastT && lastT.range_km > 100) {
        orbitLine = trajLine;
        orbitEndpoint = trajEndpoint;
      }

      /* drop zones (booster, fairing, side boosters, ...) */
      dropZones = engResult.drop_zones.map((d) => ({
        lat: d.drop_lat, lon: d.drop_lon,
        label: d.stage, sep_time_s: d.sep_time_s,
      }));

      /* flight events (Liftoff, Max-Q, MECO, Fairing, SECO, ...) */
      flightEvents = engResult.events.map((e) => ({
        lat: e.lat, lon: e.lon, label: e.event, t: e.t,
      }));

      /* ── If the launch record carries a real landing location, prefer it
            over the engine's estimated booster drop point. The engine value
            is a generic physical approximation; LL2 data is telemetry. */
      if (landZone && dropZones.length > 0) {
        dropZones[0] = {
          ...dropZones[0],
          lat: landZone.lat, lon: landZone.lon,
          label: `Booster · ${landZone.name || "Landing"}`,
          isReal: true,
        };
      }
    } catch (err) {
      console.warn('trajectory engine failed:', err);
    }
  }

  const mapId = `traj-map-${Date.now()}`;

  const heroBg = imgOf(launch);
  const cell = (k, v, small) =>
    v == null || v === "" ? "" :
    `<div class="m-cell"><div class="k">${escapeHTML(k)}</div><div class="v">${v}${small ? ` <small>${escapeHTML(small)}</small>` : ""}</div></div>`;

  const programList = (cfg.program || [])
    .map(p => `<span style="color:#fff">${escapeHTML(p.name)}</span>`)
    .join(' · ') || "—";

  let stageHTML = "";
  if (stage) {
    const serial = stageLauncher.serial_number || "—";
    const flightNo = stage.launcher_flight_number ?? "—";
    const reused = stage.reused ? "REUSED" : "NEW";
    const status = stageLanding.attempt
      ? (stageLanding.success === true ? "LANDING SUCCESS"
        : stageLanding.success === false ? "LANDING FAILURE"
        : "LANDING TBD")
      : "NO LANDING";
    const landWhere = stageLandingLoc.name || "—";
    const landType = stageLandingType.abbrev || "";
    const prev = stage.previous_flight?.name;
    const turn = stage.turn_around_time_days;

    stageHTML = `
      <div class="m-section">
        <h3>LAUNCHER STAGE · 助推器</h3>
        <div class="m-stage">
          <div class="m-stage-head">
            <div class="m-stage-name">
              <b>${escapeHTML(stage.type || "Stage")}</b>
              <small>SERIAL ${escapeHTML(serial)} · FLIGHT #${escapeHTML(String(flightNo))}</small>
            </div>
            <span class="m-stage-tag${stage.reused ? " used" : ""}">${reused}</span>
          </div>
          <div class="m-grid">
            ${cell("Landing", status)}
            ${cell("Landing Site", landWhere, landType)}
            ${cell("Downrange", stageLanding.downrange_distance ? `${stageLanding.downrange_distance} km` : "—")}
            ${cell("Previous Flight", prev || "—")}
            ${cell("Turnaround", turn ? `${turn} d` : "—")}
          </div>
        </div>
      </div>`;
  }

  const updatesHTML = (launch.updates || []).slice(0, 6).map(u => `
    <div class="m-update">
      <div class="m-update-text">
        <div class="m-update-comment">${escapeHTML(u.comment || "")}</div>
        <div class="m-update-meta">
          <span>${escapeHTML(u.created_by || "")}</span>
          <span>${escapeHTML(fmtUTC(u.created_on))}</span>
          ${u.info_url ? `<a href="${escapeHTML(u.info_url)}" target="_blank" rel="noopener">SOURCE →</a>` : ""}
        </div>
      </div>
    </div>`).join("") || `<div class="m-desc" style="color:var(--text-mute)">No updates yet</div>`;

  const timelineHTML = (launch.timeline || []).map(t => `
    <div class="when">${escapeHTML(fmtRel(t.relative_time))}</div>
    <div class="ev">
      <b>${escapeHTML(t.type?.abbrev || "—")}</b>
      <span>${escapeHTML(t.type?.description || "")}</span>
    </div>`).join("") || `<div class="when">—</div><div class="ev"><b>No timeline</b></div>`;

  const infoLinks = (launch.infoURLs || [])
    .map(l => `<a class="m-link" href="${escapeHTML(l.url)}" target="_blank" rel="noopener">${escapeHTML(l.title || l.source || "INFO")}</a>`)
    .join("");
  const vidLinks = (launch.vidURLs || [])
    .map(l => `<a class="m-link video" href="${escapeHTML(l.url)}" target="_blank" rel="noopener">▶ ${escapeHTML(l.title || "WEBCAST")}</a>`)
    .join("");
  const linksHTML = (infoLinks + vidLinks) || `<div class="m-desc" style="color:var(--text-mute)">No links</div>`;

  body.innerHTML = `
    <div class="m-hero" style="${heroBg ? `background-image:url('${heroBg.replace(/'/g, "\\'")}')` : ""}">
      ${flag ? `<img class="m-hero-flag" src="${flag}" alt="" loading="lazy" />` : ""}
      <div class="m-hero-content">
        <span class="m-status ${st.cls}">${escapeHTML(st.label)}</span>
        <h2 class="m-title">${escapeHTML(launch.name)}</h2>
        <div class="m-sub">
          <span>NET <b>${escapeHTML(fmtUTC(launch.net))}</b></span>
          ${launch.window_start ? `<span>WINDOW <b>${escapeHTML(fmtUTC(launch.window_start))} → ${escapeHTML(fmtUTC(launch.window_end))}</b></span>` : ""}
          ${launch.probability ? `<span>GO PROB <b>${launch.probability}%</b></span>` : ""}
        </div>
      </div>
    </div>

    <div class="m-section">
      <h3>MISSION · 任务</h3>
      <div class="m-desc">${escapeHTML(mission.description || "No mission description.")}</div>
      <div class="m-grid" style="margin-top:18px">
        ${cell("Mission", mission.name)}
        ${cell("Type", mission.type)}
        ${cell("Orbit", orbit.name, orbit.abbrev)}
        ${cell("Customer", (mission.agencies || []).map(a => a.name).join(", ") || "—")}
      </div>
    </div>

    <div class="m-section">
      <h3>ROCKET · 火箭</h3>
      <div class="m-grid">
        ${cell("Configuration", cfg.full_name || cfg.name)}
        ${cell("Family", cfg.family)}
        ${cell("Variant", cfg.variant)}
        ${cell("Manufacturer", mfr.name)}
        ${cell("Length", cfg.length ? `${cfg.length} m` : "—")}
        ${cell("Diameter", cfg.diameter ? `${cfg.diameter} m` : "—")}
        ${cell("Launch Mass", cfg.launch_mass ? `${cfg.launch_mass} t` : "—")}
        ${cell("Thrust", cfg.to_thrust ? `${cfg.to_thrust} kN` : "—")}
        ${cell("LEO Capacity", cfg.leo_capacity ? `${cfg.leo_capacity} kg` : "—")}
        ${cell("GTO Capacity", cfg.gto_capacity ? `${cfg.gto_capacity} kg` : "—")}
        ${cell("Stages", cfg.min_stage)}
        ${cell("Maiden Flight", cfg.maiden_flight)}
        ${cell("Launch Cost", cfg.launch_cost ? `$${Number(cfg.launch_cost).toLocaleString()}` : "—")}
        ${cell("Total Flights", cfg.total_launch_count)}
        ${cell("Success Rate", cfg.total_launch_count ? `${(cfg.successful_launches/cfg.total_launch_count*100).toFixed(1)}% (${cfg.successful_launches}/${cfg.total_launch_count})` : "—")}
        ${cell("Program", programList)}
      </div>
    </div>

    <div class="m-section">
      <h3>LAUNCH SITE · 发射场</h3>
      <div class="m-grid">
        ${cell("Pad", pad.name)}
        ${cell("Location", loc.name)}
        ${cell("Region", loc.timezone_name)}
        ${cell("Coordinates", pad.latitude && pad.longitude ? `${pad.latitude}, ${pad.longitude}` : "—")}
        ${cell("Total Pad Launches", pad.total_launch_count)}
        ${cell("Pad Turnaround", launch.pad_turnaround ? fmtDur(launch.pad_turnaround) : "—")}
      </div>
      ${pad.description ? `<div class="m-desc" style="margin-top:16px;color:var(--text-dim)">${escapeHTML(pad.description)}</div>` : ""}
    </div>

    ${stageHTML}

    ${trajLine ? `
    <div class="m-section">
      <h3>TRAJECTORY · 轨迹预报</h3>
      <div class="m-trajectory-stats">
        <span>INC <b>${engResult ? engResult.metadata.inclination_deg.toFixed(2) : "—"}°</b></span>
        <span>AZ <b>${az != null ? az.toFixed(2) : "—"}°</b></span>
        <span>DIR <b>${engResult ? (engResult.metadata.launch_southward ? "SOUTH" : "NORTH") : "—"}</b></span>
        <span>PROFILE <b>${engResult ? engResult.metadata.profile_type.replace("_", " ") : "—"}</b></span>
        <span>ROCKET <b>${escapeHTML(engResult ? engResult.metadata.rocket_name : (cfg.full_name || "—"))}</b></span>
      </div>
      <div id="${mapId}" class="m-map"></div>
      <div class="m-trajectory-legend">
        <span class="tleg-item"><span class="tleg-dot launch"></span>Launch · ${escapeHTML(pad.name || "—")}</span>
        <span class="tleg-item"><span class="tleg-line active"></span>Ascent 主动段</span>
        <span class="tleg-item"><span class="tleg-line orbit"></span>Orbit 入轨段</span>
        ${dropZones.length ? dropZones.map((d, i) => {
          const cls = i === 0 ? "landing" : "fairing";
          return `<span class="tleg-item"><span class="tleg-dot ${cls}"></span>${escapeHTML(d.label)}</span>`;
        }).join("") : ""}
        ${flightEvents.length ? `<span class="tleg-item"><span class="tleg-dot event"></span>${flightEvents.length} Events</span>` : ""}
        <span class="tleg-item"><span class="tleg-band"></span>Visible region</span>
      </div>
      ${flightEvents.length ? `
      <div class="m-events">
        ${flightEvents.map(e => `<div class="m-event"><span class="t">T+${e.t}s</span><span class="n">${escapeHTML(e.label)}</span></div>`).join("")}
      </div>` : ""}
    </div>` : ""}

    <div class="m-section">
      <h3>OPERATOR · 运营方</h3>
      <div class="m-grid">
        ${cell("Provider", lsp.name)}
        ${cell("Type", lsp.type)}
        ${cell("Administrator", lsp.administrator)}
        ${cell("Founded", lsp.founding_year)}
        ${cell("Total Launches", lsp.total_launch_count)}
        ${cell("Success Rate", lsp.total_launch_count ? `${(lsp.successful_launches/lsp.total_launch_count*100).toFixed(1)}% (${lsp.successful_launches}/${lsp.total_launch_count})` : "—")}
      </div>
      ${lsp.description ? `<div class="m-desc" style="margin-top:16px;color:var(--text-dim)">${escapeHTML(lsp.description)}</div>` : ""}
    </div>

    <div class="m-section">
      <h3>LAUNCH ATTEMPT · 计数</h3>
      <div class="m-grid">
        ${cell("Orbital #", launch.orbital_launch_attempt_count)}
        ${cell("This Year", launch.orbital_launch_attempt_count_year)}
        ${cell("Pad #", launch.pad_launch_attempt_count)}
        ${cell("Location #", launch.location_launch_attempt_count)}
        ${cell("Agency #", launch.agency_launch_attempt_count)}
        ${cell("Agency # (Year)", launch.agency_launch_attempt_count_year)}
      </div>
    </div>

    <div class="m-section">
      <h3>UPDATES · 发射动态</h3>
      <div class="m-updates">${updatesHTML}</div>
    </div>

    <div class="m-section">
      <h3>TIMELINE · 发射时序</h3>
      <div class="m-timeline">${timelineHTML}</div>
    </div>

    <div class="m-section">
      <h3>LINKS · 资料 / 直播</h3>
      <div class="m-links">${linksHTML}</div>
    </div>
  `;

  root.hidden = false;
  document.body.style.overflow = "hidden";

  /* initialize Leaflet map after DOM is visible */
  if (trajLine) {
    const mapEl = document.getElementById(mapId);
    if (mapEl) {
      const map = L.map(mapId, {
        zoomControl: true,
        scrollWheelZoom: false,
        attributionControl: false,
        maxZoom: 8,
        minZoom: 2,
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        subdomains: 'abc',
        maxZoom: 8,
      }).addTo(map);

      /* launch marker */
      L.circleMarker([padLat, padLon], {
        radius: 7, color: '#4cd964', fillColor: '#4cd964',
        fillOpacity: 1, weight: 2,
      }).addTo(map).bindPopup(`Launch · ${escapeHTML(pad.name || "—")}`);

      /* observation band along the engine's kinematic trajectory (uses real altitude) */
      if (trajectoryPts && trajectoryPts.length > 1) {
        const band = observationBand(trajectoryPts, 2000);
        if (band) {
          L.polygon(band, {
            color: 'rgba(90,200,250,0.45)',
            fillColor: 'rgba(90,200,250,0.07)',
            fillOpacity: 0.6,
            weight: 0.5,
            smoothFactor: 1.5,
          }).addTo(map).bindPopup('Visible region · 大致可观察范围');
        }
      }

      /* engine trajectory polyline — color by flight phase (active vs orbit) */
      if (trajLine && trajLine.length > 1) {
        const splitIdx = engResult
          ? engResult.trajectory.findIndex((p) => p.phase === "ORBIT")
          : -1;
        const activeSeg  = splitIdx > 0 ? trajLine.slice(0, splitIdx + 1) : trajLine;
        const orbitSeg   = splitIdx > 0 ? trajLine.slice(splitIdx)       : null;

        L.polyline(activeSeg, {
          color: 'rgba(255,159,10,0.85)',
          weight: 2.5,
          lineCap: 'round',
        }).addTo(map);

        if (orbitSeg && orbitSeg.length > 1) {
          L.polyline(orbitSeg, {
            color: 'rgba(90,200,250,0.65)',
            weight: 2,
            dashArray: '8 4',
            lineCap: 'round',
          }).addTo(map);
        }
      }

      /* flight event markers (Liftoff, Max-Q, MECO, Fairing, SECO, …) */
      flightEvents.forEach((ev) => {
        if (ev.label === "Liftoff") return;             // already drawn as green launch marker
        L.circleMarker([ev.lat, ev.lon], {
          radius: 4, color: '#ffffff', fillColor: '#888',
          fillOpacity: 0.8, weight: 1,
        }).addTo(map).bindPopup(
          `<b>${escapeHTML(ev.label)}</b><br/>T+${ev.t}s`
        );
      });

      /* drop zone markers (booster, fairing, side boosters) */
      dropZones.forEach((d, i) => {
        if (d.lat == null || d.lon == null) return;
        const isFirst = i === 0;
        const color = isFirst ? '#ff9f0a' : '#5ac8fa';
        L.circleMarker([d.lat, d.lon], {
          radius: 6, color, fillColor: color,
          fillOpacity: 0.85, weight: 2,
        }).addTo(map).bindPopup(`<b>${escapeHTML(d.label)}</b><br/>T+${d.sep_time_s}s`);
      });

      /* fit bounds to all visible geometry */
      const allPts = [
        [padLat, padLon],
        ...trajLine,
        ...dropZones.filter((d) => d.lat != null).map((d) => [d.lat, d.lon]),
      ];
      const bounds = L.latLngBounds(allPts);
      map.fitBounds(bounds, { padding: [28, 28] });

      /* Leaflet needs invalidateSize when container was hidden — give browser time to reflow */
      setTimeout(() => map.invalidateSize(), 60);
    }
  }
}

function closeModal() {
  const root = document.querySelector("#modalRoot");
  root.hidden = true;
  document.body.style.overflow = "";
}

document.addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector("#modalRoot").hidden) closeModal();
});
document.querySelector("#heroLink").addEventListener("click", (e) => {
  e.preventDefault();
  if (hero.launch) openModal(hero.launch);
});

/* =====================================================================
   EMPTY STATES
   ===================================================================== */
function emptyStateHTML(label, hint) {
  return `
    <div class="empty-state">
      <div class="empty-glyph">· · ·</div>
      <div class="empty-msg">${escapeHTML(label)}</div>
      <div class="empty-hint">${escapeHTML(hint)}</div>
    </div>`;
}
function showEmptyUpcoming() {
  document.querySelector("#upcomingGrid").innerHTML = emptyStateHTML(
    "暂无发射计划 · NO UPCOMING MISSIONS",
    "点击右上 FETCH DATA 按钮获取"
  );
  document.querySelector("#upcomingCount").textContent = "—  MISSIONS";
}
function showEmptyPast() {
  document.querySelector("#pastGrid").innerHTML = emptyStateHTML(
    "暂无历史数据 · NO RECENT MISSIONS",
    "点击右上 FETCH DATA 按钮获取"
  );
  document.querySelector("#pastCount").textContent = "—  RECENT";
}

/* =====================================================================
   CACHE LOAD
   ===================================================================== */
/* Last loaded cache — kept in memory so the TZ toggle can re-render
   every time string in place without re-hitting the network. */
let _lastCache = null;

async function loadFromCache() {
  let res;
  try {
    res = await fetch(`${API}/cache`);
  } catch (e) {
    return false;
  }
  if (res.status === 404) {
    document.querySelector("#cacheHint").textContent =
      "数据库为空 · DB EMPTY · 点击右上 FETCH DATA 让服务器拉取一次";
    document.querySelector("#cacheHint").classList.add("visible");
    return false;
  }
  if (!res.ok) return false;
  const cache = await res.json();
  if (!cache.upcoming?.results || !cache.past?.results) return false;
  _lastCache = cache;
  applyCache(cache);
  return true;
}

function applyCache(cache) {
  /* Upcoming — server already filtered (net__gte=now), but defend again */
  const now = Date.now();
  const future = cache.upcoming.results.filter((l) => new Date(l.net).getTime() >= now);

  document.querySelector("#upcomingCount").textContent =
    `${cache.upcomingCount}  MISSIONS · 任务`;

  const gridU = document.querySelector("#upcomingGrid");
  gridU.innerHTML = "";
  if (future.length) {
    future.forEach((launch, i) => {
      const card = makeCard(launch, { past: false });
      gridU.appendChild(card);
      tickCard(card);
      if (i === 0) renderHero(launch);
    });
    document.querySelector("#heroName").textContent = future[0].name;
    document.querySelector("#heroMeta").textContent =
      `已加载 · NEXT MISSION · 下一发任务`;
  } else {
    showEmptyUpcoming();
    document.querySelector("#heroName").textContent = "—";
    document.querySelector("#heroMeta").textContent =
      "暂无未来发射计划 · NO UPCOMING MISSIONS";
    document.querySelector("#heroNet").textContent = "—";
    hero.launch = null;
  }

  /* Past */
  document.querySelector("#pastCount").textContent =
    `${cache.pastCount}  RECENT · 已完成`;
  const gridP = document.querySelector("#pastGrid");
  gridP.innerHTML = "";
  if (cache.past.results.length) {
    cache.past.results.forEach((launch) => {
      gridP.appendChild(makeCard(launch, { past: true }));
    });
  } else {
    showEmptyPast();
  }

  /* Update freshness indicators */
  lastFetchedAt = cache.updated ? new Date(cache.updated) : new Date();
  updateLastFetchedLabel();
  setBtnState("ready");
}

/* =====================================================================
   FETCH BUTTON (manual, single source of upstream calls)
   ===================================================================== */
let isLoading = false;
let lastFetchedAt = null;

function setBtnState(state) {
  const btn = document.querySelector("#fetchBtn");
  const label = btn.querySelector(".btn-label");
  btn.disabled = state === "loading";
  btn.classList.toggle("loading", state === "loading");
  label.textContent = state === "loading"
    ? "LOADING · 加载中"
    : (lastFetchedAt ? "REFRESH · 重新获取" : "FETCH DATA · 获取数据");
}

function updateLastFetchedLabel() {
  const el = document.querySelector("#lastFetched");
  if (!lastFetchedAt) { el.classList.remove("visible"); el.textContent = ""; return; }
  el.textContent = `AGE · ${fmtAge(Date.now() - lastFetchedAt.getTime())} · ${fmtUTCClock(lastFetchedAt.toISOString())}`;
  el.classList.add("visible");
}

setInterval(updateLastFetchedLabel, 30 * 1000);

async function handleFetch() {
  if (isLoading) return;
  isLoading = true;
  setBtnState("loading");
  try {
    const r = await fetch(`${API}/refresh`, { method: "POST" });
    if (!r.ok) {
      /* server returns { error, detail, retryAfter } for 429/502 — read body */
      let body = {};
      try { body = await r.json(); } catch { body = { detail: await r.text().catch(() => r.statusText) }; }
      const err = new Error(body.detail || body.error || `HTTP ${r.status}`);
      err.status     = r.status;
      err.retryAfter = body.retryAfter || null;
      err.errorLabel = body.error      || null;
      throw err;
    }
    const cache = await r.json();
    _lastCache = cache;
    applyCache(cache);
    /* Hide any "DB empty" hint once refresh succeeded */
    document.querySelector("#cacheHint")?.classList.remove("visible");
  } catch (e) {
    console.error("fetch failed", e);
    const glyph = e.status === 429 ? "⏳" : "⚠";
    const label = e.status === 429
      ? "上游限流 · RATE LIMITED"
      : "请求失败 · FETCH FAILED";
    let hint;
    if (e.status === 429) {
      const sec = e.retryAfter || 0;
      const min = Math.ceil(sec / 60);
      hint = `LL2 限流 429 · 需等待约 ${min} 分钟后重试`
           + (sec ? `  (Retry-After: ${sec}s)` : "");
    } else {
      hint = e?.message || "请稍后重试";
    }
    document.querySelector("#upcomingGrid").innerHTML = `
      <div class="empty-state">
        <div class="empty-glyph">${glyph}</div>
        <div class="empty-msg">${escapeHTML(label)}</div>
        <div class="empty-hint">${escapeHTML(hint)}</div>
      </div>`;
    document.querySelector("#pastGrid").innerHTML = emptyStateHTML(
      escapeHTML(label), escapeHTML(hint)
    );
    document.querySelector("#upcomingCount").textContent = "—  MISSIONS";
    document.querySelector("#pastCount").textContent     = "—  RECENT";
  } finally {
    isLoading = false;
    setBtnState("ready");
  }
}

/* =====================================================================
   BOOT — load cache silently (no upstream call), start countdown ticker
   ===================================================================== */
function startTicker() {
  setInterval(() => {
    hero.tick();
    document.querySelectorAll("#upcomingGrid .card").forEach(tickCard);
  }, 1000);
}

/* =====================================================================
   TZ TOGGLE — UTC ↔ Beijing (Asia/Shanghai, UTC+8)
   Re-renders every card and the hero by replaying the last cache load.
   ===================================================================== */
function syncTzButton() {
  const btn = document.querySelector("#tzToggle");
  if (!btn) return;
  const lab = btn.querySelector(".tz-label");
  if (lab) lab.textContent = useBeijingTZ ? "BJT" : "UTC";
  btn.classList.toggle("on", useBeijingTZ);
  btn.title = useBeijingTZ
    ? "Current: Beijing Time (UTC+8) — click to switch to UTC"
    : "Current: UTC — click to switch to Beijing Time (UTC+8)";
}

function rerenderForTz() {
  /* If we have a last cache, replay applyCache to rewrite every time
     string in the cards with the new TZ. The countdown ticker keeps
     working unchanged (TZ-independent math). */
  if (_lastCache) applyCache(_lastCache);
  updateLastFetchedLabel();
}

document.addEventListener("DOMContentLoaded", async () => {
  showEmptyUpcoming();
  showEmptyPast();
  document.querySelector("#fetchBtn").addEventListener("click", handleFetch);
  syncTzButton();
  document.querySelector("#tzToggle")?.addEventListener("click", () => {
    setTimezone(!useBeijingTZ);
    syncTzButton();
    rerenderForTz();
  });
  startTicker();

  // Try loading cache from server (page refresh / new tab won't lose data)
  await loadFromCache();
});
