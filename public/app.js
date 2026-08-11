'use strict';

// ---------------------------------------------------------------------------
// Справочники
// ---------------------------------------------------------------------------

const ROLE_RU = {
  admin: 'Администратор системы',
  owner: 'Собственник',
  dept_admin: 'Администратор подразделения',
  manager: 'Руководитель работ',
  executor: 'Исполнитель',
};

const STATUS_RU = {
  new: 'Новая',
  in_progress: 'В работе',
  done: 'Выполнена',
  closed: 'Закрыта',
  rejected: 'Отклонена',
  cancelled: 'Отменена',
};

const PRIORITY_RU = { low: 'Низкий', normal: 'Обычный', high: 'Высокий' };

const EVENT_RU = {
  created: 'Заявка создана',
  accepted: 'Принята в работу',
  reassigned: 'Смена исполнителя',
  rejected: 'Отклонена',
  done: 'Отмечена выполненной',
  reopened: 'Возвращена на доработку',
  closed: 'Закрыта',
  cancelled: 'Отменена',
};

let currentUser = null;
let currentTab = null;

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(s) {
  if (!s) return '—';
  // В БД время в UTC ("YYYY-MM-DD HH:MM:SS") — показываем в местном времени.
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDay(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  return isNaN(d) ? s : d.toLocaleDateString('ru-RU');
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* пустой ответ */ }
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal').innerHTML = '';
}

$('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target === $('#modal-backdrop')) closeModal();
});

function showFormError(sel, msg) {
  const el = $(sel);
  if (!el) return alert(msg);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function statusBadge(s) {
  return `<span class="badge badge-${esc(s)}">${esc(STATUS_RU[s] || s)}</span>`;
}

function priorityCell(p) {
  return `<span class="priority-${esc(p)}">${esc(PRIORITY_RU[p] || p)}</span>`;
}

// ---------------------------------------------------------------------------
// Вход / выход
// ---------------------------------------------------------------------------

async function init() {
  try {
    const { user } = await api('/api/me');
    currentUser = user;
    showApp();
  } catch (_) {
    showLogin();
  }
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-input').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').classList.add('hidden');
  try {
    const { user } = await api('/api/login', {
      method: 'POST',
      body: { login: $('#login-input').value, password: $('#password-input').value },
    });
    currentUser = user;
    $('#password-input').value = '';
    showApp();
  } catch (err) {
    showFormError('#login-error', err.message);
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  showLogin();
});

$('#btn-change-password').addEventListener('click', () => {
  openModal(`
    <h3>Смена пароля</h3>
    <form id="pw-form">
      <label>Текущий пароль <input type="password" id="pw-old" required autocomplete="current-password"></label>
      <label>Новый пароль <input type="password" id="pw-new" required minlength="6" autocomplete="new-password"></label>
      <div id="pw-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `);
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/me/password', {
        method: 'POST',
        body: { old_password: $('#pw-old').value, new_password: $('#pw-new').value },
      });
      closeModal();
      toast('Пароль изменён');
    } catch (err) {
      showFormError('#pw-error', err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// Оболочка приложения
// ---------------------------------------------------------------------------

const TABS_BY_ROLE = {
  admin: [
    { id: 'users', title: 'Пользователи' },
    { id: 'departments', title: 'Подразделения' },
  ],
  owner: [
    { id: 'requests', title: 'Заявки' },
    { id: 'reports', title: 'Отчёты' },
  ],
  dept_admin: [{ id: 'requests', title: 'Заявки' }],
  manager: [{ id: 'requests', title: 'Заявки' }],
  executor: [{ id: 'requests', title: 'Мои работы' }],
};

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = currentUser.full_name;
  $('#user-role').textContent = ROLE_RU[currentUser.role] || currentUser.role;

  const tabs = TABS_BY_ROLE[currentUser.role] || [];
  const nav = $('#nav-tabs');
  nav.innerHTML = '';
  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.textContent = t.title;
    btn.dataset.tab = t.id;
    btn.addEventListener('click', () => setTab(t.id));
    nav.appendChild(btn);
  }
  setTab(tabs.length ? tabs[0].id : null);
}

function setTab(id) {
  currentTab = id;
  document.querySelectorAll('#nav-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === id);
  });
  $('#main').onclick = null;
  const render = { requests: renderRequests, reports: renderReports, users: renderUsers, departments: renderDepartments }[id];
  if (render) render();
  else $('#main').innerHTML = '<div class="empty-state">Нет доступных разделов</div>';
}

// ---------------------------------------------------------------------------
// Заявки
// ---------------------------------------------------------------------------

async function renderRequests() {
  const main = $('#main');
  const role = currentUser.role;
  const isOwner = role === 'owner';

  let departments = [];
  if (isOwner) {
    departments = (await api('/api/departments')).departments;
  }

  main.innerHTML = `
    <div class="page-header">
      <h2>${role === 'executor' ? 'Мои работы' : 'Заявки'}</h2>
      <div class="filters">
        ${isOwner ? `
          <select id="flt-dept">
            <option value="">Все подразделения</option>
            ${departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
          </select>` : ''}
        <select id="flt-status">
          <option value="">Все статусы</option>
          ${Object.entries(STATUS_RU).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
        </select>
        ${role === 'dept_admin' ? '<button id="btn-new-request" class="btn btn-primary">+ Создать заявку</button>' : ''}
      </div>
    </div>
    <div class="card"><div id="requests-table"></div></div>
  `;

  $('#flt-status').addEventListener('change', loadRequests);
  if (isOwner) $('#flt-dept').addEventListener('change', loadRequests);
  if (role === 'dept_admin') $('#btn-new-request').addEventListener('click', openNewRequestModal);

  await loadRequests();
}

async function loadRequests() {
  const params = new URLSearchParams();
  const status = $('#flt-status') && $('#flt-status').value;
  const dept = $('#flt-dept') && $('#flt-dept').value;
  if (status) params.set('status', status);
  if (dept) params.set('department_id', dept);

  const { requests } = await api('/api/requests?' + params.toString());
  const isOwner = currentUser.role === 'owner';

  const box = $('#requests-table');
  if (!requests.length) {
    box.innerHTML = '<div class="empty-state">Заявок нет</div>';
    return;
  }

  box.innerHTML = `
    <table>
      <thead><tr>
        <th>№</th><th>Тема</th>
        ${isOwner ? '<th>Подразделение</th>' : ''}
        <th>Статус</th><th>Приоритет</th><th>Руководитель</th><th>Исполнитель</th><th>Срок</th><th>Создана</th>
      </tr></thead>
      <tbody>
        ${requests.map((r) => `
          <tr class="clickable" data-id="${r.id}">
            <td>${r.id}</td>
            <td>${esc(r.title)}</td>
            ${isOwner ? `<td>${esc(r.department_name)}</td>` : ''}
            <td>${statusBadge(r.status)}</td>
            <td>${priorityCell(r.priority)}</td>
            <td>${esc(r.manager_name)}</td>
            <td>${esc(r.executor_name || '—')}</td>
            <td>${fmtDay(r.due_date)}</td>
            <td>${fmtDate(r.created_at)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
  box.querySelectorAll('tr.clickable').forEach((tr) => {
    tr.addEventListener('click', () => openRequestModal(tr.dataset.id));
  });
}

async function openNewRequestModal() {
  const { managers } = await api('/api/users/managers');
  if (!managers.length) {
    toast('В вашем подразделении нет активных руководителей работ');
    return;
  }
  openModal(`
    <h3>Новая заявка</h3>
    <form id="req-form">
      <label>Тема <input type="text" id="req-title" required maxlength="200"></label>
      <label>Описание <textarea id="req-desc" maxlength="4000"></textarea></label>
      <label>Приоритет
        <select id="req-priority">
          <option value="low">Низкий</option>
          <option value="normal" selected>Обычный</option>
          <option value="high">Высокий</option>
        </select>
      </label>
      <label>Руководитель работ
        <select id="req-manager">
          ${managers.map((m) => `<option value="${m.id}">${esc(m.full_name)}</option>`).join('')}
        </select>
      </label>
      <label>Срок выполнения <input type="date" id="req-due"></label>
      <div id="req-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">Создать</button>
      </div>
    </form>
  `);
  $('#req-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/requests', {
        method: 'POST',
        body: {
          title: $('#req-title').value,
          description: $('#req-desc').value,
          priority: $('#req-priority').value,
          manager_id: $('#req-manager').value,
          due_date: $('#req-due').value || null,
        },
      });
      closeModal();
      toast('Заявка создана');
      loadRequests();
    } catch (err) {
      showFormError('#req-error', err.message);
    }
  });
}

async function openRequestModal(id) {
  const { request: r, events } = await api('/api/requests/' + id);
  const role = currentUser.role;

  const actions = [];
  if (role === 'manager' && r.manager_id === currentUser.id) {
    if (r.status === 'new') {
      actions.push('<button class="btn btn-success" data-action="accept">Принять в работу</button>');
      actions.push('<button class="btn btn-danger" data-action="reject">Отклонить</button>');
    }
    if (r.status === 'in_progress') {
      actions.push('<button class="btn" data-action="assign">Сменить исполнителя</button>');
    }
    if (r.status === 'done') {
      actions.push('<button class="btn btn-success" data-action="close">Подтвердить и закрыть</button>');
      actions.push('<button class="btn" data-action="reopen">Вернуть на доработку</button>');
    }
  }
  if (role === 'executor' && r.executor_id === currentUser.id && r.status === 'in_progress') {
    actions.push('<button class="btn btn-success" data-action="done">Отметить выполненной</button>');
  }
  if (role === 'dept_admin' && r.status === 'new') {
    actions.push('<button class="btn btn-danger" data-action="cancel">Отменить заявку</button>');
  }

  openModal(`
    <h3>Заявка №${r.id}: ${esc(r.title)}</h3>
    <dl class="detail-grid">
      <dt>Статус</dt><dd>${statusBadge(r.status)}</dd>
      <dt>Приоритет</dt><dd>${priorityCell(r.priority)}</dd>
      <dt>Подразделение</dt><dd>${esc(r.department_name)}</dd>
      <dt>Автор</dt><dd>${esc(r.created_by_name)}</dd>
      <dt>Руководитель</dt><dd>${esc(r.manager_name)}</dd>
      <dt>Исполнитель</dt><dd>${esc(r.executor_name || 'не назначен')}</dd>
      <dt>Срок</dt><dd>${fmtDay(r.due_date)}</dd>
      <dt>Создана</dt><dd>${fmtDate(r.created_at)}</dd>
      ${r.accepted_at ? `<dt>Принята</dt><dd>${fmtDate(r.accepted_at)}</dd>` : ''}
      ${r.done_at ? `<dt>Выполнена</dt><dd>${fmtDate(r.done_at)}</dd>` : ''}
      ${r.closed_at ? `<dt>Закрыта</dt><dd>${fmtDate(r.closed_at)}</dd>` : ''}
      ${r.reject_reason ? `<dt>Причина отклонения</dt><dd>${esc(r.reject_reason)}</dd>` : ''}
      ${r.description ? `<dt>Описание</dt><dd>${esc(r.description)}</dd>` : ''}
    </dl>
    <div class="history">
      <h4>История</h4>
      ${events.map((ev) => `
        <div class="history-item">
          <strong>${esc(EVENT_RU[ev.action] || ev.action)}</strong> — ${esc(ev.user_name)}, ${fmtDate(ev.created_at)}
          ${ev.comment ? `<div class="muted">${esc(ev.comment)}</div>` : ''}
        </div>`).join('')}
    </div>
    <div id="action-area"></div>
    <div class="modal-actions" id="req-actions">
      ${actions.join('')}
      <button type="button" class="btn" onclick="closeModal()">Закрыть окно</button>
    </div>
  `);

  $('#req-actions').addEventListener('click', (e) => {
    const action = e.target.dataset && e.target.dataset.action;
    if (action) handleRequestAction(r, action);
  });
}

async function handleRequestAction(r, action) {
  const area = $('#action-area');

  const doPost = async (url, body) => {
    try {
      await api(url, { method: 'POST', body });
      closeModal();
      toast('Готово');
      loadRequests();
    } catch (err) {
      area.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    }
  };

  if (action === 'accept' || action === 'assign') {
    const { executors } = await api('/api/users/executors');
    if (!executors.length) {
      area.innerHTML = '<div class="form-error">В вашем подразделении нет активных исполнителей</div>';
      return;
    }
    area.innerHTML = `
      <label>Исполнитель
        <select id="act-executor">
          ${executors.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}
        </select>
      </label>
      <div class="modal-actions">
        <button class="btn btn-primary" id="act-confirm">
          ${action === 'accept' ? 'Принять и назначить' : 'Сменить исполнителя'}
        </button>
      </div>
    `;
    $('#act-confirm').addEventListener('click', () =>
      doPost(`/api/requests/${r.id}/${action}`, { executor_id: $('#act-executor').value })
    );
  } else if (action === 'reject' || action === 'reopen') {
    area.innerHTML = `
      <label>${action === 'reject' ? 'Причина отклонения' : 'Что нужно доработать'}
        <textarea id="act-comment" required></textarea>
      </label>
      <div class="modal-actions">
        <button class="btn btn-danger" id="act-confirm">${action === 'reject' ? 'Отклонить' : 'Вернуть на доработку'}</button>
      </div>
    `;
    $('#act-confirm').addEventListener('click', () => {
      const comment = $('#act-comment').value.trim();
      if (!comment) return;
      doPost(`/api/requests/${r.id}/${action}`, action === 'reject' ? { reason: comment } : { comment });
    });
  } else if (action === 'done') {
    area.innerHTML = `
      <label>Комментарий к выполнению (необязательно)
        <textarea id="act-comment"></textarea>
      </label>
      <div class="modal-actions">
        <button class="btn btn-success" id="act-confirm">Подтвердить выполнение</button>
      </div>
    `;
    $('#act-confirm').addEventListener('click', () =>
      doPost(`/api/requests/${r.id}/done`, { comment: $('#act-comment').value })
    );
  } else if (action === 'close') {
    doPost(`/api/requests/${r.id}/close`, {});
  } else if (action === 'cancel') {
    if (confirm('Отменить заявку №' + r.id + '?')) doPost(`/api/requests/${r.id}/cancel`, {});
  }
}

// ---------------------------------------------------------------------------
// Отчёты (собственник)
// ---------------------------------------------------------------------------

async function renderReports() {
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 29 * 24 * 3600 * 1000);
  const toISO = (d) => d.toISOString().slice(0, 10);

  $('#main').innerHTML = `
    <div class="page-header">
      <h2>Отчёты</h2>
      <div class="filters">
        <label class="small" style="margin:0">с <input type="date" id="rep-from" value="${toISO(monthAgo)}"></label>
        <label class="small" style="margin:0">по <input type="date" id="rep-to" value="${toISO(today)}"></label>
        <button id="rep-build" class="btn btn-primary">Сформировать</button>
        <button id="rep-csv" class="btn">Экспорт CSV</button>
      </div>
    </div>
    <div id="report-body"><div class="empty-state">Выберите период и нажмите «Сформировать»</div></div>
  `;

  const build = async () => {
    const from = $('#rep-from').value;
    const to = $('#rep-to').value;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const { totals, by_department } = await api('/api/reports/summary?' + params.toString());

    $('#report-body').innerHTML = `
      <div class="stats-row">
        <div class="stat-card"><div class="stat-value">${totals.total || 0}</div><div class="stat-label">Всего заявок</div></div>
        <div class="stat-card"><div class="stat-value">${totals.new_count || 0}</div><div class="stat-label">Новые</div></div>
        <div class="stat-card"><div class="stat-value">${totals.in_progress_count || 0}</div><div class="stat-label">В работе</div></div>
        <div class="stat-card"><div class="stat-value">${(totals.done_count || 0) + (totals.closed_count || 0)}</div><div class="stat-label">Выполнено</div></div>
        <div class="stat-card"><div class="stat-value">${(totals.rejected_count || 0) + (totals.cancelled_count || 0)}</div><div class="stat-label">Отклонено / отменено</div></div>
        <div class="stat-card"><div class="stat-value">${totals.avg_completion_hours != null ? totals.avg_completion_hours + ' ч' : '—'}</div><div class="stat-label">Среднее время выполнения</div></div>
      </div>
      <div class="card">
        <div class="card-title">По подразделениям</div>
        ${by_department.length ? `
        <table>
          <thead><tr>
            <th>Подразделение</th><th>Всего</th><th>Новые</th><th>В работе</th>
            <th>Выполнены</th><th>Закрыты</th><th>Отклонены</th><th>Отменены</th>
          </tr></thead>
          <tbody>
            ${by_department.map((d) => `
              <tr>
                <td>${esc(d.department_name)}</td>
                <td>${d.total}</td><td>${d.new_count}</td><td>${d.in_progress_count}</td>
                <td>${d.done_count}</td><td>${d.closed_count}</td><td>${d.rejected_count}</td><td>${d.cancelled_count}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state">Нет данных за выбранный период</div>'}
      </div>
    `;
  };

  $('#rep-build').addEventListener('click', build);
  $('#rep-csv').addEventListener('click', () => {
    const params = new URLSearchParams();
    if ($('#rep-from').value) params.set('from', $('#rep-from').value);
    if ($('#rep-to').value) params.set('to', $('#rep-to').value);
    window.location.href = '/api/reports/export.csv?' + params.toString();
  });

  await build();
}

// ---------------------------------------------------------------------------
// Пользователи (администратор системы)
// ---------------------------------------------------------------------------

async function renderUsers() {
  const [{ users }, { departments }] = await Promise.all([
    api('/api/users'),
    api('/api/departments'),
  ]);

  $('#main').innerHTML = `
    <div class="page-header">
      <h2>Пользователи</h2>
      <button id="btn-new-user" class="btn btn-primary">+ Создать пользователя</button>
    </div>
    <div class="card">
      ${users.length ? `
      <table>
        <thead><tr>
          <th>ФИО</th><th>Логин</th><th>Роль</th><th>Подразделение</th><th>Статус</th><th></th>
        </tr></thead>
        <tbody>
          ${users.map((u) => `
            <tr>
              <td>${esc(u.full_name)}</td>
              <td>${esc(u.login)}</td>
              <td>${esc(ROLE_RU[u.role] || u.role)}</td>
              <td>${esc(u.department_name || '—')}</td>
              <td><span class="badge ${u.is_active ? 'badge-active' : 'badge-inactive'}">
                ${u.is_active ? 'Активен' : 'Отключён'}</span></td>
              <td style="text-align:right; white-space:nowrap">
                <button class="btn btn-sm" data-action="edit" data-id="${u.id}">Изменить</button>
                <button class="btn btn-sm" data-action="password" data-id="${u.id}">Сброс пароля</button>
                ${u.id !== currentUser.id ? (u.is_active
                  ? `<button class="btn btn-sm btn-danger" data-action="deactivate" data-id="${u.id}">Отключить</button>`
                  : `<button class="btn btn-sm btn-success" data-action="restore" data-id="${u.id}">Восстановить</button>`) : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty-state">Пользователей нет</div>'}
    </div>
  `;

  $('#btn-new-user').addEventListener('click', () => openUserModal(null, departments));
  // onclick (а не addEventListener) — чтобы обработчик не накапливался при повторном рендере.
  $('#main').onclick = async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const user = users.find((u) => u.id === id);
    switch (btn.dataset.action) {
      case 'edit':
        openUserModal(user, departments);
        break;
      case 'password':
        openResetPasswordModal(user);
        break;
      case 'deactivate':
        if (confirm(`Отключить учётную запись «${user.full_name}»?`)) {
          try {
            await api(`/api/users/${id}/deactivate`, { method: 'POST', body: {} });
            toast('Учётная запись отключена');
            renderUsers();
          } catch (err) { toast(err.message); }
        }
        break;
      case 'restore':
        try {
          await api(`/api/users/${id}/restore`, { method: 'POST', body: {} });
          toast('Учётная запись восстановлена');
          renderUsers();
        } catch (err) { toast(err.message); }
        break;
    }
  };
}

function openUserModal(user, departments) {
  const isNew = !user;
  openModal(`
    <h3>${isNew ? 'Новый пользователь' : 'Изменение пользователя'}</h3>
    <form id="user-form">
      <label>ФИО <input type="text" id="u-name" required value="${esc(user ? user.full_name : '')}"></label>
      <label>Логин <input type="text" id="u-login" required value="${esc(user ? user.login : '')}"
        pattern="[a-zA-Z0-9._\\-]{3,32}" title="3–32 символа: латиница, цифры, точка, дефис, подчёркивание"></label>
      ${isNew ? '<label>Пароль <input type="password" id="u-password" required minlength="6" autocomplete="new-password"></label>' : ''}
      <label>Роль
        <select id="u-role">
          ${Object.entries(ROLE_RU).map(([k, v]) =>
            `<option value="${k}" ${user && user.role === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
      </label>
      <label id="u-dept-label">Подразделение
        <select id="u-dept">
          <option value="">— не указано —</option>
          ${departments.map((d) =>
            `<option value="${d.id}" ${user && user.department_id === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
      </label>
      <div id="u-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">${isNew ? 'Создать' : 'Сохранить'}</button>
      </div>
    </form>
  `);

  const roleSelect = $('#u-role');
  const deptLabel = $('#u-dept-label');
  const syncDept = () => {
    const needsDept = ['dept_admin', 'manager', 'executor'].includes(roleSelect.value);
    deptLabel.style.display = needsDept ? '' : 'none';
  };
  roleSelect.addEventListener('change', syncDept);
  syncDept();

  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      full_name: $('#u-name').value,
      login: $('#u-login').value,
      role: $('#u-role').value,
      department_id: $('#u-dept').value || null,
    };
    if (isNew) body.password = $('#u-password').value;
    try {
      await api(isNew ? '/api/users' : `/api/users/${user.id}`, {
        method: isNew ? 'POST' : 'PUT',
        body,
      });
      closeModal();
      toast(isNew ? 'Пользователь создан' : 'Изменения сохранены');
      renderUsers();
    } catch (err) {
      showFormError('#u-error', err.message);
    }
  });
}

function openResetPasswordModal(user) {
  openModal(`
    <h3>Сброс пароля: ${esc(user.full_name)}</h3>
    <form id="reset-form">
      <label>Новый пароль <input type="password" id="r-password" required minlength="6" autocomplete="new-password"></label>
      <div id="r-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">Установить пароль</button>
      </div>
    </form>
  `);
  $('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/users/${user.id}/password`, {
        method: 'POST',
        body: { password: $('#r-password').value },
      });
      closeModal();
      toast('Пароль установлен');
    } catch (err) {
      showFormError('#r-error', err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Подразделения (администратор системы)
// ---------------------------------------------------------------------------

async function renderDepartments() {
  const { departments } = await api('/api/departments');

  $('#main').innerHTML = `
    <div class="page-header">
      <h2>Подразделения</h2>
      <button id="btn-new-dept" class="btn btn-primary">+ Добавить подразделение</button>
    </div>
    <div class="card">
      ${departments.length ? `
      <table>
        <thead><tr><th>Название</th><th style="width:120px"></th></tr></thead>
        <tbody>
          ${departments.map((d) => `
            <tr>
              <td>${esc(d.name)}</td>
              <td style="text-align:right">
                <button class="btn btn-sm" data-id="${d.id}" data-name="${esc(d.name)}">Переименовать</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty-state">Подразделений пока нет</div>'}
    </div>
  `;

  $('#btn-new-dept').addEventListener('click', () => openDeptModal(null));
  $('#main').onclick = (e) => {
    const btn = e.target.closest('button[data-id]');
    if (btn) openDeptModal({ id: btn.dataset.id, name: btn.dataset.name });
  };
}

function openDeptModal(dept) {
  const isNew = !dept;
  openModal(`
    <h3>${isNew ? 'Новое подразделение' : 'Переименование'}</h3>
    <form id="dept-form">
      <label>Название <input type="text" id="d-name" required maxlength="100" value="${esc(dept ? dept.name : '')}"></label>
      <div id="d-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `);
  $('#dept-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(isNew ? '/api/departments' : `/api/departments/${dept.id}`, {
        method: isNew ? 'POST' : 'PUT',
        body: { name: $('#d-name').value },
      });
      closeModal();
      toast('Сохранено');
      renderDepartments();
    } catch (err) {
      showFormError('#d-error', err.message);
    }
  });
}

init();
