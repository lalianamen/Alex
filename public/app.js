'use strict';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const ROLE_LABEL = {
  admin: 'System Administrator',
  owner: 'Owner',
  dept_admin: 'Department Administrator',
  manager: 'Work Supervisor',
  executor: 'Executor',
};

const STATUS_LABEL = {
  new: 'New',
  in_progress: 'In progress',
  done: 'Completed',
  closed: 'Closed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High' };

const EVENT_LABEL = {
  created: 'Request created',
  accepted: 'Accepted for work',
  reassigned: 'Executor changed',
  rejected: 'Rejected',
  done: 'Marked completed',
  reopened: 'Returned for rework',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

let currentUser = null;
let currentTab = null;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(s) {
  if (!s) return '—';
  // Timestamps come from the server in UTC — render them in local time.
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDay(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  return isNaN(d) ? s : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty response */ }
  if (!res.ok) throw new Error(data.error || 'Request failed');
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
  return `<span class="badge badge-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
}

function priorityCell(p) {
  return `<span class="priority-${esc(p)}">${esc(PRIORITY_LABEL[p] || p)}</span>`;
}

// ---------------------------------------------------------------------------
// Sign in / out
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
    <h3>Change password</h3>
    <form id="pw-form">
      <label>Current password <input type="password" id="pw-old" required autocomplete="current-password"></label>
      <label>New password <input type="password" id="pw-new" required minlength="6" autocomplete="new-password"></label>
      <div id="pw-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
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
      toast('Password changed');
    } catch (err) {
      showFormError('#pw-error', err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

const TABS_BY_ROLE = {
  admin: [
    { id: 'users', title: 'Users' },
    { id: 'departments', title: 'Departments' },
  ],
  owner: [
    { id: 'requests', title: 'Requests' },
    { id: 'reports', title: 'Reports' },
  ],
  dept_admin: [{ id: 'requests', title: 'Requests' }],
  manager: [{ id: 'requests', title: 'Requests' }],
  executor: [{ id: 'requests', title: 'My Work' }],
};

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = currentUser.full_name;
  $('#user-role').textContent = ROLE_LABEL[currentUser.role] || currentUser.role;

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
  else $('#main').innerHTML = '<div class="empty-state">No sections available</div>';
}

// ---------------------------------------------------------------------------
// Requests
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
      <h2>${role === 'executor' ? 'My Work' : 'Requests'}</h2>
      <div class="filters">
        ${isOwner ? `
          <select id="flt-dept">
            <option value="">All departments</option>
            ${departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
          </select>` : ''}
        <select id="flt-status">
          <option value="">All statuses</option>
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
        </select>
        ${role === 'dept_admin' ? '<button id="btn-new-request" class="btn btn-primary">+ New request</button>' : ''}
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
    box.innerHTML = '<div class="empty-state">No requests</div>';
    return;
  }

  box.innerHTML = `
    <table>
      <thead><tr>
        <th>#</th><th>Subject</th>
        ${isOwner ? '<th>Department</th>' : ''}
        <th>Status</th><th>Priority</th><th>Supervisor</th><th>Executor</th><th>Due</th><th>Created</th>
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
    toast('There are no active supervisors in your department');
    return;
  }
  openModal(`
    <h3>New request</h3>
    <form id="req-form">
      <label>Subject <input type="text" id="req-title" required maxlength="200"></label>
      <label>Description <textarea id="req-desc" maxlength="4000"></textarea></label>
      <label>Priority
        <select id="req-priority">
          <option value="low">Low</option>
          <option value="normal" selected>Normal</option>
          <option value="high">High</option>
        </select>
      </label>
      <label>Work supervisor
        <select id="req-manager">
          ${managers.map((m) => `<option value="${m.id}">${esc(m.full_name)}</option>`).join('')}
        </select>
      </label>
      <label>Due date <input type="date" id="req-due"></label>
      <div id="req-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create</button>
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
      toast('Request created');
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
      actions.push('<button class="btn btn-success" data-action="accept">Accept</button>');
      actions.push('<button class="btn btn-danger" data-action="reject">Reject</button>');
    }
    if (r.status === 'in_progress') {
      actions.push('<button class="btn" data-action="assign">Reassign executor</button>');
    }
    if (r.status === 'done') {
      actions.push('<button class="btn btn-success" data-action="close">Confirm &amp; close</button>');
      actions.push('<button class="btn" data-action="reopen">Return for rework</button>');
    }
  }
  if (role === 'executor' && r.executor_id === currentUser.id && r.status === 'in_progress') {
    actions.push('<button class="btn btn-success" data-action="done">Mark completed</button>');
  }
  if (role === 'dept_admin' && r.status === 'new') {
    actions.push('<button class="btn btn-danger" data-action="cancel">Cancel request</button>');
  }

  openModal(`
    <h3>Request #${r.id}: ${esc(r.title)}</h3>
    <dl class="detail-grid">
      <dt>Status</dt><dd>${statusBadge(r.status)}</dd>
      <dt>Priority</dt><dd>${priorityCell(r.priority)}</dd>
      <dt>Department</dt><dd>${esc(r.department_name)}</dd>
      <dt>Created by</dt><dd>${esc(r.created_by_name)}</dd>
      <dt>Supervisor</dt><dd>${esc(r.manager_name)}</dd>
      <dt>Executor</dt><dd>${esc(r.executor_name || 'not assigned')}</dd>
      <dt>Due</dt><dd>${fmtDay(r.due_date)}</dd>
      <dt>Created</dt><dd>${fmtDate(r.created_at)}</dd>
      ${r.accepted_at ? `<dt>Accepted</dt><dd>${fmtDate(r.accepted_at)}</dd>` : ''}
      ${r.done_at ? `<dt>Completed</dt><dd>${fmtDate(r.done_at)}</dd>` : ''}
      ${r.closed_at ? `<dt>Closed</dt><dd>${fmtDate(r.closed_at)}</dd>` : ''}
      ${r.reject_reason ? `<dt>Rejection reason</dt><dd>${esc(r.reject_reason)}</dd>` : ''}
      ${r.description ? `<dt>Description</dt><dd>${esc(r.description)}</dd>` : ''}
    </dl>
    <div class="history">
      <h4>History</h4>
      ${events.map((ev) => `
        <div class="history-item">
          <strong>${esc(EVENT_LABEL[ev.action] || ev.action)}</strong> — ${esc(ev.user_name)}, ${fmtDate(ev.created_at)}
          ${ev.comment ? `<div class="muted">${esc(ev.comment)}</div>` : ''}
        </div>`).join('')}
    </div>
    <div id="action-area"></div>
    <div class="modal-actions" id="req-actions">
      ${actions.join('')}
      <button type="button" class="btn" onclick="closeModal()">Close</button>
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
      toast('Done');
      loadRequests();
    } catch (err) {
      area.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    }
  };

  if (action === 'accept' || action === 'assign') {
    const { executors } = await api('/api/users/executors');
    if (!executors.length) {
      area.innerHTML = '<div class="form-error">There are no active executors in your department</div>';
      return;
    }
    area.innerHTML = `
      <label>Executor
        <select id="act-executor">
          ${executors.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}
        </select>
      </label>
      <div class="modal-actions">
        <button class="btn btn-primary" id="act-confirm">
          ${action === 'accept' ? 'Accept &amp; assign' : 'Reassign'}
        </button>
      </div>
    `;
    $('#act-confirm').addEventListener('click', () =>
      doPost(`/api/requests/${r.id}/${action}`, { executor_id: $('#act-executor').value })
    );
  } else if (action === 'reject' || action === 'reopen') {
    area.innerHTML = `
      <label>${action === 'reject' ? 'Rejection reason' : 'What needs to be reworked'}
        <textarea id="act-comment" required></textarea>
      </label>
      <div class="modal-actions">
        <button class="btn btn-danger" id="act-confirm">${action === 'reject' ? 'Reject' : 'Return for rework'}</button>
      </div>
    `;
    $('#act-confirm').addEventListener('click', () => {
      const comment = $('#act-comment').value.trim();
      if (!comment) return;
      doPost(`/api/requests/${r.id}/${action}`, action === 'reject' ? { reason: comment } : { comment });
    });
  } else if (action === 'done') {
    area.innerHTML = `
      <label>Completion note (optional)
        <textarea id="act-comment"></textarea>
      </label>
      <div class="modal-actions">
        <button class="btn btn-success" id="act-confirm">Confirm completion</button>
      </div>
    `;
    $('#act-confirm').addEventListener('click', () =>
      doPost(`/api/requests/${r.id}/done`, { comment: $('#act-comment').value })
    );
  } else if (action === 'close') {
    doPost(`/api/requests/${r.id}/close`, {});
  } else if (action === 'cancel') {
    if (confirm('Cancel request #' + r.id + '?')) doPost(`/api/requests/${r.id}/cancel`, {});
  }
}

// ---------------------------------------------------------------------------
// Reports (owner)
// ---------------------------------------------------------------------------

async function renderReports() {
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 29 * 24 * 3600 * 1000);
  const toISO = (d) => d.toISOString().slice(0, 10);

  $('#main').innerHTML = `
    <div class="page-header">
      <h2>Reports</h2>
      <div class="filters">
        <label class="small" style="margin:0">From <input type="date" id="rep-from" value="${toISO(monthAgo)}"></label>
        <label class="small" style="margin:0">To <input type="date" id="rep-to" value="${toISO(today)}"></label>
        <button id="rep-build" class="btn btn-primary">Generate</button>
        <button id="rep-csv" class="btn">Export CSV</button>
      </div>
    </div>
    <div id="report-body"><div class="empty-state">Select a period and click “Generate”</div></div>
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
        <div class="stat-card"><div class="stat-value">${totals.total || 0}</div><div class="stat-label">Total requests</div></div>
        <div class="stat-card"><div class="stat-value">${totals.new_count || 0}</div><div class="stat-label">New</div></div>
        <div class="stat-card"><div class="stat-value">${totals.in_progress_count || 0}</div><div class="stat-label">In progress</div></div>
        <div class="stat-card"><div class="stat-value">${(totals.done_count || 0) + (totals.closed_count || 0)}</div><div class="stat-label">Completed</div></div>
        <div class="stat-card"><div class="stat-value">${(totals.rejected_count || 0) + (totals.cancelled_count || 0)}</div><div class="stat-label">Rejected / cancelled</div></div>
        <div class="stat-card"><div class="stat-value">${totals.avg_completion_hours != null ? totals.avg_completion_hours + 'h' : '—'}</div><div class="stat-label">Avg. completion time</div></div>
      </div>
      <div class="card">
        <div class="card-title">By department</div>
        ${by_department.length ? `
        <table>
          <thead><tr>
            <th>Department</th><th>Total</th><th>New</th><th>In progress</th>
            <th>Completed</th><th>Closed</th><th>Rejected</th><th>Cancelled</th>
          </tr></thead>
          <tbody>
            ${by_department.map((d) => `
              <tr>
                <td>${esc(d.department_name)}</td>
                <td>${d.total}</td><td>${d.new_count}</td><td>${d.in_progress_count}</td>
                <td>${d.done_count}</td><td>${d.closed_count}</td><td>${d.rejected_count}</td><td>${d.cancelled_count}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state">No data for the selected period</div>'}
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
// Users (system administrator)
// ---------------------------------------------------------------------------

async function renderUsers() {
  const [{ users }, { departments }] = await Promise.all([
    api('/api/users'),
    api('/api/departments'),
  ]);

  $('#main').innerHTML = `
    <div class="page-header">
      <h2>Users</h2>
      <button id="btn-new-user" class="btn btn-primary">+ New user</button>
    </div>
    <div class="card">
      ${users.length ? `
      <table>
        <thead><tr>
          <th>Full name</th><th>Username</th><th>Role</th><th>Department</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          ${users.map((u) => `
            <tr>
              <td>${esc(u.full_name)}</td>
              <td>${esc(u.login)}</td>
              <td>${esc(ROLE_LABEL[u.role] || u.role)}</td>
              <td>${esc(u.department_name || '—')}</td>
              <td><span class="badge ${u.is_active ? 'badge-active' : 'badge-inactive'}">
                ${u.is_active ? 'Active' : 'Disabled'}</span></td>
              <td style="text-align:right; white-space:nowrap">
                <button class="btn btn-sm" data-action="edit" data-id="${u.id}">Edit</button>
                <button class="btn btn-sm" data-action="password" data-id="${u.id}">Reset password</button>
                ${u.id !== currentUser.id ? (u.is_active
                  ? `<button class="btn btn-sm btn-danger" data-action="deactivate" data-id="${u.id}">Disable</button>`
                  : `<button class="btn btn-sm btn-success" data-action="restore" data-id="${u.id}">Restore</button>`) : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty-state">No users</div>'}
    </div>
  `;

  $('#btn-new-user').addEventListener('click', () => openUserModal(null, departments));
  // onclick (not addEventListener) so the handler is not stacked on re-render.
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
        if (confirm(`Disable account “${user.full_name}”?`)) {
          try {
            await api(`/api/users/${id}/deactivate`, { method: 'POST', body: {} });
            toast('Account disabled');
            renderUsers();
          } catch (err) { toast(err.message); }
        }
        break;
      case 'restore':
        try {
          await api(`/api/users/${id}/restore`, { method: 'POST', body: {} });
          toast('Account restored');
          renderUsers();
        } catch (err) { toast(err.message); }
        break;
    }
  };
}

function openUserModal(user, departments) {
  const isNew = !user;
  openModal(`
    <h3>${isNew ? 'New user' : 'Edit user'}</h3>
    <form id="user-form">
      <label>Full name <input type="text" id="u-name" required value="${esc(user ? user.full_name : '')}"></label>
      <label>Username <input type="text" id="u-login" required value="${esc(user ? user.login : '')}"
        pattern="[a-zA-Z0-9._\\-]{3,32}" title="3–32 characters: letters, digits, dot, hyphen, underscore"></label>
      ${isNew ? '<label>Password <input type="password" id="u-password" required minlength="6" autocomplete="new-password"></label>' : ''}
      <label>Role
        <select id="u-role">
          ${Object.entries(ROLE_LABEL).map(([k, v]) =>
            `<option value="${k}" ${user && user.role === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
      </label>
      <label id="u-dept-label">Department
        <select id="u-dept">
          <option value="">— none —</option>
          ${departments.map((d) =>
            `<option value="${d.id}" ${user && user.department_id === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
      </label>
      <div id="u-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${isNew ? 'Create' : 'Save'}</button>
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
      toast(isNew ? 'User created' : 'Changes saved');
      renderUsers();
    } catch (err) {
      showFormError('#u-error', err.message);
    }
  });
}

function openResetPasswordModal(user) {
  openModal(`
    <h3>Reset password: ${esc(user.full_name)}</h3>
    <form id="reset-form">
      <label>New password <input type="password" id="r-password" required minlength="6" autocomplete="new-password"></label>
      <div id="r-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Set password</button>
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
      toast('Password set');
    } catch (err) {
      showFormError('#r-error', err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Departments (system administrator)
// ---------------------------------------------------------------------------

async function renderDepartments() {
  const { departments } = await api('/api/departments');

  $('#main').innerHTML = `
    <div class="page-header">
      <h2>Departments</h2>
      <button id="btn-new-dept" class="btn btn-primary">+ Add department</button>
    </div>
    <div class="card">
      ${departments.length ? `
      <table>
        <thead><tr><th>Name</th><th style="width:120px"></th></tr></thead>
        <tbody>
          ${departments.map((d) => `
            <tr>
              <td>${esc(d.name)}</td>
              <td style="text-align:right">
                <button class="btn btn-sm" data-id="${d.id}" data-name="${esc(d.name)}">Rename</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty-state">No departments yet</div>'}
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
    <h3>${isNew ? 'New department' : 'Rename department'}</h3>
    <form id="dept-form">
      <label>Name <input type="text" id="d-name" required maxlength="100" value="${esc(dept ? dept.name : '')}"></label>
      <div id="d-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
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
      toast('Saved');
      renderDepartments();
    } catch (err) {
      showFormError('#d-error', err.message);
    }
  });
}

init();
