import "dotenv/config";
import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const sql = neon(process.env.DATABASE_URL);
const statements = schema.split(/;\s*(?:\r?\n|$)/).map(statement => statement.trim()).filter(Boolean);
for (const statement of statements) await sql.query(statement);
console.log("Database schema applied.");
