import "dotenv/config";
import { readFile } from "node:fs/promises";
import { pool, query } from "../db/client.js";

const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const statements = schema.split(/;\s*(?:\r?\n|$)/).map(statement => statement.trim()).filter(Boolean);
for (const statement of statements) await query(statement);
await pool.end();
console.log("Database schema applied.");
