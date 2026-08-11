'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { hashPassword } = require('./passwords');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','owner','dept_admin','manager','executor')),
  department_id INTEGER REFERENCES departments(id),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at   TEXT,
  done_at       TEXT,
  closed_at     TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_requests_department ON requests(department_id);
CREATE INDEX IF NOT EXISTS idx_requests_manager    ON requests(manager_id);
CREATE INDEX IF NOT EXISTS idx_requests_executor   ON requests(executor_id);
CREATE INDEX IF NOT EXISTS idx_requests_status     ON requests(status);
CREATE INDEX IF NOT EXISTS idx_events_request      ON request_events(request_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user       ON sessions(user_id);
`);

// Первый запуск: создаём администратора системы, чтобы было с чего начать.
const usersCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (usersCount === 0) {
  db.prepare(
    `INSERT INTO users (login, password_hash, full_name, role) VALUES (?, ?, ?, 'admin')`
  ).run('admin', hashPassword('admin123'), 'Администратор системы');
  console.log('Создана учётная запись администратора: admin / admin123 (смените пароль!)');
}

module.exports = { db, ROLES, DEPT_ROLES, STATUSES, PRIORITIES };
