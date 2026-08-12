'use strict';

// Demo data for the Address -> Position -> Employee model.
// Run: DATABASE_URL=postgres://... npm run seed:demo

const { pool, query, one, ready } = require('../src/db');
const { hashPassword } = require('../src/passwords');

async function main() {
  if (!pool) {
    console.error('Set the DATABASE_URL environment variable.');
    process.exit(1);
  }
  await ready();

  if (await one(`SELECT id FROM users WHERE LOWER(login) = 'owner'`)) {
    console.log('Demo data already loaded — skipping.');
    return;
  }

  const addSite = async (name) =>
    (await query('INSERT INTO sites (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  const addDept = async (name) =>
    (await query('INSERT INTO departments (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  const addPosition = async (siteId, title, perms) =>
    (
      await query(
        `INSERT INTO positions (site_id, title, perm_create, perm_view_site, perm_cancel, perm_reports)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [siteId, title, !!perms.create, !!perms.view, !!perms.cancel, !!perms.reports]
      )
    ).rows[0].id;
  const addUser = async (login, password, fullName, role, { deptId, positionId, siteId } = {}) =>
    (
      await query(
        `INSERT INTO users (login, password_hash, full_name, role, department_id, position_id, site_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [login, hashPassword(password), fullName, role, deptId || null, positionId || null, siteId || null]
      )
    ).rows[0].id;

  const mainCampus = await addSite('Main Campus — 100 Center St');
  const northHouse = await addSite('North House — 240 Oak Ave');

  const supply = await addDept('Supply');
  const repair = await addDept('Repair');
  const meds = await addDept('Medication Supply');

  // Positions (permanent seats at each address).
  const mainMgr = await addPosition(mainCampus, 'Site Manager', { create: true, view: true, cancel: true, reports: true });
  const mainClerk = await addPosition(mainCampus, 'Intake Clerk', { create: true });
  const northMgr = await addPosition(northHouse, 'Site Manager', { create: true, view: true, cancel: true, reports: true });

  await addUser('owner', 'owner123', 'Robert Owens', 'owner');

  // Employees filling positions.
  const annaId = await addUser('main.mgr', 'demo123', 'Anna Kim', 'site_admin', { positionId: mainMgr, siteId: mainCampus });
  const carlId = await addUser('main.clerk', 'demo123', 'Carl Reyes', 'site_admin', { positionId: mainClerk, siteId: mainCampus });
  const oliviaId = await addUser('north.mgr', 'demo123', 'Olivia Nelson', 'site_admin', { positionId: northMgr, siteId: northHouse });

  // Department staff.
  const supSupply = await addUser('supply.sup', 'demo123', 'David Miller', 'manager', { deptId: supply });
  const supRepair = await addUser('repair.sup', 'demo123', 'Michael Turner', 'manager', { deptId: repair });
  const supMeds = await addUser('meds.sup', 'demo123', 'Sofia Reyes', 'manager', { deptId: meds });
  const exSupply = await addUser('supply.ex1', 'demo123', 'James Carter', 'executor', { deptId: supply });
  await addUser('supply.ex2', 'demo123', 'Emily Parker', 'executor', { deptId: supply });
  const exRepair = await addUser('repair.ex1', 'demo123', 'Alex Grant', 'executor', { deptId: repair });
  const exMeds = await addUser('meds.ex1', 'demo123', 'Grace Lee', 'executor', { deptId: meds });

  const addRequest = async (f) =>
    (
      await query(
        `INSERT INTO requests (title, description, priority, status, site_id, position_id, department_id,
           created_by, created_by_name, manager_id, executor_id, due_date, reject_reason,
           created_at, accepted_at, done_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        f
      )
    ).rows[0].id;
  const addEvent = (rid, uid, uname, action, comment, at) =>
    query(
      `INSERT INTO request_events (request_id, user_id, user_name, action, comment, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [rid, uid, uname, action, comment, at]
    );

  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000);
  const inDays = (n) => new Date(now + n * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // New request from Main Campus (Intake Clerk) to Supply.
  let id = await addRequest([
    'Order office supplies for the front desk', 'Paper, pens, folders for the intake desk.',
    'normal', 'new', mainCampus, mainClerk, supply, carlId, 'Carl Reyes', null, null, inDays(4), null,
    daysAgo(1), null, null, null,
  ]);
  await addEvent(id, carlId, 'Carl Reyes', 'created', null, daysAgo(1));

  // In-progress from North House (Site Manager) to Repair.
  id = await addRequest([
    'Fix the leaking sink in room 3', 'Water pooling under the sink, needs a plumber.',
    'high', 'in_progress', northHouse, northMgr, repair, oliviaId, 'Olivia Nelson', supRepair, exRepair, inDays(1), null,
    daysAgo(2), daysAgo(1), null, null,
  ]);
  await addEvent(id, oliviaId, 'Olivia Nelson', 'created', null, daysAgo(2));
  await addEvent(id, supRepair, 'Michael Turner', 'accepted', 'Executor: Alex Grant', daysAgo(1));

  // Closed from Main Campus (Site Manager) to Medication Supply.
  id = await addRequest([
    'Restock first-aid medications', 'Bandages and antiseptics are running low.',
    'high', 'closed', mainCampus, mainMgr, meds, annaId, 'Anna Kim', supMeds, exMeds, null, null,
    daysAgo(6), daysAgo(5), daysAgo(4), daysAgo(4),
  ]);
  await addEvent(id, annaId, 'Anna Kim', 'created', null, daysAgo(6));
  await addEvent(id, supMeds, 'Sofia Reyes', 'accepted', 'Executor: Grace Lee', daysAgo(5));
  await addEvent(id, exMeds, 'Grace Lee', 'done', 'Medications restocked.', daysAgo(4));
  await addEvent(id, supMeds, 'Sofia Reyes', 'closed', null, daysAgo(4));

  // Completed (awaiting close) from North House to Supply.
  id = await addRequest([
    'Deliver cleaning supplies', 'Mops, detergent and gloves for the week.',
    'normal', 'done', northHouse, northMgr, supply, oliviaId, 'Olivia Nelson', supSupply, exSupply, inDays(0), null,
    daysAgo(3), daysAgo(2), daysAgo(1), null,
  ]);
  await addEvent(id, oliviaId, 'Olivia Nelson', 'created', null, daysAgo(3));
  await addEvent(id, supSupply, 'David Miller', 'accepted', 'Executor: James Carter', daysAgo(2));
  await addEvent(id, exSupply, 'James Carter', 'done', 'Supplies delivered.', daysAgo(1));

  // Rejected from Main Campus to Repair.
  id = await addRequest([
    'Repaint the lobby', 'The paint looks worn.',
    'low', 'rejected', mainCampus, mainMgr, repair, annaId, 'Anna Kim', supRepair, null, null,
    "Not in this quarter's budget.",
    daysAgo(5), null, null, null,
  ]);
  await addEvent(id, annaId, 'Anna Kim', 'created', null, daysAgo(5));
  await addEvent(id, supRepair, 'Michael Turner', 'rejected', "Not in this quarter's budget.", daysAgo(4));

  console.log('Demo data loaded.');
  console.log('Accounts (username / password):');
  console.log('  admin       / admin123  — system administrator');
  console.log('  owner       / owner123  — owner');
  console.log('  main.mgr    / demo123   — Site Manager @ Main Campus (all permissions)');
  console.log('  main.clerk  / demo123   — Intake Clerk @ Main Campus (create only)');
  console.log('  north.mgr   / demo123   — Site Manager @ North House (all permissions)');
  console.log('  supply.sup / repair.sup / meds.sup   / demo123 — department supervisors');
  console.log('  supply.ex1 / repair.ex1 / meds.ex1   / demo123 — department executors');
}

main()
  .then(() => pool && pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
