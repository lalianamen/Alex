'use strict';

// Наполнение базы демонстрационными данными: подразделения, пользователи всех
// ролей и несколько заявок в разных статусах.
// Запуск: DATABASE_URL=postgres://... npm run seed:demo

const { pool, query, one, ready } = require('../src/db');
const { hashPassword } = require('../src/passwords');

async function main() {
  if (!pool) {
    console.error('Задайте переменную окружения DATABASE_URL.');
    process.exit(1);
  }
  await ready();

  const already = await one(`SELECT id FROM users WHERE LOWER(login) = 'owner'`);
  if (already) {
    console.log('Демо-данные уже загружены — пропускаем.');
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

  const itDept = await addDept('ИТ-отдел');
  const hozDept = await addDept('Хозяйственный отдел');

  await addUser('owner', 'owner123', 'Владимиров Пётр Сергеевич', 'owner', null);

  const itAdmin = await addUser('it.admin', 'demo123', 'Кузнецова Анна Игоревна', 'dept_admin', itDept);
  const itManager = await addUser('it.manager', 'demo123', 'Соколов Дмитрий Олегович', 'manager', itDept);
  const itExec1 = await addUser('it.exec1', 'demo123', 'Морозов Иван Андреевич', 'executor', itDept);
  await addUser('it.exec2', 'demo123', 'Павлова Елена Викторовна', 'executor', itDept);

  const hozAdmin = await addUser('hoz.admin', 'demo123', 'Никитина Ольга Павловна', 'dept_admin', hozDept);
  const hozManager = await addUser('hoz.manager', 'demo123', 'Фёдоров Сергей Николаевич', 'manager', hozDept);
  const hozExec1 = await addUser('hoz.exec1', 'demo123', 'Григорьев Алексей Петрович', 'executor', hozDept);

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

  // Новая заявка в ИТ-отделе.
  let id = await addRequest([
    'Настроить рабочее место для нового сотрудника',
    'Подключить компьютер, создать учётные записи, выдать доступы.',
    'high', 'new', itDept, itAdmin, itManager, null, inDays(3), null,
    daysAgo(1), null, null, null,
  ]);
  await addEvent(id, itAdmin, 'created', null, daysAgo(1));

  // Заявка в работе в ИТ-отделе.
  id = await addRequest([
    'Заменить картридж в принтере бухгалтерии',
    'Принтер HP LaserJet на 2 этаже, картридж закончился.',
    'normal', 'in_progress', itDept, itAdmin, itManager, itExec1, inDays(1), null,
    daysAgo(2), daysAgo(1), null, null,
  ]);
  await addEvent(id, itAdmin, 'created', null, daysAgo(2));
  await addEvent(id, itManager, 'accepted', 'Исполнитель: Морозов Иван Андреевич', daysAgo(1));

  // Закрытая заявка в ИТ-отделе.
  id = await addRequest([
    'Восстановить доступ к корпоративной почте',
    'Сотрудник заблокировал учётную запись после смены пароля.',
    'high', 'closed', itDept, itAdmin, itManager, itExec1, null, null,
    daysAgo(6), daysAgo(5), daysAgo(4), daysAgo(4),
  ]);
  await addEvent(id, itAdmin, 'created', null, daysAgo(6));
  await addEvent(id, itManager, 'accepted', 'Исполнитель: Морозов Иван Андреевич', daysAgo(5));
  await addEvent(id, itExec1, 'done', 'Доступ восстановлен, пароль сброшен.', daysAgo(4));
  await addEvent(id, itManager, 'closed', null, daysAgo(4));

  // Выполненная, но ещё не закрытая заявка в хозотделе.
  id = await addRequest([
    'Заменить лампы в переговорной',
    'Перегорели две лампы дневного света.',
    'normal', 'done', hozDept, hozAdmin, hozManager, hozExec1, inDays(0), null,
    daysAgo(3), daysAgo(2), daysAgo(1), null,
  ]);
  await addEvent(id, hozAdmin, 'created', null, daysAgo(3));
  await addEvent(id, hozManager, 'accepted', 'Исполнитель: Григорьев Алексей Петрович', daysAgo(2));
  await addEvent(id, hozExec1, 'done', 'Лампы заменены.', daysAgo(1));

  // Отклонённая заявка в хозотделе.
  id = await addRequest([
    'Купить новый кофейный аппарат',
    'Старый часто ломается.',
    'low', 'rejected', hozDept, hozAdmin, hozManager, null, null,
    'Не входит в бюджет текущего квартала.',
    daysAgo(5), null, null, null,
  ]);
  await addEvent(id, hozAdmin, 'created', null, daysAgo(5));
  await addEvent(id, hozManager, 'rejected', 'Не входит в бюджет текущего квартала.', daysAgo(4));

  console.log('Демо-данные загружены.');
  console.log('Учётные записи (логин / пароль):');
  console.log('  admin       / admin123  — администратор системы');
  console.log('  owner       / owner123  — собственник');
  console.log('  it.admin    / demo123   — администратор ИТ-отдела');
  console.log('  it.manager  / demo123   — руководитель работ, ИТ-отдел');
  console.log('  it.exec1    / demo123   — исполнитель, ИТ-отдел');
  console.log('  it.exec2    / demo123   — исполнитель, ИТ-отдел');
  console.log('  hoz.admin   / demo123   — администратор хозотдела');
  console.log('  hoz.manager / demo123   — руководитель работ, хозотдел');
  console.log('  hoz.exec1   / demo123   — исполнитель, хозотдел');
}

main()
  .then(() => pool && pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
