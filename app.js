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

/* ---------- 좌표 & 레이아웃 ---------- */
function getPxPerMonth(zoom = State.zoom) { return PX_PER_MONTH[zoom] || 6; }
function xFromMonthIndex(mi, pxm = getPxPerMonth()) { return LEFT_PAD + mi * pxm; }
function xFromYear(y, pxm) { return xFromMonthIndex(yearToMonthIndex(y), pxm); }
function xFromDate(s, pxm) {
  const p = parseYMD(s); if (!p) return LEFT_PAD;
  return xFromMonthIndex(ymdToMonthIndex(p), pxm);
}
function totalWidth(pxm = getPxPerMonth()) { return LEFT_PAD + TOTAL_MONTHS * pxm + RIGHT_PAD; }

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

/* ---------- 렌더: 눈금자 ---------- */
function renderRuler(svg, pxm, height, opts = {}) {
  const unit = opts.unit || State.zoom;
  const g = el("g", { class: "ruler" });
  g.appendChild(el("rect", { x: 0, y: 0, width: totalWidth(pxm), height: RULER_H, fill: "#f8fafc" }));
  for (let y = YEAR_MIN; y <= YEAR_MAX; y++) {
    const x = xFromYear(y, pxm);
    g.appendChild(el("line", { x1: x, y1: 0, x2: x, y2: height, class: "grid-line year" }));
    g.appendChild(el("text", { x: x + 2, y: 14, class: "tick-label year", text: String(y) }));
    if (unit < 12) {
      for (let m = unit; m < 12; m += unit) {
        const xm = xFromMonthIndex((y - YEAR_MIN) * 12 + m, pxm);
        g.appendChild(el("line", {
          x1: xm, y1: RULER_H - 10, x2: xm, y2: height,
          class: m % 6 === 0 ? "grid-line major" : "grid-line"
        }));
        if (pxm * unit >= 28)
          g.appendChild(el("text", { x: xm + 2, y: RULER_H - 2, class: "tick-label", text: (m + 1) + "월" }));
      }
    }
  }
  const xEnd = xFromYear(YEAR_MAX, pxm) + 12 * pxm;
  g.appendChild(el("line", { x1: xEnd, y1: 0, x2: xEnd, y2: height, class: "grid-line year" }));
  svg.appendChild(g);
}

/* ---------- 렌더: 기간 ---------- */
function periodLabelText(p) {
  const s = (p.startDate || "").slice(0, 10);
  const e = (p.endDate   || "").slice(0, 10);
  return `${p.title || "기간"} (${s} ~ ${e})`;
}
function renderPeriods(svg, pxm, yStart) {
  const periods = State.data.periods;
  const segs = periods.map(p => { const b = periodBounds(p, pxm); return { id: p.id, x1: b.x1, x2: b.x2 }; });
  const { rowMap, rowCount } = assignRows(segs);
  const g = el("g", { class: "periods" });
  const positions = {};
  periods.forEach(p => {
    const r = rowMap[p.id] || 0;
    const { x1, x2 } = periodBounds(p, pxm);
    const y = yStart + r * (PERIOD_H + PERIOD_PAD);
    const w = Math.max(8, x2 - x1);
    positions[p.id] = { x: x1 + w / 2, y };
    const color = getItemColor(p, "period");
    const rect = el("rect", {
      x: x1, y, width: w, height: PERIOD_H,
      rx: 4, fill: color,
      "fill-opacity": "0.82",
      stroke: "#1f2937", "stroke-opacity": "0.18",
      class: "period-rect"
    });
    rect.addEventListener("click", () => openPeriodDetail(p));
    rect.addEventListener("contextmenu", e => { e.preventDefault(); openPeriodEdit(p); });
    g.appendChild(rect);
    g.appendChild(el("text", { x: x1 + 6, y: y + PERIOD_H - 7, class: "period-label", text: periodLabelText(p) }));
  });
  svg.appendChild(g);
  return { yEnd: yStart + rowCount * (PERIOD_H + PERIOD_PAD), positions };
}

/* ---------- 렌더: 포인트 ---------- */
function renderEvents(svg, pxm, yStart) {
  const evs = State.data.events;
  const segs = evs.map(e => {
    const x = xFromDate(e.date, pxm);
    return { id: e.id, x1: x, x2: x + estimateEventWidth(e) };
  });
  const { rowMap, rowCount } = assignRows(segs);
  const g = el("g", { class: "events" });
  const positions = {};
  evs.forEach(e => {
    const r = rowMap[e.id] || 0;
    const x = xFromDate(e.date, pxm);
    const y = yStart + r * EVENT_ROW_H + 14;
    positions[e.id] = { x, y };
    g.appendChild(el("line", { x1: x, y1: yStart - 4, x2: x, y2: y, stroke: "#94a3b8", "stroke-width": 1, "stroke-dasharray": "2 3" }));
    const color = getItemColor(e, "event");
    const circle = el("circle", { cx: x, cy: y, r: 5, fill: color, stroke: "#fff", "stroke-width": 2, class: "event-marker" });
    circle.addEventListener("click", () => openEventDetail(e));
    circle.addEventListener("contextmenu", ev => { ev.preventDefault(); openEventEdit(e); });
    g.appendChild(circle);
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
    const color = getItemColor(f, "flow");
    const mid = "arr_" + f.id;
    ensureArrowDefs(svg, color, mid);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x;
      const midY = Math.min(a.y, b.y) - 40 - Math.min(60, Math.abs(dx) * 0.15);
      const d = `M ${a.x} ${a.y - 6} Q ${(a.x + b.x) / 2} ${midY} ${b.x} ${b.y - 6}`;
      const path = el("path", { d, class: "flow-path", fill: "none", stroke: color, "stroke-width": 2, "stroke-linecap": "round", "marker-end": `url(#${mid})`, "data-flow": f.id });
      path.addEventListener("mouseenter", e => showTooltip(e, f));
      path.addEventListener("mousemove", moveTooltip);
      path.addEventListener("mouseleave", hideTooltip);
      path.addEventListener("click", () => openFlowEdit(f));
      g.appendChild(path);
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
function render() {
  const svg = $("#timeline-svg");
  svg.innerHTML = "";
  const pxm = getPxPerMonth();
  const width = totalWidth(pxm);
  const periodSegs = State.data.periods.map(p => { const b = periodBounds(p, pxm); return { id: p.id, x1: b.x1, x2: b.x2 }; });
  const periodRows = assignRows(periodSegs).rowCount;
  const eventSegs  = State.data.events.map(e => ({ id: e.id, x1: xFromDate(e.date, pxm), x2: xFromDate(e.date, pxm) + estimateEventWidth(e) }));
  const eventRows  = assignRows(eventSegs).rowCount;
  const height = RULER_H + TOP_PAD + periodRows * (PERIOD_H + PERIOD_PAD) + LANE_GAP + eventRows * EVENT_ROW_H + 40;
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  renderRuler(svg, pxm, height);
  const pY = RULER_H + TOP_PAD;
  const { yEnd: pBottom, positions: periodPos } = renderPeriods(svg, pxm, pY);
  const eY = pBottom + LANE_GAP;
  const { positions: eventPos } = renderEvents(svg, pxm, eY);
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
  const f_start = input("date", p.startDate || "1900-01-01", { min: minD, max: maxD });
  const f_end   = input("date", p.endDate   || "1910-12-31", { min: minD, max: maxD });
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
      persistUserData(); render(); closeModal();
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
    persistUserData(); render(); closeModal();
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
  const f_date  = input("date", e0.date, { min: `${YEAR_MIN}-01-01`, max: `${YEAR_MAX}-12-31` });
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
      persistUserData(); render(); closeModal();
    }));
  }
  footer.push(mkBtn("취소", "cancel", closeModal));
  footer.push(mkBtn("저장", "primary", () => {
    const y = new Date(f_date.value).getFullYear();
    if (!f_date.value || y < YEAR_MIN || y > YEAR_MAX) { alert(`${YEAR_MIN}~${YEAR_MAX} 범위의 날짜를 입력하세요`); return; }
    const obj = { id: e0.id, title: f_title.value.trim() || "(무제)", description: f_desc.value.trim(), date: f_date.value, colorTagIds: eTagIds, figures: f_fig.value.trim(), source: f_src.value.trim(), photo };
    const idx = State.data.events.findIndex(x => x.id === obj.id);
    if (idx >= 0) State.data.events[idx] = obj; else State.data.events.push(obj);
    persistUserData(); render(); closeModal();
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
      persistUserData(); render(); closeModal();
    }));
  }
  footer.push(mkBtn("취소", "cancel", closeModal));
  footer.push(mkBtn("저장", "primary", () => {
    if (selected.length < 2) { alert("항목을 2개 이상 선택하세요"); return; }
    const items = selected.map(k => { const [type, ...rest] = k.split(":"); return { type, id: rest.join(":") }; });
    const obj = { id: f0.id, title: f_title.value.trim() || "(무제 흐름)", description: f_desc.value.trim(), colorTagIds: fTagIds, items };
    const idx = State.data.flows.findIndex(x => x.id === obj.id);
    if (idx >= 0) State.data.flows[idx] = obj; else State.data.flows.push(obj);
    persistUserData(); render(); closeModal();
  }));
  openModal({ title: existing ? "흐름 편집" : "흐름 추가", body, footer });
}

/* ---------- 목록 ---------- */
function renderLegend() {
  const lp = $("#list-periods"); lp.innerHTML = "";
  State.data.periods.slice().sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "")).forEach(p => {
    const li = document.createElement("li");
    const color = getItemColor(p, "period");
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
    const color = getItemColor(e, "event");
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
    const color = getItemColor(f, "flow");
    const count = flowItems(f).length;
    li.innerHTML = `<span class="swatch" style="background:${color}"></span><span>${escapeHtml(f.title || "(무제 흐름)")} <small>${count}개</small></span>`;
    li.addEventListener("click", () => openFlowEdit(f));
    lf.appendChild(li);
  });
}

/* PART 5는 아래에 이어집니다 */
