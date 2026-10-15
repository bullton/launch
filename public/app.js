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
  document.querySelector("#heroLink").href = launch.url || "#";

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

  node.href = launch.url || "#";
  node.dataset.net = launch.net;
  node.dataset.past = past ? "1" : "0";

  const url = imgOf(launch);
  if (url) imgEl.style.backgroundImage = `url("${url}")`;

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
