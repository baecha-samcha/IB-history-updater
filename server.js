import "dotenv/config";
import crypto from "node:crypto";
import { promisify } from "node:util";
import express from "express";
import { query, transaction } from "./db/client.js";

const scrypt = promisify(crypto.scrypt);
const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const sharedUserId = "00000000-0000-0000-0000-000000000001";

app.use(express.json({ limit: "20mb" }));

app.get("/api/health", async (req, res) => {
  await query("SELECT 1");
  res.json({ ok: true, database: "mariadb" });
});

const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const dateOnly = value => value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : null;
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
  const rows = await query(`
    SELECT u.id, u.username
    FROM user_sessions s JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.is_deleted = false
      AND s.expires_at > current_timestamp(3) AND u.is_deleted = false
  `, [hashToken(token)]);
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
    await query("INSERT INTO app_users (username, password_hash, password_salt) VALUES (?, ?, ?)", [username, hash, salt]);
    res.status(201).json({ ok: true });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Username already exists" });
    throw error;
  }
});

app.post("/api/auth/login", async (req, res) => {
  const username = text(req.body?.username).trim();
  const password = text(req.body?.password);
  const rows = await query("SELECT id, username, password_hash, password_salt FROM app_users WHERE lower(username) = lower(?) AND is_deleted = false LIMIT 1", [username]);
  if (!rows.length) return res.status(401).json({ error: "Invalid username or password" });
  const candidate = await hashPassword(password, rows[0].password_salt);
  const stored = Buffer.from(rows[0].password_hash, "hex");
  const actual = Buffer.from(candidate.hash, "hex");
  if (stored.length !== actual.length || !crypto.timingSafeEqual(stored, actual)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  await query("INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, current_timestamp(3) + INTERVAL 30 DAY)", [hashToken(token), rows[0].id]);
  res.json({ token, username: rows[0].username });
});

app.get("/api/auth/me", authenticate, (req, res) => res.json({ username: req.user.username }));
app.post("/api/auth/logout", authenticate, async (req, res) => {
  await query("UPDATE user_sessions SET is_deleted = true WHERE token_hash = ?", [req.tokenHash]);
  res.json({ ok: true });
});

async function getSharedData() {
  const userId = sharedUserId;
  const [colorTags, periods, events, flows, flowItems] = await Promise.all([
    query("SELECT id, name, color FROM color_tags WHERE user_id = ? AND is_deleted = false ORDER BY updated_at", [userId]),
    query("SELECT id, title, start_date, end_date, figures, source, photo, color_tag_ids FROM periods WHERE user_id = ? AND is_deleted = false ORDER BY updated_at", [userId]),
    query("SELECT id, title, event_date, description, figures, source, photo, color_tag_ids FROM events WHERE user_id = ? AND is_deleted = false ORDER BY updated_at", [userId]),
    query("SELECT id, title, description, color_tag_ids FROM flows WHERE user_id = ? AND is_deleted = false ORDER BY updated_at", [userId]),
    query("SELECT flow_id, position, item_type, item_id FROM flow_items WHERE user_id = ? AND is_deleted = false ORDER BY flow_id, position", [userId])
  ]);
  const jsonArray = value => Array.isArray(value) ? value : JSON.parse(value || "[]");
  return {
    colorTags: colorTags.map(r => ({ id: r.id, name: r.name, color: r.color })),
    periods: periods.map(r => ({ id: r.id, title: r.title, startDate: dateOnly(r.start_date), endDate: dateOnly(r.end_date), figures: r.figures, source: r.source, photo: r.photo, colorTagIds: jsonArray(r.color_tag_ids) })),
    events: events.map(r => ({ id: r.id, title: r.title, date: dateOnly(r.event_date), description: r.description, figures: r.figures, source: r.source, photo: r.photo, colorTagIds: jsonArray(r.color_tag_ids) })),
    flows: flows.map(r => ({ id: r.id, title: r.title, description: r.description, colorTagIds: jsonArray(r.color_tag_ids),
      items: flowItems.filter(i => i.flow_id === r.id).map(i => ({ type: i.item_type, id: i.item_id })) }))
  };
}

app.get("/api/data", authenticate, async (req, res) => {
  const state = await query("SELECT version FROM workspace_state WHERE id = 'shared'");
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
  for (const operation of operations) {
    const action = operation?.action;
    const entity = operation?.entity;
    const item = operation?.item || {};
    const id = text(operation?.id || item.id);
    if (!id || !["upsert", "delete"].includes(action) || !["colorTag", "period", "event", "flow"].includes(entity)) {
      return res.status(400).json({ error: "Invalid batch operation" });
    }
  }
  const version = await transaction(async execute => {
    await execute("SELECT version FROM workspace_state WHERE id = 'shared' FOR UPDATE");
    for (const operation of operations) {
      const { action, entity } = operation;
      const item = operation.item || {};
      const id = text(operation.id || item.id);
      if (action === "delete") {
        if (entity === "colorTag") await execute("UPDATE color_tags SET is_deleted=true, updated_at=current_timestamp(3) WHERE user_id=? AND id=?", [userId, id]);
        if (entity === "period") {
          await execute("UPDATE periods SET is_deleted=true, updated_at=current_timestamp(3) WHERE user_id=? AND id=?", [userId, id]);
          await execute("UPDATE flow_items SET is_deleted=true, updated_at=current_timestamp(3) WHERE user_id=? AND item_type='period' AND item_id=?", [userId, id]);
        }
        if (entity === "event") {
          await execute("UPDATE events SET is_deleted=true, updated_at=current_timestamp(3) WHERE user_id=? AND id=?", [userId, id]);
          await execute("UPDATE flow_items SET is_deleted=true, updated_at=current_timestamp(3) WHERE user_id=? AND item_type='event' AND item_id=?", [userId, id]);
        }
        if (entity === "flow") {
          await execute("UPDATE flow_items SET is_deleted=true, updated_at=current_timestamp(3) WHERE user_id=? AND flow_id=?", [userId, id]);
          await execute("UPDATE flows SET is_deleted=true, updated_at=current_timestamp(3) WHERE user_id=? AND id=?", [userId, id]);
        }
        continue;
      }
      if (entity === "colorTag") await execute(`
        INSERT INTO color_tags (id,user_id,name,color) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE name=VALUES(name),color=VALUES(color),is_deleted=false,updated_at=current_timestamp(3)`,
        [id, userId, text(item.name), text(item.color)]);
      if (entity === "period") await execute(`
        INSERT INTO periods (id,user_id,title,start_date,end_date,figures,source,photo,color_tag_ids)
        VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),start_date=VALUES(start_date),
        end_date=VALUES(end_date),figures=VALUES(figures),source=VALUES(source),photo=VALUES(photo),
        color_tag_ids=VALUES(color_tag_ids),is_deleted=false,updated_at=current_timestamp(3)`,
        [id, userId, text(item.title), nullable(item.startDate), nullable(item.endDate), text(item.figures), text(item.source), text(item.photo), JSON.stringify(ids(item.colorTagIds))]);
      if (entity === "event") await execute(`
        INSERT INTO events (id,user_id,title,event_date,description,figures,source,photo,color_tag_ids)
        VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),event_date=VALUES(event_date),
        description=VALUES(description),figures=VALUES(figures),source=VALUES(source),photo=VALUES(photo),
        color_tag_ids=VALUES(color_tag_ids),is_deleted=false,updated_at=current_timestamp(3)`,
        [id, userId, text(item.title), nullable(item.date), text(item.description), text(item.figures), text(item.source), text(item.photo), JSON.stringify(ids(item.colorTagIds))]);
      if (entity === "flow") {
        await execute(`INSERT INTO flows (id,user_id,title,description,color_tag_ids) VALUES (?,?,?,?,?)
          ON DUPLICATE KEY UPDATE title=VALUES(title),description=VALUES(description),color_tag_ids=VALUES(color_tag_ids),is_deleted=false,updated_at=current_timestamp(3)`,
          [id, userId, text(item.title), text(item.description), JSON.stringify(ids(item.colorTagIds))]);
        await execute("UPDATE flow_items SET is_deleted=true,updated_at=current_timestamp(3) WHERE user_id=? AND flow_id=? AND is_deleted=false", [userId, id]);
        for (const [position, flowItem] of (item.items || []).entries()) {
          await execute(`INSERT INTO flow_items (user_id,flow_id,position,item_type,item_id) VALUES (?,?,?,?,?)
            ON DUPLICATE KEY UPDATE item_type=VALUES(item_type),item_id=VALUES(item_id),is_deleted=false,updated_at=current_timestamp(3)`,
            [userId, id, position, text(flowItem.type), text(flowItem.id)]);
        }
      }
    }
    await execute("UPDATE workspace_state SET version=version+1,updated_at=current_timestamp(3) WHERE id='shared'");
    const rows = await execute("SELECT version FROM workspace_state WHERE id='shared'");
    return Number(rows[0].version);
  });
  res.json({ ok: true, version });
});

app.use(express.static(process.cwd(), { extensions: ["html"] }));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(port, host, () => console.log(`IB History listening on http://${host}:${port}`));

export { app, server };
