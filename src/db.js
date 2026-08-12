'use strict';

const { Pool } = require('pg');
const { hashPassword } = require('./passwords');

// Account roles:
//   admin    — system administrator: manages companies, divisions, positions, employees
//   owner    — owner: sees all requests across all companies and builds reports
//   employee — every other user; all abilities come from the assigned position
// Hierarchy: Company -> Division (table `sites`) -> Position -> Employee (user).
const ROLES = ['admin', 'owner', 'employee'];

// Request statuses:
//   new         — created, awaiting a decision from the target division
//   in_progress — accepted, an executor is assigned
//   done        — the executor marked it completed
//   closed      — the accepter confirmed and closed the request
//   rejected    — the accepter rejected the request
//   cancelled   — the creator cancelled the request

const STATUSES = ['new', 'in_progress', 'done', 'closed', 'rejected', 'cancelled'];
const PRIORITIES = ['low', 'normal', 'high'];

// The connection string comes from the environment. The Vercel + Neon
// integration injects it, but the variable name depends on the "Custom Prefix"
// chosen when connecting (e.g. DATABASE_URL, POSTGRES_URL, STORAGE_DATABASE_URL).
// Resolve it by name first, then by scanning for any postgres:// value, so the
// app works regardless of the prefix. Pooled URLs are preferred for serverless.
function resolveConnectionString() {
  const env = process.env;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.POSTGRES_URL) return env.POSTGRES_URL;

  const isPg = (v) => typeof v === 'string' && /^postgres(ql)?:\/\//.test(v);
  const entries = Object.entries(env).filter(([, v]) => isPg(v));
  const pooled = entries.filter(([k]) => !/UNPOOLED|NON_POOLING/i.test(k));
  const pick = (arr, re) => (arr.find(([k]) => re.test(k)) || [])[1];

  return (
    pick(pooled, /DATABASE_URL$/i) ||
    pick(pooled, /POSTGRES_URL$/i) ||
    pick(pooled, /(DATABASE|POSTGRES).*URL/i) ||
    (pooled[0] && pooled[0][1]) ||
    (entries[0] && entries[0][1]) ||
    ''
  );
}

const connectionString = resolveConnectionString();
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = connectionString
  ? new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      // Local Postgres runs without TLS; cloud Postgres (Neon, etc.) requires it.
      ssl: isLocal ? false : { rejectUnauthorized: false },
    })
  : null;

async function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL environment variable is not set');
  return pool.query(text, params);
}

async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0];
}

async function all(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS companies (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "sites" is the Division level in the UI: a division belongs to a company.
-- Divisions are deactivated, never deleted, so request history is preserved.
CREATE TABLE IF NOT EXISTS sites (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  name       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kept only for backward compatibility with older databases; no longer used.
CREATE TABLE IF NOT EXISTS departments (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A position (the admin-created role) belongs to a division and carries a set of
-- permissions. It is permanent (deactivated, never deleted); the person filling
-- it changes over time.
CREATE TABLE IF NOT EXISTS positions (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id),
  title           TEXT NOT NULL,
  perm_create     BOOLEAN NOT NULL DEFAULT TRUE,
  perm_view_site  BOOLEAN NOT NULL DEFAULT FALSE,
  perm_cancel     BOOLEAN NOT NULL DEFAULT FALSE,
  perm_reports    BOOLEAN NOT NULL DEFAULT FALSE,
  perm_accept     BOOLEAN NOT NULL DEFAULT FALSE,
  perm_execute    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  login         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','owner','employee')),
  department_id INTEGER REFERENCES departments(id),
  site_id       INTEGER REFERENCES sites(id),
  position_id   INTEGER REFERENCES positions(id),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  -- When true the user has no usable password and must set one at next sign-in.
  must_set_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users (LOWER(login));

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','in_progress','done','closed','rejected','cancelled')),
  site_id        INTEGER REFERENCES sites(id),         -- origin division
  position_id    INTEGER REFERENCES positions(id),     -- creator's position
  target_site_id INTEGER REFERENCES sites(id),         -- division the request is sent to
  department_id  INTEGER REFERENCES departments(id),   -- legacy, unused
  -- created_by may become NULL if the employee is later deleted; created_by_name
  -- is a snapshot so reporting survives that deletion.
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  executor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date      TEXT,
  reject_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at   TIMESTAMPTZ,
  done_at       TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_events (
  id         SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_requests_department ON requests(department_id);
CREATE INDEX IF NOT EXISTS idx_requests_manager    ON requests(manager_id);
CREATE INDEX IF NOT EXISTS idx_requests_executor   ON requests(executor_id);
CREATE INDEX IF NOT EXISTS idx_requests_status     ON requests(status);
CREATE INDEX IF NOT EXISTS idx_events_request      ON request_events(request_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user       ON sessions(user_id);
`;

// Idempotent migrations, applied after the base schema so an existing database
// (created before sites/site-addressing) upgrades in place without data loss.
const MIGRATE_SQL = `
ALTER TABLE sites       ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id);
ALTER TABLE users    ADD COLUMN IF NOT EXISTS must_set_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id);
ALTER TABLE requests ALTER COLUMN manager_id DROP NOT NULL;
-- Collapse the old dept_admin/manager/executor/site_admin roles into "employee".
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = 'employee' WHERE role IN ('dept_admin','site_admin','manager','executor');
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','owner','employee'));

-- Positions, companies/divisions, request attribution and routing.
ALTER TABLE users    ADD COLUMN IF NOT EXISTS position_id INTEGER REFERENCES positions(id);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS perm_accept  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS perm_execute BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sites    ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS position_id INTEGER REFERENCES positions(id);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS target_site_id INTEGER REFERENCES sites(id);
ALTER TABLE requests ALTER COLUMN department_id DROP NOT NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS created_by_name TEXT NOT NULL DEFAULT '';
ALTER TABLE request_events ADD COLUMN IF NOT EXISTS user_name TEXT NOT NULL DEFAULT '';
UPDATE requests r SET created_by_name = u.full_name
  FROM users u WHERE r.created_by = u.id AND r.created_by_name = '';
UPDATE request_events e SET user_name = u.full_name
  FROM users u WHERE e.user_id = u.id AND e.user_name = '';

-- Relax the person foreign keys so an employee can be hard-deleted without
-- losing request history (the name snapshots above preserve reporting).
ALTER TABLE requests ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_created_by_fkey;
ALTER TABLE requests ADD CONSTRAINT requests_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_manager_id_fkey;
ALTER TABLE requests ADD CONSTRAINT requests_manager_id_fkey
  FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_executor_id_fkey;
ALTER TABLE requests ADD CONSTRAINT requests_executor_id_fkey
  FOREIGN KEY (executor_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE request_events ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE request_events DROP CONSTRAINT IF EXISTS request_events_user_id_fkey;
ALTER TABLE request_events ADD CONSTRAINT request_events_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Created after the site_id column exists (base schema runs first, then this).
CREATE INDEX IF NOT EXISTS idx_requests_site ON requests(site_id);
CREATE INDEX IF NOT EXISTS idx_requests_target ON requests(target_site_id);
CREATE INDEX IF NOT EXISTS idx_positions_site ON positions(site_id);
CREATE INDEX IF NOT EXISTS idx_sites_company ON sites(company_id);
`;

// The schema is created lazily on first use (on serverless hosting each
// instance checks it once; subsequent calls are free).
let readyPromise = null;

function ready() {
  if (!readyPromise) {
    readyPromise = initSchema().catch((e) => {
      readyPromise = null; // on failure, allow a retry on the next request
      throw e;
    });
  }
  return readyPromise;
}

async function initSchema() {
  await query(SCHEMA_SQL);
  await query(MIGRATE_SQL);
  const row = await one('SELECT COUNT(*)::int AS n FROM users');
  if (row.n === 0) {
    await query(
      `INSERT INTO users (login, password_hash, full_name, role) VALUES ($1, $2, $3, 'admin')`,
      ['admin', hashPassword('admin123'), 'System Administrator']
    );
    console.log('Created administrator account: admin / admin123 (please change the password!)');
  }
}

// Permission flags a position may grant.
const POSITION_PERMS = [
  'perm_create', 'perm_view_site', 'perm_cancel', 'perm_reports', 'perm_accept', 'perm_execute',
];

module.exports = {
  pool, query, one, all, ready,
  ROLES, STATUSES, PRIORITIES, POSITION_PERMS,
};
