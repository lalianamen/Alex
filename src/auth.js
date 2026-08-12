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
  // Pull the position's permissions and title onto the user so route handlers
  // can check them directly. Non-position users get NULLs (treated as false).
  // A second position (same division) unions its permissions with the first.
  const user = await one(
    `SELECT u.*,
            p.title  AS position_title,
            p2.title AS position2_title,
            (COALESCE(p.perm_create, FALSE)    OR COALESCE(p2.perm_create, FALSE))    AS perm_create,
            (COALESCE(p.perm_view_site, FALSE) OR COALESCE(p2.perm_view_site, FALSE)) AS perm_view_site,
            (COALESCE(p.perm_cancel, FALSE)    OR COALESCE(p2.perm_cancel, FALSE))    AS perm_cancel,
            (COALESCE(p.perm_reports, FALSE)   OR COALESCE(p2.perm_reports, FALSE))   AS perm_reports,
            (COALESCE(p.perm_accept, FALSE)    OR COALESCE(p2.perm_accept, FALSE))    AS perm_accept,
            (COALESCE(p.perm_execute, FALSE)   OR COALESCE(p2.perm_execute, FALSE))   AS perm_execute
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN positions p ON p.id = u.position_id
     LEFT JOIN positions p2 ON p2.id = u.position2_id
     WHERE s.token = $1 AND s.expires_at > now() AND u.is_active`,
    [token]
  );
  return user || null;
}

// Middleware: sets req.user from the cookie session.
async function sessionMiddleware(req, res, next) {
  req.user = await getSessionUser(req.cookies[COOKIE_NAME]);
  next();
}

// Middleware factory: requires authentication and (optionally) one of the roles.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = {
  COOKIE_NAME, createSession, destroySession, getSessionUser, sessionMiddleware, requireRole,
};
