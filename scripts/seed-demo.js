'use strict';

// Populate the database with demo data: sites (addresses), service departments,
// users of every role and a few requests in different statuses.
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

  const addSite = async (name) =>
    (await query('INSERT INTO sites (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  const addDept = async (name) =>
    (await query('INSERT INTO departments (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  const addUser = async (login, password, fullName, role, deptId, siteId) =>
    (
      await query(
        `INSERT INTO users (login, password_hash, full_name, role, department_id, site_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [login, hashPassword(password), fullName, role, deptId || null, siteId || null]
      )
    ).rows[0].id;

  // Sites (addresses where site administrators work).
  const mainCampus = await addSite('Main Campus — 100 Center St');
  const northHouse = await addSite('North House — 240 Oak Ave');
  const westClinic = await addSite('West Clinic — 55 Palm Blvd');

  // Service departments that fulfill requests.
  const supply = await addDept('Supply');
  const repair = await addDept('Repair');
  const meds = await addDept('Medication Supply');

  await addUser('owner', 'owner123', 'Robert Owens', 'owner', null, null);

  // Site administrators (one per address) — they create requests.
  const admMain = await addUser('main.admin', 'demo123', 'Anna Kim', 'site_admin', null, mainCampus);
  const admNorth = await addUser('north.admin', 'demo123', 'Olivia Nelson', 'site_admin', null, northHouse);
  await addUser('west.admin', 'demo123', 'Daniel Brooks', 'site_admin', null, westClinic);

  // Supervisors (one per department).
  const supSupply = await addUser('supply.sup', 'demo123', 'David Miller', 'manager', supply, null);
  const supRepair = await addUser('repair.sup', 'demo123', 'Michael Turner', 'manager', repair, null);
  const supMeds = await addUser('meds.sup', 'demo123', 'Sofia Reyes', 'manager', meds, null);

  // Executors.
  const exSupply = await addUser('supply.ex1', 'demo123', 'James Carter', 'executor', supply, null);
  await addUser('supply.ex2', 'demo123', 'Emily Parker', 'executor', supply, null);
  const exRepair = await addUser('repair.ex1', 'demo123', 'Alex Grant', 'executor', repair, null);
  const exMeds = await addUser('meds.ex1', 'demo123', 'Grace Lee', 'executor', meds, null);

  const addRequest = async (fields) =>
    (
      await query(
        `INSERT INTO requests (title, description, priority, status, site_id, department_id,
           created_by, manager_id, executor_id, due_date, reject_reason,
           created_at, accepted_at, done_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
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

  // New request from Main Campus to Supply.
  let id = await addRequest([
    'Order office supplies for the front desk', 'Paper, pens, folders for the new intake desk.',
    'normal', 'new', mainCampus, supply, admMain, null, null, inDays(4), null,
    daysAgo(1), null, null, null,
  ]);
  await addEvent(id, admMain, 'created', null, daysAgo(1));

  // In-progress request from North House to Repair.
  id = await addRequest([
    'Fix the leaking sink in room 3', 'Water pooling under the sink, needs a plumber.',
    'high', 'in_progress', northHouse, repair, admNorth, supRepair, exRepair, inDays(1), null,
    daysAgo(2), daysAgo(1), null, null,
  ]);
  await addEvent(id, admNorth, 'created', null, daysAgo(2));
  await addEvent(id, supRepair, 'accepted', 'Executor: Alex Grant', daysAgo(1));

  // Closed request from Main Campus to Medication Supply.
  id = await addRequest([
    'Restock first-aid medications', 'Bandages and antiseptics are running low.',
    'high', 'closed', mainCampus, meds, admMain, supMeds, exMeds, null, null,
    daysAgo(6), daysAgo(5), daysAgo(4), daysAgo(4),
  ]);
  await addEvent(id, admMain, 'created', null, daysAgo(6));
  await addEvent(id, supMeds, 'accepted', 'Executor: Grace Lee', daysAgo(5));
  await addEvent(id, exMeds, 'done', 'Medications restocked.', daysAgo(4));
  await addEvent(id, supMeds, 'closed', null, daysAgo(4));

  // Completed but not yet closed request from North House to Supply.
  id = await addRequest([
    'Deliver cleaning supplies', 'Need mops, detergent and gloves for the week.',
    'normal', 'done', northHouse, supply, admNorth, supSupply, exSupply, inDays(0), null,
    daysAgo(3), daysAgo(2), daysAgo(1), null,
  ]);
  await addEvent(id, admNorth, 'created', null, daysAgo(3));
  await addEvent(id, supSupply, 'accepted', 'Executor: James Carter', daysAgo(2));
  await addEvent(id, exSupply, 'done', 'Supplies delivered.', daysAgo(1));

  // Rejected request from Main Campus to Repair.
  id = await addRequest([
    'Repaint the lobby', 'The paint looks worn.',
    'low', 'rejected', mainCampus, repair, admMain, supRepair, null, null,
    "Not in this quarter's budget.",
    daysAgo(5), null, null, null,
  ]);
  await addEvent(id, admMain, 'created', null, daysAgo(5));
  await addEvent(id, supRepair, 'rejected', "Not in this quarter's budget.", daysAgo(4));

  console.log('Demo data loaded.');
  console.log('Accounts (username / password):');
  console.log('  admin        / admin123  — system administrator');
  console.log('  owner        / owner123  — owner');
  console.log('  main.admin   / demo123   — site administrator, Main Campus');
  console.log('  north.admin  / demo123   — site administrator, North House');
  console.log('  west.admin   / demo123   — site administrator, West Clinic');
  console.log('  supply.sup   / demo123   — supervisor, Supply');
  console.log('  repair.sup   / demo123   — supervisor, Repair');
  console.log('  meds.sup     / demo123   — supervisor, Medication Supply');
  console.log('  supply.ex1   / demo123   — executor, Supply');
  console.log('  repair.ex1   / demo123   — executor, Repair');
  console.log('  meds.ex1     / demo123   — executor, Medication Supply');
}

main()
  .then(() => pool && pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
