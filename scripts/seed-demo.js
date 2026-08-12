'use strict';

// Demo data for Company -> Division -> Position -> Employee.
// Run: DATABASE_URL=postgres://... npm run seed:demo

const { pool, query, one, ready } = require('../src/db');
const { hashPassword } = require('../src/passwords');

async function main() {
  if (!pool) { console.error('Set the DATABASE_URL environment variable.'); process.exit(1); }
  await ready();
  if (await one(`SELECT id FROM users WHERE LOWER(login) = 'owner'`)) {
    console.log('Demo data already loaded — skipping.');
    return;
  }

  const addCompany = async (name) =>
    (await query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  const addDivision = async (name, companyId) =>
    (await query('INSERT INTO sites (name, company_id) VALUES ($1, $2) RETURNING id', [name, companyId])).rows[0].id;
  const addPosition = async (siteId, title, perms) =>
    (
      await query(
        `INSERT INTO positions (site_id, title, perm_create, perm_view_site, perm_cancel, perm_reports, perm_accept, perm_execute)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [siteId, title, !!perms.create, !!perms.view, !!perms.cancel, !!perms.reports, !!perms.accept, !!perms.execute]
      )
    ).rows[0].id;
  const addUser = async (login, password, fullName, role, positionId, siteId) =>
    (
      await query(
        `INSERT INTO users (login, password_hash, full_name, role, position_id, site_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [login, hashPassword(password), fullName, role, positionId || null, siteId || null]
      )
    ).rows[0].id;

  const rehab = await addCompany('Rehab Inc');

  const mainCampus = await addDivision('Main Campus', rehab);
  const northHouse = await addDivision('North House', rehab);
  const supply = await addDivision('Supply', rehab);
  const repair = await addDivision('Repair', rehab);
  const meds = await addDivision('Medication', rehab);

  const posMainMgr = await addPosition(mainCampus, 'Site Manager', { create: true, view: true, cancel: true, reports: true });
  const posMainClerk = await addPosition(mainCampus, 'Intake Clerk', { create: true });
  const posNorthMgr = await addPosition(northHouse, 'Site Manager', { create: true, view: true, cancel: true, reports: true });
  const posSupplyLead = await addPosition(supply, 'Supply Lead', { accept: true });
  const posSupplyWorker = await addPosition(supply, 'Supply Worker', { execute: true });
  const posRepairLead = await addPosition(repair, 'Repair Lead', { accept: true });
  const posRepairWorker = await addPosition(repair, 'Repair Worker', { execute: true });
  const posMedsLead = await addPosition(meds, 'Meds Lead', { accept: true });
  const posMedsWorker = await addPosition(meds, 'Meds Worker', { execute: true });

  await addUser('owner', 'owner123', 'Robert Owens', 'owner', null, null);

  const anna = await addUser('main.mgr', 'demo123', 'Anna Kim', 'employee', posMainMgr, mainCampus);
  const carl = await addUser('main.clerk', 'demo123', 'Carl Reyes', 'employee', posMainClerk, mainCampus);
  const olivia = await addUser('north.mgr', 'demo123', 'Olivia Nelson', 'employee', posNorthMgr, northHouse);
  const supLead = await addUser('supply.lead', 'demo123', 'David Miller', 'employee', posSupplyLead, supply);
  const supWork = await addUser('supply.work', 'demo123', 'James Carter', 'employee', posSupplyWorker, supply);
  const repLead = await addUser('repair.lead', 'demo123', 'Michael Turner', 'employee', posRepairLead, repair);
  const repWork = await addUser('repair.work', 'demo123', 'Alex Grant', 'employee', posRepairWorker, repair);
  const medLead = await addUser('meds.lead', 'demo123', 'Sofia Reyes', 'employee', posMedsLead, meds);
  const medWork = await addUser('meds.work', 'demo123', 'Grace Lee', 'employee', posMedsWorker, meds);

  const addRequest = async (f) =>
    (
      await query(
        `INSERT INTO requests (title, description, priority, status, site_id, position_id, target_site_id,
           created_by, created_by_name, manager_id, executor_id, due_date, reject_reason,
           created_at, accepted_at, done_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        f
      )
    ).rows[0].id;
  const addEvent = (rid, uid, uname, action, comment, at) =>
    query(`INSERT INTO request_events (request_id, user_id, user_name, action, comment, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [rid, uid, uname, action, comment, at]);

  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000);
  const inDays = (n) => new Date(now + n * 24 * 3600 * 1000).toISOString().slice(0, 10);

  let id = await addRequest([
    'Order office supplies', 'Paper, pens, folders for the intake desk.',
    'normal', 'new', mainCampus, posMainClerk, supply, carl, 'Carl Reyes', null, null, inDays(4), null,
    daysAgo(1), null, null, null,
  ]);
  await addEvent(id, carl, 'Carl Reyes', 'created', null, daysAgo(1));

  id = await addRequest([
    'Fix leaking sink in room 3', 'Water pooling under the sink.',
    'high', 'in_progress', northHouse, posNorthMgr, repair, olivia, 'Olivia Nelson', repLead, repWork, inDays(1), null,
    daysAgo(2), daysAgo(1), null, null,
  ]);
  await addEvent(id, olivia, 'Olivia Nelson', 'created', null, daysAgo(2));
  await addEvent(id, repLead, 'Michael Turner', 'accepted', 'Assigned to: Alex Grant', daysAgo(1));

  id = await addRequest([
    'Restock first-aid medications', 'Bandages and antiseptics low.',
    'high', 'closed', mainCampus, posMainMgr, meds, anna, 'Anna Kim', medLead, medWork, null, null,
    daysAgo(6), daysAgo(5), daysAgo(4), daysAgo(4),
  ]);
  await addEvent(id, anna, 'Anna Kim', 'created', null, daysAgo(6));
  await addEvent(id, medLead, 'Sofia Reyes', 'accepted', 'Assigned to: Grace Lee', daysAgo(5));
  await addEvent(id, medWork, 'Grace Lee', 'done', 'Medications restocked.', daysAgo(4));
  await addEvent(id, medLead, 'Sofia Reyes', 'closed', null, daysAgo(4));

  id = await addRequest([
    'Deliver cleaning supplies', 'Mops, detergent and gloves.',
    'normal', 'done', northHouse, posNorthMgr, supply, olivia, 'Olivia Nelson', supLead, supWork, inDays(0), null,
    daysAgo(3), daysAgo(2), daysAgo(1), null,
  ]);
  await addEvent(id, olivia, 'Olivia Nelson', 'created', null, daysAgo(3));
  await addEvent(id, supLead, 'David Miller', 'accepted', 'Assigned to: James Carter', daysAgo(2));
  await addEvent(id, supWork, 'James Carter', 'done', 'Supplies delivered.', daysAgo(1));

  id = await addRequest([
    'Repaint the lobby', 'The paint looks worn.',
    'low', 'rejected', mainCampus, posMainMgr, repair, anna, 'Anna Kim', repLead, null, null,
    "Not in this quarter's budget.",
    daysAgo(5), null, null, null,
  ]);
  await addEvent(id, anna, 'Anna Kim', 'created', null, daysAgo(5));
  await addEvent(id, repLead, 'Michael Turner', 'rejected', "Not in this quarter's budget.", daysAgo(4));

  console.log('Demo data loaded.');
  console.log('Accounts (username / password):');
  console.log('  admin        / admin123  — system administrator');
  console.log('  owner        / owner123  — owner');
  console.log('  main.mgr     / demo123   — Site Manager @ Main Campus (create/view/cancel/reports)');
  console.log('  main.clerk   / demo123   — Intake Clerk @ Main Campus (create only)');
  console.log('  north.mgr    / demo123   — Site Manager @ North House');
  console.log('  supply.lead / repair.lead / meds.lead   / demo123 — accept & assign');
  console.log('  supply.work / repair.work / meds.work   / demo123 — perform work');
}

main().then(() => pool && pool.end()).catch((e) => { console.error(e); process.exit(1); });
