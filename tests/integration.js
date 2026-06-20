import "dotenv/config";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { server } from "../server.js";

const baseUrl = `http://localhost:${process.env.PORT || 3000}/api`;
const usernameA = `integration_a_${Date.now()}`;
const usernameB = `integration_b_${Date.now()}`;
const password = "integration-test-password";
const eventId = `event_${Date.now()}`;
const secondEventId = `${eventId}_second`;
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

try {
  for (const username of [usernameA, usernameB]) {
    await request("/auth/register", { method: "POST", body: JSON.stringify({ username, password }) });
  }
  token = (await request("/auth/login", { method: "POST", body: JSON.stringify({ username: usernameA, password }) })).token;
  const created = { id: eventId, title: "Created by A", date: "1900-01-01", description: "Collaboration test", figures: "", source: "", photo: "", colorTagIds: [] };
  const createResult = await request("/data/batch", { method: "POST", body: JSON.stringify({ operations: [{ action: "upsert", entity: "event", item: created }] }) });

  token = (await request("/auth/login", { method: "POST", body: JSON.stringify({ username: usernameB, password }) })).token;
  const sharedForB = await request("/data");
  assert.equal(sharedForB.data.events.find(event => event.id === eventId)?.title, "Created by A");
  const updated = { ...created, title: "Updated by B" };
  const second = { ...created, id: secondEventId, title: "Created by B" };
  const updateResult = await request("/data/batch", { method: "POST", body: JSON.stringify({ operations: [
    { action: "upsert", entity: "event", item: updated },
    { action: "upsert", entity: "event", item: second }
  ] }) });
  assert.ok(updateResult.version > createResult.version);

  token = (await request("/auth/login", { method: "POST", body: JSON.stringify({ username: usernameA, password }) })).token;
  const sharedForA = await request(`/data?version=${createResult.version}`);
  assert.equal(sharedForA.data.events.find(event => event.id === eventId)?.title, "Updated by B");
  assert.equal(sharedForA.data.events.find(event => event.id === secondEventId)?.title, "Created by B");
  await request("/data/batch", { method: "POST", body: JSON.stringify({ operations: [
    { action: "delete", entity: "event", id: eventId },
    { action: "delete", entity: "event", id: secondEventId }
  ] }) });
  assert.equal((await request("/data")).data.events.some(event => [eventId, secondEventId].includes(event.id)), false);
  const rows = await sql`SELECT is_deleted FROM events WHERE user_id='00000000-0000-0000-0000-000000000001' AND id=${eventId}`;
  assert.equal(rows[0]?.is_deleted, true);
  console.log("Multi-user collaboration and soft-delete validation completed.");
} finally {
  await sql`UPDATE events SET is_deleted=true WHERE user_id='00000000-0000-0000-0000-000000000001' AND id IN (${eventId},${secondEventId})`;
  await sql`UPDATE user_sessions SET is_deleted=true WHERE user_id IN (SELECT id FROM app_users WHERE username IN (${usernameA},${usernameB}))`;
  await sql`UPDATE app_users SET is_deleted=true WHERE username IN (${usernameA},${usernameB})`;
  await new Promise(resolve => server.close(resolve));
}
