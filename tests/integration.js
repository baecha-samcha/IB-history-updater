import "dotenv/config";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { server } from "../server.js";

const baseUrl = `http://localhost:${process.env.PORT || 3000}/api`;
const username = `integration_${Date.now()}`;
const password = "integration-test-password";
const eventId = "event-test";
const sql = neon(process.env.DATABASE_URL);
let token;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  const body = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const emptyData = () => ({ colorTags: [], periods: [], events: [], flows: [] });

try {
  await request("/auth/register", { method: "POST", body: JSON.stringify({ username, password }) });
  const login = await request("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  token = login.token;

  const created = emptyData();
  created.events.push({ id: eventId, title: "Created", date: "1900-01-01", description: "CRUD test", figures: "", source: "", photo: "", colorTagIds: [] });
  await request("/data", { method: "PUT", body: JSON.stringify({ data: created }) });
  assert.equal((await request("/data")).data.events[0].title, "Created");

  created.events[0].title = "Updated";
  await request("/data", { method: "PUT", body: JSON.stringify({ data: created }) });
  assert.equal((await request("/data")).data.events[0].title, "Updated");

  await request("/data", { method: "PUT", body: JSON.stringify({ data: emptyData() }) });
  assert.equal((await request("/data")).data.events.length, 0);
  const rows = await sql`SELECT e.is_deleted FROM events e JOIN app_users u ON u.id=e.user_id WHERE u.username=${username} AND e.id=${eventId}`;
  assert.equal(rows[0]?.is_deleted, true);
  console.log("Integration CRUD and soft-delete validation completed.");
} finally {
  await sql`UPDATE user_sessions SET is_deleted=true WHERE user_id IN (SELECT id FROM app_users WHERE username=${username})`;
  await sql`UPDATE app_users SET is_deleted=true WHERE username=${username}`;
  await new Promise(resolve => server.close(resolve));
}
