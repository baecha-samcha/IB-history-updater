import "dotenv/config";
import mysql from "mysql2/promise";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  connectionLimit: 10,
  dateStrings: true,
  timezone: "Z",
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

pool.on("connection", connection => {
  connection.query("SET SESSION time_zone = '+00:00'", error => {
    if (error) connection.destroy();
  });
});

async function query(statement, values = [], connection = pool) {
  const [rows] = await connection.execute(statement, values);
  return rows;
}

async function transaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback((statement, values = []) => query(statement, values, connection));
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export { pool, query, transaction };
