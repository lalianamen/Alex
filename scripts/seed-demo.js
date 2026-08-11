'use strict';

// Populate the database with demo data: departments, users of every role and a
// few requests in different statuses.
// Run: DATABASE_URL=postgres://... npm run seed:demo

const { pool, query, one, ready } = require('../src/db');
const { hashPassword } = require('../src/passwords');

async function main() {
  if (!pool) {
    console.error('Set the DATABASE_URL environment variable.');
    process.exit(1);
  }
  await ready();

  const already = await one(`SELECT id FROM users WHERE LOWER(login) = 'owner'`);
  if (already) {
    console.log('Demo data already loaded — skipping.');
    return;
  }

  const addDept = async (name) =>
    (await query('INSERT INTO departments (name) VALUES ($1) RETURNING id', [name])).rows[0].id;

  const addUser = async (login, password, fullName, role, deptId) =>
    (
      await query(
        `INSERT INTO users (login, password_hash, full_name, role, department_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [login, hashPassword(password), fullName, role, deptId || null]
      )
    ).rows[0].id;

  const itDept = await addDept('IT Department');
  const facDept = await addDept('Facilities Department');

  await addUser('owner', 'owner123', 'Robert Owens', 'owner', null);

  const itAdmin = await addUser('it.admin', 'demo123', 'Anna Kim', 'dept_admin', itDept);
  const itManager = await addUser('it.manager', 'demo123', 'David Miller', 'manager', itDept);
  const itExec1 = await addUser('it.exec1', 'demo123', 'James Carter', 'executor', itDept);
  await addUser('it.exec2', 'demo123', 'Emily Parker', 'executor', itDept);

  const facAdmin = await addUser('fac.admin', 'demo123', 'Olivia Nelson', 'dept_admin', facDept);
  const facManager = await addUser('fac.manager', 'demo123', 'Michael Turner', 'manager', facDept);
  const facExec1 = await addUser('fac.exec1', 'demo123', 'Alex Grant', 'executor', facDept);

  const addRequest = async (fields) =>
    (
      await query(
        `INSERT INTO requests (title, description, priority, status, department_id, created_by,
           manager_id, executor_id, due_date, reject_reason, created_at, accepted_at, done_at, closed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        fields
      )
    ).rows[0].id;

  const addEvent = (requestId, userId, action, comment, createdAt) =>
    query(
      `INSERT INTO request_events (request_id, user_id, action, comment, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [requestId, userId, action, comment, createdAt]
    );

  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000);
  const inDays = (n) => new Date(now + n * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // New request in the IT department.
  let id = await addRequest([
    'Set up a workstation for a new employee',
    'Connect the computer, create accounts, grant access.',
    'high', 'new', itDept, itAdmin, itManager, null, inDays(3), null,
    daysAgo(1), null, null, null,
  ]);
  await addEvent(id, itAdmin, 'created', null, daysAgo(1));

  // Request in progress in the IT department.
  id = await addRequest([
    'Replace toner in the accounting printer',
    'HP LaserJet on the 2nd floor, the toner is empty.',
    'normal', 'in_progress', itDept, itAdmin, itManager, itExec1, inDays(1), null,
    daysAgo(2), daysAgo(1), null, null,
  ]);
  await addEvent(id, itAdmin, 'created', null, daysAgo(2));
  await addEvent(id, itManager, 'accepted', 'Executor: James Carter', daysAgo(1));

  // Closed request in the IT department.
  id = await addRequest([
    'Restore access to corporate email',
    'The employee locked their account after a password change.',
    'high', 'closed', itDept, itAdmin, itManager, itExec1, null, null,
    daysAgo(6), daysAgo(5), daysAgo(4), daysAgo(4),
  ]);
  await addEvent(id, itAdmin, 'created', null, daysAgo(6));
  await addEvent(id, itManager, 'accepted', 'Executor: James Carter', daysAgo(5));
  await addEvent(id, itExec1, 'done', 'Access restored, password reset.', daysAgo(4));
  await addEvent(id, itManager, 'closed', null, daysAgo(4));

  // Completed but not yet closed request in the Facilities department.
  id = await addRequest([
    'Replace lights in the meeting room',
    'Two fluorescent lights burned out.',
    'normal', 'done', facDept, facAdmin, facManager, facExec1, inDays(0), null,
    daysAgo(3), daysAgo(2), daysAgo(1), null,
  ]);
  await addEvent(id, facAdmin, 'created', null, daysAgo(3));
  await addEvent(id, facManager, 'accepted', 'Executor: Alex Grant', daysAgo(2));
  await addEvent(id, facExec1, 'done', 'Lights replaced.', daysAgo(1));

  // Rejected request in the Facilities department.
  id = await addRequest([
    'Buy a new coffee machine',
    'The old one breaks often.',
    'low', 'rejected', facDept, facAdmin, facManager, null, null,
    "Not in this quarter's budget.",
    daysAgo(5), null, null, null,
  ]);
  await addEvent(id, facAdmin, 'created', null, daysAgo(5));
  await addEvent(id, facManager, 'rejected', "Not in this quarter's budget.", daysAgo(4));

  console.log('Demo data loaded.');
  console.log('Accounts (username / password):');
  console.log('  admin        / admin123  — system administrator');
  console.log('  owner        / owner123  — owner');
  console.log('  it.admin     / demo123   — IT department administrator');
  console.log('  it.manager   / demo123   — work supervisor, IT department');
  console.log('  it.exec1     / demo123   — executor, IT department');
  console.log('  it.exec2     / demo123   — executor, IT department');
  console.log('  fac.admin    / demo123   — Facilities department administrator');
  console.log('  fac.manager  / demo123   — work supervisor, Facilities department');
  console.log('  fac.exec1    / demo123   — executor, Facilities department');
}

main()
  .then(() => pool && pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
