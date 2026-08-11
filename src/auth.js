'use strict';

const crypto = require('crypto');
const { db } = require('./db');

const SESSION_TTL_HOURS = 12;
const COOKIE_NAME = 'sid';

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_TTL_HOURS} hours'))`
  ).run(token, userId);
  return token;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function getSessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now') AND u.is_active = 1`
    )
    .get(token);
  return row || null;
}

// Middleware: подставляет req.user по cookie-сессии.
function sessionMiddleware(req, res, next) {
  req.user = getSessionUser(req.cookies[COOKIE_NAME]);
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
