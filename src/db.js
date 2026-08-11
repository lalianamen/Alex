'use strict';

const { Pool } = require('pg');
const { hashPassword } = require('./passwords');

// Роли:
//   admin      — администратор системы: управляет учётными записями и правами
//   owner      — собственник: видит все подразделения и заявки, формирует отчёты
//   dept_admin — администратор подразделения: создаёт заявки руководителям работ
//   manager    — руководитель исполняемых работ: принимает заявки, назначает исполнителей
//   executor   — исполнитель: видит и выполняет только свои работы
const ROLES = ['admin', 'owner', 'dept_admin', 'manager', 'executor'];
const DEPT_ROLES = ['dept_admin', 'manager', 'executor'];

// Статусы заявки:
//   new         — новая, ожидает решения руководителя
//   in_progress — принята в работу, назначен исполнитель
//   done        — исполнитель отметил выполнение
//   closed      — руководитель подтвердил и закрыл заявку
//   rejected    — руководитель отклонил заявку
//   cancelled   — администратор подразделения отменил заявку
const STATUSES = ['new', 'in_progress', 'done', 'closed', 'rejected', 'cancelled'];
const PRIORITIES = ['low', 'normal', 'high'];

// Строка подключения приходит из окружения. На Vercel интеграция с Neon
// добавляет DATABASE_URL автоматически.
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

const pool = connectionString
  ? new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      // Локальный Postgres — без TLS; облачный (Neon и т.п.) — по строке подключения.
      ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : undefined,
    })
  : null;

async function query(text, params) {
  if (!pool) throw new Error('Не задана переменная окружения DATABASE_URL');
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
CREATE TABLE IF NOT EXISTS departments (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  login         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','owner','dept_admin','manager','executor')),
  department_id INTEGER REFERENCES departments(id),
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
  department_id INTEGER NOT NULL REFERENCES departments(id),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  manager_id    INTEGER NOT NULL REFERENCES users(id),
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

// Схема создаётся лениво при первом обращении (на бессерверном хостинге
// каждый экземпляр проверяет её один раз; повторные вызовы бесплатны).
let readyPromise = null;

function ready() {
  if (!readyPromise) {
    readyPromise = initSchema().catch((e) => {
      readyPromise = null; // при сбое даём шанс повторить на следующем запросе
      throw e;
    });
  }
  return readyPromise;
}

async function initSchema() {
  await query(SCHEMA_SQL);
  const row = await one('SELECT COUNT(*)::int AS n FROM users');
  if (row.n === 0) {
    await query(
      `INSERT INTO users (login, password_hash, full_name, role) VALUES ($1, $2, $3, 'admin')`,
      ['admin', hashPassword('admin123'), 'Администратор системы']
    );
    console.log('Создана учётная запись администратора: admin / admin123 (смените пароль!)');
  }
}

module.exports = { pool, query, one, all, ready, ROLES, DEPT_ROLES, STATUSES, PRIORITIES };
