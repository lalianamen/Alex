'use strict';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const ROLE_LABEL = {
  admin: 'System Administrator',
  owner: 'Owner',
  site_admin: 'Site Administrator',
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

// Which extra attribute a role is bound to.
const DEPT_ROLES = ['manager', 'executor'];
const SITE_ROLES = ['site_admin'];

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

// Toggle a password field between hidden and visible. Called from inline
// onclick in template strings, so it must be reachable on the global scope.
function togglePw(btn) {
  const input = btn.parentNode.querySelector('input');
  if (!input) return;
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  btn.textContent = reveal ? 'Hide' : 'Show';
}

// Password input wrapped with a Show/Hide toggle. `attrs` is extra input HTML.
function pwField(id, attrs = '') {
  return `<div class="pw-wrap">
    <input type="password" id="${id}" ${attrs}>
    <button type="button" class="pw-toggle" onclick="togglePw(this)">Show</button>
  </div>`;
}

function statusBadge(s) {
  return `<span class="badge badge-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
}

function priorityCell(p) {
  return `<span class="priority-${esc(p)}">${esc(PRIORITY_LABEL[p] || p)}</span>`;
}

// options for a <select>, active items only, but always keeping `selectedId`.
function optionList(items, selectedId) {
  return items
    .filter((i) => i.is_active || i.id === selectedId)
    .map((i) => `<option value="${i.id}" ${i.id === selectedId ? 'selected' : ''}>${esc(i.name)}${i.is_active ? '' : ' (inactive)'}</option>`)
    .join('');
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
      <label>Current password ${pwField('pw-old', 'required autocomplete="current-password"')}</label>
      <label>New password ${pwField('pw-new', 'required minlength="6" autocomplete="new-password"')}</label>
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
    { id: 'sites', title: 'Sites' },
  ],
  owner: [
    { id: 'requests', title: 'Requests' },
    { id: 'reports', title: 'Reports' },
  ],
  site_admin: [{ id: 'requests', title: 'Requests' }],
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
  const render = {
    requests: renderRequests,
    reports: renderReports,
    users: renderUsers,
    departments: () => renderNamedList('departments'),
    sites: () => renderNamedList('sites'),
  }[id];
  if (render) render();
  else $('#main').innerHTML = '<div class="empty-state">No sections available</div>';
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// Which optional columns each role sees in the request list.
function requestColumns(role) {
  return {
    site: role === 'owner' || role === 'manager',
    department: role !== 'manager',
    supervisor: role === 'owner' || role === 'site_admin',
    executor: role === 'owner' || role === 'manager' || role === 'site_admin',
  };
}

async function renderRequests() {
  const main = $('#main');
  const role = currentUser.role;
  const isOwner = role === 'owner';

  let departments = [];
  let sites = [];
  if (isOwner) {
    [departments, sites] = await Promise.all([
      api('/api/departments').then((r) => r.departments),
      api('/api/sites').then((r) => r.sites),
    ]);
  }

  main.innerHTML = `
    <div class="page-header">
      <h2>${role === 'executor' ? 'My Work' : 'Requests'}</h2>
      <div class="filters">
        ${isOwner ? `
          <select id="flt-site">
            <option value="">All sites</option>
            ${sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
          </select>
          <select id="flt-dept">
            <option value="">All departments</option>
            ${departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
          </select>` : ''}
        <select id="flt-status">
          <option value="">All statuses</option>
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
        </select>
        ${role === 'site_admin' ? '<button id="btn-new-request" class="btn btn-primary">+ New request</button>' : ''}
      </div>
    </div>
    <div class="card"><div id="requests-table"></div></div>
  `;

  $('#flt-status').addEventListener('change', loadRequests);
  if (isOwner) {
    $('#flt-dept').addEventListener('change', loadRequests);
    $('#flt-site').addEventListener('change', loadRequests);
  }
  if (role === 'site_admin') $('#btn-new-request').addEventListener('click', openNewRequestModal);

  await loadRequests();
}

async function loadRequests() {
  const params = new URLSearchParams();
  const val = (sel) => ($(sel) ? $(sel).value : '');
  if (val('#flt-status')) params.set('status', val('#flt-status'));
  if (val('#flt-dept')) params.set('department_id', val('#flt-dept'));
  if (val('#flt-site')) params.set('site_id', val('#flt-site'));

  const { requests } = await api('/api/requests?' + params.toString());
  const cols = requestColumns(currentUser.role);

  const box = $('#requests-table');
  if (!requests.length) {
    box.innerHTML = '<div class="empty-state">No requests</div>';
    return;
  }

  const head = ['<th>#</th>', '<th>Subject</th>'];
  if (cols.site) head.push('<th>Site</th>');
  if (cols.department) head.push('<th>Department</th>');
  head.push('<th>Status</th>', '<th>Priority</th>');
  if (cols.supervisor) head.push('<th>Supervisor</th>');
  if (cols.executor) head.push('<th>Executor</th>');
  head.push('<th>Due</th>', '<th>Created</th>');

  box.innerHTML = `
    <table>
      <thead><tr>${head.join('')}</tr></thead>
      <tbody>
        ${requests.map((r) => {
          const cells = [`<td>${r.id}</td>`, `<td>${esc(r.title)}</td>`];
          if (cols.site) cells.push(`<td>${esc(r.site_name || '—')}</td>`);
          if (cols.department) cells.push(`<td>${esc(r.department_name)}</td>`);
          cells.push(`<td>${statusBadge(r.status)}</td>`, `<td>${priorityCell(r.priority)}</td>`);
          if (cols.supervisor) cells.push(`<td>${esc(r.manager_name || '—')}</td>`);
          if (cols.executor) cells.push(`<td>${esc(r.executor_name || '—')}</td>`);
          cells.push(`<td>${fmtDay(r.due_date)}</td>`, `<td>${fmtDate(r.created_at)}</td>`);
          return `<tr class="clickable" data-id="${r.id}">${cells.join('')}</tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  box.querySelectorAll('tr.clickable').forEach((tr) => {
    tr.addEventListener('click', () => openRequestModal(tr.dataset.id));
  });
}

async function openNewRequestModal() {
  const departments = (await api('/api/departments')).departments.filter((d) => d.is_active);
  if (!departments.length) {
    toast('No active departments to send a request to');
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
      <label>Department
        <select id="req-dept">
          ${departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
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
          department_id: $('#req-dept').value,
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
  if (role === 'manager') {
    if (r.status === 'new') {
      actions.push('<button class="btn btn-success" data-action="accept">Accept</button>');
      actions.push('<button class="btn btn-danger" data-action="reject">Reject</button>');
    }
    if (r.status === 'in_progress' && r.manager_id === currentUser.id) {
      actions.push('<button class="btn" data-action="assign">Reassign executor</button>');
    }
    if (r.status === 'done' && r.manager_id === currentUser.id) {
      actions.push('<button class="btn btn-success" data-action="close">Confirm &amp; close</button>');
      actions.push('<button class="btn" data-action="reopen">Return for rework</button>');
    }
  }
  if (role === 'executor' && r.executor_id === currentUser.id && r.status === 'in_progress') {
    actions.push('<button class="btn btn-success" data-action="done">Mark completed</button>');
  }
  if (role === 'site_admin' && r.status === 'new') {
    actions.push('<button class="btn btn-danger" data-action="cancel">Cancel request</button>');
  }

  openModal(`
    <h3>Request #${r.id}: ${esc(r.title)}</h3>
    <dl class="detail-grid">
      <dt>Status</dt><dd>${statusBadge(r.status)}</dd>
      <dt>Priority</dt><dd>${priorityCell(r.priority)}</dd>
      <dt>Site</dt><dd>${esc(r.site_name || '—')}</dd>
      <dt>Department</dt><dd>${esc(r.department_name)}</dd>
      <dt>Created by</dt><dd>${esc(r.created_by_name)}</dd>
      <dt>Supervisor</dt><dd>${esc(r.manager_name || 'not accepted yet')}</dd>
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

  const breakdownTable = (title, rows, labelKey, labelHead) => `
    <div class="card">
      <div class="card-title">${title}</div>
      ${rows.length ? `
      <table>
        <thead><tr>
          <th>${labelHead}</th><th>Total</th><th>New</th><th>In progress</th>
          <th>Completed</th><th>Closed</th><th>Rejected</th><th>Cancelled</th>
        </tr></thead>
        <tbody>
          ${rows.map((d) => `
            <tr>
              <td>${esc(d[labelKey] || '—')}</td>
              <td>${d.total}</td><td>${d.new_count}</td><td>${d.in_progress_count}</td>
              <td>${d.done_count}</td><td>${d.closed_count}</td><td>${d.rejected_count}</td><td>${d.cancelled_count}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty-state">No data for the selected period</div>'}
    </div>
  `;

  const build = async () => {
    const params = new URLSearchParams();
    if ($('#rep-from').value) params.set('from', $('#rep-from').value);
    if ($('#rep-to').value) params.set('to', $('#rep-to').value);
    const { totals, by_department, by_site } = await api('/api/reports/summary?' + params.toString());

    $('#report-body').innerHTML = `
      <div class="stats-row">
        <div class="stat-card"><div class="stat-value">${totals.total || 0}</div><div class="stat-label">Total requests</div></div>
        <div class="stat-card"><div class="stat-value">${totals.new_count || 0}</div><div class="stat-label">New</div></div>
        <div class="stat-card"><div class="stat-value">${totals.in_progress_count || 0}</div><div class="stat-label">In progress</div></div>
        <div class="stat-card"><div class="stat-value">${(totals.done_count || 0) + (totals.closed_count || 0)}</div><div class="stat-label">Completed</div></div>
        <div class="stat-card"><div class="stat-value">${(totals.rejected_count || 0) + (totals.cancelled_count || 0)}</div><div class="stat-label">Rejected / cancelled</div></div>
        <div class="stat-card"><div class="stat-value">${totals.avg_completion_hours != null ? totals.avg_completion_hours + 'h' : '—'}</div><div class="stat-label">Avg. completion time</div></div>
      </div>
      ${breakdownTable('By department', by_department, 'department_name', 'Department')}
      ${breakdownTable('By site', by_site, 'site_name', 'Site')}
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
  const [{ users }, { departments }, { sites }] = await Promise.all([
    api('/api/users'),
    api('/api/departments'),
    api('/api/sites'),
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
          <th>Full name</th><th>Username</th><th>Role</th><th>Department / Site</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          ${users.map((u) => `
            <tr>
              <td>${esc(u.full_name)}</td>
              <td>${esc(u.login)}</td>
              <td>${esc(ROLE_LABEL[u.role] || u.role)}</td>
              <td>${esc(u.department_name || u.site_name || '—')}</td>
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

  $('#btn-new-user').addEventListener('click', () => openUserModal(null, departments, sites));
  $('#main').onclick = async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const user = users.find((u) => u.id === id);
    switch (btn.dataset.action) {
      case 'edit':
        openUserModal(user, departments, sites);
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

function openUserModal(user, departments, sites) {
  const isNew = !user;
  openModal(`
    <h3>${isNew ? 'New user' : 'Edit user'}</h3>
    <form id="user-form">
      <label>Full name <input type="text" id="u-name" required value="${esc(user ? user.full_name : '')}"></label>
      <label>Username <input type="text" id="u-login" required value="${esc(user ? user.login : '')}"
        pattern="[a-zA-Z0-9._\\-]{3,32}" title="3–32 characters: letters, digits, dot, hyphen, underscore"></label>
      ${isNew ? `<label>Password ${pwField('u-password', 'required minlength="6" autocomplete="new-password"')}</label>` : ''}
      <label>Role
        <select id="u-role">
          ${Object.entries(ROLE_LABEL).map(([k, v]) =>
            `<option value="${k}" ${user && user.role === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
      </label>
      <label id="u-dept-label">Department
        <select id="u-dept">${optionList(departments, user ? user.department_id : null)}</select>
        <div id="u-dept-hint" class="field-hint hidden">No departments yet — add one on the Departments tab first.</div>
      </label>
      <label id="u-site-label">Site
        <select id="u-site">${optionList(sites, user ? user.site_id : null)}</select>
        <div id="u-site-hint" class="field-hint hidden">No sites yet — add one on the Sites tab first.</div>
      </label>
      <div id="u-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" id="u-submit" class="btn btn-primary">${isNew ? 'Create' : 'Save'}</button>
      </div>
    </form>
  `);

  const hasActiveDept = departments.some((d) => d.is_active) || (user && user.department_id);
  const hasActiveSite = sites.some((s) => s.is_active) || (user && user.site_id);
  const roleSelect = $('#u-role');
  const syncFields = () => {
    const needDept = DEPT_ROLES.includes(roleSelect.value);
    const needSite = SITE_ROLES.includes(roleSelect.value);
    $('#u-dept-label').style.display = needDept ? '' : 'none';
    $('#u-site-label').style.display = needSite ? '' : 'none';
    const deptMissing = needDept && !hasActiveDept;
    const siteMissing = needSite && !hasActiveSite;
    $('#u-dept-hint').classList.toggle('hidden', !deptMissing);
    $('#u-site-hint').classList.toggle('hidden', !siteMissing);
    $('#u-dept').style.display = deptMissing ? 'none' : '';
    $('#u-site').style.display = siteMissing ? 'none' : '';
    $('#u-submit').disabled = deptMissing || siteMissing;
  };
  roleSelect.addEventListener('change', syncFields);
  syncFields();

  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = $('#u-role').value;
    const body = {
      full_name: $('#u-name').value,
      login: $('#u-login').value,
      role,
      department_id: DEPT_ROLES.includes(role) ? $('#u-dept').value || null : null,
      site_id: SITE_ROLES.includes(role) ? $('#u-site').value || null : null,
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
      <label>New password ${pwField('r-password', 'required minlength="6" autocomplete="new-password"')}</label>
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
// Departments and Sites (system administrator) — add, rename, deactivate/restore
// ---------------------------------------------------------------------------

const NAMED_LIST_META = {
  departments: { title: 'Departments', singular: 'department', addLabel: '+ Add department' },
  sites: { title: 'Sites', singular: 'site', addLabel: '+ Add site' },
};

async function renderNamedList(kind) {
  const meta = NAMED_LIST_META[kind];
  const items = (await api(`/api/${kind}`))[kind];

  $('#main').innerHTML = `
    <div class="page-header">
      <h2>${meta.title}</h2>
      <button id="btn-new" class="btn btn-primary">${meta.addLabel}</button>
    </div>
    <div class="card">
      ${items.length ? `
      <table>
        <thead><tr><th>Name</th><th>Status</th><th style="width:220px"></th></tr></thead>
        <tbody>
          ${items.map((it) => `
            <tr>
              <td>${esc(it.name)}</td>
              <td><span class="badge ${it.is_active ? 'badge-active' : 'badge-inactive'}">
                ${it.is_active ? 'Active' : 'Inactive'}</span></td>
              <td style="text-align:right; white-space:nowrap">
                <button class="btn btn-sm" data-action="rename" data-id="${it.id}" data-name="${esc(it.name)}">Rename</button>
                ${it.is_active
                  ? `<button class="btn btn-sm btn-danger" data-action="deactivate" data-id="${it.id}">Deactivate</button>`
                  : `<button class="btn btn-sm btn-success" data-action="restore" data-id="${it.id}">Restore</button>`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty-state">No ${meta.title.toLowerCase()} yet</div>`}
    </div>
  `;

  $('#btn-new').addEventListener('click', () => openNamedModal(kind, null));
  $('#main').onclick = async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const action = btn.dataset.action;
    if (action === 'rename') {
      openNamedModal(kind, { id, name: btn.dataset.name });
    } else {
      try {
        await api(`/api/${kind}/${id}/${action}`, { method: 'POST', body: {} });
        toast('Saved');
        renderNamedList(kind);
      } catch (err) { toast(err.message); }
    }
  };
}

function openNamedModal(kind, item) {
  const meta = NAMED_LIST_META[kind];
  const isNew = !item;
  openModal(`
    <h3>${isNew ? `New ${meta.singular}` : `Rename ${meta.singular}`}</h3>
    <form id="named-form">
      <label>Name <input type="text" id="n-name" required maxlength="120" value="${esc(item ? item.name : '')}"></label>
      <div id="n-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `);
  $('#named-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(isNew ? `/api/${kind}` : `/api/${kind}/${item.id}`, {
        method: isNew ? 'POST' : 'PUT',
        body: { name: $('#n-name').value },
      });
      closeModal();
      toast('Saved');
      renderNamedList(kind);
    } catch (err) {
      showFormError('#n-error', err.message);
    }
  });
}

init();
