# Neon PostgreSQL to MariaDB migration

This migration keeps Neon read-only, writes only to a separately created MariaDB database, and does not change the application's `DATABASE_URL` or service configuration.

## Schema comparison

`db/schema.sql` is the MariaDB target definition. The live Neon `public` schema was inspected read-only on 2026-07-21.

| Table | Neon definition | MariaDB target | Notes |
| --- | --- | --- | --- |
| `app_users` | UUID PK; unbounded text fields; partial unique index on `lower(username)` for active rows; `timestamptz` | `char(36)` PK; bounded credential fields; stored `active_username` with UNIQUE; `timestamp(6)` | Live maximums are UUID 36, username 27, hash 128, salt 32. The generated column reproduces active-only uniqueness. |
| `workspace_state` | text PK, bigint, `timestamptz` | `varchar(50)` PK, bigint, `timestamp(6)` | Live ID maximum is 6. |
| `color_tags` | `(user_id,id)` PK; user FK; text values; partial active index | same PK/FK; bounded ID/color; `(user_id,is_deleted)` index | Live ID maximum is 8. Neon `name` defaults to `''`; MariaDB has no default. Migration supplies it explicitly. |
| `periods` | `(user_id,id)` PK; user FK; `text[]`; `timestamptz` | same PK/FK; JSON; `timestamp(6)` | Array values are encoded as JSON arrays. Live ID maximum is 8. |
| `events` | `(user_id,id)` PK; user FK; `text[]`; `timestamptz` | same PK/FK; JSON; `timestamp(6)` | Array values are encoded as JSON arrays. Live ID maximum is 26. |
| `flows` | `(user_id,id)` PK; user FK; `text[]`; `timestamptz` | same PK/FK; JSON; `timestamp(6)` | Array values are encoded as JSON arrays. Live ID maximum is 8. |
| `flow_items` | `(user_id,flow_id,position)` PK; user FK and composite flow FK; text plus CHECK item type; partial active index | same PK and composite flow FK; ENUM item type; `(user_id,is_deleted)` index | The direct user FK is logically implied by the composite flow FK and was not added. Live item IDs are at most 8. |
| `user_sessions` | text PK; user FK; two `timestamptz` columns | `char(64)` PK; user FK; two `timestamp(6)` columns | Every live token hash is 64 lowercase hexadecimal characters. |

All nullable source fields remain nullable. All non-null source fields remain non-null. PostgreSQL empty-string defaults on `color_tags.name` and the three title columns are not copied into the target schema because the current application and migration explicitly supply these values; `NULL` and `''` are kept distinct during copying.

PostgreSQL partial non-unique indexes on active content rows have no direct MariaDB equivalent. The target's `(user_id,is_deleted)` indexes support the same active-row queries but also contain deleted rows. The partial unique username index is represented by a nullable generated column because MariaDB UNIQUE indexes permit multiple `NULL` values.

UUIDs are canonical 36-character lowercase values in the live data. The current `utf8mb4_unicode_ci` target collation is case-insensitive; that does not collide for the current UUID data. Free-form text IDs could theoretically collide under this collation where PostgreSQL considers them distinct. The test migration is the definitive collision check for the current data.

MariaDB's JSON columns are implemented as `LONGTEXT` plus `JSON_VALID` checks. The migration additionally checks `JSON_TYPE(...) = 'ARRAY'` for every `color_tag_ids` value.

## Timestamp policy

Neon reports timezone `GMT`, and all source values are timezone-aware. The migration converts every timestamp to UTC, removes the timezone marker only after conversion, and sets the MariaDB connection session to `+00:00`. `timestamp(6)` preserves Neon microseconds. MariaDB's server system timezone is KST, so any later operational migration must also retain the explicit UTC session setting in the script.

## SQL splitter assessment

`scripts/migrate.js` splits input with `schema.split(/;\s*(?:\r?\n|$)/)`. The current schema contains ten simple statements and no comments, stored routines, triggers, delimiter directives, or quoted semicolons, so it applies successfully today. This is not a general SQL parser: semicolons in procedure/trigger bodies, some comments, or string literals can split a statement incorrectly. Apply future complex schemas with the `mariadb` client or replace this splitter with a parser before adding those constructs.

## Migration script safety

`scripts/migrate-neon-to-mariadb.py` uses `psycopg` and `PyMySQL` and requires:

- `NEON_URL` for the read-only PostgreSQL source;
- either `MARIADB_URL`, or `MARIADB_HOST`, `MARIADB_PORT`, `MARIADB_USER`, `MARIADB_PASSWORD`, and required `MARIADB_DATABASE`;
- a target database name ending in `_migration_test` unless `--allow-non-test-database` is explicitly passed.

The target transaction is rolled back on any error. By default, any non-empty target table stops the migration. Because `db/schema.sql` creates one bootstrap user and one workspace row, a freshly initialized target must use `--allow-schema-seed`; the script verifies that these are the only rows and that their values match the exact bootstrap identity before proceeding. It never logs passwords, connection URLs, password hashes, salts, or session tokens.

The script copies in this order: `app_users`, `workspace_state`, `color_tags`, `periods`, `events`, `flows`, `flow_items`, `user_sessions`. It then compares every copied value, including `NULL` versus empty string and microsecond UTC timestamps, before commit.

## Session decision

Session token hashing and password hashing are unchanged between the PostgreSQL and MariaDB application code. Token hashes are compatible, and all session timestamps fit MariaDB's `TIMESTAMP` range. Therefore sessions can be copied. At inspection time, eight of ten sessions were already expired and seven were marked deleted; retaining them is harmless but mostly historical. Passing `--skip-user-sessions` is the more conservative alternative and forces users to sign in again.

## Commands for an isolated test

The following examples intentionally do not alter `.env`:

```bash
python3 -m venv .venv-migration
.venv-migration/bin/pip install 'psycopg[binary]' PyMySQL

sudo mariadb -e "CREATE DATABASE history_timeline_migration_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
sudo mariadb history_timeline_migration_test < db/schema.sql

sudo --preserve-env=NEON_URL env \
  MARIADB_DATABASE=history_timeline_migration_test \
  MARIADB_USER=root \
  MARIADB_UNIX_SOCKET=/run/mysqld/mysqld.sock \
  .venv-migration/bin/python scripts/migrate-neon-to-mariadb.py --allow-schema-seed
```

Do not rerun the `CREATE DATABASE` statement when the database already exists. The migration itself will refuse a populated target.

## Test migration result

The isolated migration completed on 2026-07-21 against `history_timeline_migration_test`. No application or service was started, and no application connection setting was changed.

| Table | Neon | MariaDB | Result |
| --- | ---: | ---: | --- |
| `app_users` | 8 | 8 | exact values verified |
| `workspace_state` | 1 | 1 | exact values verified |
| `color_tags` | 7 | 7 | exact values verified |
| `periods` | 5 | 5 | exact values verified |
| `events` | 39 | 39 | exact values verified |
| `flows` | 4 | 4 | exact values verified |
| `flow_items` | 13 | 13 | exact values verified |
| `user_sessions` | 10 | 10 | exact values verified |

Post-commit checks found zero FK orphans, zero invalid JSON values, zero non-array `color_tag_ids` values, zero duplicate active usernames, zero invalid `item_type` values, and zero missing polymorphic event/period references. PK, FK, UNIQUE, CHECK, and ENUM definitions were also read back from MariaDB. All timestamp ranges matched the Neon source when queried in a `+00:00` MariaDB session.

The isolated environment contains only the direct requested packages and the binary extra selected by psycopg. Its exact frozen versions are recorded in `docs/migration-requirements.txt`.

## Proposed production cutover (do not run yet)

Create a new, empty replacement database rather than modifying the existing production database. Apply `db/schema.sql`, run the migration with `--allow-schema-seed --allow-non-test-database`, repeat all validations, take an operational backup, and only then change the application's database connection and restart it in a scheduled cutover. The exact connection-change and service commands must be confirmed against the deployed environment at cutover time; none are part of this test migration.
