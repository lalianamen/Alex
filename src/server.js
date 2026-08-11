'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db, ROLES, DEPT_ROLES, PRIORITIES } = require('./db');
const { hashPassword, verifyPassword } = require('./passwords');
const {
  COOKIE_NAME,
  createSession,
  destroySession,
  sessionMiddleware,
  requireRole,
} = require('./auth');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

function publicUser(u) {
  return {
    id: u.id,
    login: u.login,
    full_name: u.full_name,
    role: u.role,
    department_id: u.department_id,
    is_active: !!u.is_active,
    created_at: u.created_at,
  };
}

const REQUEST_SELECT = `
  SELECT r.*,
         d.name  AS department_name,
         cu.full_name AS created_by_name,
         mu.full_name AS manager_name,
         eu.full_name AS executor_name
  FROM requests r
  JOIN departments d ON d.id = r.department_id
  JOIN users cu ON cu.id = r.created_by
  JOIN users mu ON mu.id = r.manager_id
  LEFT JOIN users eu ON eu.id = r.executor_id
`;

function getRequest(id) {
  return db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id);
}

// Кому видна заявка (просмотр карточки и списка).
function canSeeRequest(user, r) {
  switch (user.role) {
    case 'owner':
      return true;
    case 'dept_admin':
    case 'manager':
      return r.department_id === user.department_id;
    case 'executor':
      return r.executor_id === user.id;
    default:
      return false;
  }
}

function addEvent(requestId, userId, action, comment) {
  db.prepare(
    'INSERT INTO request_events (request_id, user_id, action, comment) VALUES (?, ?, ?, ?)'
  ).run(requestId, userId, action, comment || null);
}

// ---------------------------------------------------------------------------
// Авторизация
// ---------------------------------------------------------------------------

app.post('/api/login', (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'Укажите логин и пароль' });
  }
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get(String(login).trim());
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'Учётная запись отключена. Обратитесь к администратору' });
  }
  const token = createSession(user.id);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax' });
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  if (req.cookies[COOKIE_NAME]) destroySession(req.cookies[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в систему' });
  res.json({ user: publicUser(req.user) });
});

app.post('/api/me/password', requireRole(), (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) {
    return res.status(400).json({ error: 'Укажите текущий и новый пароль' });
  }
  if (String(new_password).length < 6) {
    return res.status(400).json({ error: 'Новый пароль должен быть не короче 6 символов' });
  }
  if (!verifyPassword(String(old_password), req.user.password_hash)) {
    return res.status(400).json({ error: 'Текущий пароль указан неверно' });
  }
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(
    hashPassword(String(new_password)),
    req.user.id
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Подразделения
// ---------------------------------------------------------------------------

app.get('/api/departments', requireRole(), (req, res) => {
  res.json({ departments: db.prepare('SELECT * FROM departments ORDER BY name').all() });
});

app.post('/api/departments', requireRole('admin'), (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название подразделения' });
  try {
    const info = db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
    res.json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(info.lastInsertRowid) });
  } catch (e) {
    res.status(400).json({ error: 'Подразделение с таким названием уже существует' });
  }
});

app.put('/api/departments/:id', requireRole('admin'), (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название подразделения' });
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!dept) return res.status(404).json({ error: 'Подразделение не найдено' });
  try {
    db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(name, dept.id);
    res.json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(dept.id) });
  } catch (e) {
    res.status(400).json({ error: 'Подразделение с таким названием уже существует' });
  }
});

// ---------------------------------------------------------------------------
// Пользователи (администратор системы)
// ---------------------------------------------------------------------------

function validateUserPayload(body, { requirePassword }) {
  const login = String(body.login || '').trim();
  const full_name = String(body.full_name || '').trim();
  const role = String(body.role || '');
  const password = body.password == null ? '' : String(body.password);
  const department_id = body.department_id ? Number(body.department_id) : null;

  if (!login) return { error: 'Укажите логин' };
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(login)) {
    return { error: 'Логин: 3–32 символа, латиница, цифры, точка, дефис, подчёркивание' };
  }
  if (!full_name) return { error: 'Укажите ФИО' };
  if (!ROLES.includes(role)) return { error: 'Некорректная роль' };
  if (requirePassword && password.length < 6) {
    return { error: 'Пароль должен быть не короче 6 символов' };
  }
  if (DEPT_ROLES.includes(role)) {
    if (!department_id) return { error: 'Для этой роли необходимо указать подразделение' };
    const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
    if (!dept) return { error: 'Подразделение не найдено' };
  }
  return {
    value: {
      login,
      full_name,
      role,
      password,
      department_id: DEPT_ROLES.includes(role) ? department_id : null,
    },
  };
}

app.get('/api/users', requireRole('admin'), (req, res) => {
  const users = db
    .prepare(
      `SELECT u.*, d.name AS department_name
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
       ORDER BY u.is_active DESC, u.full_name`
    )
    .all()
    .map((u) => ({ ...publicUser(u), department_name: u.department_name }));
  res.json({ users });
});

app.post('/api/users', requireRole('admin'), (req, res) => {
  const check = validateUserPayload(req.body || {}, { requirePassword: true });
  if (check.error) return res.status(400).json({ error: check.error });
  const v = check.value;
  const exists = db.prepare('SELECT id FROM users WHERE login = ?').get(v.login);
  if (exists) return res.status(400).json({ error: 'Пользователь с таким логином уже существует' });
  const info = db
    .prepare(
      `INSERT INTO users (login, password_hash, full_name, role, department_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(v.login, hashPassword(v.password), v.full_name, v.role, v.department_id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
});

app.put('/api/users/:id', requireRole('admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const check = validateUserPayload(req.body || {}, { requirePassword: false });
  if (check.error) return res.status(400).json({ error: check.error });
  const v = check.value;
  const exists = db.prepare('SELECT id FROM users WHERE login = ? AND id != ?').get(v.login, user.id);
  if (exists) return res.status(400).json({ error: 'Пользователь с таким логином уже существует' });
  db.prepare(
    `UPDATE users SET login = ?, full_name = ?, role = ?, department_id = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(v.login, v.full_name, v.role, v.department_id, user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

app.post('/api/users/:id/password', requireRole('admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const password = String((req.body || {}).password || '');
  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  }
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(
    hashPassword(password),
    user.id
  );
  // Смена пароля закрывает старые сессии пользователя.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/deactivate', requireRole('admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.id === req.user.id) {
    return res.status(400).json({ error: 'Нельзя отключить собственную учётную запись' });
  }
  db.prepare(`UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/restore', requireRole('admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  db.prepare(`UPDATE users SET is_active = 1, updated_at = datetime('now') WHERE id = ?`).run(user.id);
  res.json({ ok: true });
});

// Справочники для форм: руководители своего подразделения (для админа подразделения)
// и исполнители своего подразделения (для руководителя).
app.get('/api/users/managers', requireRole('dept_admin'), (req, res) => {
  const managers = db
    .prepare(
      `SELECT id, full_name FROM users
       WHERE role = 'manager' AND department_id = ? AND is_active = 1
       ORDER BY full_name`
    )
    .all(req.user.department_id);
  res.json({ managers });
});

app.get('/api/users/executors', requireRole('manager'), (req, res) => {
  const executors = db
    .prepare(
      `SELECT id, full_name FROM users
       WHERE role = 'executor' AND department_id = ? AND is_active = 1
       ORDER BY full_name`
    )
    .all(req.user.department_id);
  res.json({ executors });
});

// ---------------------------------------------------------------------------
// Заявки
// ---------------------------------------------------------------------------

app.get('/api/requests', requireRole('owner', 'dept_admin', 'manager', 'executor'), (req, res) => {
  const where = [];
  const params = [];

  switch (req.user.role) {
    case 'owner':
      if (req.query.department_id) {
        where.push('r.department_id = ?');
        params.push(Number(req.query.department_id));
      }
      break;
    case 'dept_admin':
      where.push('r.department_id = ?');
      params.push(req.user.department_id);
      break;
    case 'manager':
      where.push('r.department_id = ? AND r.manager_id = ?');
      params.push(req.user.department_id, req.user.id);
      break;
    case 'executor':
      where.push('r.executor_id = ?');
      params.push(req.user.id);
      break;
  }

  if (req.query.status) {
    where.push('r.status = ?');
    params.push(String(req.query.status));
  }

  const sql = `${REQUEST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY r.created_at DESC, r.id DESC`;
  res.json({ requests: db.prepare(sql).all(...params) });
});

app.get('/api/requests/:id', requireRole('owner', 'dept_admin', 'manager', 'executor'), (req, res) => {
  const r = getRequest(req.params.id);
  if (!r || !canSeeRequest(req.user, r)) return res.status(404).json({ error: 'Заявка не найдена' });
  const events = db
    .prepare(
      `SELECT e.*, u.full_name AS user_name
       FROM request_events e JOIN users u ON u.id = e.user_id
       WHERE e.request_id = ? ORDER BY e.created_at, e.id`
    )
    .all(r.id);
  res.json({ request: r, events });
});

// Создание заявки — администратор подразделения, адресуется руководителю работ
// своего подразделения.
app.post('/api/requests', requireRole('dept_admin'), (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
  const manager_id = Number(b.manager_id);
  const due_date = b.due_date ? String(b.due_date) : null;

  if (!title) return res.status(400).json({ error: 'Укажите тему заявки' });
  if (!manager_id) return res.status(400).json({ error: 'Выберите руководителя работ' });
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return res.status(400).json({ error: 'Некорректный срок выполнения' });
  }

  const manager = db
    .prepare(`SELECT * FROM users WHERE id = ? AND role = 'manager' AND is_active = 1`)
    .get(manager_id);
  if (!manager || manager.department_id !== req.user.department_id) {
    return res.status(400).json({ error: 'Руководитель должен относиться к вашему подразделению' });
  }

  const info = db
    .prepare(
      `INSERT INTO requests (title, description, priority, department_id, created_by, manager_id, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(title, description, priority, req.user.department_id, req.user.id, manager_id, due_date);
  addEvent(info.lastInsertRowid, req.user.id, 'created', null);
  res.json({ request: getRequest(info.lastInsertRowid) });
});

// Принять в работу и назначить исполнителя — руководитель работ.
app.post('/api/requests/:id/accept', requireRole('manager'), (req, res) => {
  const r = getRequest(req.params.id);
  if (!r || r.manager_id !== req.user.id) return res.status(404).json({ error: 'Заявка не найдена' });
  if (r.status !== 'new') return res.status(400).json({ error: 'Заявка уже обработана' });

  const executor_id = Number((req.body || {}).executor_id);
  if (!executor_id) return res.status(400).json({ error: 'Выберите исполнителя' });
  const executor = db
    .prepare(`SELECT * FROM users WHERE id = ? AND role = 'executor' AND is_active = 1`)
    .get(executor_id);
  if (!executor || executor.department_id !== req.user.department_id) {
    return res.status(400).json({ error: 'Исполнитель должен относиться к вашему подразделению' });
  }

  db.prepare(
    `UPDATE requests SET status = 'in_progress', executor_id = ?,
       accepted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(executor_id, r.id);
  addEvent(r.id, req.user.id, 'accepted', `Исполнитель: ${executor.full_name}`);
  res.json({ request: getRequest(r.id) });
});

// Сменить исполнителя по заявке в работе — руководитель работ.
app.post('/api/requests/:id/assign', requireRole('manager'), (req, res) => {
  const r = getRequest(req.params.id);
  if (!r || r.manager_id !== req.user.id) return res.status(404).json({ error: 'Заявка не найдена' });
  if (r.status !== 'in_progress') {
    return res.status(400).json({ error: 'Сменить исполнителя можно только по заявке в работе' });
  }

  const executor_id = Number((req.body || {}).executor_id);
  if (!executor_id) return res.status(400).json({ error: 'Выберите исполнителя' });
  const executor = db
    .prepare(`SELECT * FROM users WHERE id = ? AND role = 'executor' AND is_active = 1`)
    .get(executor_id);
  if (!executor || executor.department_id !== req.user.department_id) {
    return res.status(400).json({ error: 'Исполнитель должен относиться к вашему подразделению' });
  }

  db.prepare(`UPDATE requests SET executor_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    executor_id,
    r.id
  );
  addEvent(r.id, req.user.id, 'reassigned', `Новый исполнитель: ${executor.full_name}`);
  res.json({ request: getRequest(r.id) });
});

// Отклонить заявку — руководитель работ (с указанием причины).
app.post('/api/requests/:id/reject', requireRole('manager'), (req, res) => {
  const r = getRequest(req.params.id);
  if (!r || r.manager_id !== req.user.id) return res.status(404).json({ error: 'Заявка не найдена' });
  if (r.status !== 'new') return res.status(400).json({ error: 'Отклонить можно только новую заявку' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Укажите причину отклонения' });

  db.prepare(
    `UPDATE requests SET status = 'rejected', reject_reason = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(reason, r.id);
  addEvent(r.id, req.user.id, 'rejected', reason);
  res.json({ request: getRequest(r.id) });
});

// Отметить выполнение — исполнитель.
app.post('/api/requests/:id/done', requireRole('executor'), (req, res) => {
  const r = getRequest(req.params.id);
  if (!r || r.executor_id !== req.user.id) return res.status(404).json({ error: 'Заявка не найдена' });
  if (r.status !== 'in_progress') return res.status(400).json({ error: 'Заявка не находится в работе' });
  const comment = String((req.body || {}).comment || '').trim();

  db.prepare(
    `UPDATE requests SET status = 'done', done_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(r.id);
  addEvent(r.id, req.user.id, 'done', comment || null);
  res.json({ request: getRequest(r.id) });
});

// Подтвердить выполнение и закрыть — руководитель работ.
app.post('/api/requests/:id/close', requireRole('manager'), (req, res) => {
  const r = getRequest(req.params.id);
  if (!r || r.manager_id !== req.user.id) return res.status(404).json({ error: 'Заявка не найдена' });
  if (r.status !== 'done') return res.status(400).json({ error: 'Закрыть можно только выполненную заявку' });

  db.prepare(
    `UPDATE requests SET status = 'closed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(r.id);
  addEvent(r.id, req.user.id, 'closed', null);
  res.json({ request: getRequest(r.id) });
});

// Вернуть выполненную заявку в работу (доработка) — руководитель работ.
app.post('/api/requests/:id/reopen', requireRole('manager'), (req, res) => {
  const r = getRequest(req.params.id);
  if (!r || r.manager_id !== req.user.id) return res.status(404).json({ error: 'Заявка не найдена' });
  if (r.status !== 'done') return res.status(400).json({ error: 'Вернуть в работу можно только выполненную заявку' });
  const comment = String((req.body || {}).comment || '').trim();
  if (!comment) return res.status(400).json({ error: 'Укажите, что нужно доработать' });

  db.prepare(
    `UPDATE requests SET status = 'in_progress', done_at = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(r.id);
  addEvent(r.id, req.user.id, 'reopened', comment);
  res.json({ request: getRequest(r.id) });
});

// Отменить новую заявку — администратор подразделения (автор).
app.post('/api/requests/:id/cancel', requireRole('dept_admin'), (req, res) => {
  const r = getRequest(req.params.id);
  if (!r || r.department_id !== req.user.department_id) {
    return res.status(404).json({ error: 'Заявка не найдена' });
  }
  if (r.status !== 'new') return res.status(400).json({ error: 'Отменить можно только новую заявку' });

  db.prepare(
    `UPDATE requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
  ).run(r.id);
  addEvent(r.id, req.user.id, 'cancelled', null);
  res.json({ request: getRequest(r.id) });
});

// ---------------------------------------------------------------------------
// Отчёты (собственник)
// ---------------------------------------------------------------------------

function periodFilter(query) {
  const where = [];
  const params = [];
  if (query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from)) {
    where.push(`r.created_at >= ?`);
    params.push(`${query.from} 00:00:00`);
  }
  if (query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to)) {
    where.push(`r.created_at <= ?`);
    params.push(`${query.to} 23:59:59`);
  }
  return { where, params };
}

app.get('/api/reports/summary', requireRole('owner'), (req, res) => {
  const { where, params } = periodFilter(req.query);
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const byDepartment = db
    .prepare(
      `SELECT d.id AS department_id, d.name AS department_name,
              COUNT(*) AS total,
              SUM(CASE WHEN r.status = 'new' THEN 1 ELSE 0 END)         AS new_count,
              SUM(CASE WHEN r.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
              SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END)        AS done_count,
              SUM(CASE WHEN r.status = 'closed' THEN 1 ELSE 0 END)      AS closed_count,
              SUM(CASE WHEN r.status = 'rejected' THEN 1 ELSE 0 END)    AS rejected_count,
              SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END)   AS cancelled_count
       FROM requests r JOIN departments d ON d.id = r.department_id
       ${cond}
       GROUP BY d.id, d.name ORDER BY d.name`
    )
    .all(...params);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN r.status = 'new' THEN 1 ELSE 0 END)         AS new_count,
              SUM(CASE WHEN r.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
              SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END)        AS done_count,
              SUM(CASE WHEN r.status = 'closed' THEN 1 ELSE 0 END)      AS closed_count,
              SUM(CASE WHEN r.status = 'rejected' THEN 1 ELSE 0 END)    AS rejected_count,
              SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END)   AS cancelled_count,
              ROUND(AVG(CASE WHEN r.done_at IS NOT NULL
                    THEN (julianday(r.done_at) - julianday(r.created_at)) * 24 END), 1)
                AS avg_completion_hours
       FROM requests r ${cond}`
    )
    .get(...params);

  res.json({ by_department: byDepartment, totals });
});

const STATUS_RU = {
  new: 'Новая',
  in_progress: 'В работе',
  done: 'Выполнена',
  closed: 'Закрыта',
  rejected: 'Отклонена',
  cancelled: 'Отменена',
};
const PRIORITY_RU = { low: 'Низкий', normal: 'Обычный', high: 'Высокий' };

app.get('/api/reports/export.csv', requireRole('owner'), (req, res) => {
  const { where, params } = periodFilter(req.query);
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`${REQUEST_SELECT} ${cond} ORDER BY r.created_at`).all(...params);

  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    '№', 'Тема', 'Подразделение', 'Статус', 'Приоритет', 'Автор',
    'Руководитель', 'Исполнитель', 'Создана', 'Принята', 'Выполнена', 'Закрыта', 'Срок',
  ];
  const lines = [header.join(';')];
  for (const r of rows) {
    lines.push(
      [
        r.id, r.title, r.department_name, STATUS_RU[r.status] || r.status,
        PRIORITY_RU[r.priority] || r.priority, r.created_by_name, r.manager_name,
        r.executor_name, r.created_at, r.accepted_at, r.done_at, r.closed_at, r.due_date,
      ]
        .map(esc)
        .join(';')
    );
  }
  // BOM — чтобы Excel корректно открыл кириллицу.
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
  res.send('\uFEFF' + lines.join('\r\n'));
});

// ---------------------------------------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
}

module.exports = app;
