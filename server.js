import "dotenv/config";
import crypto from "node:crypto";
import { promisify } from "node:util";
import express from "express";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = neon(process.env.DATABASE_URL);
const scrypt = promisify(crypto.scrypt);
const app = express();
const port = Number(process.env.PORT || 3000);
const sharedUserId = "00000000-0000-0000-0000-000000000001";

app.use(express.json({ limit: "20mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const text = value => (value == null ? "" : String(value));
const nullable = value => (value ? String(value) : null);
const ids = value => (Array.isArray(value) ? value.map(String) : []);

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString("hex") };
}

async function authenticate(req, res, next) {
  const token = req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const rows = await sql`
    SELECT u.id, u.username
    FROM user_sessions s JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ${hashToken(token)} AND s.is_deleted = false
      AND s.expires_at > now() AND u.is_deleted = false
  `;
  if (!rows.length) return res.status(401).json({ error: "Session expired" });
  req.user = rows[0];
  req.tokenHash = hashToken(token);
  next();
}

app.post("/api/auth/register", async (req, res) => {
  const username = text(req.body?.username).trim();
  const password = text(req.body?.password);
  if (username.length < 2 || username.length > 50 || password.length < 6) {
    return res.status(400).json({ error: "Username must be 2-50 characters and password at least 6 characters" });
  }
  const { salt, hash } = await hashPassword(password);
  try {
    await sql`INSERT INTO app_users (username, password_hash, password_salt) VALUES (${username}, ${hash}, ${salt})`;
    res.status(201).json({ ok: true });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Username already exists" });
    throw error;
  }
});

app.post("/api/auth/login", async (req, res) => {
  const username = text(req.body?.username).trim();
  const password = text(req.body?.password);
  const rows = await sql`SELECT id, username, password_hash, password_salt FROM app_users WHERE lower(username) = lower(${username}) AND is_deleted = false LIMIT 1`;
  if (!rows.length) return res.status(401).json({ error: "Invalid username or password" });
  const candidate = await hashPassword(password, rows[0].password_salt);
  const stored = Buffer.from(rows[0].password_hash, "hex");
  const actual = Buffer.from(candidate.hash, "hex");
  if (stored.length !== actual.length || !crypto.timingSafeEqual(stored, actual)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  await sql`INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (${hashToken(token)}, ${rows[0].id}, now() + interval '30 days')`;
  res.json({ token, username: rows[0].username });
});

app.get("/api/auth/me", authenticate, (req, res) => res.json({ username: req.user.username }));
app.post("/api/auth/logout", authenticate, async (req, res) => {
  await sql`UPDATE user_sessions SET is_deleted = true WHERE token_hash = ${req.tokenHash}`;
  res.json({ ok: true });
});

async function getSharedData() {
  const userId = sharedUserId;
  const [colorTags, periods, events, flows, flowItems] = await Promise.all([
    sql`SELECT id, name, color FROM color_tags WHERE user_id = ${userId} AND is_deleted = false ORDER BY updated_at`,
    sql`SELECT id, title, start_date, end_date, figures, source, photo, color_tag_ids FROM periods WHERE user_id = ${userId} AND is_deleted = false ORDER BY updated_at`,
    sql`SELECT id, title, event_date, description, figures, source, photo, color_tag_ids FROM events WHERE user_id = ${userId} AND is_deleted = false ORDER BY updated_at`,
    sql`SELECT id, title, description, color_tag_ids FROM flows WHERE user_id = ${userId} AND is_deleted = false ORDER BY updated_at`,
    sql`SELECT flow_id, position, item_type, item_id FROM flow_items WHERE user_id = ${userId} AND is_deleted = false ORDER BY flow_id, position`
  ]);
  return {
    colorTags: colorTags.map(r => ({ id: r.id, name: r.name, color: r.color })),
    periods: periods.map(r => ({ id: r.id, title: r.title, startDate: r.start_date, endDate: r.end_date, figures: r.figures, source: r.source, photo: r.photo, colorTagIds: r.color_tag_ids })),
    events: events.map(r => ({ id: r.id, title: r.title, date: r.event_date, description: r.description, figures: r.figures, source: r.source, photo: r.photo, colorTagIds: r.color_tag_ids })),
    flows: flows.map(r => ({ id: r.id, title: r.title, description: r.description, colorTagIds: r.color_tag_ids,
      items: flowItems.filter(i => i.flow_id === r.id).map(i => ({ type: i.item_type, id: i.item_id })) }))
  };
}

app.get("/api/data", authenticate, async (req, res) => {
  const state = await sql`SELECT version FROM workspace_state WHERE id = 'shared'`;
  const version = Number(state[0].version);
  if (Number(req.query.version) === version) return res.json({ unchanged: true, version });
  res.json({ data: await getSharedData(), version });
});

app.post("/api/data/batch", authenticate, async (req, res) => {
  const operations = req.body?.operations;
  if (!Array.isArray(operations) || !operations.length) {
    return res.status(400).json({ error: "At least one operation is required" });
  }
  const userId = sharedUserId;
  const queries = [];
  for (const operation of operations) {
    const action = operation?.action;
    const entity = operation?.entity;
    const item = operation?.item || {};
    const id = text(operation?.id || item.id);
    if (!id || !["upsert", "delete"].includes(action) || !["colorTag", "period", "event", "flow"].includes(entity)) {
      return res.status(400).json({ error: "Invalid batch operation" });
    }
    if (action === "delete") {
      if (entity === "colorTag") queries.push(sql`UPDATE color_tags SET is_deleted=true, updated_at=now() WHERE user_id=${userId} AND id=${id}`);
      if (entity === "period") {
        queries.push(sql`UPDATE periods SET is_deleted=true, updated_at=now() WHERE user_id=${userId} AND id=${id}`);
        queries.push(sql`UPDATE flow_items SET is_deleted=true, updated_at=now() WHERE user_id=${userId} AND item_type='period' AND item_id=${id}`);
      }
      if (entity === "event") {
        queries.push(sql`UPDATE events SET is_deleted=true, updated_at=now() WHERE user_id=${userId} AND id=${id}`);
        queries.push(sql`UPDATE flow_items SET is_deleted=true, updated_at=now() WHERE user_id=${userId} AND item_type='event' AND item_id=${id}`);
      }
      if (entity === "flow") {
        queries.push(sql`UPDATE flow_items SET is_deleted=true, updated_at=now() WHERE user_id=${userId} AND flow_id=${id}`);
        queries.push(sql`UPDATE flows SET is_deleted=true, updated_at=now() WHERE user_id=${userId} AND id=${id}`);
      }
      continue;
    }
    if (entity === "colorTag") queries.push(sql`
      INSERT INTO color_tags (id,user_id,name,color) VALUES (${id},${userId},${text(item.name)},${text(item.color)})
      ON CONFLICT (user_id,id) DO UPDATE SET name=EXCLUDED.name,color=EXCLUDED.color,is_deleted=false,updated_at=now()`);
    if (entity === "period") queries.push(sql`
      INSERT INTO periods (id,user_id,title,start_date,end_date,figures,source,photo,color_tag_ids)
      VALUES (${id},${userId},${text(item.title)},${nullable(item.startDate)},${nullable(item.endDate)},${text(item.figures)},${text(item.source)},${text(item.photo)},${ids(item.colorTagIds)})
      ON CONFLICT (user_id,id) DO UPDATE SET title=EXCLUDED.title,start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,figures=EXCLUDED.figures,source=EXCLUDED.source,photo=EXCLUDED.photo,color_tag_ids=EXCLUDED.color_tag_ids,is_deleted=false,updated_at=now()`);
    if (entity === "event") queries.push(sql`
      INSERT INTO events (id,user_id,title,event_date,description,figures,source,photo,color_tag_ids)
      VALUES (${id},${userId},${text(item.title)},${nullable(item.date)},${text(item.description)},${text(item.figures)},${text(item.source)},${text(item.photo)},${ids(item.colorTagIds)})
      ON CONFLICT (user_id,id) DO UPDATE SET title=EXCLUDED.title,event_date=EXCLUDED.event_date,description=EXCLUDED.description,figures=EXCLUDED.figures,source=EXCLUDED.source,photo=EXCLUDED.photo,color_tag_ids=EXCLUDED.color_tag_ids,is_deleted=false,updated_at=now()`);
    if (entity === "flow") {
      queries.push(sql`INSERT INTO flows (id,user_id,title,description,color_tag_ids) VALUES (${id},${userId},${text(item.title)},${text(item.description)},${ids(item.colorTagIds)}) ON CONFLICT (user_id,id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,color_tag_ids=EXCLUDED.color_tag_ids,is_deleted=false,updated_at=now()`);
      queries.push(sql`UPDATE flow_items SET is_deleted=true,updated_at=now() WHERE user_id=${userId} AND flow_id=${id} AND is_deleted=false`);
      (item.items || []).forEach((flowItem, position) => queries.push(sql`
        INSERT INTO flow_items (user_id,flow_id,position,item_type,item_id) VALUES (${userId},${id},${position},${text(flowItem.type)},${text(flowItem.id)})
        ON CONFLICT (user_id,flow_id,position) DO UPDATE SET item_type=EXCLUDED.item_type,item_id=EXCLUDED.item_id,is_deleted=false,updated_at=now()`));
    }
  }
  queries.push(sql`UPDATE workspace_state SET version=version+1,updated_at=now() WHERE id='shared' RETURNING version`);
  const results = await sql.transaction(queries);
  const version = Number(results.at(-1)[0].version);
  res.json({ ok: true, version });
});

app.use(express.static(process.cwd(), { extensions: ["html"] }));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(port, () => console.log(`IB History listening on http://localhost:${port}`));

export { app, server };
