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

/* ===========================================================
   Part 2/5: 전역 상태 + Supabase 인증 + 동기화
   =========================================================== */

/* ---------- 전역 상태 ---------- */
const State = {
  session: null,   // Supabase session 객체
  user: null,      // username 문자열
  data: emptyData(),
  zoom: 6,
};

/* ---------- 동기화 상태 UI ---------- */
function updateSyncStatus(s) {
  const el2 = $("#sync-status");
  if (!el2) return;
  const map = { syncing: "⏳ 동기화 중", synced: "☁️ 동기화됨", offline: "📴 오프라인", error: "⚠️ 오류" };
  el2.textContent = map[s] || "";
}

/* ---------- Supabase 인증 ---------- */
function showAuthMsg(msg, ok = false) {
  const n = $("#auth-msg");
  n.textContent = msg || "";
  n.style.color = ok ? "#0a7" : "#b33";
}

function usernameToEmail(u) {
  return u.toLowerCase().replace(/[^a-z0-9._-]/g, "_") + "@ibhistory.app";
}

async function handleRegister() {
  const u = $("#auth-username").value.trim();
  const p = $("#auth-password").value;
  if (!u || !p) return showAuthMsg("아이디/비밀번호를 입력하세요");
  const email = usernameToEmail(u);
  showAuthMsg("가입 중...");
  const { error } = await sb.auth.signUp({ email, password: p });
  if (error) return showAuthMsg(error.message);
  showAuthMsg("가입 완료. 로그인 해주세요.", true);
}

async function handleLogin(e) {
  e && e.preventDefault();
  const u = $("#auth-username").value.trim();
  const p = $("#auth-password").value;
  if (!u || !p) return showAuthMsg("아이디/비밀번호를 입력하세요");
  const email = usernameToEmail(u);
  showAuthMsg("로그인 중...");
  const { data, error } = await sb.auth.signInWithPassword({ email, password: p });
  if (error) return showAuthMsg(error.message);
  State.session = data.session;
  State.user = u;
  await enterApp();
}

async function handleLogout() {
  await sb.auth.signOut();
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
      await loadFromSupabase();
      const cache = loadCache();
      cache[State.user] = State.data;
      saveCache(cache);
      updateSyncStatus("synced");
    } catch (err) {
      console.warn("Supabase load failed, using cache:", err);
      const cache = loadCache();
      State.data = cache[State.user] || emptyData();
      migrateData(State.data);
      updateSyncStatus("offline");
    }
  } else {
    const cache = loadCache();
    State.data = cache[State.user] || emptyData();
    migrateData(State.data);
    updateSyncStatus("offline");
  }
  render();
}

/* ---------- Supabase 데이터 불러오기 ---------- */
async function loadFromSupabase() {
  const userId = State.session.user.id;
  const [ct, p, e, f, fi] = await Promise.all([
    sb.from("color_tags").select("*").eq("user_id", userId),
    sb.from("periods").select("*").eq("user_id", userId),
    sb.from("events").select("*").eq("user_id", userId),
    sb.from("flows").select("*").eq("user_id", userId),
    sb.from("flow_items").select("*"),
  ]);
  State.data = {
    colorTags: (ct.data || []).map(r => ({ id: r.id, name: r.name, color: r.color })),
    periods: (p.data || []).map(r => ({
      id: r.id, title: r.title,
      startDate: r.start_date, endDate: r.end_date,
      figures: r.figures, source: r.source, photo: r.photo,
      colorTagIds: r.color_tag_ids || []
    })),
    events: (e.data || []).map(r => ({
      id: r.id, title: r.title, date: r.event_date,
      description: r.description, figures: r.figures,
      source: r.source, photo: r.photo,
      colorTagIds: r.color_tag_ids || []
    })),
    flows: (f.data || []).map(r => ({
      id: r.id, title: r.title, description: r.description,
      colorTagIds: r.color_tag_ids || [],
      items: (fi.data || [])
        .filter(i => i.flow_id === r.id)
        .sort((a, b) => a.position - b.position)
        .map(i => ({ type: i.item_type, id: i.item_id }))
    })),
  };
}

/* ---------- Supabase 동기화 (전체 교체) ---------- */
async function syncToSupabase() {
  if (!navigator.onLine || !State.session) return false;
  const userId = State.session.user.id;
  // 기존 데이터 전체 삭제 (flow_items는 flows 삭제 시 CASCADE)
  await Promise.all([
    sb.from("flows").delete().eq("user_id", userId),
    sb.from("periods").delete().eq("user_id", userId),
    sb.from("events").delete().eq("user_id", userId),
    sb.from("color_tags").delete().eq("user_id", userId),
  ]);
  // 새 데이터 삽입
  if (State.data.colorTags.length)
    await sb.from("color_tags").insert(
      State.data.colorTags.map(t => ({ id: t.id, user_id: userId, name: t.name, color: t.color }))
    );
  if (State.data.periods.length)
    await sb.from("periods").insert(
      State.data.periods.map(p => ({
        id: p.id, user_id: userId, title: p.title,
        start_date: p.startDate, end_date: p.endDate,
        figures: p.figures, source: p.source, photo: p.photo,
        color_tag_ids: p.colorTagIds || []
      }))
    );
  if (State.data.events.length)
    await sb.from("events").insert(
      State.data.events.map(e => ({
        id: e.id, user_id: userId, title: e.title, event_date: e.date,
        description: e.description, figures: e.figures,
        source: e.source, photo: e.photo,
        color_tag_ids: e.colorTagIds || []
      }))
    );
  if (State.data.flows.length) {
    await sb.from("flows").insert(
      State.data.flows.map(f => ({
        id: f.id, user_id: userId, title: f.title,
        description: f.description, color_tag_ids: f.colorTagIds || []
      }))
    );
    const rows = [];
    State.data.flows.forEach(f =>
      (f.items || []).forEach((it, idx) =>
        rows.push({ flow_id: f.id, position: idx, item_type: it.type, item_id: it.id })
      )
    );
    if (rows.length) await sb.from("flow_items").insert(rows);
  }
  return true;
}

let _syncTimer = null;
function schedulePushSync() {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    updateSyncStatus("syncing");
    try {
      const ok = await syncToSupabase();
      updateSyncStatus(ok ? "synced" : "offline");
    } catch (err) {
      console.error("Sync error:", err);
      updateSyncStatus("error");
    }
  }, 800);
}

function persistUserData() {
  if (!State.user) return;
  const cache = loadCache();
  cache[State.user] = State.data;
  saveCache(cache);
  schedulePushSync();
}

/* PART 3–5는 아래에 이어집니다 */
