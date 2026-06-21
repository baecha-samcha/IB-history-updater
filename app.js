/* ===========================================================
   IB History Timeline — app.js
   Part 1/5: API + 상수 + 유틸 + 캐시 + 데이터 모델
   =========================================================== */

/* ---------- Server API ---------- */
const SESSION_KEY = "ibhistory.session.v1";
const SHARED_CACHE_USER = "__shared__";
const PENDING_OPERATIONS_KEY = "ibhistory.pending-operations.v1";

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (State.session?.token) headers.Authorization = `Bearer ${State.session.token}`;
  const response = await fetch(`/api${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

/* ---------- 1. 상수 & 유틸 ---------- */
const YEAR_MIN = 1850;
const YEAR_MAX = 2000;
const CACHE_KEY = "ibhistory.cache.v2";

const PX_PER_MONTH = { 12: 3, 6: 6, 3: 12, 1: 36, 0.5: 72, 0.333: 108, 0.1: 360, 0.033: 1080 };

const RULER_H    = 46;
const PERIOD_H   = 24;
const EVENT_ROW_H = 34;
const LEFT_PAD   = 40;
const RIGHT_PAD  = 40;
const TOP_PAD    = 10;

const $   = (sel, root = document) => root.querySelector(sel);
const $$  = (sel, root = document) => [...root.querySelectorAll(sel)];
const SVG_NS = "http://www.w3.org/2000/svg";

const el = (tag, attrs = {}, children = []) => {
  const isSvg = ["svg","g","rect","line","text","path","circle","defs","marker","pattern"].includes(tag);
  const node = isSvg
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") node.setAttribute("class", v);
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
};

function parseYMD(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return { y, m: m || 1, d: d || 1 };
}
function normalizeDate(value, fallback = "") {
  if (!value) return fallback;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : fallback;
}
function dateToUtc(value) {
  const p = parseYMD(normalizeDate(value));
  return p ? Date.UTC(p.y, p.m - 1, p.d) : NaN;
}
function shiftDate(value, days) {
  return new Date(dateToUtc(value) + days * 86400000).toISOString().slice(0, 10);
}
function getDataTimelineRange() {
  const dates = [
    ...State.data.events.map(event => event.date),
    ...State.data.periods.flatMap(period => [period.startDate, period.endDate])
  ].map(date => normalizeDate(date)).filter(Boolean).sort();
  if (!dates.length) return { start: "1900-01-01", end: "2000-12-31" };
  return { start: shiftDate(dates[0], -7), end: shiftDate(dates[dates.length - 1], 7) };
}
function clampYear(y) { return Math.max(YEAR_MIN, Math.min(YEAR_MAX, y | 0)); }
function uid() { return Math.random().toString(36).slice(2, 10); }
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const COLOR_PRESETS = [
  "#ef4444","#f97316","#eab308","#22c55e","#3b82f6",
  "#8b5cf6","#ec4899","#14b8a6","#6366f1","#0ea5e9"
];
function randomColor() {
  return COLOR_PRESETS[Math.floor(Math.random() * COLOR_PRESETS.length)];
}

/* ---------- 2. 로컬 캐시 ---------- */
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveCache(cache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}
function emptyData() {
  return { colorTags: [], periods: [], events: [], flows: [] };
}

/* ---------- 3. 데이터 마이그레이션 ---------- */
function migrateData(data) {
  data.colorTags = data.colorTags || [];
  data.periods   = data.periods   || [];
  data.events    = data.events    || [];
  data.flows     = data.flows     || [];

  const byKey = new Map();
  data.colorTags.forEach(t => byKey.set(`${t.name}|${t.color}`, t.id));

  function getOrCreate(name, color) {
    const key = `${name}|${color}`;
    if (byKey.has(key)) return byKey.get(key);
    const id = uid();
    data.colorTags.push({ id, name, color });
    byKey.set(key, id);
    return id;
  }

  // periods: 구형 color+tags → colorTagIds
  data.periods.forEach(p => {
    if (!p.startDate && p.startYear != null) {
      p.startDate = `${p.startYear}-01-01`;
      p.endDate   = `${p.endYear || p.startYear}-12-31`;
    }
    if (!p.colorTagIds) {
      const tagArr = p.tags || (p.colorTag ? [p.colorTag] : []);
      const color  = p.color || "#94a3b8";
      p.colorTagIds = tagArr.map(t => getOrCreate(t, color));
    }
    p.startDate = normalizeDate(p.startDate, `${YEAR_MIN}-01-01`);
    p.endDate = normalizeDate(p.endDate, p.startDate);
  });

  // events: colorTagIds 없으면 빈 배열
  data.events.forEach(e => {
    e.colorTagIds = e.colorTagIds || [];
    e.date = normalizeDate(e.date, `${YEAR_MIN}-01-01`);
  });

  // flows: 구형 color+tags+eventIds → colorTagIds+items
  data.flows.forEach(f => {
    if (!f.items) f.items = (f.eventIds || []).map(id => ({ type: "event", id }));
    if (!f.colorTagIds) {
      const tagArr = f.tags || (f.colorTag ? [f.colorTag] : []);
      const color  = f.color || "#ef4444";
      f.colorTagIds = tagArr.map(t => getOrCreate(t, color));
    }
  });
}

/* ===========================================================
   Part 2/5: 전역 상태 + API 인증 + 동기화
   =========================================================== */

/* ---------- 전역 상태 ---------- */
const State = {
  session: null,
  user: null,      // username 문자열
  data: emptyData(),
  version: -1,
  zoom: 6,
  timelineRange: { start: "1900-01-01", end: "2000-12-31" },
};

/* ---------- 동기화 상태 UI ---------- */
function updateSyncStatus(s) {
  const el2 = $("#sync-status");
  if (!el2) return;
  const map = { syncing: "⏳ 동기화 중", synced: "☁️ 동기화됨", offline: "📴 오프라인", error: "⚠️ 오류" };
  el2.textContent = map[s] || "";
}

/* ---------- API 인증 ---------- */
function showAuthMsg(msg, ok = false) {
  const n = $("#auth-msg");
  n.textContent = msg || "";
  n.style.color = ok ? "#0a7" : "#b33";
}

async function handleRegister() {
  const u = $("#auth-username").value.trim();
  const p = $("#auth-password").value;
  if (!u || !p) return showAuthMsg("아이디/비밀번호를 입력하세요");
  showAuthMsg("가입 중...");
  try {
    await api("/auth/register", { method: "POST", body: JSON.stringify({ username: u, password: p }) });
    showAuthMsg("가입 완료. 로그인 해주세요.", true);
  } catch (error) { showAuthMsg(error.message); }
}

async function handleLogin(e) {
  e && e.preventDefault();
  const u = $("#auth-username").value.trim();
  const p = $("#auth-password").value;
  if (!u || !p) return showAuthMsg("아이디/비밀번호를 입력하세요");
  showAuthMsg("로그인 중...");
  try {
    const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ username: u, password: p }) });
    State.session = { token: data.token, username: data.username };
    State.user = data.username;
    localStorage.setItem(SESSION_KEY, JSON.stringify(State.session));
    await enterApp();
  } catch (error) { showAuthMsg(error.message); }
}

async function handleLogout() {
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  localStorage.removeItem(SESSION_KEY);
  State.session = null;
  State.user = null;
  State.data = emptyData();
  $("#app-view").classList.add("hidden");
  $("#auth-view").classList.remove("hidden");
  $("#auth-password").value = "";
  showAuthMsg("");
}

async function enterApp() {
  $("#user-badge").textContent = State.user;
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  if (navigator.onLine) {
    updateSyncStatus("syncing");
    try {
      await loadFromDatabase();
      const cache = loadCache();
      cache[SHARED_CACHE_USER] = State.data;
      saveCache(cache);
      updateSyncStatus("synced");
    } catch (err) {
      console.warn("Database load failed, using cache:", err);
      const cache = loadCache();
      State.data = cache[SHARED_CACHE_USER] || emptyData();
      migrateData(State.data);
      updateSyncStatus("offline");
    }
  } else {
    const cache = loadCache();
    State.data = cache[SHARED_CACHE_USER] || emptyData();
    migrateData(State.data);
    updateSyncStatus("offline");
  }
  render();
}

/* ---------- PostgreSQL 데이터 불러오기 ---------- */
async function loadFromDatabase() {
  const response = await api("/data");
  State.data = response.data;
  State.version = response.version;
  migrateData(State.data);
}
/* ---------- PostgreSQL 동기화 ---------- */
let _pendingOperations = (() => {
  try { return JSON.parse(localStorage.getItem(PENDING_OPERATIONS_KEY)) || []; }
  catch { return []; }
})();
let _syncInFlight = false;

function savePendingOperations() {
  localStorage.setItem(PENDING_OPERATIONS_KEY, JSON.stringify(_pendingOperations));
}

async function syncToDatabase() {
  if (!navigator.onLine || !State.session || !_pendingOperations.length) return false;
  const operations = _pendingOperations;
  _pendingOperations = [];
  savePendingOperations();
  _syncInFlight = true;
  try {
    const response = await api("/data/batch", { method: "POST", body: JSON.stringify({ operations }) });
    State.version = response.version;
    if (!_pendingOperations.length) {
      await loadFromDatabase();
      const cache = loadCache();
      cache[SHARED_CACHE_USER] = State.data;
      saveCache(cache);
      render();
    }
  } catch (error) {
    _pendingOperations = [...operations, ..._pendingOperations];
    savePendingOperations();
    throw error;
  } finally {
    _syncInFlight = false;
  }
  return true;
}

let _syncTimer = null;
function schedulePushSync() {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    _syncTimer = null;
    updateSyncStatus("syncing");
    try {
      const ok = await syncToDatabase();
      updateSyncStatus(ok ? "synced" : "offline");
    } catch (err) {
      console.error("Sync error:", err);
      updateSyncStatus("error");
    }
  }, 800);
}

function persistUserData(operations = []) {
  if (!State.user) return;
  const cache = loadCache();
  cache[SHARED_CACHE_USER] = State.data;
  saveCache(cache);
  operations.forEach(operation => {
    const id = operation.id || operation.item?.id;
    _pendingOperations = _pendingOperations.filter(current =>
      current.entity !== operation.entity || (current.id || current.item?.id) !== id
    );
    _pendingOperations.push(operation);
  });
  savePendingOperations();
  schedulePushSync();
}

function colorTagOperations() {
  return State.data.colorTags.map(item => ({ action: "upsert", entity: "colorTag", item }));
}

async function pollDatabase() {
  if (!navigator.onLine || !State.session || _syncTimer || _syncInFlight || _pendingOperations.length) return;
  try {
    const response = await api(`/data?version=${State.version}`);
    if (response.unchanged) return;
    State.data = response.data;
    State.version = response.version;
    migrateData(State.data);
    const cache = loadCache();
    cache[SHARED_CACHE_USER] = State.data;
    saveCache(cache);
    render();
    updateSyncStatus("synced");
  } catch (error) {
    console.warn("Workspace refresh failed:", error);
  }
}

/* ===========================================================
   Part 3/5: 모달 + 폼 헬퍼 + colorTagSelector + 좌표/렌더
   =========================================================== */

/* ---------- 모달 ---------- */
function openModal({ title, body, footer }) {
  $("#modal-title").textContent = title || "";
  const bodyEl = $("#modal-body"); bodyEl.innerHTML = "";
  if (typeof body === "string") bodyEl.innerHTML = body;
  else if (body instanceof Node) bodyEl.appendChild(body);
  const footEl = $("#modal-foot"); footEl.innerHTML = "";
  (footer || []).forEach(b => footEl.appendChild(b));
  $("#modal-root").classList.remove("hidden");
}
function closeModal() { $("#modal-root").classList.add("hidden"); }
function mkBtn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = cls; b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function readImageAsDataURL(file, maxW = 800) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function field(label, inputNode) {
  const d = document.createElement("div");
  d.className = "field";
  const l = document.createElement("label");
  l.textContent = label;
  d.appendChild(l); d.appendChild(inputNode);
  return d;
}
function row(...fields) {
  const r = document.createElement("div");
  r.className = "field-row";
  fields.forEach(f => r.appendChild(f));
  return r;
}
function input(type, value = "", attrs = {}) {
  const i = document.createElement("input");
  i.type = type; i.value = value ?? "";
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  return i;
}
function textarea(value = "") {
  const t = document.createElement("textarea");
  t.value = value || "";
  return t;
}

/* ---------- colorTagSelector ---------- */
// selectedIdsInit: 초기 선택된 id 배열
// onChange(selectedIds): 선택 변경 시 콜백
function colorTagSelector(selectedIdsInit, onChange) {
  let sel = [...selectedIdsInit];
  const wrap = document.createElement("div");
  wrap.className = "tag-selector";
  const chips = document.createElement("div");
  chips.className = "tag-chips";
  wrap.appendChild(chips);

  function redraw() {
    chips.innerHTML = "";
    State.data.colorTags.forEach(ct => {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "tag-chip color-tag-chip" + (sel.includes(ct.id) ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "color-dot";
      dot.style.background = ct.color;
      c.appendChild(dot);
      c.appendChild(document.createTextNode(ct.name));
      c.onclick = () => {
        sel = sel.includes(ct.id) ? sel.filter(s => s !== ct.id) : [...sel, ct.id];
        onChange(sel); redraw();
      };
      chips.appendChild(c);
    });

    const addRow = document.createElement("div");
    addRow.className = "tag-add-row color-tag-add-row";
    const colorInp = input("color", randomColor());
    const nameInp  = input("text", "", { placeholder: "새 레이블 이름..." });
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = "+";
    btn.onclick = () => {
      const name = nameInp.value.trim();
      if (!name) return;
      if (State.data.colorTags.some(t => t.name === name)) {
        alert("이미 존재하는 이름입니다"); return;
      }
      const newCt = { id: uid(), name, color: colorInp.value };
      State.data.colorTags.push(newCt);
      sel = [...sel, newCt.id];
      nameInp.value = "";
      onChange(sel); redraw();
    };
    nameInp.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); btn.click(); }
    });
    addRow.appendChild(colorInp);
    addRow.appendChild(nameInp);
    addRow.appendChild(btn);
    chips.appendChild(addRow);
  }
  redraw();
  return wrap;
}

/* ---------- 색상 헬퍼 ---------- */
function getItemColor(item, type) {
  const ids = item.colorTagIds || [];
  if (ids.length) {
    const ct = State.data.colorTags.find(t => t.id === ids[0]);
    if (ct) return ct.color;
  }
  return type === "event" ? "#1d4ed8" : type === "flow" ? "#ef4444" : "#94a3b8";
}

function getItemColors(item, type) {
  const colors = (item.colorTagIds || [])
    .map(id => State.data.colorTags.find(t => t.id === id)?.color)
    .filter(Boolean);
  return colors.length ? colors : [getItemColor(item, type)];
}
function getItemColorBackground(item, type) {
  const colors = getItemColors(item, type);
  if (colors.length === 1) return colors[0];
  const stops = colors.flatMap((color, index) => {
    const start = index * 100 / colors.length;
    const end = (index + 1) * 100 / colors.length;
    return [`${color} ${start}%`, `${color} ${end}%`];
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/* ---------- 좌표 & 레이아웃 ---------- */
function getPxPerMonth(zoom = State.zoom) { return PX_PER_MONTH[zoom] || 6; }
function xFromDate(s, pxm) {
  const value = dateToUtc(s);
  const start = dateToUtc(State.timelineRange.start);
  if (!Number.isFinite(value) || !Number.isFinite(start)) return LEFT_PAD;
  return LEFT_PAD + ((value - start) / 86400000) * (pxm / 30.4375);
}
function xFromYear(y, pxm) { return xFromDate(`${y}-01-01`, pxm); }
function totalWidth(pxm = getPxPerMonth()) {
  const days = Math.max(1, (dateToUtc(State.timelineRange.end) - dateToUtc(State.timelineRange.start)) / 86400000);
  return LEFT_PAD + days * (pxm / 30.4375) + RIGHT_PAD;
}

function assignRows(segments) {
  const sorted = [...segments].sort((a, b) => a.x1 - b.x1);
  const rows = [];
  const out = {};
  for (const s of sorted) {
    let r = rows.findIndex(end => end <= s.x1 - 4);
    if (r < 0) { rows.push(s.x2); r = rows.length - 1; }
    else rows[r] = s.x2;
    out[s.id] = r;
  }
  return { rowMap: out, rowCount: Math.max(1, rows.length) };
}
function estimateEventWidth(ev) {
  return Math.max(60, ((ev.title || "") + "  " + (ev.date || "")).length * 7 + 20);
}
function periodBounds(p, pxm) {
  const x1 = xFromDate(p.startDate, pxm);
  const x2 = xFromDate(p.endDate, pxm);
  return { x1: Math.min(x1, x2), x2: Math.max(x1, x2) };
}
function estimatePeriodLabelWidth(p) {
  return Math.max(80, periodLabelText(p).length * 7 + 16);
}

/* ---------- 렌더: 눈금자 ---------- */
function renderRuler(svg, pxm, height, opts = {}) {
  const unit = opts.unit || State.zoom;
  const g = el("g", { class: "ruler" });
  g.appendChild(el("rect", { x: 0, y: 0, width: totalWidth(pxm), height: RULER_H, fill: "#f8fafc" }));
  const startYear = parseYMD(State.timelineRange.start).y;
  const endYear = parseYMD(State.timelineRange.end).y;

  if (unit < 1) {
    const dayStep = unit === 0.5 ? 15 : unit === 0.333 ? 10 : unit === 0.1 ? 3 : 1;
    let defs = svg.querySelector("defs");
    if (!defs) { defs = el("defs"); svg.appendChild(defs); }
    const patternId = `day-grid-${String(unit).replace(".", "-")}`;
    const spacing = dayStep * pxm / 30.4375;
    const pattern = el("pattern", { id: patternId, width: spacing, height: 1, patternUnits: "userSpaceOnUse" });
    pattern.appendChild(el("line", { x1: 0, y1: 0, x2: 0, y2: 1, class: "grid-line" }));
    defs.appendChild(pattern);
    g.appendChild(el("rect", { x: LEFT_PAD, y: RULER_H - 8, width: totalWidth(pxm) - LEFT_PAD - RIGHT_PAD, height: height - RULER_H + 8, fill: `url(#${patternId})` }));
  }

  for (let y = startYear; y <= endYear; y++) {
    const x = xFromYear(y, pxm);
    g.appendChild(el("line", { x1: x, y1: 0, x2: x, y2: height, class: "grid-line year" }));
    g.appendChild(el("text", { x: x + 2, y: 14, class: "tick-label year", text: String(y) }));
    if (unit >= 1 && unit < 12) {
      for (let m = unit; m < 12; m += unit) {
        const xm = xFromDate(`${y}-${String(m + 1).padStart(2, "0")}-01`, pxm);
        g.appendChild(el("line", {
          x1: xm, y1: RULER_H - 10, x2: xm, y2: height,
          class: m % 6 === 0 ? "grid-line major" : "grid-line"
        }));
        if (pxm * unit >= 28)
          g.appendChild(el("text", { x: xm + 2, y: RULER_H - 2, class: "tick-label", text: (m + 1) + "월" }));
      }
    } else if (unit < 1) {
      for (let month = 1; month <= 12; month++) {
        const monthX = xFromDate(`${y}-${String(month).padStart(2, "0")}-01`, pxm);
        g.appendChild(el("line", { x1: monthX, y1: RULER_H - 14, x2: monthX, y2: height, class: "grid-line major" }));
        g.appendChild(el("text", { x: monthX + 2, y: RULER_H - 3, class: "tick-label", text: `${month}월` }));
      }
    }
  }
  const xEnd = xFromDate(State.timelineRange.end, pxm);
  g.appendChild(el("line", { x1: xEnd, y1: 0, x2: xEnd, y2: height, class: "grid-line year" }));
  svg.appendChild(g);
}

/* ---------- 렌더: 기간 ---------- */
function periodLabelText(p) {
  const s = (p.startDate || "").slice(0, 10);
  const e = (p.endDate   || "").slice(0, 10);
  return `${p.title || "기간"} (${s} ~ ${e})`;
}
function renderPeriods(svg, pxm, yStart, layout = null) {
  const periods = State.data.periods;
  const segs = periods.map(p => { const b = periodBounds(p, pxm); return { id: p.id, x1: b.x1, x2: b.x2 }; });
  const { rowMap, rowCount } = layout || assignRows(segs);
  const g = el("g", { class: "periods" });
  const positions = {};
  periods.forEach(p => {
    const r = rowMap[p.id] || 0;
    const { x1, x2 } = periodBounds(p, pxm);
    const y = yStart + r * EVENT_ROW_H;
    const w = Math.max(8, x2 - x1);
    positions[p.id] = { x: x1 + w / 2, y };
    const colors = getItemColors(p, "period");
    colors.forEach((color, index) => {
      const stripeH = PERIOD_H / colors.length;
      const rect = el("rect", {
        x: x1, y: y + index * stripeH, width: w, height: stripeH + 0.5,
        rx: colors.length === 1 ? 4 : 0, fill: color,
        "fill-opacity": "0.82", stroke: "#1f2937", "stroke-opacity": "0.18",
        class: "period-rect"
      });
      rect.addEventListener("click", () => openPeriodDetail(p));
      rect.addEventListener("contextmenu", e => { e.preventDefault(); openPeriodEdit(p); });
      g.appendChild(rect);
    });
    g.appendChild(el("text", { x: x1 + 6, y: y + PERIOD_H - 7, class: "period-label", text: periodLabelText(p) }));
  });
  svg.appendChild(g);
  return { yEnd: yStart + rowCount * EVENT_ROW_H, positions };
}

/* ---------- 렌더: 포인트 ---------- */
function circleSlicePath(cx, cy, radius, startAngle, endAngle) {
  const start = { x: cx + radius * Math.cos(startAngle), y: cy + radius * Math.sin(startAngle) };
  const end = { x: cx + radius * Math.cos(endAngle), y: cy + radius * Math.sin(endAngle) };
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}
function renderEvents(svg, pxm, yStart, layout = null) {
  const evs = State.data.events;
  const segs = evs.map(e => {
    const x = xFromDate(e.date, pxm);
    return { id: e.id, x1: x, x2: x + estimateEventWidth(e) };
  });
  const { rowMap, rowCount } = layout || assignRows(segs);
  const g = el("g", { class: "events" });
  const positions = {};
  evs.forEach(e => {
    const r = rowMap[e.id] || 0;
    const x = xFromDate(e.date, pxm);
    const y = yStart + r * EVENT_ROW_H + 14;
    positions[e.id] = { x, y };
    g.appendChild(el("line", { x1: x, y1: yStart - 4, x2: x, y2: y, stroke: "#94a3b8", "stroke-width": 1, "stroke-dasharray": "2 3" }));
    const colors = getItemColors(e, "event");
    const markerParts = colors.length === 1
      ? [el("circle", { cx: x, cy: y, r: 5, fill: colors[0], class: "event-marker" })]
      : colors.map((color, index) => el("path", {
          d: circleSlicePath(x, y, 5, -Math.PI / 2 + index * Math.PI * 2 / colors.length, -Math.PI / 2 + (index + 1) * Math.PI * 2 / colors.length),
          fill: color, class: "event-marker"
        }));
    markerParts.forEach(marker => {
      marker.addEventListener("click", () => openEventDetail(e));
      marker.addEventListener("contextmenu", ev => { ev.preventDefault(); openEventEdit(e); });
      g.appendChild(marker);
    });
    g.appendChild(el("circle", { cx: x, cy: y, r: 5, fill: "none", stroke: "#fff", "stroke-width": 1.5, "pointer-events": "none" }));
    const t = el("text", { x: x + 8, y: y + 4, class: "event-label", text: e.title || "(제목 없음)", style: "cursor:pointer" });
    t.addEventListener("click", () => openEventDetail(e));
    t.addEventListener("contextmenu", ev => { ev.preventDefault(); openEventEdit(e); });
    g.appendChild(t);
  });
  svg.appendChild(g);
  return { yEnd: yStart + rowCount * EVENT_ROW_H, positions };
}

/* ---------- 렌더: 흐름 ---------- */
function ensureArrowDefs(svg, color, id) {
  let defs = svg.querySelector("defs");
  if (!defs) { defs = el("defs"); svg.appendChild(defs); }
  if (svg.querySelector(`#${id}`)) return;
  const marker = el("marker", { id, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
  marker.appendChild(el("path", { d: "M0,0 L10,5 L0,10 Z", fill: color }));
  defs.appendChild(marker);
}
function flowItems(f) {
  if (f.items) return f.items;
  return (f.eventIds || []).map(id => ({ type: "event", id }));
}
function renderFlows(svg, positions) {
  const g = el("g", { class: "flows" });
  State.data.flows.forEach(f => {
    const pts = flowItems(f).map(it => positions[`${it.type}:${it.id}`]).filter(Boolean);
    if (pts.length < 2) return;
    const colors = getItemColors(f, "flow");
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x;
      const midY = Math.min(a.y, b.y) - 40 - Math.min(60, Math.abs(dx) * 0.15);
      colors.forEach((color, colorIndex) => {
        const offset = (colorIndex - (colors.length - 1) / 2) * 4;
        const markerId = `arr_${f.id}_${colorIndex}`;
        ensureArrowDefs(svg, color, markerId);
        const d = `M ${a.x} ${a.y - 6 + offset} Q ${(a.x + b.x) / 2} ${midY + offset} ${b.x} ${b.y - 6 + offset}`;
        const path = el("path", { d, class: "flow-path", fill: "none", stroke: color, "stroke-width": 2, "stroke-linecap": "round", "marker-end": `url(#${markerId})`, "data-flow": f.id });
        path.addEventListener("mouseenter", e => showTooltip(e, f));
        path.addEventListener("mousemove", moveTooltip);
        path.addEventListener("mouseleave", hideTooltip);
        path.addEventListener("click", () => openFlowEdit(f));
        g.appendChild(path);
      });
      if (i === 0) {
        const title = el("text", { x: (a.x + b.x) / 2, y: midY - 7, class: "flow-label", "text-anchor": "middle", text: f.title || "(무제 흐름)" });
        title.addEventListener("click", () => openFlowEdit(f));
        g.appendChild(title);
      }
    }
  });
  svg.appendChild(g);
}

function showTooltip(e, flow) {
  const t = $("#tooltip");
  t.innerHTML = `<b>${escapeHtml(flow.title || "(무제 흐름)")}</b>${flow.description ? escapeHtml(flow.description) : ""}`;
  t.classList.remove("hidden");
  moveTooltip(e);
}
function moveTooltip(e) {
  const t = $("#tooltip");
  t.style.left = (e.clientX + 14) + "px";
  t.style.top  = (e.clientY + 14) + "px";
}
function hideTooltip() { $("#tooltip").classList.add("hidden"); }

/* ---------- 전체 render ---------- */
function combinePositions(periodPos, eventPos) {
  const out = {};
  for (const [id, p] of Object.entries(periodPos)) out["period:" + id] = p;
  for (const [id, p] of Object.entries(eventPos))  out["event:"  + id] = p;
  return out;
}
function getTimelineLayout(pxm) {
  const segments = [
    ...State.data.periods.map(p => {
      const b = periodBounds(p, pxm);
      return { id: `period:${p.id}`, x1: b.x1, x2: Math.max(b.x2, b.x1 + estimatePeriodLabelWidth(p)) };
    }),
    ...State.data.events.map(e => {
      const x = xFromDate(e.date, pxm);
      return { id: `event:${e.id}`, x1: x, x2: x + estimateEventWidth(e) };
    })
  ];
  const combined = assignRows(segments);
  const periodMap = {}, eventMap = {};
  State.data.periods.forEach(p => { periodMap[p.id] = combined.rowMap[`period:${p.id}`] || 0; });
  State.data.events.forEach(e => { eventMap[e.id] = combined.rowMap[`event:${e.id}`] || 0; });
  return {
    rowCount: combined.rowCount,
    periodLayout: { rowMap: periodMap, rowCount: combined.rowCount },
    eventLayout: { rowMap: eventMap, rowCount: combined.rowCount }
  };
}
function render() {
  const svg = $("#timeline-svg");
  svg.innerHTML = "";
  State.timelineRange = getDataTimelineRange();
  const pxm = getPxPerMonth();
  const width = totalWidth(pxm);
  const layout = getTimelineLayout(pxm);
  const height = RULER_H + TOP_PAD + layout.rowCount * EVENT_ROW_H + 36;
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  renderRuler(svg, pxm, height);
  const pY = RULER_H + TOP_PAD;
  const { positions: periodPos } = renderPeriods(svg, pxm, pY, layout.periodLayout);
  const { positions: eventPos } = renderEvents(svg, pxm, pY, layout.eventLayout);
  renderFlows(svg, combinePositions(periodPos, eventPos));
  renderLegend();
}

/* ===========================================================
   Part 4/5: 폼 다이얼로그 + 상세보기 + 목록
   =========================================================== */

/* ---------- 태그 칩 렌더 (상세보기용) ---------- */
function renderColorTagChips(colorTagIds) {
  const row2 = document.createElement("div");
  row2.className = "detail-tags";
  (colorTagIds || []).forEach(id => {
    const ct = State.data.colorTags.find(t => t.id === id);
    if (!ct) return;
    const chip = document.createElement("span");
    chip.className = "detail-tag";
    const dot = document.createElement("span");
    dot.className = "color-dot"; dot.style.background = ct.color;
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(ct.name));
    row2.appendChild(chip);
  });
  return row2;
}

/* ---------- 기간 상세 ---------- */
function openPeriodDetail(p) {
  const body = document.createElement("div");
  const hero = document.createElement("div"); hero.className = "detail-hero";
  const title = document.createElement("h3"); title.textContent = p.title || "기간";
  const date  = document.createElement("div"); date.className = "detail-date";
  date.textContent = `${p.startDate || ""} ~ ${p.endDate || ""}`;
  hero.appendChild(title); hero.appendChild(date);
  if (p.colorTagIds && p.colorTagIds.length) hero.appendChild(renderColorTagChips(p.colorTagIds));
  body.appendChild(hero);
  const sec = (k, v) => {
    if (!v) return;
    const s = document.createElement("div"); s.className = "detail-section";
    s.innerHTML = `<div class="k">${k}</div><div class="v"></div>`;
    s.querySelector(".v").textContent = v; body.appendChild(s);
  };
  sec("핵심 인물", p.figures);
  sec("출처", p.source);
  if (p.photo) {
    const s = document.createElement("div"); s.className = "detail-section";
    s.innerHTML = `<div class="k">사진</div>`;
    const img = document.createElement("img"); img.className = "photo-preview"; img.src = p.photo;
    s.appendChild(img); body.appendChild(s);
  }
  openModal({ title: "기간 상세", body, footer: [
    mkBtn("편집", "cancel", () => { closeModal(); openPeriodEdit(p); }),
    mkBtn("닫기", "primary", closeModal)
  ]});
}

/* ---------- 기간 편집 ---------- */
function openPeriodEdit(existing = null) {
  const p = existing || { id: uid(), colorTagIds: [], startDate: "1900-01-01", endDate: "1910-12-31", title: "", figures: "", photo: "", source: "" };
  const minD = `${YEAR_MIN}-01-01`, maxD = `${YEAR_MAX}-12-31`;
  const f_title = input("text", p.title, { placeholder: "예: 빅토리아 시대" });
  const f_start = input("date", normalizeDate(p.startDate, "1900-01-01"), { min: minD, max: maxD });
  const f_end   = input("date", normalizeDate(p.endDate, "1910-12-31"), { min: minD, max: maxD });
  let pTagIds = [...(p.colorTagIds || [])];
  const tagSel = colorTagSelector(pTagIds, ids => { pTagIds = ids; });
  const f_fig   = textarea(p.figures);
  const f_src   = textarea(p.source);
  const f_photo = input("file", "", { accept: "image/*" });
  const f_prev  = document.createElement("img"); f_prev.className = "photo-preview";
  if (p.photo) f_prev.src = p.photo; else f_prev.style.display = "none";
  let photoData = p.photo || "";
  f_photo.addEventListener("change", async () => {
    const file = f_photo.files[0]; if (!file) return;
    photoData = await readImageAsDataURL(file);
    f_prev.src = photoData; f_prev.style.display = "block";
  });
  const body = document.createElement("div");
  body.appendChild(field("제목", f_title));
  body.appendChild(row(field("시작 연월일", f_start), field("끝 연월일", f_end)));
  body.appendChild(field("레이블(색상 태그)", tagSel));
  body.appendChild(field("핵심 인물", f_fig));
  body.appendChild(field("출처", f_src));
  body.appendChild(field("사진 첨부", f_photo));
  body.appendChild(f_prev);
  const footer = [];
  if (existing) {
    footer.push(mkBtn("삭제", "danger", () => {
      State.data.periods = State.data.periods.filter(x => x.id !== p.id);
      State.data.flows.forEach(fl => { fl.items = (fl.items || []).filter(it => !(it.type === "period" && it.id === p.id)); });
      persistUserData([{ action: "delete", entity: "period", id: p.id }]); render(); closeModal();
    }));
  }
  footer.push(mkBtn("취소", "cancel", closeModal));
  footer.push(mkBtn("저장", "primary", () => {
    const sd = f_start.value, ed = f_end.value;
    if (!sd || !ed) { alert("시작/끝 날짜를 입력하세요"); return; }
    const sy = +sd.slice(0, 4), ey = +ed.slice(0, 4);
    if (sy < YEAR_MIN || ey > YEAR_MAX) { alert(`${YEAR_MIN}~${YEAR_MAX} 범위로 입력하세요`); return; }
    if (ed < sd) { alert("끝 날짜가 시작보다 앞섭니다"); return; }
    const obj = { id: p.id, title: f_title.value.trim(), colorTagIds: pTagIds, startDate: sd, endDate: ed, figures: f_fig.value.trim(), source: f_src.value.trim(), photo: photoData };
    const idx = State.data.periods.findIndex(x => x.id === obj.id);
    if (idx >= 0) State.data.periods[idx] = obj; else State.data.periods.push(obj);
    persistUserData([...colorTagOperations(), { action: "upsert", entity: "period", item: obj }]); render(); closeModal();
  }));
  openModal({ title: existing ? "기간 편집" : "기간 추가", body, footer });
}

/* ---------- 포인트 상세 ---------- */
function openEventDetail(e) {
  const body = document.createElement("div");
  const hero = document.createElement("div"); hero.className = "detail-hero";
  const title = document.createElement("h3"); title.textContent = e.title || "(무제)";
  const date  = document.createElement("div"); date.className = "detail-date";
  date.textContent = e.date || "";
  hero.appendChild(title); hero.appendChild(date);
  if (e.colorTagIds && e.colorTagIds.length) hero.appendChild(renderColorTagChips(e.colorTagIds));
  body.appendChild(hero);
  const sec = (k, v) => {
    if (!v) return;
    const s = document.createElement("div"); s.className = "detail-section";
    s.innerHTML = `<div class="k">${k}</div><div class="v"></div>`;
    s.querySelector(".v").textContent = v; body.appendChild(s);
  };
  sec("설명", e.description);
  sec("핵심 인물", e.figures);
  sec("출처", e.source);
  if (e.photo) {
    const s = document.createElement("div"); s.className = "detail-section";
    s.innerHTML = `<div class="k">사진</div>`;
    const img = document.createElement("img"); img.className = "photo-preview"; img.src = e.photo;
    s.appendChild(img); body.appendChild(s);
  }
  openModal({ title: "포인트 상세", body, footer: [
    mkBtn("편집", "cancel", () => { closeModal(); openEventEdit(e); }),
    mkBtn("닫기", "primary", closeModal)
  ]});
}

/* ---------- 포인트 편집 ---------- */
function openEventEdit(existing = null) {
  const e0 = existing || { id: uid(), title: "", description: "", date: "1900-01-01", colorTagIds: [], figures: "", photo: "", source: "" };
  const f_title = input("text", e0.title, { placeholder: "예: 빅토리아 여왕 즉위" });
  const f_date  = input("date", normalizeDate(e0.date, "1900-01-01"), { min: `${YEAR_MIN}-01-01`, max: `${YEAR_MAX}-12-31` });
  const f_desc  = textarea(e0.description);
  let eTagIds = [...(e0.colorTagIds || [])];
  const tagSel = colorTagSelector(eTagIds, ids => { eTagIds = ids; });
  const f_fig   = textarea(e0.figures);
  const f_src   = textarea(e0.source);
  const f_photo = input("file", "", { accept: "image/*" });
  const f_prev  = document.createElement("img"); f_prev.className = "photo-preview";
  if (e0.photo) f_prev.src = e0.photo; else f_prev.style.display = "none";
  let photo = e0.photo || "";
  f_photo.addEventListener("change", async () => {
    const file = f_photo.files[0]; if (!file) return;
    photo = await readImageAsDataURL(file);
    f_prev.src = photo; f_prev.style.display = "block";
  });
  const body = document.createElement("div");
  body.appendChild(field("제목", f_title));
  body.appendChild(field("연월일", f_date));
  body.appendChild(field("설명", f_desc));
  body.appendChild(field("레이블(색상 태그)", tagSel));
  body.appendChild(field("핵심 인물", f_fig));
  body.appendChild(field("출처", f_src));
  body.appendChild(field("사진 첨부", f_photo));
  body.appendChild(f_prev);
  const footer = [];
  if (existing) {
    footer.push(mkBtn("삭제", "danger", () => {
      State.data.events = State.data.events.filter(x => x.id !== e0.id);
      State.data.flows.forEach(fl => { fl.items = (fl.items || []).filter(it => !(it.type === "event" && it.id === e0.id)); });
      persistUserData([{ action: "delete", entity: "event", id: e0.id }]); render(); closeModal();
    }));
  }
  footer.push(mkBtn("취소", "cancel", closeModal));
  footer.push(mkBtn("저장", "primary", () => {
    const y = new Date(f_date.value).getFullYear();
    if (!f_date.value || y < YEAR_MIN || y > YEAR_MAX) { alert(`${YEAR_MIN}~${YEAR_MAX} 범위의 날짜를 입력하세요`); return; }
    const obj = { id: e0.id, title: f_title.value.trim() || "(무제)", description: f_desc.value.trim(), date: f_date.value, colorTagIds: eTagIds, figures: f_fig.value.trim(), source: f_src.value.trim(), photo };
    const idx = State.data.events.findIndex(x => x.id === obj.id);
    if (idx >= 0) State.data.events[idx] = obj; else State.data.events.push(obj);
    persistUserData([...colorTagOperations(), { action: "upsert", entity: "event", item: obj }]); render(); closeModal();
  }));
  openModal({ title: existing ? "포인트 편집" : "포인트 추가", body, footer });
}

/* ---------- 흐름 편집 ---------- */
function openFlowEdit(existing = null) {
  const f0 = existing || { id: uid(), title: "", description: "", colorTagIds: [], items: [] };
  const f_title = input("text", f0.title, { placeholder: "예: 산업혁명 → 제국주의" });
  const f_desc  = textarea(f0.description);
  let fTagIds = [...(f0.colorTagIds || [])];
  const tagSel = colorTagSelector(fTagIds, ids => { fTagIds = ids; });

  const candidates = [
    ...State.data.periods.map(p => ({ key: "period:" + p.id, type: "period", id: p.id, sortKey: p.startDate || "", label: `[기간] ${p.title || "기간"}  (${p.startDate || ""} ~ ${p.endDate || ""})` })),
    ...State.data.events.map(e => ({ key: "event:" + e.id, type: "event", id: e.id, sortKey: e.date || "", label: `[포인트] ${e.title || "(무제)"}  (${e.date || ""})` }))
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  let selected = flowItems(f0).map(it => `${it.type}:${it.id}`);
  const listBox = document.createElement("div");
  listBox.className = "multi-select";
  if (!candidates.length) listBox.textContent = "먼저 기간 또는 포인트를 추가하세요.";

  function renderList() {
    listBox.innerHTML = "";
    candidates.forEach(c => {
      const idx = selected.indexOf(c.key);
      const rowEl = document.createElement("label");
      const cb = input("checkbox");
      cb.checked = idx >= 0;
      cb.addEventListener("change", () => {
        if (cb.checked) { if (!selected.includes(c.key)) selected.push(c.key); }
        else selected = selected.filter(k => k !== c.key);
        renderList();
      });
      rowEl.appendChild(cb);
      const order = document.createElement("span"); order.className = "order";
      order.textContent = idx >= 0 ? `#${idx + 1}` : "";
      rowEl.appendChild(order);
      const span = document.createElement("span"); span.textContent = c.label;
      rowEl.appendChild(span);
      listBox.appendChild(rowEl);
    });
  }
  renderList();

  const body = document.createElement("div");
  body.appendChild(field("제목", f_title));
  body.appendChild(field("설명", f_desc));
  body.appendChild(field("레이블(색상 태그)", tagSel));
  body.appendChild(field("연결할 항목 (2개 이상, 선택 순서대로 연결)", listBox));

  const footer = [];
  if (existing) {
    footer.push(mkBtn("삭제", "danger", () => {
      State.data.flows = State.data.flows.filter(x => x.id !== f0.id);
      persistUserData([{ action: "delete", entity: "flow", id: f0.id }]); render(); closeModal();
    }));
  }
  footer.push(mkBtn("취소", "cancel", closeModal));
  footer.push(mkBtn("저장", "primary", () => {
    if (selected.length < 2) { alert("항목을 2개 이상 선택하세요"); return; }
    const items = selected.map(k => { const [type, ...rest] = k.split(":"); return { type, id: rest.join(":") }; });
    const obj = { id: f0.id, title: f_title.value.trim() || "(무제 흐름)", description: f_desc.value.trim(), colorTagIds: fTagIds, items };
    const idx = State.data.flows.findIndex(x => x.id === obj.id);
    if (idx >= 0) State.data.flows[idx] = obj; else State.data.flows.push(obj);
    persistUserData([...colorTagOperations(), { action: "upsert", entity: "flow", item: obj }]); render(); closeModal();
  }));
  openModal({ title: existing ? "흐름 편집" : "흐름 추가", body, footer });
}

/* ---------- 목록 ---------- */
function renderLegend() {
  const lp = $("#list-periods"); lp.innerHTML = "";
  State.data.periods.slice().sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "")).forEach(p => {
    const li = document.createElement("li");
    const color = getItemColorBackground(p, "period");
    const tags = (p.colorTagIds || []).map(id => {
      const ct = State.data.colorTags.find(t => t.id === id);
      return ct ? `<small style="color:${ct.color}">#${escapeHtml(ct.name)}</small>` : "";
    }).join(" ");
    li.innerHTML = `<span class="swatch" style="background:${color}"></span><span>${escapeHtml(p.title || "기간")} ${tags} <small>(${p.startDate || ""} ~ ${p.endDate || ""})</small></span>`;
    li.title = "좌클릭: 상세 / 우클릭: 편집";
    li.addEventListener("click", () => openPeriodDetail(p));
    li.addEventListener("contextmenu", e => { e.preventDefault(); openPeriodEdit(p); });
    lp.appendChild(li);
  });

  const le = $("#list-events"); le.innerHTML = "";
  State.data.events.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "")).forEach(e => {
    const li = document.createElement("li");
    const color = getItemColorBackground(e, "event");
    const tags = (e.colorTagIds || []).map(id => {
      const ct = State.data.colorTags.find(t => t.id === id);
      return ct ? `<small style="color:${ct.color}">#${escapeHtml(ct.name)}</small>` : "";
    }).join(" ");
    li.innerHTML = `<span class="swatch" style="background:${color}"></span><span>${escapeHtml(e.title || "(무제)")} ${tags} <small>${e.date || ""}</small></span>`;
    li.title = "좌클릭: 상세 / 우클릭: 편집";
    li.addEventListener("click", () => openEventDetail(e));
    li.addEventListener("contextmenu", ev => { ev.preventDefault(); openEventEdit(e); });
    le.appendChild(li);
  });

  const lf = $("#list-flows"); lf.innerHTML = "";
  State.data.flows.forEach(f => {
    const li = document.createElement("li");
    const color = getItemColorBackground(f, "flow");
    const count = flowItems(f).length;
    li.innerHTML = `<span class="swatch" style="background:${color}"></span><span>${escapeHtml(f.title || "(무제 흐름)")} <small>${count}개</small></span>`;
    li.addEventListener("click", () => openFlowEdit(f));
    lf.appendChild(li);
  });
}

/* ===========================================================
   Part 5/5: PNG 내보내기 + 줌 + 부트
   =========================================================== */

function buildExportSVG({ startYear, endYear, unit }) {
  const bakZoom = State.zoom;
  const bakRange = State.timelineRange;
  State.zoom = unit;
  State.timelineRange = { start: `${startYear}-01-01`, end: `${endYear}-12-31` };
  const pxm = getPxPerMonth(unit);
  const x0 = LEFT_PAD;
  const x1 = xFromDate(`${endYear + 1}-01-01`, pxm);
  const regionW = (x1 - x0) + LEFT_PAD + RIGHT_PAD;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);

  const layout = getTimelineLayout(pxm);
  const height = RULER_H + TOP_PAD + layout.rowCount * EVENT_ROW_H + 36;

  renderRuler(svg, pxm, height, { unit });
  const pY = RULER_H + TOP_PAD;
  const { positions: periodPos } = renderPeriods(svg, pxm, pY, layout.periodLayout);
  const { positions: eventPos } = renderEvents(svg, pxm, pY, layout.eventLayout);
  renderFlows(svg, combinePositions(periodPos, eventPos));

  svg.setAttribute("viewBox", `${x0 - LEFT_PAD} 0 ${regionW} ${height}`);
  svg.setAttribute("width", regionW);
  svg.setAttribute("height", height);
  svg.insertBefore(el("rect", { x: x0 - LEFT_PAD, y: 0, width: regionW, height, fill: "#ffffff" }), svg.firstChild);

  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = `
    .grid-line{stroke:#eef1f5}.grid-line.major{stroke:#cbd5e1}.grid-line.year{stroke:#94a3b8}
    .tick-label{font:10px sans-serif;fill:#64748b}.tick-label.year{font:700 12px sans-serif;fill:#334155}
    .period-label{font:600 11px sans-serif;fill:#111}.event-label{font:11px sans-serif;fill:#1f2430}
    .flow-path{fill:none;stroke-linecap:round}.flow-label{font:600 11px sans-serif;fill:#334155}
  `;
  svg.insertBefore(style, svg.firstChild);
  State.zoom = bakZoom;
  State.timelineRange = bakRange;
  return { svg, width: regionW, height };
}

async function exportPng({ startYear, endYear, unit }) {
  const { svg, width, height } = buildExportSVG({ startYear, endYear, unit });
  const xml = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const scale = Math.min(2, Math.max(1, 1600 / width));
  const canvas = document.createElement("canvas");
  canvas.width  = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  canvas.toBlob(blob => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const unitName = ({ 12: "1y", 6: "6m", 3: "3m", 1: "1m", 0.5: "15d", 0.333: "10d", 0.1: "3d", 0.033: "1d" })[unit] || String(unit);
    a.download = `timeline_${startYear}-${endYear}_${unitName}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");
}

function openExportDialog() {
  const f_start = input("number", 1850, { min: YEAR_MIN, max: YEAR_MAX });
  const f_end   = input("number", 2000, { min: YEAR_MIN, max: YEAR_MAX });
  const f_unit  = document.createElement("select");
  [["12","1년"],["6","6개월"],["3","3개월"],["1","1개월"],["0.5","15일"],["0.333","10일"],["0.1","3일"],["0.033","1일"]].forEach(([v, l]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = l;
    f_unit.appendChild(o);
  });
  f_unit.value = String(State.zoom);
  const body = document.createElement("div");
  body.appendChild(row(field("시작 연도", f_start), field("끝 연도", f_end)));
  body.appendChild(field("단위", f_unit));
  openModal({ title: "PNG 내보내기", body, footer: [
    mkBtn("취소", "cancel", closeModal),
    mkBtn("내보내기", "primary", async () => {
      const s = clampYear(+f_start.value);
      const e = clampYear(+f_end.value);
      if (e < s) return alert("끝 연도가 시작보다 작습니다");
      closeModal();
      await exportPng({ startYear: s, endYear: e, unit: +f_unit.value });
    })
  ]});
}

function openTagManager() {
  const body = document.createElement("div");
  const rows = State.data.colorTags.map(tag => {
    const line = document.createElement("div");
    line.className = "tag-manager-row";
    const colorInput = input("color", tag.color || "#94a3b8");
    const nameInput = input("text", tag.name || "", { "aria-label": "태그 이름" });
    line.appendChild(colorInput);
    line.appendChild(nameInput);
    body.appendChild(line);
    return { tag, colorInput, nameInput };
  });
  if (!rows.length) body.textContent = "편집할 태그가 없습니다. 기간, 포인트 또는 흐름 편집 창에서 태그를 먼저 추가하세요.";
  openModal({ title: "태그 색상 편집", body, footer: [
    mkBtn("취소", "cancel", closeModal),
    mkBtn("저장", "primary", () => {
      const names = rows.map(row => row.nameInput.value.trim());
      if (names.some(name => !name)) return alert("태그 이름을 입력하세요.");
      if (new Set(names).size !== names.length) return alert("태그 이름은 중복될 수 없습니다.");
      rows.forEach(row => {
        row.tag.name = row.nameInput.value.trim();
        row.tag.color = row.colorInput.value;
      });
      persistUserData(colorTagOperations());
      render();
      closeModal();
    })
  ]});
}

function setZoom(z) {
  State.zoom = z;
  $$(".seg-btn").forEach(b => b.classList.toggle("active", +b.dataset.zoom === z));
  render();
}

/* ---------- 부트 ---------- */
function wireAuth() {
  $("#auth-form").addEventListener("submit", handleLogin);
  $("#btn-register").addEventListener("click", handleRegister);
}
function wireApp() {
  $("#btn-logout").addEventListener("click", handleLogout);
  $("#btn-add-period").addEventListener("click", () => openPeriodEdit());
  $("#btn-add-event").addEventListener("click",  () => openEventEdit());
  $("#btn-add-flow").addEventListener("click",   () => openFlowEdit());
  $("#btn-manage-tags").addEventListener("click", openTagManager);
  $("#btn-export").addEventListener("click", openExportDialog);
  $$(".seg-btn").forEach(b => b.addEventListener("click", () => setZoom(+b.dataset.zoom)));
  $("#modal-root").addEventListener("click", e => { if (e.target.dataset.close === "1") closeModal(); });
  document.addEventListener("keydown", e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || !$("#modal-root").classList.contains("hidden") || $("#app-view").classList.contains("hidden")) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    const actions = { "1": openPeriodEdit, "2": openEventEdit, "3": openFlowEdit };
    if (actions[e.key]) {
      e.preventDefault();
      actions[e.key]();
    }
  });
}

async function boot() {
  wireAuth();
  wireApp();
  try {
    State.session = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (State.session?.token) {
      if (navigator.onLine) {
        const current = await api("/auth/me");
        State.user = current.username;
        State.session.username = current.username;
        localStorage.setItem(SESSION_KEY, JSON.stringify(State.session));
      } else {
        State.user = State.session.username;
      }
      if (!State.user) throw new Error("Session username is missing");
      await enterApp();
    }
  } catch {
    State.session = null;
    localStorage.removeItem(SESSION_KEY);
  }
  if (State.session && _pendingOperations.length) schedulePushSync();
  // 오프라인 → 온라인 전환 시 자동 동기화
  window.addEventListener("online", () => {
    if (State.session) {
      if (_pendingOperations.length) schedulePushSync();
      else pollDatabase();
    }
  });
  setInterval(pollDatabase, 3000);
}
document.addEventListener("DOMContentLoaded", boot);
