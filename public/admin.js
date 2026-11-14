/* =====================================================================
   admin.js — log console client
   ===================================================================== */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);

const state = { kind: "all", onlyFail: false, q: "" };
let autoTimer = 0;
let searchTimer = 0;

const KIND_LABEL = { api: "API", notam: "NOTAM", server: "SVC", admin: "ADM" };

/* ---------- formatting ---------- */
function pad(n) { return String(n).padStart(2, "0"); }

function fmtStamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return sameDay ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function fmtRel(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function fmtDur(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "—";
  const v = Number(ms);
  return v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)}s`;
}

function fmtUptime(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}天 ${h}小时`;
  if (h) return `${h}小时 ${m}分`;
  return `${m}分`;
}

function summarizeMeta(meta) {
  if (!meta || typeof meta !== "object") return "";
  const bits = [];
  if (meta.upstream) {
    const u = meta.upstream;
    const one = (label, v) => v ? `${label} ${v.status ?? "?"} · ${fmtDur(v.ms)}` : null;
    [one("upcoming", u.upcoming), one("past", u.past)].forEach((s) => s && bits.push(s));
  }
  if (meta.retryAfter) bits.push(`Retry-After ${meta.retryAfter}s`);
  if (meta.zones != null) bits.push(`${meta.zones} 个落区`);
  if (meta.azimuth != null) bits.push(`方位角 ${meta.azimuth}°`);
  if (meta.trigger) bits.push(meta.trigger);
  return bits.join(" · ");
}

/* ---------- dom helpers ---------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function banner(msg) {
  const b = $("#admBanner");
  if (!msg) { b.hidden = true; b.textContent = ""; return; }
  b.hidden = false;
  b.textContent = msg;
}

/* ---------- data ---------- */
async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}${t ? ` · ${t.slice(0, 160)}` : ""}`);
  }
  return r.json();
}

function logQuery() {
  const p = new URLSearchParams({ limit: "300" });
  if (state.kind !== "all") p.set("kind", state.kind);
  if (state.onlyFail) p.set("level", "error");
  if (state.q) p.set("q", state.q);
  return `/api/admin/logs?${p.toString()}`;
}

async function loadAll() {
  const [stats, logs, notam] = await Promise.all([
    getJson("/api/admin/stats"),
    getJson(logQuery()),
    getJson("/api/admin/notam?limit=40"),
  ]);
  banner("");
  renderStats(stats, logs.entries || []);
  renderLogs(logs.entries || []);
  renderNotam(notam.results || []);
}

/* ---------- render: stats ---------- */
function statTile(k, valueNode, extraClass) {
  const card = el("div", `adm-stat${extraClass ? ` ${extraClass}` : ""}`);
  card.appendChild(el("div", "k", k));
  const v = el("div", "v");
  v.appendChild(valueNode);
  card.appendChild(v);
  return card;
}

function renderStats(s, entries) {
  const guard = $("#admGuard");
  guard.textContent = s.guard === "token" ? "TOKEN 访问" : "内网访问";

  const lastFetch = s.lastFetch || null;
  const wrap = $("#admStats");
  wrap.innerHTML = "";

  const dbVal = el("span");
  dbVal.appendChild(el("b", null, String(s.totalRows ?? 0)));
  dbVal.appendChild(document.createTextNode("条"));
  dbVal.appendChild(el("span", "sub", `即将 ${s.upcomingCount ?? 0} · 历史 ${s.pastCount ?? 0} · NOTAM ${s.notamRows ?? 0}`));
  wrap.appendChild(statTile("数据库 · DB", dbVal));

  const fetchVal = el("span");
  if (s.lastRefresh) {
    fetchVal.appendChild(document.createTextNode(fmtStamp(s.lastRefresh)));
    fetchVal.appendChild(el("span", "sub", `${fmtRel(s.lastRefresh)}${lastFetch?.durationMs != null ? ` · ${fmtDur(lastFetch.durationMs)}` : ""}`));
  } else {
    fetchVal.textContent = "尚未获取";
  }
  wrap.appendChild(statTile("最近获取 · LAST FETCH", fetchVal));

  const upVal = el("span");
  let upClass = "warn";
  if (lastFetch) {
    upClass = lastFetch.ok ? "ok" : "err";
    upVal.appendChild(el("b", null, lastFetch.ok ? "正常" : "异常"));
    upVal.appendChild(el("span", "sub",
      `${lastFetch.status != null ? `HTTP ${lastFetch.status} · ` : ""}${fmtStamp(lastFetch.at)}`));
  } else {
    upVal.textContent = "暂无记录";
  }
  wrap.appendChild(statTile("上游状态 · UPSTREAM", upVal, upClass));

  const procVal = el("span");
  procVal.appendChild(el("b", null, fmtUptime(s.uptimeSec)));
  procVal.appendChild(el("span", "sub", `PID ${s.pid ?? "—"} · Node ${s.node ?? "—"}`));
  wrap.appendChild(statTile("服务进程 · PROCESS", procVal));

  const buildVal = el("span");
  buildVal.appendChild(document.createTextNode(`v${s.version ?? "—"}`));
  buildVal.appendChild(el("span", "sub", `commit ${s.commit ?? "—"} · 启动 ${fmtStamp(s.startedAt)}`));
  wrap.appendChild(statTile("版本 · BUILD", buildVal));
}

/* ---------- render: logs ---------- */
function renderLogs(entries) {
  const body = $("#admLogBody");
  $("#admLogCount").textContent = entries.length ? `${entries.length} 条` : "";
  body.innerHTML = "";
  if (!entries.length) {
    const tr = el("tr");
    const td = el("td", "adm-empty", "没有符合条件的日志");
    td.colSpan = 5;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const e of entries) {
    const tr = el("tr", `lv-${e.level || "info"}`);

    tr.appendChild(el("td", "c-time", fmtStamp(e.ts)));

    const kd = el("td", "c-kind");
    kd.appendChild(el("span", `adm-kind ${e.kind || ""}`, KIND_LABEL[e.kind] || (e.kind || "—").toUpperCase()));
    tr.appendChild(kd);

    const md = el("td");
    const msg = el("div", "adm-msg");
    msg.appendChild(el("span", `adm-level ${e.level || "info"}`));
    msg.appendChild(document.createTextNode(e.msg || ""));
    const metaText = summarizeMeta(e.meta);
    if (metaText) msg.appendChild(el("span", "meta", metaText));
    md.appendChild(msg);
    tr.appendChild(md);

    tr.appendChild(el("td", "c-dur", fmtDur(e.durationMs)));

    const sd = el("td", "c-status");
    const level = e.level || "info";
    const cls = level === "error" ? "fail" : level === "warn" ? "warn" : "ok";
    const label = e.status != null ? String(e.status) : (level === "error" ? "FAIL" : level === "warn" ? "WARN" : "OK");
    sd.appendChild(el("span", `adm-badge ${cls}`, label));
    tr.appendChild(sd);

    body.appendChild(tr);
  }
}

/* ---------- render: notam ---------- */
function renderNotam(rows) {
  const body = $("#admNotamBody");
  $("#admNotamCount").textContent = rows.length ? `${rows.length} 条` : "";
  body.innerHTML = "";
  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", "adm-empty", "暂无 NOTAM 记录");
    td.colSpan = 6;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const tr = el("tr");
    tr.appendChild(el("td", "c-time", fmtStamp(r.fetched_at)));
    tr.appendChild(el("td", null, r.launch_name || r.launch_id || "—"));

    const sd = el("td", "c-status");
    const cls = r.found ? (r.permanent ? "ok" : "warn") : "fail";
    const label = r.found ? (r.permanent ? "AZ 已归档" : "有落区") : "未命中";
    sd.appendChild(el("span", `adm-badge ${cls}`, label));
    tr.appendChild(sd);

    tr.appendChild(el("td", "c-num", r.azimuth_deg != null ? `${r.azimuth_deg}°` : "—"));
    tr.appendChild(el("td", "c-num", r.implied_inclination_deg != null ? `${r.implied_inclination_deg}°` : "—"));
    tr.appendChild(el("td", "c-num", String(r.zones ?? 0)));
    body.appendChild(tr);
  }
}

/* ---------- refresh loop ---------- */
function scheduleAuto() {
  clearInterval(autoTimer);
  if ($("#autoRefresh").checked) {
    autoTimer = setInterval(() => {
      loadAll().catch((e) => banner(`自动刷新失败：${e.message}`));
    }, 5000);
  }
}

async function manualRefresh() {
  const btn = $("#refreshBtn");
  btn.disabled = true;
  btn.textContent = "刷新中…";
  try {
    await loadAll();
  } catch (e) {
    banner(`加载失败：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "刷新";
  }
}

/* ---------- wiring ---------- */
document.addEventListener("DOMContentLoaded", () => {
  $("#refreshBtn").addEventListener("click", manualRefresh);
  $("#autoRefresh").addEventListener("change", scheduleAuto);

  document.querySelectorAll(".adm-chips button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".adm-chips button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      state.kind = b.dataset.kind || "all";
      loadAll().catch((e) => banner(`加载失败：${e.message}`));
    });
  });

  $("#onlyFail").addEventListener("change", (e) => {
    state.onlyFail = e.target.checked;
    loadAll().catch((err) => banner(`加载失败：${err.message}`));
  });

  $("#logSearch").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = v;
      loadAll().catch((err) => banner(`加载失败：${err.message}`));
    }, 250);
  });

  const clock = () => {
    const d = new Date();
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    $("#admClock").textContent = `LOCAL ${t} · 5s 自动刷新`;
  };
  clock();
  setInterval(clock, 1000);

  manualRefresh();
  scheduleAuto();
});
