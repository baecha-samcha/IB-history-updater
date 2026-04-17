/* ===========================================================
   IB History Timeline
   ----------------------------------------------------------- */

/* ---------- 1. 상수 & 유틸 ---------- */
const YEAR_MIN = 1850;
const YEAR_MAX = 2000;
const TOTAL_MONTHS = (YEAR_MAX - YEAR_MIN + 1) * 12; // 1812
const STORAGE_KEY = "ibhistory.v1";

// 줌 단계: 선택된 tick 단위(개월) → px/month
const PX_PER_MONTH = { 12: 3, 6: 6, 3: 12, 1: 36 };

const RULER_H   = 46;
const LANE_GAP  = 18;
const PERIOD_H  = 24;
const PERIOD_PAD = 4;
const EVENT_ROW_H = 52;
const LEFT_PAD  = 40;
const RIGHT_PAD = 40;
const TOP_PAD   = 10;

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
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
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
};

// 날짜 헬퍼 ----------------------------------------------------
function parseYMD(s) {
  // "YYYY-MM-DD" → {y,m,d} (m: 1~12)
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return { y, m: m || 1, d: d || 1 };
}
function ymdToMonthIndex(ymd) {
  // 1850-01 = 0
  return (ymd.y - YEAR_MIN) * 12 + (ymd.m - 1) + (ymd.d - 1) / 31;
}
function yearToMonthIndex(y) { return (y - YEAR_MIN) * 12; }
function clampYear(y) { return Math.max(YEAR_MIN, Math.min(YEAR_MAX, y|0)); }
function uid() { return Math.random().toString(36).slice(2, 10); }

async function sha256(str) {
  if (window.crypto && crypto.subtle) {
    const buf = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,"0")).join("");
  }
  // fallback (약식)
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return "f_" + (h >>> 0).toString(16);
}

/* ---------- 2. 저장소 ---------- */
// 구조:
// { users: { [username]: { passwordHash, data: { periods, events, flows } } },
//   session: { username } }
function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { users: {}, session: null };
    const s = JSON.parse(raw);
    s.users = s.users || {};
    s.session = s.session || null;
    return s;
  } catch {
    return { users: {}, session: null };
  }
}
function saveStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}
function emptyData() {
  return { periods: [], events: [], flows: [] };
}
function getUserData(store, username) {
  const u = store.users[username];
  if (!u) return null;
  u.data = u.data || emptyData();
  u.data.periods = u.data.periods || [];
  u.data.events  = u.data.events  || [];
  u.data.flows   = u.data.flows   || [];
  migrateData(u.data);
  return u.data;
}
function migrateData(data) {
  // 연도 기반 → 날짜 기반
  data.periods.forEach(p => {
    if (!p.startDate && p.startYear != null) {
      p.startDate = `${p.startYear}-01-01`;
      p.endDate   = `${p.endYear || p.startYear}-12-31`;
    }
    if (p.colorTag == null) p.colorTag = "";
  });
  // flow: eventIds → items
  data.flows.forEach(f => {
    if (!f.items) {
      f.items = (f.eventIds || []).map(id => ({ type: "event", id }));
    }
    if (f.colorTag == null) f.colorTag = "";
  });
}
function persistUserData() {
  if (!State.user) return;
  const store = loadStore();
  if (!store.users[State.user]) return;
  store.users[State.user].data = State.data;
  saveStore(store);
}

/* ---------- 3. 전역 상태 & 인증 ---------- */
const State = {
  user: null,
  data: emptyData(),
  zoom: 6,        // 6 | 3 | 1  (개월 단위)
};

function showAuthMsg(msg, ok = false) {
  const n = $("#auth-msg");
  n.textContent = msg || "";
  n.style.color = ok ? "#0a7" : "#b33";
}

async function handleRegister() {
  const u = $("#auth-username").value.trim();
  const p = $("#auth-password").value;
  if (!u || !p) return showAuthMsg("아이디/비밀번호를 입력하세요");
  const store = loadStore();
  if (store.users[u]) return showAuthMsg("이미 존재하는 아이디입니다");
  store.users[u] = { passwordHash: await sha256(p), data: emptyData() };
  saveStore(store);
  showAuthMsg("가입 완료. 로그인 해주세요.", true);
}

async function handleLogin(e) {
  e && e.preventDefault();
  const u = $("#auth-username").value.trim();
  const p = $("#auth-password").value;
  if (!u || !p) return showAuthMsg("아이디/비밀번호를 입력하세요");
  const store = loadStore();
  const user = store.users[u];
  if (!user) return showAuthMsg("존재하지 않는 계정입니다");
  const hash = await sha256(p);
  if (user.passwordHash !== hash) return showAuthMsg("비밀번호가 틀렸습니다");
  store.session = { username: u };
  saveStore(store);
  enterApp(u);
}

function handleLogout() {
  const store = loadStore();
  store.session = null;
  saveStore(store);
  State.user = null;
  State.data = emptyData();
  $("#app-view").classList.add("hidden");
  $("#auth-view").classList.remove("hidden");
  $("#auth-password").value = "";
  showAuthMsg("");
}

function enterApp(username) {
  State.user = username;
  const store = loadStore();
  State.data = getUserData(store, username) || emptyData();
  $("#user-badge").textContent = username;
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  render();
}

/* ---------- 4. 모달 ---------- */
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

// 이미지 파일을 data URL로 변환 + 리사이즈 (최대 800px)
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

// 간단한 필드 빌더
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
  for (const [k,v] of Object.entries(attrs)) i.setAttribute(k, v);
  return i;
}
function textarea(value = "") {
  const t = document.createElement("textarea");
  t.value = value || "";
  return t;
}

/* ---------- 5. 좌표 & 레이아웃 ---------- */
function getPxPerMonth(zoom = State.zoom) { return PX_PER_MONTH[zoom] || 6; }

function xFromMonthIndex(mi, pxm = getPxPerMonth()) {
  return LEFT_PAD + mi * pxm;
}
function xFromYear(y, pxm) { return xFromMonthIndex(yearToMonthIndex(y), pxm); }
function xFromDate(s, pxm) {
  const p = parseYMD(s); if (!p) return LEFT_PAD;
  return xFromMonthIndex(ymdToMonthIndex(p), pxm);
}

function totalWidth(pxm = getPxPerMonth()) {
  return LEFT_PAD + TOTAL_MONTHS * pxm + RIGHT_PAD;
}

// 겹치지 않게 행 배치 (greedy). segments: [{id, x1, x2}] → {id: rowIndex}
function assignRows(segments) {
  const sorted = [...segments].sort((a,b) => a.x1 - b.x1);
  const rows = []; // each = 마지막 x2
  const out = {};
  for (const s of sorted) {
    let r = rows.findIndex(end => end <= s.x1 - 4);
    if (r < 0) { rows.push(s.x2); r = rows.length - 1; }
    else rows[r] = s.x2;
    out[s.id] = r;
  }
  return { rowMap: out, rowCount: Math.max(1, rows.length) };
}

// 이벤트 라벨 폭 추정
function estimateEventWidth(ev) {
  const s = (ev.title || "") + "  " + (ev.date || "");
  return Math.max(60, s.length * 7 + 20);
}

/* ---------- 6. 렌더: 눈금자 + 기간 ---------- */
function renderRuler(svg, pxm, height, opts = {}) {
  const unit = opts.unit || State.zoom;   // 6 | 3 | 1
  const g = el("g", { class: "ruler" });
  // 배경
  g.appendChild(el("rect", {
    x: 0, y: 0, width: totalWidth(pxm), height: RULER_H,
    fill: "#f8fafc"
  }));
  // 눈금
  for (let y = YEAR_MIN; y <= YEAR_MAX; y++) {
    const x = xFromYear(y, pxm);
    // 연도 라인
    g.appendChild(el("line", {
      x1: x, y1: 0, x2: x, y2: height,
      class: "grid-line year"
    }));
    g.appendChild(el("text", {
      x: x + 2, y: 14, class: "tick-label year", text: String(y)
    }));
    // 하위 눈금 (unit 개월마다). unit >= 12 이면 sub-tick 없음.
    if (unit < 12) {
      for (let m = unit; m < 12; m += unit) {
        const xm = xFromMonthIndex((y - YEAR_MIN) * 12 + m, pxm);
        g.appendChild(el("line", {
          x1: xm, y1: RULER_H - 10, x2: xm, y2: height,
          class: m % 6 === 0 ? "grid-line major" : "grid-line"
        }));
        if (pxm * unit >= 28) {
          g.appendChild(el("text", {
            x: xm + 2, y: RULER_H - 2, class: "tick-label",
            text: (m + 1) + "월"
          }));
        }
      }
    }
  }
  // 최종 경계
  const xEnd = xFromYear(YEAR_MAX, pxm) + 12 * pxm;
  g.appendChild(el("line", {
    x1: xEnd, y1: 0, x2: xEnd, y2: height, class: "grid-line year"
  }));
  svg.appendChild(g);
}

function periodBounds(p, pxm) {
  const x1 = xFromDate(p.startDate, pxm);
  const x2 = xFromDate(p.endDate, pxm);
  return { x1: Math.min(x1, x2), x2: Math.max(x1, x2) };
}
function periodLabelText(p) {
  const s = (p.startDate || "").slice(0, 10);
  const e = (p.endDate || "").slice(0, 10);
  const tag = p.colorTag ? `[${p.colorTag}] ` : "";
  return `${tag}${p.title || "기간"} (${s} ~ ${e})`;
}

function renderPeriods(svg, pxm, yStart) {
  const periods = State.data.periods;
  const segs = periods.map(p => {
    const b = periodBounds(p, pxm);
    return { id: p.id, x1: b.x1, x2: b.x2 };
  });
  const { rowMap, rowCount } = assignRows(segs);
  const g = el("g", { class: "periods" });
  const positions = {}; // id → {x, y} (중심 상단, 흐름 기준점)
  periods.forEach(p => {
    const r = rowMap[p.id] || 0;
    const { x1, x2 } = periodBounds(p, pxm);
    const y  = yStart + r * (PERIOD_H + PERIOD_PAD);
    const w  = Math.max(8, x2 - x1);
    positions[p.id] = { x: x1 + w / 2, y };
    g.appendChild(el("rect", {
      x: x1, y, width: w, height: PERIOD_H,
      rx: 4, fill: p.color || "#60a5fa",
      "fill-opacity": "0.82",
      stroke: "#1f2937", "stroke-opacity": "0.25",
      class: "period-rect",
      onClick: () => openPeriodEdit(p)
    }));
    g.appendChild(el("text", {
      x: x1 + 6, y: y + PERIOD_H - 7,
      class: "period-label", text: periodLabelText(p)
    }));
  });
  svg.appendChild(g);
  return { yEnd: yStart + rowCount * (PERIOD_H + PERIOD_PAD), positions };
}

/* ---------- 7. 렌더: 포인트 + 전체 render ---------- */
function renderEvents(svg, pxm, yStart) {
  const evs = State.data.events;
  const segs = evs.map(e => {
    const x = xFromDate(e.date, pxm);
    const w = estimateEventWidth(e);
    return { id: e.id, x1: x, x2: x + w };
  });
  const { rowMap, rowCount } = assignRows(segs);
  const g = el("g", { class: "events" });
  const positions = {}; // id → {x, y}
  evs.forEach(e => {
    const r = rowMap[e.id] || 0;
    const x = xFromDate(e.date, pxm);
    const y = yStart + r * EVENT_ROW_H + 14;
    positions[e.id] = { x, y };
    // 마커 (세로선 + 점)
    g.appendChild(el("line", {
      x1: x, y1: yStart - 4, x2: x, y2: y,
      stroke: "#94a3b8", "stroke-width": 1, "stroke-dasharray": "2 3"
    }));
    g.appendChild(el("circle", {
      cx: x, cy: y, r: 5, fill: "#1d4ed8", stroke: "#fff", "stroke-width": 2,
      class: "event-marker",
      onClick: () => openEventDetail(e)
    }));
    // 제목 (클릭 가능)
    const t = el("text", {
      x: x + 8, y: y + 4,
      class: "event-label", text: e.title || "(제목 없음)",
      style: "cursor:pointer",
      onClick: () => openEventDetail(e)
    });
    g.appendChild(t);
  });
  svg.appendChild(g);
  return { yEnd: yStart + rowCount * EVENT_ROW_H, positions };
}

function render() {
  const svg = $("#timeline-svg");
  svg.innerHTML = "";
  const pxm = getPxPerMonth();
  const width = totalWidth(pxm);

  // 레이아웃 계산 → 높이 확정 → 실제 렌더
  const periodSegs = State.data.periods.map(p => {
    const b = periodBounds(p, pxm);
    return { id: p.id, x1: b.x1, x2: b.x2 };
  });
  const periodRows = assignRows(periodSegs).rowCount;
  const periodsH = periodRows * (PERIOD_H + PERIOD_PAD);

  const eventSegs = State.data.events.map(e => {
    const x = xFromDate(e.date, pxm);
    return { id: e.id, x1: x, x2: x + estimateEventWidth(e) };
  });
  const eventRows = assignRows(eventSegs).rowCount;
  const eventsH = eventRows * EVENT_ROW_H;

  const height = RULER_H + TOP_PAD + periodsH + LANE_GAP + eventsH + 40;

  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  renderRuler(svg, pxm, height);
  const periodsY = RULER_H + TOP_PAD;
  const { yEnd: periodsBottom, positions: periodPos } = renderPeriods(svg, pxm, periodsY);
  const eventsY = periodsBottom + LANE_GAP;
  const { positions: eventPos } = renderEvents(svg, pxm, eventsY);

  const combined = combinePositions(periodPos, eventPos);
  renderFlows(svg, combined);
  renderLegend();
}

function combinePositions(periodPos, eventPos) {
  const out = {};
  for (const [id, p] of Object.entries(periodPos)) out["period:" + id] = p;
  for (const [id, p] of Object.entries(eventPos))  out["event:"  + id] = p;
  return out;
}

/* ---------- 8. 렌더: 흐름 화살표 + 툴팁 ---------- */
function ensureArrowDefs(svg, color, id) {
  let defs = svg.querySelector("defs");
  if (!defs) { defs = el("defs"); svg.appendChild(defs); }
  if (svg.querySelector(`#${id}`)) return;
  const marker = el("marker", {
    id, viewBox: "0 0 10 10", refX: "9", refY: "5",
    markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse"
  });
  marker.appendChild(el("path", { d: "M0,0 L10,5 L0,10 Z", fill: color }));
  defs.appendChild(marker);
}

function flowItems(f) {
  // 마이그레이션 후에는 f.items 사용
  if (f.items) return f.items;
  return (f.eventIds || []).map(id => ({ type: "event", id }));
}
function renderFlows(svg, positions) {
  const flows = State.data.flows;
  const g = el("g", { class: "flows" });
  flows.forEach(f => {
    const pts = flowItems(f)
      .map(it => positions[`${it.type}:${it.id}`])
      .filter(Boolean);
    if (pts.length < 2) return;
    const color = f.color || "#ef4444";
    const markerId = "arr_" + f.id;
    ensureArrowDefs(svg, color, markerId);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i+1];
      const dx = b.x - a.x;
      const midY = Math.min(a.y, b.y) - 40 - Math.min(60, Math.abs(dx) * 0.15);
      const d = `M ${a.x} ${a.y - 6} Q ${(a.x + b.x)/2} ${midY} ${b.x} ${b.y - 6}`;
      const path = el("path", {
        d, class: "flow-path",
        stroke: color, "stroke-width": 2,
        "marker-end": `url(#${markerId})`,
        "data-flow": f.id
      });
      path.addEventListener("mouseenter", (e) => showTooltip(e, f));
      path.addEventListener("mousemove", (e) => moveTooltip(e));
      path.addEventListener("mouseleave", hideTooltip);
      path.addEventListener("click", () => openFlowEdit(f));
      g.appendChild(path);
    }
  });
  svg.appendChild(g);
}

function showTooltip(e, flow) {
  const t = $("#tooltip");
  t.innerHTML = `<b>${escapeHtml(flow.title || "(무제 흐름)")}</b>${
    flow.description ? escapeHtml(flow.description) : ""
  }`;
  t.classList.remove("hidden");
  moveTooltip(e);
}
function moveTooltip(e) {
  const t = $("#tooltip");
  t.style.left = (e.clientX + 14) + "px";
  t.style.top  = (e.clientY + 14) + "px";
}
function hideTooltip() { $("#tooltip").classList.add("hidden"); }
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------- 9. 폼 (기간 / 포인트 / 흐름) + 상세 + 목록 ---------- */

// --- 기간(Period) ---
function openPeriodEdit(existing = null) {
  const p = existing || {
    id: uid(), color: "#60a5fa", colorTag: "",
    startDate: "1900-01-01", endDate: "1910-12-31",
    title: "", figures: "", photo: "", source: ""
  };
  const minD = `${YEAR_MIN}-01-01`, maxD = `${YEAR_MAX}-12-31`;
  const f_title   = input("text", p.title, { placeholder: "예: 빅토리아 시대" });
  const f_color   = input("color", p.color || "#60a5fa");
  const f_tag     = input("text",  p.colorTag || "", { placeholder: "태그 (예: 정치, 경제)" });
  const f_start   = input("date",  p.startDate || "1900-01-01", { min: minD, max: maxD });
  const f_end     = input("date",  p.endDate   || "1910-12-31", { min: minD, max: maxD });
  const f_figures = textarea(p.figures);
  const f_source  = textarea(p.source);
  const f_photo   = input("file", "", { accept: "image/*" });
  const f_preview = document.createElement("img");
  f_preview.className = "photo-preview";
  if (p.photo) f_preview.src = p.photo; else f_preview.style.display = "none";
  let photoData = p.photo || "";
  f_photo.addEventListener("change", async () => {
    const file = f_photo.files[0];
    if (!file) return;
    photoData = await readImageAsDataURL(file);
    f_preview.src = photoData; f_preview.style.display = "block";
  });

  const body = document.createElement("div");
  body.appendChild(field("제목", f_title));
  body.appendChild(row(field("색상", f_color), field("색상 태그", f_tag)));
  body.appendChild(row(field("시작 연월일", f_start), field("끝 연월일", f_end)));
  body.appendChild(field("핵심 인물", f_figures));
  body.appendChild(field("출처", f_source));
  body.appendChild(field("사진 첨부", f_photo));
  body.appendChild(f_preview);

  const footer = [];
  if (existing) {
    footer.push(mkBtn("삭제", "danger", () => {
      State.data.periods = State.data.periods.filter(x => x.id !== p.id);
      // flow의 해당 기간 참조 제거
      State.data.flows.forEach(fl => {
        fl.items = (fl.items || []).filter(it => !(it.type === "period" && it.id === p.id));
      });
      persistUserData(); render(); closeModal();
    }));
  }
  footer.push(mkBtn("취소", "cancel", closeModal));
  footer.push(mkBtn("저장", "primary", () => {
    const sd = f_start.value, ed = f_end.value;
    if (!sd || !ed) { alert("시작/끝 날짜를 입력하세요"); return; }
    const sy = +sd.slice(0,4), ey = +ed.slice(0,4);
    if (sy < YEAR_MIN || ey > YEAR_MAX) {
      alert(`${YEAR_MIN}~${YEAR_MAX} 범위 내로 입력하세요`); return;
    }
    if (ed < sd) { alert("끝 날짜가 시작보다 앞섭니다"); return; }
    const obj = {
      id: p.id, color: f_color.value, colorTag: f_tag.value.trim(),
      startDate: sd, endDate: ed,
      title: f_title.value.trim(),
      figures: f_figures.value.trim(),
      source: f_source.value.trim(),
      photo: photoData
    };
    const idx = State.data.periods.findIndex(x => x.id === obj.id);
    if (idx >= 0) State.data.periods[idx] = obj;
    else State.data.periods.push(obj);
    persistUserData(); render(); closeModal();
  }));
  openModal({ title: existing ? "기간 편집" : "기간 추가", body, footer });
}

// --- 포인트(Event) ---
function openEventEdit(existing = null) {
  const e0 = existing || {
    id: uid(), title: "", description: "", date: "1900-01-01",
    figures: "", photo: "", source: ""
  };
  const f_title = input("text", e0.title, { placeholder: "예: 빅토리아 여왕 즉위" });
  const f_date  = input("date", e0.date, { min: `${YEAR_MIN}-01-01`, max: `${YEAR_MAX}-12-31` });
  const f_desc  = textarea(e0.description);
  const f_fig   = textarea(e0.figures);
  const f_src   = textarea(e0.source);
  const f_photo = input("file", "", { accept: "image/*" });
  const f_prev  = document.createElement("img"); f_prev.className = "photo-preview";
  if (e0.photo) f_prev.src = e0.photo; else f_prev.style.display = "none";
  let photo = e0.photo || "";
  f_photo.addEventListener("change", async () => {
    const file = f_photo.files[0];
    if (!file) return;
    photo = await readImageAsDataURL(file);
    f_prev.src = photo; f_prev.style.display = "block";
  });

  const body = document.createElement("div");
  body.appendChild(field("제목", f_title));
  body.appendChild(field("연월일", f_date));
  body.appendChild(field("설명", f_desc));
  body.appendChild(field("핵심 인물", f_fig));
  body.appendChild(field("출처", f_src));
  body.appendChild(field("사진 첨부", f_photo));
  body.appendChild(f_prev);

  const footer = [];
  if (existing) {
    footer.push(mkBtn("삭제", "danger", () => {
      State.data.events = State.data.events.filter(x => x.id !== e0.id);
      // flow에서 제거
      State.data.flows.forEach(fl => {
        fl.eventIds = (fl.eventIds || []).filter(i => i !== e0.id);
      });
      persistUserData(); render(); closeModal();
    }));
  }
  footer.push(mkBtn("취소", "cancel", closeModal));
  footer.push(mkBtn("저장", "primary", () => {
    const y = new Date(f_date.value).getFullYear();
    if (!f_date.value || y < YEAR_MIN || y > YEAR_MAX) {
      alert(`${YEAR_MIN}~${YEAR_MAX} 범위의 날짜를 입력하세요`); return;
    }
    const obj = {
      id: e0.id, title: f_title.value.trim() || "(무제)",
      description: f_desc.value.trim(),
      date: f_date.value,
      figures: f_fig.value.trim(),
      source: f_src.value.trim(),
      photo
    };
    const idx = State.data.events.findIndex(x => x.id === obj.id);
    if (idx >= 0) State.data.events[idx] = obj;
    else State.data.events.push(obj);
    persistUserData(); render(); closeModal();
  }));
  openModal({ title: existing ? "포인트 편집" : "포인트 추가", body, footer });
}

// 포인트 상세 (제목 클릭 시)
function openEventDetail(e) {
  const body = document.createElement("div");
  const section = (k, v) => {
    if (!v) return;
    const s = document.createElement("div");
    s.className = "detail-section";
    s.innerHTML = `<div class="k">${k}</div><div class="v"></div>`;
    s.querySelector(".v").textContent = v;
    body.appendChild(s);
  };
  section("제목", e.title);
  section("연월일", e.date);
  section("설명", e.description);
  section("핵심 인물", e.figures);
  section("출처", e.source);
  if (e.photo) {
    const s = document.createElement("div");
    s.className = "detail-section";
    s.innerHTML = `<div class="k">사진</div>`;
    const img = document.createElement("img");
    img.className = "photo-preview"; img.src = e.photo;
    s.appendChild(img);
    body.appendChild(s);
  }
  const footer = [
    mkBtn("편집", "cancel", () => { closeModal(); openEventEdit(e); }),
    mkBtn("닫기", "primary", closeModal)
  ];
  openModal({ title: "포인트 상세", body, footer });
}

// --- 흐름(Flow) ---
function openFlowEdit(existing = null) {
  const f0 = existing || {
    id: uid(), title: "", description: "",
    color: "#ef4444", colorTag: "",
    items: []
  };
  const f_title = input("text", f0.title, { placeholder: "예: 산업혁명 → 제국주의" });
  const f_desc  = textarea(f0.description);
  const f_color = input("color", f0.color || "#ef4444");
  const f_tag   = input("text",  f0.colorTag || "", { placeholder: "태그 (예: 인과관계)" });

  // 후보: 기간 + 포인트. key = "type:id"
  const candidates = [
    ...State.data.periods.map(p => ({
      key: "period:" + p.id, type: "period", id: p.id,
      sortKey: p.startDate || "",
      label: `[기간] ${p.title || "기간"}  (${p.startDate || ""} ~ ${p.endDate || ""})`
    })),
    ...State.data.events.map(e => ({
      key: "event:" + e.id, type: "event", id: e.id,
      sortKey: e.date || "",
      label: `[포인트] ${e.title || "(무제)"}  (${e.date || ""})`
    }))
  ].sort((a,b) => a.sortKey.localeCompare(b.sortKey));

  // 현재 선택 순서 (배열 of "type:id")
  let selected = (flowItems(f0)).map(it => `${it.type}:${it.id}`);

  const listBox = document.createElement("div");
  listBox.className = "multi-select";
  if (!candidates.length) {
    listBox.textContent = "먼저 기간 또는 포인트를 추가하세요.";
  }
  function renderList() {
    listBox.innerHTML = "";
    candidates.forEach(c => {
      const idx = selected.indexOf(c.key);
      const row = document.createElement("label");
      const cb = input("checkbox");
      cb.checked = idx >= 0;
      cb.addEventListener("change", () => {
        if (cb.checked) {
          if (!selected.includes(c.key)) selected.push(c.key);
        } else {
          selected = selected.filter(k => k !== c.key);
        }
        renderList();
      });
      row.appendChild(cb);
      const order = document.createElement("span");
      order.style.cssText = "min-width:22px;display:inline-block;text-align:center;font-size:11px;color:#2563eb;font-weight:700";
      order.textContent = idx >= 0 ? `#${idx + 1}` : "";
      row.appendChild(order);
      const span = document.createElement("span");
      span.textContent = c.label;
      row.appendChild(span);
      listBox.appendChild(row);
    });
  }
  renderList();

  const body = document.createElement("div");
  body.appendChild(field("제목", f_title));
  body.appendChild(field("설명", f_desc));
  body.appendChild(row(field("화살표 색상", f_color), field("색상 태그", f_tag)));
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
    const items = selected.map(k => {
      const [type, ...rest] = k.split(":");
      return { type, id: rest.join(":") };
    });
    const obj = {
      id: f0.id,
      title: f_title.value.trim() || "(무제 흐름)",
      description: f_desc.value.trim(),
      color: f_color.value,
      colorTag: f_tag.value.trim(),
      items
    };
    // 구 필드 제거
    delete obj.eventIds;
    const idx = State.data.flows.findIndex(x => x.id === obj.id);
    if (idx >= 0) State.data.flows[idx] = obj;
    else State.data.flows.push(obj);
    persistUserData(); render(); closeModal();
  }));
  openModal({ title: existing ? "흐름 편집" : "흐름 추가", body, footer });
}

// --- 좌측 목록 ---
function renderLegend() {
  const lp = $("#list-periods"); lp.innerHTML = "";
  State.data.periods
    .slice()
    .sort((a,b) => (a.startDate || "").localeCompare(b.startDate || ""))
    .forEach(p => {
      const li = document.createElement("li");
      const tag = p.colorTag ? ` <small>#${escapeHtml(p.colorTag)}</small>` : "";
      li.innerHTML = `<span class="swatch" style="background:${p.color}"></span>
        <span>${escapeHtml(p.title || "기간")}${tag} <small>(${p.startDate || ""} ~ ${p.endDate || ""})</small></span>`;
      li.addEventListener("click", () => openPeriodEdit(p));
      lp.appendChild(li);
    });

  const le = $("#list-events"); le.innerHTML = "";
  State.data.events
    .slice()
    .sort((a,b) => (a.date||"").localeCompare(b.date||""))
    .forEach(e => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="swatch" style="background:#1d4ed8"></span>
        <span>${escapeHtml(e.title || "(무제)")} <small>${e.date || ""}</small></span>`;
      li.addEventListener("click", () => openEventDetail(e));
      le.appendChild(li);
    });

  const lf = $("#list-flows"); lf.innerHTML = "";
  State.data.flows.forEach(f => {
    const li = document.createElement("li");
    const tag = f.colorTag ? ` <small>#${escapeHtml(f.colorTag)}</small>` : "";
    const count = flowItems(f).length;
    li.innerHTML = `<span class="swatch" style="background:${f.color}"></span>
      <span>${escapeHtml(f.title || "(무제 흐름)")}${tag} <small>${count}개</small></span>`;
    li.addEventListener("click", () => openFlowEdit(f));
    lf.appendChild(li);
  });
}

/* ---------- 10. PNG 내보내기 + 줌 + 부트 ---------- */

// 주어진 옵션으로 타임라인 SVG 문자열을 새로 빌드 (현재 화면과 별개)
function buildExportSVG({ startYear, endYear, unit }) {
  // State.zoom / xFrom* 함수는 전역을 쓰므로, 임시 백업/복원
  const bakZoom = State.zoom;
  State.zoom = unit;
  const pxm = getPxPerMonth(unit);
  const x0 = xFromYear(startYear, pxm);
  const x1 = xFromYear(endYear + 1, pxm);
  const regionW = (x1 - x0) + LEFT_PAD + RIGHT_PAD;

  // 오프스크린 svg
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);

  // 레이아웃 계산 (전체 데이터 기준, 현재 상태 재사용)
  const allPeriodSegs = State.data.periods.map(p => {
    const b = periodBounds(p, pxm);
    return { id: p.id, x1: b.x1, x2: b.x2 };
  });
  const periodRows = assignRows(allPeriodSegs).rowCount;
  const allEventSegs = State.data.events.map(e => ({
    id: e.id,
    x1: xFromDate(e.date, pxm),
    x2: xFromDate(e.date, pxm) + estimateEventWidth(e)
  }));
  const eventRows = assignRows(allEventSegs).rowCount;
  const height = RULER_H + TOP_PAD + periodRows * (PERIOD_H + PERIOD_PAD)
               + LANE_GAP + eventRows * EVENT_ROW_H + 40;

  // 렌더 (일반 render와 동일한 좌표계)
  renderRuler(svg, pxm, height, { unit });
  const pY = RULER_H + TOP_PAD;
  const { yEnd: pBottom, positions: periodPos } = renderPeriods(svg, pxm, pY);
  const eY = pBottom + LANE_GAP;
  const { positions: eventPos } = renderEvents(svg, pxm, eY);
  renderFlows(svg, combinePositions(periodPos, eventPos));

  // viewBox를 [startYear, endYear] 범위로 잘라냄
  svg.setAttribute("viewBox", `${x0 - LEFT_PAD} 0 ${regionW} ${height}`);
  svg.setAttribute("width", regionW);
  svg.setAttribute("height", height);
  // 배경 (맨 아래)
  const bg = el("rect", { x: x0 - LEFT_PAD, y: 0, width: regionW, height, fill: "#ffffff" });
  svg.insertBefore(bg, svg.firstChild);

  // CSS 인라인 (export 독립성 위해)
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = `
    .grid-line { stroke:#eef1f5 } .grid-line.major{stroke:#cbd5e1}
    .grid-line.year{stroke:#94a3b8}
    .tick-label { font:10px sans-serif; fill:#64748b }
    .tick-label.year { font:700 12px sans-serif; fill:#334155 }
    .period-label { font:600 11px sans-serif; fill:#111 }
    .event-label { font:11px sans-serif; fill:#1f2430 }
  `;
  svg.insertBefore(style, svg.firstChild);

  State.zoom = bakZoom;
  return { svg, width: regionW, height };
}

async function exportPng({ startYear, endYear, unit }) {
  const { svg, width, height } = buildExportSVG({ startYear, endYear, unit });
  const xml = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.decoding = "sync";
  await new Promise((res, rej) => {
    img.onload = res; img.onerror = rej; img.src = url;
  });

  const scale = Math.min(2, Math.max(1, 1600 / width)); // 해상도 보정
  const canvas = document.createElement("canvas");
  canvas.width  = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);

  canvas.toBlob(blob => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `timeline_${startYear}-${endYear}_${unit}m.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");
}

function openExportDialog() {
  const f_start = input("number", 1850, { min: YEAR_MIN, max: YEAR_MAX });
  const f_end   = input("number", 2000, { min: YEAR_MIN, max: YEAR_MAX });
  const f_unit  = document.createElement("select");
  [["6","6개월"],["3","3개월"],["1","1개월"]].forEach(([v,l]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = l;
    f_unit.appendChild(o);
  });
  f_unit.value = String(State.zoom);
  const body = document.createElement("div");
  body.appendChild(row(field("시작 연도", f_start), field("끝 연도", f_end)));
  body.appendChild(field("단위", f_unit));
  const footer = [
    mkBtn("취소", "cancel", closeModal),
    mkBtn("내보내기", "primary", async () => {
      const s = clampYear(+f_start.value);
      const e = clampYear(+f_end.value);
      if (e < s) return alert("끝 연도가 시작보다 작습니다");
      closeModal();
      await exportPng({ startYear: s, endYear: e, unit: +f_unit.value });
    })
  ];
  openModal({ title: "PNG 내보내기", body, footer });
}

// 줌 컨트롤
function setZoom(z) {
  State.zoom = z;
  $$(".seg-btn").forEach(b => b.classList.toggle("active", +b.dataset.zoom === z));
  render();
}

/* --- 부트 --- */
function wireAuth() {
  $("#auth-form").addEventListener("submit", handleLogin);
  $("#btn-register").addEventListener("click", handleRegister);
}
function wireApp() {
  $("#btn-logout").addEventListener("click", handleLogout);
  $("#btn-add-period").addEventListener("click", () => openPeriodEdit());
  $("#btn-add-event").addEventListener("click", () => openEventEdit());
  $("#btn-add-flow").addEventListener("click", () => openFlowEdit());
  $("#btn-export").addEventListener("click", openExportDialog);
  $$(".seg-btn").forEach(b => b.addEventListener("click", () => setZoom(+b.dataset.zoom)));
  $("#modal-root").addEventListener("click", (e) => {
    if (e.target.dataset.close === "1") closeModal();
  });
}

function boot() {
  wireAuth();
  wireApp();
  const store = loadStore();
  if (store.session && store.users[store.session.username]) {
    enterApp(store.session.username);
  }
}

document.addEventListener("DOMContentLoaded", boot);
