/* ===========================================================
   IB History Timeline — app.js
   Part 1/5: Supabase + 상수 + 유틸 + 캐시 + 데이터 모델
   =========================================================== */

/* ---------- Supabase ---------- */
const SUPA_URL = "https://kwrfxmcxhejekbewlreb.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3cmZ4bWN4aGVqZWtiZXdscmViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MDk3MjEsImV4cCI6MjA5MjA4NTcyMX0.pdkt7ujtdFzIvLXLtMVwkGu-881hZbnblmvaiTgNPtU";
const sb = supabase.createClient(SUPA_URL, SUPA_KEY);

/* ---------- 1. 상수 & 유틸 ---------- */
const YEAR_MIN = 1850;
const YEAR_MAX = 2000;
const TOTAL_MONTHS = (YEAR_MAX - YEAR_MIN + 1) * 12;
const CACHE_KEY = "ibhistory.cache.v2";

const PX_PER_MONTH = { 12: 3, 6: 6, 3: 12, 1: 36 };

const RULER_H    = 46;
const LANE_GAP   = 18;
const PERIOD_H   = 24;
const PERIOD_PAD = 4;
const EVENT_ROW_H = 52;
const LEFT_PAD   = 40;
const RIGHT_PAD  = 40;
const TOP_PAD    = 10;

const $   = (sel, root = document) => root.querySelector(sel);
const $$  = (sel, root = document) => [...root.querySelectorAll(sel)];
const SVG_NS = "http://www.w3.org/2000/svg";

const el = (tag, attrs = {}, children = []) => {
  const isSvg = ["svg","g","rect","line","text","path","circle","defs","marker"].includes(tag);
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
function ymdToMonthIndex(ymd) {
  return (ymd.y - YEAR_MIN) * 12 + (ymd.m - 1) + (ymd.d - 1) / 31;
}
function yearToMonthIndex(y) { return (y - YEAR_MIN) * 12; }
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
  });

  // events: colorTagIds 없으면 빈 배열
  data.events.forEach(e => { e.colorTagIds = e.colorTagIds || []; });

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

/* PART 2–5는 아래에 이어집니다 */
