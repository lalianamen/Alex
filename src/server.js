'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { pool, query, one, all, ready, ROLES, PRIORITIES, POSITION_PERMS } = require('./db');
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
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    phone: u.phone || null,
    address: u.address || null,
    supervisor_id: u.supervisor_id || null,
    role: u.role,
    site_id: u.site_id,
    position_id: u.position_id,
    position2_id: u.position2_id || null,
    position_title: u.position_title || null,
    position2_title: u.position2_title || null,
    is_active: !!u.is_active,
    is_super: !!u.is_super,
    must_set_password: !!u.must_set_password,
    // Effective permissions (from the position); false for non-employee users.
    perm_create: !!u.perm_create,
    perm_view_site: !!u.perm_view_site,
    perm_cancel: !!u.perm_cancel,
    perm_reports: !!u.perm_reports,
    perm_accept: !!u.perm_accept,
    perm_execute: !!u.perm_execute,
    created_at: u.created_at,
  };
}

// Guard: the signed-in employee's position grants a particular permission.
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role !== 'employee' || !req.user[perm]) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Guard: only the super administrator (the built-in "admin"). Regular admins
// have every other power but cannot permanently delete companies/divisions.
function requireSuper(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin' || !req.user.is_super) {
    return res.status(403).json({ error: 'Only the main administrator can delete — deactivate instead' });
  }
  next();
}

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// created_by_name is a snapshot on requests (survives employee deletion); it
// comes from r.*, not a live users join.
const REQUEST_SELECT = `
  SELECT r.*,
         os.name  AS site_name,          -- origin division
         ts.name  AS target_site_name,   -- target division
         pos.title AS position_title,
         mu.full_name AS manager_name,
         eu.full_name AS executor_name
  FROM requests r
  LEFT JOIN sites os ON os.id = r.site_id
  LEFT JOIN sites ts ON ts.id = r.target_site_id
  LEFT JOIN positions pos ON pos.id = r.position_id
  LEFT JOIN users mu ON mu.id = r.manager_id
  LEFT JOIN users eu ON eu.id = r.executor_id
`;

async function getRequest(id) {
  if (!id) return undefined;
  return one(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
}

// Who can see a request.
//   owner    — everything
//   employee — union of: created it; (view-all) any request from own division;
//              (accept) any request sent to own division; (perform) assigned to them
function canSeeRequest(u, r) {
  if (u.role === 'owner') return true;
  if (u.role !== 'employee') return false;
  if (r.created_by === u.id) return true;
  if (u.perm_view_site && r.site_id === u.site_id) return true;
  if (u.perm_accept && r.target_site_id === u.site_id) return true;
  if (u.perm_execute && r.executor_id === u.id) return true;
  return false;
}

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
  const user = await one('SELECT * FROM users WHERE LOWER(login) = LOWER($1)', [String(login).trim()]);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  if (!user.must_set_password && !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'Account is disabled. Contact your administrator' });
  }
  const token = await createSession(user.id);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES });
  const enriched = await getSessionUser(token);
  res.json({ user: publicUser(enriched || user) });
});

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
// Companies
// ---------------------------------------------------------------------------

app.get('/api/companies', requireRole(), async (req, res) => {
  res.json({ companies: await all('SELECT * FROM companies ORDER BY is_active DESC, name') });
});

app.post('/api/companies', requireRole('admin'), async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter a company name' });
  try {
    res.json({ company: await one('INSERT INTO companies (name) VALUES ($1) RETURNING *', [name]) });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'This name already exists' });
    throw e;
  }
});

app.put('/api/companies/:id', requireRole('admin'), async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter a company name' });
  const c = await one('SELECT * FROM companies WHERE id = $1', [toId(req.params.id)]);
  if (!c) return res.status(404).json({ error: 'Company not found' });
  try {
    res.json({ company: await one('UPDATE companies SET name = $1 WHERE id = $2 RETURNING *', [name, c.id]) });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'This name already exists' });
    throw e;
  }
});

const setCompanyActive = (active) => async (req, res) => {
  const c = await one('SELECT * FROM companies WHERE id = $1', [toId(req.params.id)]);
  if (!c) return res.status(404).json({ error: 'Company not found' });
  res.json({ company: await one('UPDATE companies SET is_active = $1 WHERE id = $2 RETURNING *', [active, c.id]) });
};
app.post('/api/companies/:id/deactivate', requireRole('admin'), setCompanyActive(false));
app.post('/api/companies/:id/restore', requireRole('admin'), setCompanyActive(true));

app.delete('/api/companies/:id', requireSuper, async (req, res) => {
  const c = await one('SELECT * FROM companies WHERE id = $1', [toId(req.params.id)]);
  if (!c) return res.status(404).json({ error: 'Company not found' });
  if (await one('SELECT 1 FROM sites WHERE company_id = $1 LIMIT 1', [c.id])) {
    return res.status(400).json({ error: 'This company has divisions — remove or reassign them first' });
  }
  await query('DELETE FROM companies WHERE id = $1', [c.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Divisions (stored in the `sites` table) — belong to a company; never deleted
// ---------------------------------------------------------------------------

const DIVISION_SELECT = `
  SELECT s.*, c.name AS company_name
  FROM sites s LEFT JOIN companies c ON c.id = s.company_id
`;

app.get('/api/sites', requireRole(), async (req, res) => {
  res.json({ sites: await all(`${DIVISION_SELECT} ORDER BY s.is_active DESC, c.name, s.name`) });
});

async function validateDivision(body) {
  const name = String((body || {}).name || '').trim();
  const company_id = toId((body || {}).company_id);
  if (!name) return { error: 'Enter a division name' };
  if (!company_id || !(await one('SELECT id FROM companies WHERE id = $1', [company_id]))) {
    return { error: 'Select a company' };
  }
  return { value: { name, company_id } };
}

app.post('/api/sites', requireRole('admin'), async (req, res) => {
  const check = await validateDivision(req.body);
  if (check.error) return res.status(400).json({ error: check.error });
  try {
    const row = await one('INSERT INTO sites (name, company_id) VALUES ($1, $2) RETURNING *', [
      check.value.name,
      check.value.company_id,
    ]);
    res.json({ site: row });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'This name already exists' });
    throw e;
  }
});

app.put('/api/sites/:id', requireRole('admin'), async (req, res) => {
  const s = await one('SELECT * FROM sites WHERE id = $1', [toId(req.params.id)]);
  if (!s) return res.status(404).json({ error: 'Division not found' });
  const check = await validateDivision(req.body);
  if (check.error) return res.status(400).json({ error: check.error });
  try {
    const row = await one('UPDATE sites SET name = $1, company_id = $2 WHERE id = $3 RETURNING *', [
      check.value.name,
      check.value.company_id,
      s.id,
    ]);
    res.json({ site: row });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'This name already exists' });
    throw e;
  }
});

const setDivisionActive = (active) => async (req, res) => {
  const s = await one('SELECT * FROM sites WHERE id = $1', [toId(req.params.id)]);
  if (!s) return res.status(404).json({ error: 'Division not found' });
  res.json({ site: await one('UPDATE sites SET is_active = $1 WHERE id = $2 RETURNING *', [active, s.id]) });
};
app.post('/api/sites/:id/deactivate', requireRole('admin'), setDivisionActive(false));
app.post('/api/sites/:id/restore', requireRole('admin'), setDivisionActive(true));

// Only the super administrator may permanently delete a division, and only when
// nothing references it (positions, employees or requests) so history is safe.
app.delete('/api/sites/:id', requireSuper, async (req, res) => {
  const s = await one('SELECT * FROM sites WHERE id = $1', [toId(req.params.id)]);
  if (!s) return res.status(404).json({ error: 'Division not found' });
  const used =
    (await one('SELECT 1 FROM positions WHERE site_id = $1 LIMIT 1', [s.id])) ||
    (await one('SELECT 1 FROM users WHERE site_id = $1 LIMIT 1', [s.id])) ||
    (await one('SELECT 1 FROM requests WHERE site_id = $1 OR target_site_id = $1 LIMIT 1', [s.id]));
  if (used) {
    return res.status(400).json({ error: 'This division is in use and cannot be deleted — deactivate it instead' });
  }
  await query('DELETE FROM sites WHERE id = $1', [s.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Positions (belong to a division, carry permissions; never deleted)
// ---------------------------------------------------------------------------

const POSITION_SELECT = `
  SELECT p.*, s.name AS site_name, c.name AS company_name
  FROM positions p
  JOIN sites s ON s.id = p.site_id
  LEFT JOIN companies c ON c.id = s.company_id
`;

function positionPerms(body) {
  const perms = {};
  for (const key of POSITION_PERMS) perms[key] = !!(body && body[key]);
  return perms;
}

app.get('/api/positions', requireRole(), async (req, res) => {
  const siteId = toId(req.query.site_id);
  const rows = siteId
    ? await all(`${POSITION_SELECT} WHERE p.site_id = $1 ORDER BY p.is_active DESC, s.name, p.title`, [siteId])
    : await all(`${POSITION_SELECT} ORDER BY p.is_active DESC, c.name, s.name, p.title`);
  res.json({ positions: rows });
});

app.post('/api/positions', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const site_id = toId(b.site_id);
  if (!title) return res.status(400).json({ error: 'Enter a position title' });
  if (!site_id || !(await one('SELECT id FROM sites WHERE id = $1', [site_id]))) {
    return res.status(400).json({ error: 'Select a division' });
  }
  const p = positionPerms(b);
  const row = await one(
    `INSERT INTO positions (site_id, title, perm_create, perm_view_site, perm_cancel, perm_reports, perm_accept, perm_execute)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [site_id, title, p.perm_create, p.perm_view_site, p.perm_cancel, p.perm_reports, p.perm_accept, p.perm_execute]
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
       perm_reports = $5, perm_accept = $6, perm_execute = $7 WHERE id = $8 RETURNING *`,
    [title, p.perm_create, p.perm_view_site, p.perm_cancel, p.perm_reports, p.perm_accept, p.perm_execute, pos.id]
  );
  res.json({ position: row });
});

const setPositionActive = (active) => async (req, res) => {
  const pos = await one('SELECT * FROM positions WHERE id = $1', [toId(req.params.id)]);
  if (!pos) return res.status(404).json({ error: 'Position not found' });
  res.json({ position: await one('UPDATE positions SET is_active = $1 WHERE id = $2 RETURNING *', [active, pos.id]) });
};
app.post('/api/positions/:id/deactivate', requireRole('admin'), setPositionActive(false));
app.post('/api/positions/:id/restore', requireRole('admin'), setPositionActive(true));

// ---------------------------------------------------------------------------
// Employees (users) — system administrator
// ---------------------------------------------------------------------------

async function validateUserPayload(body, selfId) {
  const login = String(body.login || '').trim();
  let first_name = String(body.first_name || '').trim();
  let last_name = String(body.last_name || '').trim();
  // Fall back to splitting a supplied full_name when first/last aren't given.
  if (!first_name && !last_name && body.full_name) {
    const parts = String(body.full_name).trim().split(/\s+/);
    first_name = parts.shift() || '';
    last_name = parts.join(' ');
  }
  const full_name = [first_name, last_name].filter(Boolean).join(' ');
  const role = String(body.role || '');
  const password = body.password == null ? '' : String(body.password);
  const phone = String(body.phone || '').trim() || null;
  const address = String(body.address || '').trim() || null;
  const position_id = body.position_id ? toId(body.position_id) : null;
  const position2_id = body.position2_id ? toId(body.position2_id) : null;
  const supervisor_id = body.supervisor_id ? toId(body.supervisor_id) : null;

  if (!login) return { error: 'Enter a username' };
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(login)) {
    return { error: 'Username: 3–32 characters, letters, digits, dot, hyphen, underscore' };
  }
  if (!full_name) return { error: 'Enter a first and last name' };
  if (!ROLES.includes(role)) return { error: 'Invalid role' };
  if (password && password.length < 6) {
    return { error: 'Password must be at least 6 characters' };
  }

  if (supervisor_id) {
    if (supervisor_id === selfId) return { error: 'A person cannot be their own supervisor' };
    if (!(await one('SELECT id FROM users WHERE id = $1', [supervisor_id]))) {
      return { error: 'Supervisor not found' };
    }
  }

  // Employees are attached to a position; the division is derived from it. An
  // optional second position must be in the same division.
  let site = null;
  let position = null;
  let position2 = null;
  if (role === 'employee') {
    if (!position_id) return { error: 'This role requires a position' };
    const pos = await one('SELECT * FROM positions WHERE id = $1', [position_id]);
    if (!pos) return { error: 'Position not found' };
    position = pos.id;
    site = pos.site_id;
    if (position2_id) {
      if (position2_id === position_id) return { error: 'The two positions must be different' };
      const pos2 = await one('SELECT * FROM positions WHERE id = $1', [position2_id]);
      if (!pos2) return { error: 'Second position not found' };
      if (pos2.site_id !== pos.site_id) {
        return { error: 'The second position must be in the same division' };
      }
      position2 = pos2.id;
    }
  }
  return {
    value: {
      login, full_name, first_name, last_name, phone, address, role, password,
      site_id: site, position_id: position, position2_id: position2, supervisor_id,
    },
  };
}

app.get('/api/users', requireRole('admin'), async (req, res) => {
  const users = (
    await all(
      `SELECT u.*, p.title AS position_title, p2.title AS position2_title,
              s.name AS site_name, c.name AS company_name, sup.full_name AS supervisor_name
       FROM users u
       LEFT JOIN positions p ON p.id = u.position_id
       LEFT JOIN positions p2 ON p2.id = u.position2_id
       LEFT JOIN sites s ON s.id = u.site_id
       LEFT JOIN companies c ON c.id = s.company_id
       LEFT JOIN users sup ON sup.id = u.supervisor_id
       ORDER BY u.is_active DESC, u.full_name`
    )
  ).map((u) => ({
    ...publicUser(u),
    position_title: u.position_title || null,
    position2_title: u.position2_title || null,
    site_name: u.site_name || null,
    company_name: u.company_name || null,
    supervisor_name: u.supervisor_name || null,
  }));
  res.json({ users });
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const check = await validateUserPayload(req.body || {});
  if (check.error) return res.status(400).json({ error: check.error });
  const v = check.value;
  if (await one('SELECT id FROM users WHERE LOWER(login) = LOWER($1)', [v.login])) {
    return res.status(400).json({ error: 'A user with this username already exists' });
  }
  const hasPassword = v.password.length >= 6;
  const user = await one(
    `INSERT INTO users (login, password_hash, full_name, first_name, last_name, phone, address,
       role, site_id, position_id, position2_id, supervisor_id, must_set_password)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [v.login, hasPassword ? hashPassword(v.password) : '', v.full_name, v.first_name, v.last_name,
      v.phone, v.address, v.role, v.site_id, v.position_id, v.position2_id, v.supervisor_id, !hasPassword]
  );
  res.json({ user: publicUser(user) });
});

app.put('/api/users/:id', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const check = await validateUserPayload(req.body || {}, user.id);
  if (check.error) return res.status(400).json({ error: check.error });
  const v = check.value;
  if (await one('SELECT id FROM users WHERE LOWER(login) = LOWER($1) AND id != $2', [v.login, user.id])) {
    return res.status(400).json({ error: 'A user with this username already exists' });
  }
  const updated = await one(
    `UPDATE users SET login = $1, full_name = $2, first_name = $3, last_name = $4, phone = $5,
       address = $6, role = $7, site_id = $8, position_id = $9, position2_id = $10,
       supervisor_id = $11, updated_at = now() WHERE id = $12 RETURNING *`,
    [v.login, v.full_name, v.first_name, v.last_name, v.phone, v.address, v.role, v.site_id,
      v.position_id, v.position2_id, v.supervisor_id, user.id]
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
  if (password) {
    await query('UPDATE users SET password_hash = $1, must_set_password = FALSE, updated_at = now() WHERE id = $2',
      [hashPassword(password), user.id]);
  } else {
    await query("UPDATE users SET password_hash = '', must_set_password = TRUE, updated_at = now() WHERE id = $1",
      [user.id]);
  }
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  res.json({ ok: true });
});

app.post('/api/users/:id/deactivate', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.is_super) return res.status(400).json({ error: 'The main administrator cannot be disabled' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account' });
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

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [toId(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.is_super) return res.status(400).json({ error: 'The main administrator cannot be deleted' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  await query('DELETE FROM users WHERE id = $1', [user.id]);
  res.json({ ok: true });
});

// Active divisions in the current employee's company — targets for a new request.
app.get('/api/target-divisions', requirePerm('perm_create'), async (req, res) => {
  const rows = await all(
    `SELECT s.* FROM sites s
     WHERE s.is_active
       AND s.company_id IS NOT DISTINCT FROM (SELECT company_id FROM sites WHERE id = $1)
     ORDER BY s.name`,
    [req.user.site_id]
  );
  res.json({ divisions: rows });
});

// Employees in the current division who can perform work (for the accepter).
app.get('/api/users/executors', requirePerm('perm_accept'), async (req, res) => {
  const executors = await all(
    `SELECT u.id, u.full_name FROM users u
     WHERE u.role = 'employee' AND u.is_active AND EXISTS (
       SELECT 1 FROM positions p
       WHERE p.id IN (u.position_id, u.position2_id)
         AND p.perm_execute AND p.site_id = $1
     )
     ORDER BY u.full_name`,
    [req.user.site_id]
  );
  res.json({ executors });
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

app.get('/api/requests', requireRole('owner', 'employee'), async (req, res) => {
  const where = [];
  const params = [];
  const add = (val) => { params.push(val); return `$${params.length}`; };

  if (req.user.role === 'owner') {
    if (toId(req.query.target_site_id)) where.push(`r.target_site_id = ${add(toId(req.query.target_site_id))}`);
    if (toId(req.query.site_id)) where.push(`r.site_id = ${add(toId(req.query.site_id))}`);
  } else {
    const or = [`r.created_by = ${add(req.user.id)}`];
    if (req.user.perm_view_site) or.push(`r.site_id = ${add(req.user.site_id)}`);
    if (req.user.perm_accept) or.push(`r.target_site_id = ${add(req.user.site_id)}`);
    if (req.user.perm_execute) or.push(`r.executor_id = ${add(req.user.id)}`);
    where.push('(' + or.join(' OR ') + ')');
  }
  if (req.query.status) where.push(`r.status = ${add(String(req.query.status))}`);

  const sql = `${REQUEST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY r.created_at DESC, r.id DESC`;
  res.json({ requests: await all(sql, params) });
});

app.get('/api/requests/:id', requireRole('owner', 'employee'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || !canSeeRequest(req.user, r)) return res.status(404).json({ error: 'Request not found' });
  const events = await all(
    `SELECT * FROM request_events WHERE request_id = $1 ORDER BY created_at, id`,
    [r.id]
  );
  res.json({ request: r, events });
});

// Create a request — an employee whose position may create requests; addressed
// to a target division within the same company.
app.post('/api/requests', requirePerm('perm_create'), async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
  const target_site_id = toId(b.target_site_id);
  const due_date = b.due_date ? String(b.due_date) : null;

  if (!title) return res.status(400).json({ error: 'Enter a request subject' });
  if (!target_site_id) return res.status(400).json({ error: 'Select a division to send it to' });
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return res.status(400).json({ error: 'Invalid due date' });
  }
  const target = await one(
    `SELECT id FROM sites WHERE id = $1 AND is_active
       AND company_id IS NOT DISTINCT FROM (SELECT company_id FROM sites WHERE id = $2)`,
    [target_site_id, req.user.site_id]
  );
  if (!target) return res.status(400).json({ error: 'Select an active division in your company' });

  const row = await one(
    `INSERT INTO requests (title, description, priority, site_id, position_id, target_site_id,
       created_by, created_by_name, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [title, description, priority, req.user.site_id, req.user.position_id, target_site_id,
      req.user.id, req.user.full_name, due_date]
  );
  await addEvent(row.id, req.user, 'created', null);
  res.json({ request: await getRequest(row.id) });
});

// An accepter may act on a request only if it is addressed to their division.
async function targetRequest(req, res) {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.target_site_id !== req.user.site_id) {
    res.status(404).json({ error: 'Request not found' });
    return null;
  }
  return r;
}

app.post('/api/requests/:id/accept', requirePerm('perm_accept'), async (req, res) => {
  const r = await targetRequest(req, res);
  if (!r) return;
  if (r.status !== 'new') return res.status(400).json({ error: 'Request has already been processed' });
  const executor_id = toId((req.body || {}).executor_id);
  if (!executor_id) return res.status(400).json({ error: 'Select someone to perform the work' });
  const executor = await one(
    `SELECT u.* FROM users u
     WHERE u.id = $1 AND u.is_active AND EXISTS (
       SELECT 1 FROM positions p
       WHERE p.id IN (u.position_id, u.position2_id)
         AND p.perm_execute AND p.site_id = $2
     )`,
    [executor_id, req.user.site_id]
  );
  if (!executor) return res.status(400).json({ error: 'That person cannot perform work in this division' });
  await query(
    `UPDATE requests SET status = 'in_progress', manager_id = $1, executor_id = $2,
       accepted_at = now(), updated_at = now() WHERE id = $3`,
    [req.user.id, executor_id, r.id]
  );
  await addEvent(r.id, req.user, 'accepted', `Assigned to: ${executor.full_name}`);
  res.json({ request: await getRequest(r.id) });
});

app.post('/api/requests/:id/reject', requirePerm('perm_accept'), async (req, res) => {
  const r = await targetRequest(req, res);
  if (!r) return;
  if (r.status !== 'new') return res.status(400).json({ error: 'Only a new request can be rejected' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Enter a rejection reason' });
  await query(
    `UPDATE requests SET status = 'rejected', manager_id = $1, reject_reason = $2, updated_at = now() WHERE id = $3`,
    [req.user.id, reason, r.id]
  );
  await addEvent(r.id, req.user, 'rejected', reason);
  res.json({ request: await getRequest(r.id) });
});

// The accepter who took the request owns its later transitions.
async function acceptedByMe(req, res) {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.manager_id !== req.user.id) {
    res.status(404).json({ error: 'Request not found' });
    return null;
  }
  return r;
}

app.post('/api/requests/:id/assign', requirePerm('perm_accept'), async (req, res) => {
  const r = await acceptedByMe(req, res);
  if (!r) return;
  if (r.status !== 'in_progress') {
    return res.status(400).json({ error: 'You can reassign only a request that is in progress' });
  }
  const executor_id = toId((req.body || {}).executor_id);
  if (!executor_id) return res.status(400).json({ error: 'Select someone to perform the work' });
  const executor = await one(
    `SELECT u.* FROM users u
     WHERE u.id = $1 AND u.is_active AND EXISTS (
       SELECT 1 FROM positions p
       WHERE p.id IN (u.position_id, u.position2_id)
         AND p.perm_execute AND p.site_id = $2
     )`,
    [executor_id, req.user.site_id]
  );
  if (!executor) return res.status(400).json({ error: 'That person cannot perform work in this division' });
  await query('UPDATE requests SET executor_id = $1, updated_at = now() WHERE id = $2', [executor_id, r.id]);
  await addEvent(r.id, req.user, 'reassigned', `Reassigned to: ${executor.full_name}`);
  res.json({ request: await getRequest(r.id) });
});

app.post('/api/requests/:id/done', requirePerm('perm_execute'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.executor_id !== req.user.id) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'in_progress') return res.status(400).json({ error: 'Request is not in progress' });
  const comment = String((req.body || {}).comment || '').trim();
  await query(`UPDATE requests SET status = 'done', done_at = now(), updated_at = now() WHERE id = $1`, [r.id]);
  await addEvent(r.id, req.user, 'done', comment || null);
  res.json({ request: await getRequest(r.id) });
});

app.post('/api/requests/:id/close', requirePerm('perm_accept'), async (req, res) => {
  const r = await acceptedByMe(req, res);
  if (!r) return;
  if (r.status !== 'done') return res.status(400).json({ error: 'Only a completed request can be closed' });
  await query(`UPDATE requests SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1`, [r.id]);
  await addEvent(r.id, req.user, 'closed', null);
  res.json({ request: await getRequest(r.id) });
});

app.post('/api/requests/:id/reopen', requirePerm('perm_accept'), async (req, res) => {
  const r = await acceptedByMe(req, res);
  if (!r) return;
  if (r.status !== 'done') return res.status(400).json({ error: 'Only a completed request can be returned for rework' });
  const comment = String((req.body || {}).comment || '').trim();
  if (!comment) return res.status(400).json({ error: 'Describe what needs to be reworked' });
  await query(`UPDATE requests SET status = 'in_progress', done_at = NULL, updated_at = now() WHERE id = $1`, [r.id]);
  await addEvent(r.id, req.user, 'reopened', comment);
  res.json({ request: await getRequest(r.id) });
});

// Cancel a new request — an employee with the cancel permission, in the
// division the request came from.
app.post('/api/requests/:id/cancel', requirePerm('perm_cancel'), async (req, res) => {
  const r = await getRequest(toId(req.params.id));
  if (!r || r.site_id !== req.user.site_id) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'new') return res.status(400).json({ error: 'Only a new request can be cancelled' });
  await query(`UPDATE requests SET status = 'cancelled', updated_at = now() WHERE id = $1`, [r.id]);
  await addEvent(r.id, req.user, 'cancelled', null);
  res.json({ request: await getRequest(r.id) });
});

// ---------------------------------------------------------------------------
// Reports — owner (whole organization) or an employee whose position may view
// its division's reports (scoped to that division, incoming and outgoing).
// ---------------------------------------------------------------------------

function requireReports(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const ok = req.user.role === 'owner' || (req.user.role === 'employee' && req.user.perm_reports);
  if (!ok) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
}

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
  if (req.user.role === 'employee') {
    params.push(req.user.site_id);
    where.push(`(r.site_id = $${params.length} OR r.target_site_id = $${params.length})`);
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

  const byOrigin = await all(
    `SELECT s.id AS site_id, s.name AS site_name, COUNT(*)::int AS total, ${STATUS_COUNTS}
     FROM requests r LEFT JOIN sites s ON s.id = r.site_id
     ${cond} GROUP BY s.id, s.name ORDER BY s.name NULLS LAST`,
    params
  );
  const byTarget = await all(
    `SELECT s.id AS site_id, s.name AS site_name, COUNT(*)::int AS total, ${STATUS_COUNTS}
     FROM requests r LEFT JOIN sites s ON s.id = r.target_site_id
     ${cond} GROUP BY s.id, s.name ORDER BY s.name NULLS LAST`,
    params
  );
  const totals = await one(
    `SELECT COUNT(*)::int AS total, ${STATUS_COUNTS},
            ROUND((AVG(EXTRACT(EPOCH FROM (r.done_at - r.created_at)) / 3600.0)
                   FILTER (WHERE r.done_at IS NOT NULL))::numeric, 1)::float8 AS avg_completion_hours
     FROM requests r ${cond}`,
    params
  );
  res.json({ by_origin: byOrigin, by_target: byTarget, totals });
});

const STATUS_LABEL = {
  new: 'New', in_progress: 'In progress', done: 'Completed',
  closed: 'Closed', rejected: 'Rejected', cancelled: 'Cancelled',
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
    '#', 'Subject', 'From division', 'To division', 'Status', 'Priority', 'Created by',
    'Accepter', 'Performer', 'Created (UTC)', 'Accepted (UTC)', 'Completed (UTC)', 'Closed (UTC)', 'Due',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.title, r.site_name, r.target_site_name, STATUS_LABEL[r.status] || r.status,
      PRIORITY_LABEL[r.priority] || r.priority, r.created_by_name, r.manager_name, r.executor_name,
      fmtTs(r.created_at), fmtTs(r.accepted_at), fmtTs(r.done_at), fmtTs(r.closed_at), r.due_date,
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
  res.send('\uFEFF' + lines.join('\r\n'));
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
