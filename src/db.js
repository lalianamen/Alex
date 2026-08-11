'use strict';

const { Pool } = require('pg');
const { hashPassword } = require('./passwords');

// Roles:
//   admin      — system administrator: manages accounts, sites and departments
//   owner      — owner: sees all sites and requests, builds reports
//   site_admin — site administrator: works at a site (address), creates requests
//                addressed to a service department of their choice
//   manager    — work supervisor: belongs to a department, accepts requests
//                addressed to it and assigns an executor
//   executor   — executor: belongs to a department, performs only their own work
const ROLES = ['admin', 'owner', 'site_admin', 'manager', 'executor'];
// Roles bound to a service department.
const DEPT_ROLES = ['manager', 'executor'];
// Roles bound to a site (address).
const SITE_ROLES = ['site_admin'];

// Request statuses:
//   new         — new, awaiting the supervisor's decision
//   in_progress — accepted for work, an executor is assigned
//   done        — the executor marked it completed
//   closed      — the supervisor confirmed and closed the request
//   rejected    — the supervisor rejected the request
//   cancelled   — the department administrator cancelled the request
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
CREATE TABLE IF NOT EXISTS sites (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departments (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  login         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','owner','site_admin','manager','executor')),
  department_id INTEGER REFERENCES departments(id),
  site_id       INTEGER REFERENCES sites(id),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
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
  site_id       INTEGER REFERENCES sites(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  manager_id    INTEGER REFERENCES users(id),
  executor_id   INTEGER REFERENCES users(id),
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
  user_id    INTEGER NOT NULL REFERENCES users(id),
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
ALTER TABLE requests ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id);
ALTER TABLE requests ALTER COLUMN manager_id DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = 'site_admin' WHERE role = 'dept_admin';
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','owner','site_admin','manager','executor'));
-- Created after the site_id column exists (base schema runs first, then this).
CREATE INDEX IF NOT EXISTS idx_requests_site ON requests(site_id);
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

module.exports = { pool, query, one, all, ready, ROLES, DEPT_ROLES, SITE_ROLES, STATUSES, PRIORITIES };
