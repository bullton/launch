/* =====================================================================
   ROCKET — Launch Tracker
   Data: SQLite cache served by this server, refreshed in the background
         from Launch Library 2 (https://thespacedevs.com)

   Flow:
     • Page load       → GET  /api/ll/cache   (read DB, no upstream)
     • Manual refresh  → POST /api/ll/refresh  (force upstream fetch)
     • Background      → server refreshes DB every REFRESH_INTERVAL_MS
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

/* -------- formatters -------- */
const fmtUTC = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};
const fmtUTCShort = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
};
const fmtLocal = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtUTCClock = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
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
const pad2 = (n) => String(n).padStart(2, "0");

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

  /* ── launch azimuth from orbit type + pad lat ── */
  function launchAzimuth(padLat, orbitName) {
    const lat = Math.abs(padLat);
    const name = (orbitName || '').toLowerCase();
    if (name.includes('polar') || name.includes('sso')) return padLat >= 0 ? 180 : 0;
    if (name.includes('equator') || name.includes('geo') || name.includes('gto')) return 95;
    if (name.includes('iss') || name.includes('station')) return lat < 30 ? 45 : 35;
    if (name.includes('leo') || name.includes('low earth')) {
      /* initial flight azimuth (safety corridor, before any dogleg).
         Calibrated against Shenzhou / Long March ground tracks which
         typically run ESE to reach Pacific tracking ships. */
      if (lat < 25) return 60;
      if (lat < 35) return 80;
      return 115;
    }
    return 110;
  }

  /* ── rhumb line endpoint (constant bearing — appears as straight line on Mercator) ── */
  function rhumbEndpoint(lat1, lon1, bearing, distKm) {
    const R = 6371;
    const toRad = (d) => d * Math.PI / 180;
    const toDeg = (r) => r * 180 / Math.PI;
    const δ = distKm / R;
    const φ1 = toRad(lat1), λ1 = toRad(lon1), θ = toRad(bearing);
    const Δφ = δ * Math.cos(θ);
    const φ2 = φ1 + Δφ;
    const Δψ = Math.log(Math.tan(Math.PI/4 + φ2/2) / Math.tan(Math.PI/4 + φ1/2));
    const q = Math.abs(Δψ) > 1e-10 ? Δφ / Δψ : Math.cos(φ1);
    const Δλ = δ * Math.sin(θ) / q;
    return [toDeg(φ2), lon1 + toDeg(Δλ)];
  }

  /* ── interpolate a 2-point line into N points ── */
  function interpolateLine(line, steps) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      pts.push([
        line[0][0] + (line[1][0] - line[0][0]) * f,
        line[0][1] + (line[1][1] - line[0][1]) * f,
      ]);
    }
    return pts;
  }

  /* ── observation band: visibility range based on flight altitude ──
     Visibility d ≈ √(2·R·h), where R = 6371km, h = altitude.
     100km altitude → ~1100km visible
     400km altitude → ~2200km visible
     Width grows from 0 to max over the first 30% of trajectory (ascent), then constant. */
  function observationBand(line, maxWidthKm) {
    if (!line || line.length < 2) return null;
    const pts = line.length > 2 ? line : interpolateLine(line, 24);
    const N = pts.length;
    const left = [], right = [];
    for (let i = 0; i < N; i++) {
      const [lat, lon] = pts[i];
      const bearing = (i < N - 1)
        ? azimuthBetween(lat, lon, pts[i+1][0], pts[i+1][1])
        : azimuthBetween(pts[i-1][0], pts[i-1][1], lat, lon);
      const f = i / (N - 1);
      /* ramp: 0 → maxWidth over first 30% of trajectory, then constant */
      const width = maxWidthKm * Math.min(1, f / 0.3);
      const halfWidth = width / 2;
      const [lLat, lLon] = rhumbEndpoint(lat, lon, (bearing - 90 + 360) % 360, halfWidth);
      const [rLat, rLon] = rhumbEndpoint(lat, lon, (bearing + 90) % 360, halfWidth);
      left.push([lLat, lLon]);
      right.push([rLat, rLon]);
    }
    return [...left, ...right.reverse()];
  }

  /* ── endpoint along azimuth + distance ── */
  function pointAlongAzimuth(lat, lon, az, distKm) {
    const R = 6371;
    const toRad = (d) => d * Math.PI / 180;
    const toDeg = (r) => r * 180 / Math.PI;
    const phi = toRad(lat), lam = toRad(lon), theta = toRad(az);
    const d = distKm / R;
    const phi2 = Math.asin(Math.sin(phi) * Math.cos(d) + Math.cos(phi) * Math.sin(d) * Math.cos(theta));
    const lam2 = toDeg(lam + Math.atan2(
      Math.sin(theta) * Math.sin(d) * Math.cos(phi),
      Math.cos(d) - Math.sin(phi) * Math.sin(phi2)
    ));
    return [toDeg(phi2), lam2];
  }

  /* ── azimuth from point A to point B ── */
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

  /* ── orbit name → payload extend distance (km) ── */
  function orbitExtendKm(orbitName) {
    const n = (orbitName || '').toLowerCase();
    if (n.includes('polar') || n.includes('sso') || n.includes('ssO')) return 2500;
    if (n.includes('gto') || n.includes('geo') || n.includes('transfer')) return 12000;
    if (n.includes('leo') || n.includes('iss') || n.includes('station')) return 5000;
    if (n.includes('moon') || n.includes('lunar') || n.includes('trans-lunar')) return 400000;
    return 5000;
  }

  const padLat = parseFloat(pad.latitude);
  const padLon = parseFloat(pad.longitude);
  const orbitName = orbit.name || '';
  const az = launchAzimuth(padLat, orbitName);
  const downrange = stageLanding.downrange_distance || 0;

  /* ── primary: booster landing trajectory (only if we have landing data) ──
     straight line on Mercator (rhumb line from launch to landing zone) */
  let trajLine = null, trajEndpoint = null;
  if (!isNaN(padLat) && !isNaN(padLon) && landZone) {
    trajEndpoint = [landZone.lat, landZone.lon];
    trajLine = [[padLat, padLon], trajEndpoint];
  } else if (!isNaN(padLat) && !isNaN(padLon) && downrange > 0) {
    trajEndpoint = rhumbEndpoint(padLat, padLon, az, downrange);
    trajLine = [[padLat, padLon], trajEndpoint];
  }

  /* ── payload orbit direction: always draw, straight line from launch along azimuth ── */
  let orbitLine = null, orbitEndpoint = null;
  if (!isNaN(padLat) && !isNaN(padLon)) {
    const extendKm = orbitExtendKm(orbitName);
    orbitEndpoint = rhumbEndpoint(padLat, padLon, az, extendKm);
    orbitLine = [[padLat, padLon], orbitEndpoint];
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

    ${orbitLine ? `
    <div class="m-section">
      <h3>TRAJECTORY · 轨迹预报</h3>
      <div id="${mapId}" class="m-map"></div>
      <div class="m-trajectory-legend">
        <span class="tleg-item"><span class="tleg-dot launch"></span>Launch · ${escapeHTML(pad.name || "—")}</span>
        ${trajEndpoint ? `<span class="tleg-item"><span class="tleg-dot landing"></span>Booster · ${escapeHTML(stageLandingLoc.name || "—")}${downrange > 0 ? ` · ${downrange} km` : ''}</span>` : ""}
        <span class="tleg-item"><span class="tleg-line orbit"></span>Payload · ${escapeHTML(orbit.name || "—")}</span>
        <span class="tleg-item"><span class="tleg-band"></span>Visible region · 可观察范围</span>
        <span class="tleg-item tleg-az">Azimuth ${Math.round(az)}°</span>
      </div>
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
  if (orbitLine) {
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
      }).addTo(map).bindPopup(`Launch · ${pad.name}`);

      /* booster landing line + marker */
      if (trajLine && trajEndpoint) {
        L.polyline(trajLine, {
          color: 'rgba(255,159,10,0.55)',
          weight: 2.5,
          dashArray: '6 5',
          lineCap: 'round',
        }).addTo(map);
        L.circleMarker(trajEndpoint, {
          radius: 6, color: '#ff9f0a', fillColor: '#ff9f0a',
          fillOpacity: 1, weight: 2,
        }).addTo(map).bindPopup(`Booster · ${escapeHTML(stageLandingLoc.name || 'TBD')}`);
      }

      /* payload orbit line + marker (always draw) */
      if (orbitLine && orbitEndpoint) {
        /* observation band — visibility range based on flight altitude */
        const band = observationBand(orbitLine, 2000);
        if (band) {
          L.polygon(band, {
            color: 'rgba(90,200,250,0.45)',
            fillColor: 'rgba(90,200,250,0.07)',
            fillOpacity: 0.6,
            weight: 0.5,
            smoothFactor: 1.5,
          }).addTo(map).bindPopup('Visible region · 大致可观察范围');
        }

        L.polyline(orbitLine, {
          color: 'rgba(90,200,250,0.6)',
          weight: 2,
          dashArray: '10 4',
          lineCap: 'round',
        }).addTo(map);
        L.circleMarker(orbitEndpoint, {
          radius: 5, color: '#5ac8fa', fillColor: '#5ac8fa',
          fillOpacity: 0.8, weight: 1.5,
        }).addTo(map).bindPopup(`Orbit · ${escapeHTML(orbit.name || '—')}`);
      }

      /* fit bounds to show entire trajectory (orbit always extends furthest) */
      const bounds = L.latLngBounds(orbitLine.map(([la, lo]) => [la, lo]));
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
  el.textContent = "AGE · " + fmtAge(Date.now() - lastFetchedAt.getTime());
  el.classList.add("visible");
}

setInterval(updateLastFetchedLabel, 30 * 1000);

async function handleFetch() {
  if (isLoading) return;
  isLoading = true;
  setBtnState("loading");
  try {
    const r = await fetch(`${API}/refresh`, { method: "POST" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const cache = await r.json();
    applyCache(cache);
    /* Hide any "DB empty" hint once refresh succeeded */
    document.querySelector("#cacheHint")?.classList.remove("visible");
  } catch (e) {
    console.error("fetch failed", e);
    document.querySelector("#upcomingGrid").innerHTML = `
      <div class="empty-state">
        <div class="empty-glyph">⚠</div>
        <div class="empty-msg">请求失败 · FETCH FAILED</div>
        <div class="empty-hint">${escapeHTML(String(e?.message || e))}</div>
      </div>`;
    document.querySelector("#pastGrid").innerHTML = emptyStateHTML(
      "请求失败 · FETCH FAILED", "请稍后重试"
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

document.addEventListener("DOMContentLoaded", async () => {
  showEmptyUpcoming();
  showEmptyPast();
  document.querySelector("#fetchBtn").addEventListener("click", handleFetch);
  startTicker();

  // Try loading cache from server (page refresh / new tab won't lose data)
  await loadFromCache();
});
