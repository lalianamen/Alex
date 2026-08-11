'use strict';

// Наполнение базы демонстрационными данными: подразделения, пользователи всех
// ролей и несколько заявок в разных статусах. Запуск: npm run seed:demo

const { db } = require('../src/db');
const { hashPassword } = require('../src/passwords');

const already = db.prepare(`SELECT id FROM users WHERE login = 'owner'`).get();
if (already) {
  console.log('Демо-данные уже загружены — пропускаем.');
  process.exit(0);
}

const insertDept = db.prepare('INSERT INTO departments (name) VALUES (?)');
const itDept = insertDept.run('ИТ-отдел').lastInsertRowid;
const hozDept = insertDept.run('Хозяйственный отдел').lastInsertRowid;

const insertUser = db.prepare(
  `INSERT INTO users (login, password_hash, full_name, role, department_id)
   VALUES (?, ?, ?, ?, ?)`
);

function addUser(login, password, fullName, role, deptId) {
  return insertUser.run(login, hashPassword(password), fullName, role, deptId || null).lastInsertRowid;
}

addUser('owner', 'owner123', 'Владимиров Пётр Сергеевич', 'owner', null);

const itAdmin = addUser('it.admin', 'demo123', 'Кузнецова Анна Игоревна', 'dept_admin', itDept);
const itManager = addUser('it.manager', 'demo123', 'Соколов Дмитрий Олегович', 'manager', itDept);
const itExec1 = addUser('it.exec1', 'demo123', 'Морозов Иван Андреевич', 'executor', itDept);
addUser('it.exec2', 'demo123', 'Павлова Елена Викторовна', 'executor', itDept);

const hozAdmin = addUser('hoz.admin', 'demo123', 'Никитина Ольга Павловна', 'dept_admin', hozDept);
const hozManager = addUser('hoz.manager', 'demo123', 'Фёдоров Сергей Николаевич', 'manager', hozDept);
const hozExec1 = addUser('hoz.exec1', 'demo123', 'Григорьев Алексей Петрович', 'executor', hozDept);

const insertReq = db.prepare(
  `INSERT INTO requests (title, description, priority, status, department_id, created_by,
     manager_id, executor_id, due_date, created_at, accepted_at, done_at, closed_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertEvent = db.prepare(
  `INSERT INTO request_events (request_id, user_id, action, comment, created_at) VALUES (?, ?, ?, ?, ?)`
);

const now = Date.now();
const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
const inDays = (n) => new Date(now + n * 24 * 3600 * 1000).toISOString().slice(0, 10);

// Новая заявка в ИТ-отделе.
let id = insertReq.run(
  'Настроить рабочее место для нового сотрудника', 'Подключить компьютер, создать учётные записи, выдать доступы.',
  'high', 'new', itDept, itAdmin, itManager, null, inDays(3), daysAgo(1), null, null, null
).lastInsertRowid;
insertEvent.run(id, itAdmin, 'created', null, daysAgo(1));

// Заявка в работе в ИТ-отделе.
id = insertReq.run(
  'Заменить картридж в принтере бухгалтерии', 'Принтер HP LaserJet на 2 этаже, картридж закончился.',
  'normal', 'in_progress', itDept, itAdmin, itManager, itExec1, inDays(1), daysAgo(2), daysAgo(1), null, null
).lastInsertRowid;
insertEvent.run(id, itAdmin, 'created', null, daysAgo(2));
insertEvent.run(id, itManager, 'accepted', 'Исполнитель: Морозов Иван Андреевич', daysAgo(1));

// Закрытая заявка в ИТ-отделе.
id = insertReq.run(
  'Восстановить доступ к корпоративной почте', 'Сотрудник заблокировал учётную запись после смены пароля.',
  'high', 'closed', itDept, itAdmin, itManager, itExec1, null, daysAgo(6), daysAgo(5), daysAgo(4), daysAgo(4)
).lastInsertRowid;
insertEvent.run(id, itAdmin, 'created', null, daysAgo(6));
insertEvent.run(id, itManager, 'accepted', 'Исполнитель: Морозов Иван Андреевич', daysAgo(5));
insertEvent.run(id, itExec1, 'done', 'Доступ восстановлен, пароль сброшен.', daysAgo(4));
insertEvent.run(id, itManager, 'closed', null, daysAgo(4));

// Выполненная, но ещё не закрытая заявка в хозотделе.
id = insertReq.run(
  'Заменить лампы в переговорной', 'Перегорели две лампы дневного света.',
  'normal', 'done', hozDept, hozAdmin, hozManager, hozExec1, inDays(0), daysAgo(3), daysAgo(2), daysAgo(1), null
).lastInsertRowid;
insertEvent.run(id, hozAdmin, 'created', null, daysAgo(3));
insertEvent.run(id, hozManager, 'accepted', 'Исполнитель: Григорьев Алексей Петрович', daysAgo(2));
insertEvent.run(id, hozExec1, 'done', 'Лампы заменены.', daysAgo(1));

// Отклонённая заявка в хозотделе.
id = insertReq.run(
  'Купить новый кофейный аппарат', 'Старый часто ломается.',
  'low', 'rejected', hozDept, hozAdmin, hozManager, null, null, daysAgo(5), null, null, null
).lastInsertRowid;
insertEvent.run(id, hozAdmin, 'created', null, daysAgo(5));
insertEvent.run(id, hozManager, 'rejected', 'Не входит в бюджет текущего квартала.', daysAgo(4));
db.prepare(`UPDATE requests SET reject_reason = ? WHERE id = ?`).run('Не входит в бюджет текущего квартала.', id);

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
