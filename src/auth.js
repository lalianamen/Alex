'use strict';

const crypto = require('crypto');
const { query, one } = require('./db');

const COOKIE_NAME = 'sid';

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '12 hours')`,
    [token, userId]
  );
  return token;
}

async function destroySession(token) {
  await query('DELETE FROM sessions WHERE token = $1', [token]);
}

async function getSessionUser(token) {
  if (!token) return null;
  const user = await one(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now() AND u.is_active`,
    [token]
  );
  return user || null;
}

// Middleware: подставляет req.user по cookie-сессии.
async function sessionMiddleware(req, res, next) {
  req.user = await getSessionUser(req.cookies[COOKIE_NAME]);
  next();
}

// Middleware-фабрика: требует авторизацию и (опционально) одну из ролей.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Требуется вход в систему' });
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}

module.exports = { COOKIE_NAME, createSession, destroySession, sessionMiddleware, requireRole };
