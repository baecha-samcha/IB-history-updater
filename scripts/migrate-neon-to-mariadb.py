#!/usr/bin/env python3
"""Copy the history timeline data from Neon PostgreSQL to an empty MariaDB database."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import unquote, urlparse

try:
    import psycopg
    from psycopg.rows import dict_row
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError as exc:  # pragma: no cover - depends on the operator environment
    raise SystemExit(
        "Missing migration dependency. Install psycopg[binary] and PyMySQL in an isolated environment."
    ) from exc


TABLES = (
    "app_users",
    "workspace_state",
    "color_tags",
    "periods",
    "events",
    "flows",
    "flow_items",
    "user_sessions",
)

SPECS = {
    "app_users": {
        "columns": ("id", "username", "password_hash", "password_salt", "is_deleted", "created_at"),
        "pk": ("id",),
        "booleans": ("is_deleted",),
        "timestamps": ("created_at",),
    },
    "workspace_state": {
        "columns": ("id", "version", "updated_at"),
        "pk": ("id",),
        "timestamps": ("updated_at",),
    },
    "color_tags": {
        "columns": ("id", "user_id", "name", "color", "is_deleted", "updated_at"),
        "pk": ("user_id", "id"),
        "booleans": ("is_deleted",),
        "timestamps": ("updated_at",),
    },
    "periods": {
        "columns": ("id", "user_id", "title", "start_date", "end_date", "figures", "source", "photo", "color_tag_ids", "is_deleted", "updated_at"),
        "pk": ("user_id", "id"),
        "json": ("color_tag_ids",),
        "booleans": ("is_deleted",),
        "timestamps": ("updated_at",),
    },
    "events": {
        "columns": ("id", "user_id", "title", "event_date", "description", "figures", "source", "photo", "color_tag_ids", "is_deleted", "updated_at"),
        "pk": ("user_id", "id"),
        "json": ("color_tag_ids",),
        "booleans": ("is_deleted",),
        "timestamps": ("updated_at",),
    },
    "flows": {
        "columns": ("id", "user_id", "title", "description", "color_tag_ids", "is_deleted", "updated_at"),
        "pk": ("user_id", "id"),
        "json": ("color_tag_ids",),
        "booleans": ("is_deleted",),
        "timestamps": ("updated_at",),
    },
    "flow_items": {
        "columns": ("user_id", "flow_id", "position", "item_type", "item_id", "is_deleted", "updated_at"),
        "pk": ("user_id", "flow_id", "position"),
        "booleans": ("is_deleted",),
        "timestamps": ("updated_at",),
    },
    "user_sessions": {
        "columns": ("token_hash", "user_id", "expires_at", "is_deleted", "created_at"),
        "pk": ("token_hash",),
        "booleans": ("is_deleted",),
        "timestamps": ("expires_at", "created_at"),
    },
}

BOOTSTRAP_USER_ID = "00000000-0000-0000-0000-000000000001"


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-schema-seed",
        action="store_true",
        help="allow only the two bootstrap rows inserted by db/schema.sql",
    )
    parser.add_argument(
        "--skip-user-sessions",
        action="store_true",
        help="do not copy sessions; users will need to sign in again",
    )
    parser.add_argument(
        "--allow-non-test-database",
        action="store_true",
        help="permit a target database whose name does not end in _migration_test",
    )
    return parser.parse_args()


def mariadb_config() -> dict[str, Any]:
    raw_url = os.environ.get("MARIADB_URL")
    if raw_url:
        parsed = urlparse(raw_url)
        if parsed.scheme not in {"mysql", "mariadb"}:
            raise ValueError("MARIADB_URL must use mysql:// or mariadb://")
        database = parsed.path.lstrip("/")
        if not database:
            raise ValueError("MARIADB_URL must include a database name")
        return {
            "host": parsed.hostname or "127.0.0.1",
            "port": parsed.port or 3306,
            "user": unquote(parsed.username or ""),
            "password": unquote(parsed.password or ""),
            "database": unquote(database),
        }

    database = os.environ.get("MARIADB_DATABASE")
    user = os.environ.get("MARIADB_USER")
    if not database or not user:
        raise ValueError("Set MARIADB_DATABASE and MARIADB_USER, or set MARIADB_URL")
    config: dict[str, Any] = {
        "host": os.environ.get("MARIADB_HOST", "127.0.0.1"),
        "port": int(os.environ.get("MARIADB_PORT", "3306")),
        "user": user,
        "password": os.environ.get("MARIADB_PASSWORD", ""),
        "database": database,
    }
    if os.environ.get("MARIADB_UNIX_SOCKET"):
        config["unix_socket"] = os.environ["MARIADB_UNIX_SOCKET"]
    return config


def source_rows(pg: psycopg.Connection[Any], table: str) -> list[dict[str, Any]]:
    spec = SPECS[table]
    columns = ", ".join(f'"{column}"' for column in spec["columns"])
    order = ", ".join(f'"{column}"' for column in spec["pk"])
    with pg.cursor() as cursor:
        cursor.execute(f'SELECT {columns} FROM "public"."{table}" ORDER BY {order}')
        return list(cursor.fetchall())


def utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc).replace(tzinfo=None)
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def insert_value(table: str, column: str, value: Any) -> Any:
    if value is None:
        return None
    spec = SPECS[table]
    if column in spec.get("json", ()):
        if not isinstance(value, (list, tuple)):
            raise ValueError(f"{table}.{column} is not a PostgreSQL array")
        return json.dumps([str(item) for item in value], ensure_ascii=False, separators=(",", ":"))
    if column in spec.get("timestamps", ()):
        if not isinstance(value, datetime):
            raise ValueError(f"{table}.{column} is not a timestamp")
        return utc_naive(value)
    # psycopg returns UUID objects; str() preserves their canonical value.
    if column in {"id", "user_id"} and not isinstance(value, (str, int)):
        return str(value)
    return value


def table_counts(cursor: DictCursor) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in TABLES:
        cursor.execute(f"SELECT COUNT(*) AS row_count FROM `{table}`")
        counts[table] = int(cursor.fetchone()["row_count"])
    return counts


def require_safe_target(cursor: DictCursor, allow_schema_seed: bool) -> None:
    counts = table_counts(cursor)
    if not any(counts.values()):
        return
    if not allow_schema_seed:
        populated = ", ".join(f"{table}={count}" for table, count in counts.items() if count)
        raise RuntimeError(f"target is not empty ({populated}); migration stopped")

    expected = {table: 0 for table in TABLES}
    expected.update({"app_users": 1, "workspace_state": 1})
    if counts != expected:
        raise RuntimeError("--allow-schema-seed accepts only the exact db/schema.sql bootstrap row counts")
    cursor.execute(
        "SELECT COUNT(*) AS matches FROM app_users "
        "WHERE id=%s AND username='__shared_workspace__' AND password_hash='system' "
        "AND password_salt='system' AND is_deleted=false",
        (BOOTSTRAP_USER_ID,),
    )
    if int(cursor.fetchone()["matches"]) != 1:
        raise RuntimeError("the existing app_users row is not the expected schema bootstrap user")
    cursor.execute("SELECT COUNT(*) AS matches FROM workspace_state WHERE id='shared' AND version=0")
    if int(cursor.fetchone()["matches"]) != 1:
        raise RuntimeError("the existing workspace_state row is not the expected schema bootstrap state")


def insert_rows(cursor: DictCursor, table: str, rows: list[dict[str, Any]], allow_seed: bool) -> None:
    if not rows:
        return
    columns = SPECS[table]["columns"]
    quoted = ", ".join(f"`{column}`" for column in columns)
    placeholders = ", ".join(["%s"] * len(columns))
    sql = f"INSERT INTO `{table}` ({quoted}) VALUES ({placeholders})"
    if allow_seed and table in {"app_users", "workspace_state"}:
        non_pk = [column for column in columns if column not in SPECS[table]["pk"]]
        updates = ", ".join(f"`{column}`=VALUES(`{column}`)" for column in non_pk)
        sql += f" ON DUPLICATE KEY UPDATE {updates}"
    values = [tuple(insert_value(table, column, row[column]) for column in columns) for row in rows]
    cursor.executemany(sql, values)


def canonical(table: str, row: dict[str, Any]) -> tuple[Any, ...]:
    spec = SPECS[table]
    result: list[Any] = []
    for column in spec["columns"]:
        value = row[column]
        if value is None:
            result.append(None)
        elif column in spec.get("json", ()):
            parsed = json.loads(value) if isinstance(value, str) else list(value)
            result.append(tuple(str(item) for item in parsed))
        elif column in spec.get("timestamps", ()):
            result.append(utc_naive(value).isoformat(timespec="microseconds"))
        elif column in spec.get("booleans", ()):
            result.append(bool(value))
        elif isinstance(value, date):
            result.append(value.isoformat())
        elif column in {"id", "user_id"}:
            result.append(str(value))
        else:
            result.append(value)
    return tuple(result)


def validate_exact_rows(cursor: DictCursor, copied: dict[str, list[dict[str, Any]]]) -> None:
    for table, source in copied.items():
        spec = SPECS[table]
        columns = ", ".join(f"`{column}`" for column in spec["columns"])
        order = ", ".join(f"`{column}`" for column in spec["pk"])
        cursor.execute(f"SELECT {columns} FROM `{table}` ORDER BY {order}")
        target = list(cursor.fetchall())
        if len(source) != len(target):
            raise RuntimeError(f"row count mismatch for {table}: source={len(source)} target={len(target)}")
        for index, (source_row, target_row) in enumerate(zip(source, target)):
            if canonical(table, source_row) != canonical(table, target_row):
                key = tuple(source_row[column] for column in spec["pk"])
                raise RuntimeError(f"value mismatch for {table} at row {index}, key={key!r}")


def scalar(cursor: DictCursor, sql: str) -> int:
    cursor.execute(sql)
    return int(next(iter(cursor.fetchone().values())))


def validate_constraints(cursor: DictCursor, copied_tables: set[str]) -> None:
    checks = {
        "orphan user_sessions": "SELECT COUNT(*) FROM user_sessions s LEFT JOIN app_users u ON u.id=s.user_id WHERE u.id IS NULL",
        "orphan color_tags": "SELECT COUNT(*) FROM color_tags x LEFT JOIN app_users u ON u.id=x.user_id WHERE u.id IS NULL",
        "orphan periods": "SELECT COUNT(*) FROM periods x LEFT JOIN app_users u ON u.id=x.user_id WHERE u.id IS NULL",
        "orphan events": "SELECT COUNT(*) FROM events x LEFT JOIN app_users u ON u.id=x.user_id WHERE u.id IS NULL",
        "orphan flows": "SELECT COUNT(*) FROM flows x LEFT JOIN app_users u ON u.id=x.user_id WHERE u.id IS NULL",
        "orphan flow parents": "SELECT COUNT(*) FROM flow_items x LEFT JOIN flows f ON f.user_id=x.user_id AND f.id=x.flow_id WHERE f.id IS NULL",
        "invalid item_type": "SELECT COUNT(*) FROM flow_items WHERE item_type NOT IN ('event','period')",
        "orphan typed flow item": """SELECT COUNT(*) FROM flow_items x
            WHERE (x.item_type='event' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.user_id=x.user_id AND e.id=x.item_id))
               OR (x.item_type='period' AND NOT EXISTS (SELECT 1 FROM periods p WHERE p.user_id=x.user_id AND p.id=x.item_id))""",
        "duplicate active username": """SELECT COUNT(*) FROM (
            SELECT active_username FROM app_users WHERE active_username IS NOT NULL
            GROUP BY active_username HAVING COUNT(*) > 1) duplicates""",
        "invalid periods JSON": "SELECT COUNT(*) FROM periods WHERE NOT JSON_VALID(color_tag_ids) OR JSON_TYPE(color_tag_ids) <> 'ARRAY'",
        "invalid events JSON": "SELECT COUNT(*) FROM events WHERE NOT JSON_VALID(color_tag_ids) OR JSON_TYPE(color_tag_ids) <> 'ARRAY'",
        "invalid flows JSON": "SELECT COUNT(*) FROM flows WHERE NOT JSON_VALID(color_tag_ids) OR JSON_TYPE(color_tag_ids) <> 'ARRAY'",
    }
    if "user_sessions" not in copied_tables:
        checks.pop("orphan user_sessions")
    failures = {}
    for name, sql in checks.items():
        count = scalar(cursor, sql)
        if count:
            failures[name] = count
    if failures:
        raise RuntimeError(f"integrity validation failed: {failures}")

    expected_pks = {table: tuple(SPECS[table]["pk"]) for table in TABLES}
    for table, expected in expected_pks.items():
        cursor.execute(
            """SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
               WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s AND CONSTRAINT_NAME='PRIMARY'
               ORDER BY ORDINAL_POSITION""",
            (table,),
        )
        actual = tuple(row["COLUMN_NAME"] for row in cursor.fetchall())
        if actual != expected:
            raise RuntimeError(f"primary key mismatch for {table}: expected={expected}, actual={actual}")

    cursor.execute(
        """SELECT COLUMN_TYPE FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='flow_items' AND COLUMN_NAME='item_type'"""
    )
    if cursor.fetchone()["COLUMN_TYPE"] != "enum('event','period')":
        raise RuntimeError("flow_items.item_type is not enum('event','period')")
    cursor.execute("SELECT @@session.time_zone AS session_timezone")
    if cursor.fetchone()["session_timezone"] != "+00:00":
        raise RuntimeError("MariaDB migration session is not UTC")


def redact(message: str, secrets: list[str]) -> str:
    for secret in secrets:
        if secret:
            message = message.replace(secret, "<redacted>")
    return message


def main() -> int:
    args = arguments()
    neon_url = os.environ.get("NEON_URL")
    if not neon_url:
        raise ValueError("NEON_URL is required")
    maria = mariadb_config()
    target_database = maria["database"]
    if not args.allow_non_test_database and not target_database.endswith("_migration_test"):
        raise RuntimeError("target database must end in _migration_test (or pass --allow-non-test-database)")

    print(f"Source: Neon database (read-only); target database: {target_database}")
    with psycopg.connect(neon_url, row_factory=dict_row) as pg:
        pg.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        copied = {
            table: source_rows(pg, table)
            for table in TABLES
            if not (args.skip_user_sessions and table == "user_sessions")
        }

        maria.update({"charset": "utf8mb4", "autocommit": False, "cursorclass": DictCursor})
        with pymysql.connect(**maria) as target:
            try:
                with target.cursor() as cursor:
                    cursor.execute("SET SESSION time_zone = '+00:00'")
                    cursor.execute("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                    require_safe_target(cursor, args.allow_schema_seed)
                    for table in TABLES:
                        if table in copied:
                            insert_rows(cursor, table, copied[table], args.allow_schema_seed)
                    validate_exact_rows(cursor, copied)
                    validate_constraints(cursor, set(copied))
                    counts = table_counts(cursor)
                target.commit()
            except Exception:
                target.rollback()
                raise

    for table in TABLES:
        source_count = len(copied.get(table, []))
        status = "skipped" if table not in copied else "verified"
        print(f"{table}: source={source_count} target={counts[table]} {status}")
    print("Validation passed: exact values, counts, PKs, FKs, JSON arrays, active usernames, ENUM, typed flow targets, UTC session")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        secrets = [
            os.environ.get("NEON_URL", ""),
            os.environ.get("MARIADB_URL", ""),
            os.environ.get("MARIADB_PASSWORD", ""),
        ]
        print(f"Migration failed ({type(exc).__name__}): {redact(str(exc), secrets)}", file=sys.stderr)
        raise SystemExit(1)
