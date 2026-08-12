'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const {
  pool, query, one, all, ready,
  ROLES, DEPT_ROLES, SITE_ROLES, PRIORITIES, POSITION_PERMS,
} = require('./db');
const { hashPassword, verifyPassword } = require('./passwords');
const {
  COOKIE_NAME,
  createSession,
  destroySession,
  getSessionUser,
  sessionMiddleware,
  requireRole,
} = require('./auth');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Every API request: check the DB connection, initialize the schema, read the session.
app.use('/api', async (req, res, next) => {
  if (!pool) {
    return res.status(503).json({
      error:
        'Database is not connected. Create a database in the Vercel dashboard (Storage → Neon) and redeploy the app.',
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
    site_id: u.site_id,
    position_id: u.position_id,
    position_title: u.position_title || null,
    is_active: !!u.is_active,
    must_set_password: !!u.must_set_password,
    // Effective permissions (from the position); false for non-position users.
    perm_create: !!u.perm_create,
    perm_view_site: !!u.perm_view_site,
    perm_cancel: !!u.perm_cancel,
    perm_reports: !!u.perm_reports,
    created_at: u.created_at,
  };
}

// Guard: the signed-in site-admin position grants a particular permission.
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role !== 'site_admin' || !req.user[perm]) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Numeric id from a URL/param; null if it is not a positive integer.
function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// created_by_name is a snapshot column on requests (survives employee deletion),
// so it comes from r.* — do not re-derive it from a live users join.
const REQUEST_SELECT = `
  SELECT r.*,
         d.name    AS department_name,
         st.name   AS site_name,
         pos.title AS position_title,
         mu.full_name AS manager_name,
         eu.full_name AS executor_name
  FROM requests r
  JOIN departments d ON d.id = r.department_id
  LEFT JOIN sites st ON st.id = r.site_id
  LEFT JOIN positions pos ON pos.id = r.position_id
  LEFT JOIN users mu ON mu.id = r.manager_id
  LEFT JOIN users eu ON eu.id = r.executor_id
`;

async function getRequest(id) {
  if (!id) return undefined;
  return one(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
}

// Who can see a request (card and list view).
//   owner      — everything
//   site_admin — requests originating from their site
//   manager    — requests addressed to their department
//   executor   — requests assigned to them
function canSeeRequest(user, r) {
  switch (user.role) {
    case 'owner':
      return true;
    case 'site_admin':
      return user.perm_view_site ? r.site_id === user.site_id : r.created_by === user.id;
    case 'manager':
      return r.department_id === user.department_id;
    case 'executor':
      return r.executor_id === user.id;
    default:
      return false;
  }
}

// Records who did what; user_name is snapshotted so the log survives a later
// deletion of the employee.
async function addEvent(requestId, user, action, comment) {
  await query(
    'INSERT INTO request_events (request_id, user_id, user_name, action, comment) VALUES ($1, $2, $3, $4, $5)',
    [requestId, user.id, user.full_name, action, comment || null]
  );
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {};
  if (!login) return res.status(400).json({ error: 'Enter a username' });
  const user = await one('SELECT * FROM users WHERE LOWER(login) = LOWER($1)', [
    String(login).trim(),
  ]);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  // Accounts awaiting first-time setup have no password: sign in on username
  // alone, then the client forces the user to choose a password.
  if (!user.must_set_password && !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'Account is disabled. Contact your administrator' });
  }
  const token = await createSession(user.id);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES });
  // Reload through the session query so the response carries the position's
  // permissions and title, not just the bare users row.
  const enriched = await getSessionUser(token);
  res.json({ user: publicUser(enriched || user) });
});

// Set a password for an account that was created (or reset) without one.
app.post('/api/me/set-password', requireRole(), async (req, res) => {
  if (!req.user.must_set_password) {
    return res.status(400).json({ error: 'A password is already set; use Change password' });
  }
  const password = String((req.body || {}).new_password || '');
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  await query(
    'UPDATE users SET password_hash = $1, must_set_password = FALSE, updated_at = now() WHERE id = $2',
    [hashPassword(password), req.user.id]
  );
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  if (req.cookies[COOKIE_NAME]) await destroySession(req.cookies[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  res.json({ user: publicUser(req.user) });
});

app.post('/api/me/password', requireRole(), async (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) {
    return res.status(400).json({ error: 'Enter your current and new password' });
  }
  if (String(new_password).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  if (!verifyPassword(String(old_password), req.user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
    hashPassword(String(new_password)),
    req.user.id,
  ]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Simple named lists — departments (service departments) and sites (addresses)
// ---------------------------------------------------------------------------

function namedListRoutes(pathName, table) {
  // Any signed-in user can read the lists (used to fill dropdowns). The client
  // shows only active entries in pickers; the admin screen shows all.
  app.get(`/api/${pathName}`, requireRole(), async (req, res) => {
    res.json({
      [pathName]: await all(`SELECT * FROM ${table} ORDER BY is_active DESC, name`),
    });
  });

  app.post(`/api/${pathName}`, requireRole('admin'), async (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter a name' });
    try {
      const row = await one(`INSERT INTO ${table} (name) VALUES ($1) RETURNING *`, [name]);
      res.json({ item: row });
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'This name already exists' });
      throw e;
    }
  });

  app.put(`/api/${pathName}/:id`, requireRole('admin'), async (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter a name' });
    const existing = await one(`SELECT * FROM ${table} WHERE id = $1`, [toId(req.params.id)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    try {
      const row = await one(`UPDATE ${table} SET name = $1 WHERE id = $2 RETURNING *`, [name, existing.id]);
      res.json({ item: row });
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'This name already exists' });
      throw e;
    }
  });

  // Entries are never deleted (existing requests/users still reference them);
  // they are deactivated instead, which just hides them from new pickers.
  const setActive = (active) => async (req, res) => {
    const existing = await one(`SELECT * FROM ${table} WHERE id = $1`, [toId(req.params.id)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const row = await one(`UPDATE ${table} SET is_active = $1 WHERE id = $2 RETURNING *`, [
      active,
      existing.id,
    ]);
    res.json({ item: row });
  };
  app.post(`/api/${pathName}/:id/deactivate`, requireRole('admin'), setActive(false));
  app.post(`/api/${pathName}/:id/restore`, requireRole('admin'), setActive(true));
}

namedListRoutes('departments', 'departments');
namedListRoutes('sites', 'sites');

// ---------------------------------------------------------------------------
// Positions (belong to a site, carry permissions; permanent — never deleted)
// ---------------------------------------------------------------------------

const POSITION_SELECT = `
  SELECT p.*, s.name AS site_name
  FROM positions p JOIN sites s ON s.id = p.site_id
`;

function positionPerms(body) {
  const perms = {};
  for (const key of POSITION_PERMS) perms[key] = !!(body && body[key]);
  return perms;
}

// Everyone signed in can read positions (to fill pickers). Optional ?site_id=.
app.get('/api/positions', requireRole(), async (req, res) => {
  const siteId = toId(req.query.site_id);
  const rows = siteId
    ? await all(`${POSITION_SELECT} WHERE p.site_id = $1 ORDER BY p.is_active DESC, s.name, p.title`, [siteId])
    : await all(`${POSITION_SELECT} ORDER BY p.is_active DESC, s.name, p.title`);
  res.json({ positions: rows });
});

app.post('/api/positions', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const site_id = toId(b.site_id);
  if (!title) return res.status(400).json({ error: 'Enter a position title' });
  if (!site_id || !(await one('SELECT id FROM sites WHERE id = $1', [site_id]))) {
    return res.status(400).json({ error: 'Select a site' });
  }
  const p = positionPerms(b);
  const row = await one(
    `INSERT INTO positions (site_id, title, perm_create, perm_view_site, perm_cancel, perm_reports)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [site_id, title, p.perm_create, p.perm_view_site, p.perm_cancel, p.perm_reports]
  );
  res.json({ position: row });
});

app.put('/api/positions/:id', requireRole('admin'), async (req, res) => {
  const pos = await one('SELECT * FROM positions WHERE id = $1', [toId(req.params.id)]);
  if (!pos) return res.status(404).json({ error: 'Position not found' });
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Enter a position title' });
  const p = positionPerms(b);
  const row = await one(
    `UPDATE positions SET title = $1, perm_create = $2, perm_view_site = $3, perm_cancel = $4,
       perm_reports = $5 WHERE id = $6 RETURNING *`,
    [title, p.perm_create, p.perm_view_site, p.perm_cancel, p.perm_reports, pos.id]
  );
  res.json({ position: row });
});

const setPositionActive = (active) => async (req, res) => {
  const pos = await one('SELECT * FROM positions WHERE id = $1', [toId(req.params.id)]);
  if (!pos) return res.status(404).json({ error: 'Position not found' });
  const row = await one('UPDATE positions SET is_active = $1 WHERE id = $2 RETURNING *', [active, pos.id]);
  res.json({ position: row });
};
app.post('/api/positions/:id/deactivate', requireRole('admin'), setPositionActive(false));
app.post('/api/positions/:id/restore', requireRole('admin'), setPositionActive(true));

// A department may be permanently deleted only when nothing references it;
// otherwise it must be deactivated so request history is preserved.
app.delete('/api/departments/:id', requireRole('admin'), async (req, res) => {
  const dept = await one('SELECT * FROM departments WHERE id = $1', [toId(req.params.id)]);
  if (!dept) return res.status(404).json({ error: 'Department not found' });
  if (await one('SELECT 1 FROM requests WHERE department_id = $1 LIMIT 1', [dept.id])) {
    return res.status(400).json({
      error: 'This department has requests and cannot be deleted — deactivate it instead',
    });
  }
  if (await one('SELECT 1 FROM users WHERE department_id = $1 LIMIT 1', [dept.id])) {
    return res.status(400).json({ error: 'This department has users assigned — reassign them first' });
  }
  await query('DELETE FROM departments WHERE id = $1', [dept.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Users (system administrator)
// ---------------------------------------------------------------------------

async function validateUserPayload(body) {
  const login = String(body.login || '').trim();
  const full_name = String(body.full_name || '').trim();
  const role = String(body.role || '');
  // Password is optional: when blank, the user sets it at first sign-in.
  const password = body.password == null ? '' : String(body.password);
  const department_id = body.department_id ? toId(body.department_id) : null;
  const position_id = body.position_id ? toId(body.position_id) : null;

  if (!login) return { error: 'Enter a username' };
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(login)) {
    return { error: 'Username: 3–32 characters, letters, digits, dot, hyphen, underscore' };
  }
  if (!full_name) return { error: 'Enter a full name' };
  if (!ROLES.includes(role)) return { error: 'Invalid role' };
  if (password && password.length < 6) {
    return { error: 'Password must be at least 6 characters' };
  }

  // Department roles are bound to a department; site roles to a position (which
  // itself belongs to a site — the site is derived from the position).
  let dept = null;
  let site = null;
  let position = null;
  if (DEPT_ROLES.includes(role)) {
    if (!department_id) return { error: 'This role requires a department' };
    if (!(await one('SELECT id FROM departments WHERE id = $1', [department_id]))) {
      return { error: 'Department not found' };
    }
    dept = department_id;
  } else if (SITE_ROLES.includes(role)) {
    if (!position_id) return { error: 'This role requires a position' };
    const pos = await one('SELECT * FROM positions WHERE id = $1', [position_id]);
    if (!pos) return { error: 'Position not found' };
    position = pos.id;
    site = pos.site_id;
  }

  return {
    value: { login, full_name, role, password, department_id: dept, site_id: site, position_id: position },
  };
}

app.get('/api/users', requireRole('admin'), async (req, res) => {
  const users = (
    await all(
      `SELECT u.*, d.name AS department_name, st.name AS site_name, p.title AS position_title
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN sites st ON st.id = u.site_id
       LEFT JOIN positions p ON p.id = u.position_id
       ORDER BY u.is_active DESC, u.full_name`
    )
  ).map((u) => ({
    ...publicUser(u),
    department_name: u.department_name,
    site_name: u.site_name,
    position_title: u.position_title || null,
  }));
  res.json({ users });
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const check = await validateUserPayload(req.body || {});
  if (check.error) return res.status(400).json({ error: check.error });
  const v = check.value;
  const exists = await one('SELECT id FROM users WHERE LOWER(login) = LOWER($1)', [v.login]);
  if (exists) return res.status(400).json({ error: 'A user with this username already exists' });
  const hasPassword = v.password.length >= 6;
  const user = await one(
    `INSERT INTO users (login, password_hash, full_name, role, department_id, site_id, position_id, must_set_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      v.login,
      hasPassword ? hashPassword(v.password) : '',
      v.full_name,
      v.role,
      v.department_id,
      v.site_id,
      v.position_id,
      !hasPassword,
    ]
  );
  res.json({ user: publicUser(user) });
});

app.put('/api/users/:id', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const check = await validateUserPayload(req.body || {});
  if (check.error) return res.status(400).json({ error: check.error });
  const v = check.value;
  const exists = await one('SELECT id FROM users WHERE LOWER(login) = LOWER($1) AND id != $2', [
    v.login,
    user.id,
  ]);
  if (exists) return res.status(400).json({ error: 'A user with this username already exists' });
  const updated = await one(
    `UPDATE users SET login = $1, full_name = $2, role = $3, department_id = $4, site_id = $5,
       position_id = $6, updated_at = now() WHERE id = $7 RETURNING *`,
    [v.login, v.full_name, v.role, v.department_id, v.site_id, v.position_id, user.id]
  );
  res.json({ user: publicUser(updated) });
});

app.post('/api/users/:id/password', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = String((req.body || {}).password || '');
  if (password && password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  // A blank password resets the account: the user chooses a new one at next
  // sign-in. A supplied password is set directly.
  if (password) {
    await query(
      'UPDATE users SET password_hash = $1, must_set_password = FALSE, updated_at = now() WHERE id = $2',
      [hashPassword(password), user.id]
    );
  } else {
    await query(
      "UPDATE users SET password_hash = '', must_set_password = TRUE, updated_at = now() WHERE id = $1",
      [user.id]
    );
  }
  // Resetting the password invalidates the user's existing sessions.
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  res.json({ ok: true });
});

app.post('/api/users/:id/deactivate', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot disable your own account' });
  }
  await query('UPDATE users SET is_active = FALSE, updated_at = now() WHERE id = $1', [user.id]);
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  res.json({ ok: true });
});

app.post('/api/users/:id/restore', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await query('UPDATE users SET is_active = TRUE, updated_at = now() WHERE id = $1', [user.id]);
  res.json({ ok: true });
});

// Permanently delete an employee. Request history is preserved via the name
// snapshots on requests/events; the person foreign keys become NULL.
app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  await query('DELETE FROM users WHERE id = $1', [user.id]);
  res.json({ ok: true });
});

// Executors of the current supervisor's department (for the assign form).
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
// Requests
// ---------------------------------------------------------------------------

app.get(
  '/api/requests',
  requireRole('owner', 'site_admin', 'manager', 'executor'),
  async (req, res) => {
    const where = [];
    const params = [];
    const add = (clause, value) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    switch (req.user.role) {
      case 'owner':
        if (toId(req.query.department_id)) add('r.department_id = $?', toId(req.query.department_id));
        if (toId(req.query.site_id)) add('r.site_id = $?', toId(req.query.site_id));
        break;
      case 'site_admin':
        // "view all site requests" permission widens the view from own to site.
        if (req.user.perm_view_site) add('r.site_id = $?', req.user.site_id);
        else add('r.created_by = $?', req.user.id);
        break;
      case 'manager':
        add('r.department_id = $?', req.user.department_id);
        break;
      case 'executor':
        add('r.executor_id = $?', req.user.id);
        break;
    }

    if (req.query.status) add('r.status = $?', String(req.query.status));

    const sql = `${REQUEST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY r.created_at DESC, r.id DESC`;
    res.json({ requests: await all(sql, params) });
  }
);

app.get(
  '/api/requests/:id',
  requireRole('owner', 'site_admin', 'manager', 'executor'),
  async (req, res) => {
    const r = await getRequest(toId(req.params.id));
    if (!r || !canSeeRequest(req.user, r)) {
      return res.status(404).json({ error: 'Request not found' });
    }
    // user_name is a snapshot column, so no join to a live users row is needed.
    const events = await all(
      `SELECT * FROM request_events WHERE request_id = $1 ORDER BY created_at, id`,
      [r.id]
    );
    res.json({ request: r, events });
  }
);

// Create a request — a position with the "create requests" permission; addressed
// to a service department. The site, position and creator name are recorded
// (the name as a snapshot, for durable reporting).
app.post('/api/requests', requirePerm('perm_create'), async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
  const department_id = toId(b.department_id);
  const due_date = b.due_date ? String(b.due_date) : null;

  if (!title) return res.status(400).json({ error: 'Enter a request subject' });
  if (!department_id) return res.status(400).json({ error: 'Select a department' });
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return res.status(400).json({ error: 'Invalid due date' });
  }
  if (!(await one('SELECT id FROM departments WHERE id = $1 AND is_active', [department_id]))) {
    return res.status(400).json({ error: 'Select an active department' });
  }

  const row = await one(
    `INSERT INTO requests (title, description, priority, site_id, position_id, department_id,
       created_by, created_by_name, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      title, description, priority, req.user.site_id, req.user.position_id, department_id,
      req.user.id, req.user.full_name, due_date,
    ]
  );
  await addEvent(row.id, req.user, 'created', null);
  res.json({ request: await getRequest(row.id) });
});

// A supervisor may act on a request only if it is addressed to their department.
async function managerRequest(req, res) {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.department_id !== req.user.department_id) {
    res.status(404).json({ error: 'Request not found' });
    return null;
  }
  return r;
}

// Accept and assign an executor — any supervisor of the target department.
app.post('/api/requests/:id/accept', requireRole('manager'), async (req, res) => {
  const r = await managerRequest(req, res);
  if (!r) return;
  if (r.status !== 'new') return res.status(400).json({ error: 'Request has already been processed' });

  const executor_id = toId((req.body || {}).executor_id);
  if (!executor_id) return res.status(400).json({ error: 'Select an executor' });
  const executor = await one(
    `SELECT * FROM users WHERE id = $1 AND role = 'executor' AND is_active`,
    [executor_id]
  );
  if (!executor || executor.department_id !== req.user.department_id) {
    return res.status(400).json({ error: 'The executor must belong to your department' });
  }

  await query(
    `UPDATE requests SET status = 'in_progress', manager_id = $1, executor_id = $2,
       accepted_at = now(), updated_at = now() WHERE id = $3`,
    [req.user.id, executor_id, r.id]
  );
  await addEvent(r.id, req.user, 'accepted', `Executor: ${executor.full_name}`);
  res.json({ request: await getRequest(r.id) });
});

// Reject a request — any supervisor of the target department (with a reason).
app.post('/api/requests/:id/reject', requireRole('manager'), async (req, res) => {
  const r = await managerRequest(req, res);
  if (!r) return;
  if (r.status !== 'new') return res.status(400).json({ error: 'Only a new request can be rejected' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Enter a rejection reason' });

  await query(
    `UPDATE requests SET status = 'rejected', manager_id = $1, reject_reason = $2,
       updated_at = now() WHERE id = $3`,
    [req.user.id, reason, r.id]
  );
  await addEvent(r.id, req.user, 'rejected', reason);
  res.json({ request: await getRequest(r.id) });
});

// The supervisor who accepted a request owns its later transitions.
async function owningManagerRequest(req, res) {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.manager_id !== req.user.id) {
    res.status(404).json({ error: 'Request not found' });
    return null;
  }
  return r;
}

// Reassign the executor on a request in progress.
app.post('/api/requests/:id/assign', requireRole('manager'), async (req, res) => {
  const r = await owningManagerRequest(req, res);
  if (!r) return;
  if (r.status !== 'in_progress') {
    return res.status(400).json({ error: 'You can reassign only a request that is in progress' });
  }

  const executor_id = toId((req.body || {}).executor_id);
  if (!executor_id) return res.status(400).json({ error: 'Select an executor' });
  const executor = await one(
    `SELECT * FROM users WHERE id = $1 AND role = 'executor' AND is_active`,
    [executor_id]
  );
  if (!executor || executor.department_id !== req.user.department_id) {
    return res.status(400).json({ error: 'The executor must belong to your department' });
  }

  await query('UPDATE requests SET executor_id = $1, updated_at = now() WHERE id = $2', [
    executor_id,
    r.id,
  ]);
  await addEvent(r.id, req.user, 'reassigned', `New executor: ${executor.full_name}`);
  res.json({ request: await getRequest(r.id) });
});

// Mark as completed — executor.
app.post('/api/requests/:id/done', requireRole('executor'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.executor_id !== req.user.id) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (r.status !== 'in_progress') {
    return res.status(400).json({ error: 'Request is not in progress' });
  }
  const comment = String((req.body || {}).comment || '').trim();

  await query(
    `UPDATE requests SET status = 'done', done_at = now(), updated_at = now() WHERE id = $1`,
    [r.id]
  );
  await addEvent(r.id, req.user, 'done', comment || null);
  res.json({ request: await getRequest(r.id) });
});

// Confirm completion and close — the supervisor who accepted it.
app.post('/api/requests/:id/close', requireRole('manager'), async (req, res) => {
  const r = await owningManagerRequest(req, res);
  if (!r) return;
  if (r.status !== 'done') {
    return res.status(400).json({ error: 'Only a completed request can be closed' });
  }

  await query(
    `UPDATE requests SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1`,
    [r.id]
  );
  await addEvent(r.id, req.user, 'closed', null);
  res.json({ request: await getRequest(r.id) });
});

// Return a completed request for rework — the supervisor who accepted it.
app.post('/api/requests/:id/reopen', requireRole('manager'), async (req, res) => {
  const r = await owningManagerRequest(req, res);
  if (!r) return;
  if (r.status !== 'done') {
    return res.status(400).json({ error: 'Only a completed request can be returned for rework' });
  }
  const comment = String((req.body || {}).comment || '').trim();
  if (!comment) return res.status(400).json({ error: 'Describe what needs to be reworked' });

  await query(
    `UPDATE requests SET status = 'in_progress', done_at = NULL, updated_at = now() WHERE id = $1`,
    [r.id]
  );
  await addEvent(r.id, req.user, 'reopened', comment);
  res.json({ request: await getRequest(r.id) });
});

// Cancel a new request — a position with the "cancel requests" permission (own site).
app.post('/api/requests/:id/cancel', requirePerm('perm_cancel'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.site_id !== req.user.site_id) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (r.status !== 'new') {
    return res.status(400).json({ error: 'Only a new request can be cancelled' });
  }

  await query(`UPDATE requests SET status = 'cancelled', updated_at = now() WHERE id = $1`, [r.id]);
  await addEvent(r.id, req.user, 'cancelled', null);
  res.json({ request: await getRequest(r.id) });
});

// ---------------------------------------------------------------------------
// Reports — the owner (whole organization) or a position with the "view site
// reports" permission (scoped to its own site).
// ---------------------------------------------------------------------------

function requireReports(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const ok = req.user.role === 'owner' || (req.user.role === 'site_admin' && req.user.perm_reports);
  if (!ok) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
}

// Period filter, plus an automatic site restriction for site-scoped reporters.
function periodFilter(req) {
  const q = req.query;
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
  if (req.user.role === 'site_admin') {
    params.push(req.user.site_id);
    where.push(`r.site_id = $${params.length}`);
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

app.get('/api/reports/summary', requireReports, async (req, res) => {
  const { where, params } = periodFilter(req);
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const byDepartment = await all(
    `SELECT d.id AS department_id, d.name AS department_name,
            COUNT(*)::int AS total, ${STATUS_COUNTS}
     FROM requests r JOIN departments d ON d.id = r.department_id
     ${cond}
     GROUP BY d.id, d.name ORDER BY d.name`,
    params
  );

  const bySite = await all(
    `SELECT st.id AS site_id, st.name AS site_name,
            COUNT(*)::int AS total, ${STATUS_COUNTS}
     FROM requests r LEFT JOIN sites st ON st.id = r.site_id
     ${cond}
     GROUP BY st.id, st.name ORDER BY st.name NULLS LAST`,
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

  res.json({ by_department: byDepartment, by_site: bySite, totals });
});

const STATUS_LABEL = {
  new: 'New',
  in_progress: 'In progress',
  done: 'Completed',
  closed: 'Closed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High' };

app.get('/api/reports/export.csv', requireReports, async (req, res) => {
  const { where, params } = periodFilter(req);
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await all(`${REQUEST_SELECT} ${cond} ORDER BY r.created_at`, params);

  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fmtTs = (v) => (v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 16) : v);
  const header = [
    '#', 'Subject', 'Site', 'Department', 'Status', 'Priority', 'Created by',
    'Supervisor', 'Executor', 'Created (UTC)', 'Accepted (UTC)',
    'Completed (UTC)', 'Closed (UTC)', 'Due',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id, r.title, r.site_name, r.department_name, STATUS_LABEL[r.status] || r.status,
        PRIORITY_LABEL[r.priority] || r.priority, r.created_by_name, r.manager_name,
        r.executor_name, fmtTs(r.created_at), fmtTs(r.accepted_at),
        fmtTs(r.done_at), fmtTs(r.closed_at), r.due_date,
      ]
        .map(esc)
        .join(',')
    );
  }
  // BOM so Excel opens the file as UTF-8.
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

// ---------------------------------------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
}

module.exports = app;
