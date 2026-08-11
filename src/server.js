'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { pool, query, one, all, ready, ROLES, DEPT_ROLES, PRIORITIES } = require('./db');
const { hashPassword, verifyPassword } = require('./passwords');
const {
  COOKIE_NAME,
  createSession,
  destroySession,
  sessionMiddleware,
  requireRole,
} = require('./auth');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Все API-запросы: проверяем подключение БД, инициализируем схему, читаем сессию.
app.use('/api', async (req, res, next) => {
  if (!pool) {
    return res.status(503).json({
      error:
        'База данных не подключена. Создайте базу в панели Vercel (Storage → Neon) и переразверните приложение.',
    });
  }
  await ready();
  next();
});
app.use('/api', sessionMiddleware);

const PORT = process.env.PORT || 3000;
const SECURE_COOKIES = !!process.env.VERCEL || process.env.NODE_ENV === 'production';

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

// Числовой идентификатор из URL/параметров; null, если это не целое число.
function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
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

async function getRequest(id) {
  if (!id) return undefined;
  return one(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
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

async function addEvent(requestId, userId, action, comment) {
  await query(
    'INSERT INTO request_events (request_id, user_id, action, comment) VALUES ($1, $2, $3, $4)',
    [requestId, userId, action, comment || null]
  );
}

// ---------------------------------------------------------------------------
// Авторизация
// ---------------------------------------------------------------------------

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'Укажите логин и пароль' });
  }
  const user = await one('SELECT * FROM users WHERE LOWER(login) = LOWER($1)', [
    String(login).trim(),
  ]);
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'Учётная запись отключена. Обратитесь к администратору' });
  }
  const token = await createSession(user.id);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES });
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', async (req, res) => {
  if (req.cookies[COOKIE_NAME]) await destroySession(req.cookies[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в систему' });
  res.json({ user: publicUser(req.user) });
});

app.post('/api/me/password', requireRole(), async (req, res) => {
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
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
    hashPassword(String(new_password)),
    req.user.id,
  ]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Подразделения
// ---------------------------------------------------------------------------

app.get('/api/departments', requireRole(), async (req, res) => {
  res.json({ departments: await all('SELECT * FROM departments ORDER BY name') });
});

app.post('/api/departments', requireRole('admin'), async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название подразделения' });
  try {
    const department = await one('INSERT INTO departments (name) VALUES ($1) RETURNING *', [name]);
    res.json({ department });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(400).json({ error: 'Подразделение с таким названием уже существует' });
    }
    throw e;
  }
});

app.put('/api/departments/:id', requireRole('admin'), async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название подразделения' });
  const dept = await one('SELECT * FROM departments WHERE id = $1', [toId(req.params.id)]);
  if (!dept) return res.status(404).json({ error: 'Подразделение не найдено' });
  try {
    const department = await one('UPDATE departments SET name = $1 WHERE id = $2 RETURNING *', [
      name,
      dept.id,
    ]);
    res.json({ department });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(400).json({ error: 'Подразделение с таким названием уже существует' });
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Пользователи (администратор системы)
// ---------------------------------------------------------------------------

async function validateUserPayload(body, { requirePassword }) {
  const login = String(body.login || '').trim();
  const full_name = String(body.full_name || '').trim();
  const role = String(body.role || '');
  const password = body.password == null ? '' : String(body.password);
  const department_id = body.department_id ? toId(body.department_id) : null;

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
    const dept = await one('SELECT id FROM departments WHERE id = $1', [department_id]);
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

app.get('/api/users', requireRole('admin'), async (req, res) => {
  const users = (
    await all(
      `SELECT u.*, d.name AS department_name
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
       ORDER BY u.is_active DESC, u.full_name`
    )
  ).map((u) => ({ ...publicUser(u), department_name: u.department_name }));
  res.json({ users });
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const check = await validateUserPayload(req.body || {}, { requirePassword: true });
  if (check.error) return res.status(400).json({ error: check.error });
  const v = check.value;
  const exists = await one('SELECT id FROM users WHERE LOWER(login) = LOWER($1)', [v.login]);
  if (exists) return res.status(400).json({ error: 'Пользователь с таким логином уже существует' });
  const user = await one(
    `INSERT INTO users (login, password_hash, full_name, role, department_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [v.login, hashPassword(v.password), v.full_name, v.role, v.department_id]
  );
  res.json({ user: publicUser(user) });
});

app.put('/api/users/:id', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const check = await validateUserPayload(req.body || {}, { requirePassword: false });
  if (check.error) return res.status(400).json({ error: check.error });
  const v = check.value;
  const exists = await one('SELECT id FROM users WHERE LOWER(login) = LOWER($1) AND id != $2', [
    v.login,
    user.id,
  ]);
  if (exists) return res.status(400).json({ error: 'Пользователь с таким логином уже существует' });
  const updated = await one(
    `UPDATE users SET login = $1, full_name = $2, role = $3, department_id = $4, updated_at = now()
     WHERE id = $5 RETURNING *`,
    [v.login, v.full_name, v.role, v.department_id, user.id]
  );
  res.json({ user: publicUser(updated) });
});

app.post('/api/users/:id/password', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const password = String((req.body || {}).password || '');
  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  }
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
    hashPassword(password),
    user.id,
  ]);
  // Смена пароля закрывает старые сессии пользователя.
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  res.json({ ok: true });
});

app.post('/api/users/:id/deactivate', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.id === req.user.id) {
    return res.status(400).json({ error: 'Нельзя отключить собственную учётную запись' });
  }
  await query('UPDATE users SET is_active = FALSE, updated_at = now() WHERE id = $1', [user.id]);
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  res.json({ ok: true });
});

app.post('/api/users/:id/restore', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  await query('UPDATE users SET is_active = TRUE, updated_at = now() WHERE id = $1', [user.id]);
  res.json({ ok: true });
});

// Справочники для форм: руководители своего подразделения (для админа подразделения)
// и исполнители своего подразделения (для руководителя).
app.get('/api/users/managers', requireRole('dept_admin'), async (req, res) => {
  const managers = await all(
    `SELECT id, full_name FROM users
     WHERE role = 'manager' AND department_id = $1 AND is_active
     ORDER BY full_name`,
    [req.user.department_id]
  );
  res.json({ managers });
});

app.get('/api/users/executors', requireRole('manager'), async (req, res) => {
  const executors = await all(
    `SELECT id, full_name FROM users
     WHERE role = 'executor' AND department_id = $1 AND is_active
     ORDER BY full_name`,
    [req.user.department_id]
  );
  res.json({ executors });
});

// ---------------------------------------------------------------------------
// Заявки
// ---------------------------------------------------------------------------

app.get(
  '/api/requests',
  requireRole('owner', 'dept_admin', 'manager', 'executor'),
  async (req, res) => {
    const where = [];
    const params = [];

    switch (req.user.role) {
      case 'owner': {
        const did = toId(req.query.department_id);
        if (did) {
          params.push(did);
          where.push(`r.department_id = $${params.length}`);
        }
        break;
      }
      case 'dept_admin':
        params.push(req.user.department_id);
        where.push(`r.department_id = $${params.length}`);
        break;
      case 'manager':
        params.push(req.user.department_id);
        where.push(`r.department_id = $${params.length}`);
        params.push(req.user.id);
        where.push(`r.manager_id = $${params.length}`);
        break;
      case 'executor':
        params.push(req.user.id);
        where.push(`r.executor_id = $${params.length}`);
        break;
    }

    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`r.status = $${params.length}`);
    }

    const sql = `${REQUEST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY r.created_at DESC, r.id DESC`;
    res.json({ requests: await all(sql, params) });
  }
);

app.get(
  '/api/requests/:id',
  requireRole('owner', 'dept_admin', 'manager', 'executor'),
  async (req, res) => {
    const r = await getRequest(toId(req.params.id));
    if (!r || !canSeeRequest(req.user, r)) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }
    const events = await all(
      `SELECT e.*, u.full_name AS user_name
       FROM request_events e JOIN users u ON u.id = e.user_id
       WHERE e.request_id = $1 ORDER BY e.created_at, e.id`,
      [r.id]
    );
    res.json({ request: r, events });
  }
);

// Создание заявки — администратор подразделения, адресуется руководителю работ
// своего подразделения.
app.post('/api/requests', requireRole('dept_admin'), async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
  const manager_id = toId(b.manager_id);
  const due_date = b.due_date ? String(b.due_date) : null;

  if (!title) return res.status(400).json({ error: 'Укажите тему заявки' });
  if (!manager_id) return res.status(400).json({ error: 'Выберите руководителя работ' });
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return res.status(400).json({ error: 'Некорректный срок выполнения' });
  }

  const manager = await one(
    `SELECT * FROM users WHERE id = $1 AND role = 'manager' AND is_active`,
    [manager_id]
  );
  if (!manager || manager.department_id !== req.user.department_id) {
    return res.status(400).json({ error: 'Руководитель должен относиться к вашему подразделению' });
  }

  const row = await one(
    `INSERT INTO requests (title, description, priority, department_id, created_by, manager_id, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [title, description, priority, req.user.department_id, req.user.id, manager_id, due_date]
  );
  await addEvent(row.id, req.user.id, 'created', null);
  res.json({ request: await getRequest(row.id) });
});

// Принять в работу и назначить исполнителя — руководитель работ.
app.post('/api/requests/:id/accept', requireRole('manager'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.manager_id !== req.user.id) {
    return res.status(404).json({ error: 'Заявка не найдена' });
  }
  if (r.status !== 'new') return res.status(400).json({ error: 'Заявка уже обработана' });

  const executor_id = toId((req.body || {}).executor_id);
  if (!executor_id) return res.status(400).json({ error: 'Выберите исполнителя' });
  const executor = await one(
    `SELECT * FROM users WHERE id = $1 AND role = 'executor' AND is_active`,
    [executor_id]
  );
  if (!executor || executor.department_id !== req.user.department_id) {
    return res.status(400).json({ error: 'Исполнитель должен относиться к вашему подразделению' });
  }

  await query(
    `UPDATE requests SET status = 'in_progress', executor_id = $1,
       accepted_at = now(), updated_at = now() WHERE id = $2`,
    [executor_id, r.id]
  );
  await addEvent(r.id, req.user.id, 'accepted', `Исполнитель: ${executor.full_name}`);
  res.json({ request: await getRequest(r.id) });
});

// Сменить исполнителя по заявке в работе — руководитель работ.
app.post('/api/requests/:id/assign', requireRole('manager'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.manager_id !== req.user.id) {
    return res.status(404).json({ error: 'Заявка не найдена' });
  }
  if (r.status !== 'in_progress') {
    return res.status(400).json({ error: 'Сменить исполнителя можно только по заявке в работе' });
  }

  const executor_id = toId((req.body || {}).executor_id);
  if (!executor_id) return res.status(400).json({ error: 'Выберите исполнителя' });
  const executor = await one(
    `SELECT * FROM users WHERE id = $1 AND role = 'executor' AND is_active`,
    [executor_id]
  );
  if (!executor || executor.department_id !== req.user.department_id) {
    return res.status(400).json({ error: 'Исполнитель должен относиться к вашему подразделению' });
  }

  await query('UPDATE requests SET executor_id = $1, updated_at = now() WHERE id = $2', [
    executor_id,
    r.id,
  ]);
  await addEvent(r.id, req.user.id, 'reassigned', `Новый исполнитель: ${executor.full_name}`);
  res.json({ request: await getRequest(r.id) });
});

// Отклонить заявку — руководитель работ (с указанием причины).
app.post('/api/requests/:id/reject', requireRole('manager'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.manager_id !== req.user.id) {
    return res.status(404).json({ error: 'Заявка не найдена' });
  }
  if (r.status !== 'new') {
    return res.status(400).json({ error: 'Отклонить можно только новую заявку' });
  }
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Укажите причину отклонения' });

  await query(
    `UPDATE requests SET status = 'rejected', reject_reason = $1, updated_at = now() WHERE id = $2`,
    [reason, r.id]
  );
  await addEvent(r.id, req.user.id, 'rejected', reason);
  res.json({ request: await getRequest(r.id) });
});

// Отметить выполнение — исполнитель.
app.post('/api/requests/:id/done', requireRole('executor'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.executor_id !== req.user.id) {
    return res.status(404).json({ error: 'Заявка не найдена' });
  }
  if (r.status !== 'in_progress') {
    return res.status(400).json({ error: 'Заявка не находится в работе' });
  }
  const comment = String((req.body || {}).comment || '').trim();

  await query(
    `UPDATE requests SET status = 'done', done_at = now(), updated_at = now() WHERE id = $1`,
    [r.id]
  );
  await addEvent(r.id, req.user.id, 'done', comment || null);
  res.json({ request: await getRequest(r.id) });
});

// Подтвердить выполнение и закрыть — руководитель работ.
app.post('/api/requests/:id/close', requireRole('manager'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.manager_id !== req.user.id) {
    return res.status(404).json({ error: 'Заявка не найдена' });
  }
  if (r.status !== 'done') {
    return res.status(400).json({ error: 'Закрыть можно только выполненную заявку' });
  }

  await query(
    `UPDATE requests SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1`,
    [r.id]
  );
  await addEvent(r.id, req.user.id, 'closed', null);
  res.json({ request: await getRequest(r.id) });
});

// Вернуть выполненную заявку в работу (доработка) — руководитель работ.
app.post('/api/requests/:id/reopen', requireRole('manager'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.manager_id !== req.user.id) {
    return res.status(404).json({ error: 'Заявка не найдена' });
  }
  if (r.status !== 'done') {
    return res.status(400).json({ error: 'Вернуть в работу можно только выполненную заявку' });
  }
  const comment = String((req.body || {}).comment || '').trim();
  if (!comment) return res.status(400).json({ error: 'Укажите, что нужно доработать' });

  await query(
    `UPDATE requests SET status = 'in_progress', done_at = NULL, updated_at = now() WHERE id = $1`,
    [r.id]
  );
  await addEvent(r.id, req.user.id, 'reopened', comment);
  res.json({ request: await getRequest(r.id) });
});

// Отменить новую заявку — администратор подразделения (своё подразделение).
app.post('/api/requests/:id/cancel', requireRole('dept_admin'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.department_id !== req.user.department_id) {
    return res.status(404).json({ error: 'Заявка не найдена' });
  }
  if (r.status !== 'new') {
    return res.status(400).json({ error: 'Отменить можно только новую заявку' });
  }

  await query(`UPDATE requests SET status = 'cancelled', updated_at = now() WHERE id = $1`, [r.id]);
  await addEvent(r.id, req.user.id, 'cancelled', null);
  res.json({ request: await getRequest(r.id) });
});

// ---------------------------------------------------------------------------
// Отчёты (собственник)
// ---------------------------------------------------------------------------

function periodFilter(q) {
  const where = [];
  const params = [];
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) {
    params.push(q.from);
    where.push(`r.created_at >= $${params.length}::date`);
  }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
    params.push(q.to);
    where.push(`r.created_at < $${params.length}::date + interval '1 day'`);
  }
  return { where, params };
}

const STATUS_COUNTS = `
  COUNT(*) FILTER (WHERE r.status = 'new')::int         AS new_count,
  COUNT(*) FILTER (WHERE r.status = 'in_progress')::int AS in_progress_count,
  COUNT(*) FILTER (WHERE r.status = 'done')::int        AS done_count,
  COUNT(*) FILTER (WHERE r.status = 'closed')::int      AS closed_count,
  COUNT(*) FILTER (WHERE r.status = 'rejected')::int    AS rejected_count,
  COUNT(*) FILTER (WHERE r.status = 'cancelled')::int   AS cancelled_count
`;

app.get('/api/reports/summary', requireRole('owner'), async (req, res) => {
  const { where, params } = periodFilter(req.query);
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const byDepartment = await all(
    `SELECT d.id AS department_id, d.name AS department_name,
            COUNT(*)::int AS total, ${STATUS_COUNTS}
     FROM requests r JOIN departments d ON d.id = r.department_id
     ${cond}
     GROUP BY d.id, d.name ORDER BY d.name`,
    params
  );

  const totals = await one(
    `SELECT COUNT(*)::int AS total, ${STATUS_COUNTS},
            ROUND((AVG(EXTRACT(EPOCH FROM (r.done_at - r.created_at)) / 3600.0)
                   FILTER (WHERE r.done_at IS NOT NULL))::numeric, 1)::float8
              AS avg_completion_hours
     FROM requests r ${cond}`,
    params
  );

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

app.get('/api/reports/export.csv', requireRole('owner'), async (req, res) => {
  const { where, params } = periodFilter(req.query);
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await all(`${REQUEST_SELECT} ${cond} ORDER BY r.created_at`, params);

  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fmtTs = (v) => (v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 16) : v);
  const header = [
    '№', 'Тема', 'Подразделение', 'Статус', 'Приоритет', 'Автор',
    'Руководитель', 'Исполнитель', 'Создана (UTC)', 'Принята (UTC)',
    'Выполнена (UTC)', 'Закрыта (UTC)', 'Срок',
  ];
  const lines = [header.join(';')];
  for (const r of rows) {
    lines.push(
      [
        r.id, r.title, r.department_name, STATUS_RU[r.status] || r.status,
        PRIORITY_RU[r.priority] || r.priority, r.created_by_name, r.manager_name,
        r.executor_name, fmtTs(r.created_at), fmtTs(r.accepted_at),
        fmtTs(r.done_at), fmtTs(r.closed_at), r.due_date,
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
