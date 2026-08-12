'use strict';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const ROLE_LABEL = {
  admin: 'System Administrator',
  owner: 'Owner',
  employee: 'Employee',
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
  accepted: 'Accepted',
  reassigned: 'Reassigned',
  rejected: 'Rejected',
  done: 'Marked completed',
  reopened: 'Returned for rework',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const PERM_LABEL = {
  perm_create: 'Create requests',
  perm_view_site: 'View all division requests',
  perm_cancel: 'Cancel requests',
  perm_reports: 'View division reports',
  perm_accept: 'Accept & assign requests',
  perm_execute: 'Perform assigned work',
};

let currentUser = null;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  try { data = await res.json(); } catch (_) { /* empty */ }
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
$('#modal-backdrop').addEventListener('click', (e) => { if (e.target === $('#modal-backdrop')) closeModal(); });

function showFormError(sel, msg) {
  const el = $(sel);
  if (!el) return alert(msg);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function togglePw(btn) {
  const input = btn.parentNode.querySelector('input');
  if (!input) return;
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  btn.textContent = reveal ? 'Hide' : 'Show';
}
function pwField(id, attrs = '') {
  return `<div class="pw-wrap">
    <input type="password" id="${id}" ${attrs}>
    <button type="button" class="pw-toggle" onclick="togglePw(this)">Show</button>
  </div>`;
}

function statusBadge(s) { return `<span class="badge badge-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`; }
function priorityCell(p) { return `<span class="priority-${esc(p)}">${esc(PRIORITY_LABEL[p] || p)}</span>`; }

// options for a <select>, active items only, but always keeping `selectedId`.
function optionList(items, selectedId, label = (i) => i.name) {
  return items
    .filter((i) => i.is_active || i.id === selectedId)
    .map((i) => `<option value="${i.id}" ${i.id === selectedId ? 'selected' : ''}>${esc(label(i))}${i.is_active === false ? ' (inactive)' : ''}</option>`)
    .join('');
}

const divisionLabel = (d) => (d.company_name ? `${d.company_name} — ${d.name}` : d.name);
function positionOptionList(items, selectedId) {
  return items
    .filter((p) => p.is_active || p.id === selectedId)
    .map((p) => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.site_name)} — ${esc(p.title)}${p.is_active ? '' : ' (inactive)'}</option>`)
    .join('');
}
function permSummary(p) {
  const on = Object.keys(PERM_LABEL).filter((k) => p[k]).map((k) => PERM_LABEL[k]);
  return on.length ? on.join(', ') : 'No permissions';
}

// ---------------------------------------------------------------------------
// Sign in / first-password setup
// ---------------------------------------------------------------------------

async function init() {
  try {
    const { user } = await api('/api/me');
    currentUser = user;
    routeAfterAuth();
  } catch (_) {
    showLogin();
  }
}

function routeAfterAuth() {
  if (currentUser.must_set_password) showSetPassword();
  else showApp();
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#setpw-screen').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-input').focus();
}

function showSetPassword() {
  $('#app').classList.add('hidden');
  $('#login-screen').classList.add('hidden');
  $('#setpw-name').textContent = currentUser.full_name;
  $('#setpw-error').classList.add('hidden');
  $('#setpw-new').value = '';
  $('#setpw-confirm').value = '';
  $('#setpw-screen').classList.remove('hidden');
  $('#setpw-new').focus();
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
    routeAfterAuth();
  } catch (err) {
    showFormError('#login-error', err.message);
  }
});

$('#setpw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#setpw-error').classList.add('hidden');
  const btn = $('#setpw-form button[type="submit"]');
  const pw = $('#setpw-new').value;
  if (pw.length < 6) return showFormError('#setpw-error', 'Password must be at least 6 characters');
  if (pw !== $('#setpw-confirm').value) return showFormError('#setpw-error', 'The passwords do not match');
  btn.disabled = true;
  try {
    await api('/api/me/set-password', { method: 'POST', body: { new_password: pw } });
    currentUser.must_set_password = false;
    showApp();
    toast('Password set');
  } catch (err) {
    if (/already set/i.test(err.message)) {
      try { currentUser = (await api('/api/me')).user; } catch (_) {}
      return showApp();
    }
    btn.disabled = false;
    showFormError('#setpw-error', err.message);
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  showLogin();
});

// Escape hatch from the first-password screen: sign out and return to login.
$('#setpw-cancel').addEventListener('click', async () => {
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
      await api('/api/me/password', { method: 'POST', body: { old_password: $('#pw-old').value, new_password: $('#pw-new').value } });
      closeModal();
      toast('Password changed');
    } catch (err) { showFormError('#pw-error', err.message); }
  });
});

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

function tabsForUser() {
  if (currentUser.role === 'admin') {
    return [
      { id: 'companies', title: 'Companies' },
      { id: 'divisions', title: 'Divisions' },
      { id: 'positions', title: 'Positions' },
      { id: 'employees', title: 'Employees' },
    ];
  }
  if (currentUser.role === 'owner') {
    return [{ id: 'requests', title: 'Requests' }, { id: 'reports', title: 'Reports' }];
  }
  // employee
  const tabs = [{ id: 'requests', title: 'Requests' }];
  if (currentUser.perm_reports) tabs.push({ id: 'reports', title: 'Reports' });
  return tabs;
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#setpw-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = currentUser.full_name;
  $('#user-role').textContent = currentUser.position_title || ROLE_LABEL[currentUser.role] || currentUser.role;

  const tabs = tabsForUser();
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
  document.querySelectorAll('#nav-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  $('#main').onclick = null;
  const render = {
    requests: renderRequests,
    reports: renderReports,
    employees: renderEmployees,
    positions: renderPositions,
    divisions: renderDivisions,
    companies: renderCompanies,
  }[id];
  if (render) render();
  else $('#main').innerHTML = '<div class="empty-state">No sections available</div>';
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

async function renderRequests() {
  const main = $('#main');
  const isOwner = currentUser.role === 'owner';
  let divisions = [];
  if (isOwner) divisions = (await api('/api/sites')).sites;

  main.innerHTML = `
    <div class="page-header">
      <h2>Requests</h2>
      <div class="filters">
        ${isOwner ? `<select id="flt-div"><option value="">All divisions (to)</option>
          ${divisions.map((d) => `<option value="${d.id}">${esc(divisionLabel(d))}</option>`).join('')}</select>` : ''}
        <select id="flt-status">
          <option value="">All statuses</option>
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
        </select>
        ${currentUser.role === 'employee' && currentUser.perm_create ? '<button id="btn-new-request" class="btn btn-primary">+ New request</button>' : ''}
      </div>
    </div>
    <div class="card"><div id="requests-table"></div></div>
  `;

  $('#flt-status').addEventListener('change', loadRequests);
  if (isOwner) $('#flt-div').addEventListener('change', loadRequests);
  if (currentUser.role === 'employee' && currentUser.perm_create) $('#btn-new-request').addEventListener('click', openNewRequestModal);
  await loadRequests();
}

async function loadRequests() {
  const params = new URLSearchParams();
  const val = (s) => ($(s) ? $(s).value : '');
  if (val('#flt-status')) params.set('status', val('#flt-status'));
  if (val('#flt-div')) params.set('target_site_id', val('#flt-div'));

  const { requests } = await api('/api/requests?' + params.toString());
  const box = $('#requests-table');
  if (!requests.length) { box.innerHTML = '<div class="empty-state">No requests</div>'; return; }

  box.innerHTML = `
    <table>
      <thead><tr>
        <th>#</th><th>Subject</th><th>From</th><th>To</th><th>Status</th><th>Priority</th>
        <th>Created by</th><th>Performer</th><th>Due</th><th>Created</th>
      </tr></thead>
      <tbody>
        ${requests.map((r) => `
          <tr class="clickable" data-id="${r.id}">
            <td>${r.id}</td>
            <td>${esc(r.title)}</td>
            <td>${esc(r.site_name || '—')}</td>
            <td>${esc(r.target_site_name || '—')}</td>
            <td>${statusBadge(r.status)}</td>
            <td>${priorityCell(r.priority)}</td>
            <td>${esc(r.created_by_name || '—')}</td>
            <td>${esc(r.executor_name || '—')}</td>
            <td>${fmtDay(r.due_date)}</td>
            <td>${fmtDate(r.created_at)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
  box.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openRequestModal(tr.dataset.id)));
}

async function openNewRequestModal() {
  const divisions = (await api('/api/target-divisions')).divisions;
  if (!divisions.length) { toast('No active divisions to send a request to'); return; }
  openModal(`
    <h3>New request</h3>
    <form id="req-form">
      <label>Subject <input type="text" id="req-title" required maxlength="200"></label>
      <label>Description <textarea id="req-desc" maxlength="4000"></textarea></label>
      <label>Priority
        <select id="req-priority"><option value="low">Low</option><option value="normal" selected>Normal</option><option value="high">High</option></select>
      </label>
      <label>Send to division
        <select id="req-div">${divisions.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>
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
          target_site_id: $('#req-div').value,
          due_date: $('#req-due').value || null,
        },
      });
      closeModal();
      toast('Request created');
      loadRequests();
    } catch (err) { showFormError('#req-error', err.message); }
  });
}

async function openRequestModal(id) {
  const { request: r, events } = await api('/api/requests/' + id);
  const u = currentUser;
  const isEmp = u.role === 'employee';
  const isTargetDiv = r.target_site_id === u.site_id;
  const isOriginDiv = r.site_id === u.site_id;

  const actions = [];
  if (isEmp && u.perm_accept && isTargetDiv) {
    if (r.status === 'new') {
      actions.push('<button class="btn btn-success" data-action="accept">Accept</button>');
      actions.push('<button class="btn btn-danger" data-action="reject">Reject</button>');
    }
    if (r.status === 'in_progress' && r.manager_id === u.id) actions.push('<button class="btn" data-action="assign">Reassign</button>');
    if (r.status === 'done' && r.manager_id === u.id) {
      actions.push('<button class="btn btn-success" data-action="close">Confirm &amp; close</button>');
      actions.push('<button class="btn" data-action="reopen">Return for rework</button>');
    }
  }
  if (isEmp && u.perm_execute && r.executor_id === u.id && r.status === 'in_progress') {
    actions.push('<button class="btn btn-success" data-action="done">Mark completed</button>');
  }
  if (isEmp && u.perm_cancel && isOriginDiv && r.status === 'new') {
    actions.push('<button class="btn btn-danger" data-action="cancel">Cancel request</button>');
  }

  openModal(`
    <h3>Request #${r.id}: ${esc(r.title)}</h3>
    <dl class="detail-grid">
      <dt>Status</dt><dd>${statusBadge(r.status)}</dd>
      <dt>Priority</dt><dd>${priorityCell(r.priority)}</dd>
      <dt>From division</dt><dd>${esc(r.site_name || '—')}</dd>
      <dt>To division</dt><dd>${esc(r.target_site_name || '—')}</dd>
      <dt>Created by</dt><dd>${esc(r.created_by_name || '—')}${r.position_title ? ` <span class="muted">(${esc(r.position_title)})</span>` : ''}</dd>
      <dt>Accepted by</dt><dd>${esc(r.manager_name || 'not accepted yet')}</dd>
      <dt>Performer</dt><dd>${esc(r.executor_name || 'not assigned')}</dd>
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
          <strong>${esc(EVENT_LABEL[ev.action] || ev.action)}</strong> — ${esc(ev.user_name || '—')}, ${fmtDate(ev.created_at)}
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
    } catch (err) { area.innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
  };

  if (action === 'accept' || action === 'assign') {
    const { executors } = await api('/api/users/executors');
    if (!executors.length) { area.innerHTML = '<div class="form-error">No one in this division can perform work yet</div>'; return; }
    area.innerHTML = `
      <label>Assign to
        <select id="act-executor">${executors.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select>
      </label>
      <div class="modal-actions"><button class="btn btn-primary" id="act-confirm">${action === 'accept' ? 'Accept &amp; assign' : 'Reassign'}</button></div>
    `;
    $('#act-confirm').addEventListener('click', () => doPost(`/api/requests/${r.id}/${action}`, { executor_id: $('#act-executor').value }));
  } else if (action === 'reject' || action === 'reopen') {
    area.innerHTML = `
      <label>${action === 'reject' ? 'Rejection reason' : 'What needs to be reworked'}<textarea id="act-comment" required></textarea></label>
      <div class="modal-actions"><button class="btn btn-danger" id="act-confirm">${action === 'reject' ? 'Reject' : 'Return for rework'}</button></div>
    `;
    $('#act-confirm').addEventListener('click', () => {
      const comment = $('#act-comment').value.trim();
      if (!comment) return;
      doPost(`/api/requests/${r.id}/${action}`, action === 'reject' ? { reason: comment } : { comment });
    });
  } else if (action === 'done') {
    area.innerHTML = `
      <label>Completion note (optional)<textarea id="act-comment"></textarea></label>
      <div class="modal-actions"><button class="btn btn-success" id="act-confirm">Confirm completion</button></div>
    `;
    $('#act-confirm').addEventListener('click', () => doPost(`/api/requests/${r.id}/done`, { comment: $('#act-comment').value }));
  } else if (action === 'close') {
    doPost(`/api/requests/${r.id}/close`, {});
  } else if (action === 'cancel') {
    if (confirm('Cancel request #' + r.id + '?')) doPost(`/api/requests/${r.id}/cancel`, {});
  }
}

// ---------------------------------------------------------------------------
// Reports
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

  const breakdown = (title, rows) => `
    <div class="card">
      <div class="card-title">${title}</div>
      ${rows.length ? `<table>
        <thead><tr><th>Division</th><th>Total</th><th>New</th><th>In progress</th><th>Completed</th><th>Closed</th><th>Rejected</th><th>Cancelled</th></tr></thead>
        <tbody>${rows.map((d) => `<tr>
          <td>${esc(d.site_name || '—')}</td>
          <td>${d.total}</td><td>${d.new_count}</td><td>${d.in_progress_count}</td>
          <td>${d.done_count}</td><td>${d.closed_count}</td><td>${d.rejected_count}</td><td>${d.cancelled_count}</td>
        </tr>`).join('')}</tbody>
      </table>` : '<div class="empty-state">No data for the selected period</div>'}
    </div>
  `;

  const build = async () => {
    const params = new URLSearchParams();
    if ($('#rep-from').value) params.set('from', $('#rep-from').value);
    if ($('#rep-to').value) params.set('to', $('#rep-to').value);
    const { totals, by_origin, by_target } = await api('/api/reports/summary?' + params.toString());
    $('#report-body').innerHTML = `
      <div class="stats-row">
        <div class="stat-card"><div class="stat-value">${totals.total || 0}</div><div class="stat-label">Total requests</div></div>
        <div class="stat-card"><div class="stat-value">${totals.new_count || 0}</div><div class="stat-label">New</div></div>
        <div class="stat-card"><div class="stat-value">${totals.in_progress_count || 0}</div><div class="stat-label">In progress</div></div>
        <div class="stat-card"><div class="stat-value">${(totals.done_count || 0) + (totals.closed_count || 0)}</div><div class="stat-label">Completed</div></div>
        <div class="stat-card"><div class="stat-value">${(totals.rejected_count || 0) + (totals.cancelled_count || 0)}</div><div class="stat-label">Rejected / cancelled</div></div>
        <div class="stat-card"><div class="stat-value">${totals.avg_completion_hours != null ? totals.avg_completion_hours + 'h' : '—'}</div><div class="stat-label">Avg. completion time</div></div>
      </div>
      ${breakdown('By division that sent the request', by_origin)}
      ${breakdown('By division that received the request', by_target)}
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
// Employees (users)
// ---------------------------------------------------------------------------

function userAttachment(u) {
  if (u.position_title) {
    const div = u.site_name ? ` — ${u.site_name}` : '';
    const co = u.company_name ? ` (${u.company_name})` : '';
    return `${u.position_title}${div}${co}`;
  }
  return '—';
}

async function renderEmployees() {
  const [{ users }, { positions }] = await Promise.all([api('/api/users'), api('/api/positions')]);

  $('#main').innerHTML = `
    <div class="page-header">
      <h2>Employees</h2>
      <button id="btn-new-user" class="btn btn-primary">+ New employee</button>
    </div>
    <div class="card">
      ${users.length ? `<table>
        <thead><tr><th>Full name</th><th>Username</th><th>Role</th><th>Position — Division (Company)</th><th>Supervisor</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr>
            <td>${esc(u.full_name)}</td>
            <td>${esc(u.login)}</td>
            <td>${esc(ROLE_LABEL[u.role] || u.role)}</td>
            <td>${esc(userAttachment(u))}</td>
            <td>${esc(u.supervisor_name || '—')}</td>
            <td><span class="badge ${u.is_active ? 'badge-active' : 'badge-inactive'}">${u.is_active ? 'Active' : 'Disabled'}</span></td>
            <td style="text-align:right; white-space:nowrap">
              <button class="btn btn-sm" data-action="edit" data-id="${u.id}">Edit</button>
              <button class="btn btn-sm" data-action="password" data-id="${u.id}">Reset password</button>
              ${u.id !== currentUser.id && !u.is_super ? (u.is_active
                ? `<button class="btn btn-sm btn-danger" data-action="deactivate" data-id="${u.id}">Disable</button>`
                : `<button class="btn btn-sm btn-success" data-action="restore" data-id="${u.id}">Restore</button>`) : ''}
              ${u.id !== currentUser.id && !u.is_super ? `<button class="btn btn-sm btn-danger" data-action="delete" data-id="${u.id}">Delete</button>` : ''}
            </td>
          </tr>`).join('')}</tbody>
      </table>` : '<div class="empty-state">No employees</div>'}
    </div>
  `;

  $('#btn-new-user').addEventListener('click', () => openUserModal(null, positions, users));
  $('#main').onclick = async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const user = users.find((u) => u.id === id);
    const act = btn.dataset.action;
    if (act === 'edit') return openUserModal(user, positions, users);
    if (act === 'password') return openResetPasswordModal(user);
    const confirmMsg = {
      deactivate: `Disable account “${user.full_name}”?`,
      delete: `Delete “${user.full_name}” permanently? Request history is kept.`,
    }[act];
    if (confirmMsg && !confirm(confirmMsg)) return;
    try {
      if (act === 'delete') await api(`/api/users/${id}`, { method: 'DELETE' });
      else await api(`/api/users/${id}/${act}`, { method: 'POST', body: {} });
      toast('Saved');
      renderEmployees();
    } catch (err) { toast(err.message); }
  };
}

function openUserModal(user, positions, allUsers) {
  const isNew = !user;
  // Prefill first/last name from stored fields, or split legacy full_name.
  let first = user ? user.first_name || '' : '';
  let last = user ? user.last_name || '' : '';
  if (user && !first && !last && user.full_name) {
    const parts = user.full_name.split(' ');
    first = parts.shift() || '';
    last = parts.join(' ');
  }
  const supervisors = (allUsers || []).filter((x) => !user || x.id !== user.id);
  openModal(`
    <h3>${isNew ? 'New employee' : 'Edit employee'}</h3>
    <form id="user-form">
      <div class="two-col">
        <label>First name <input type="text" id="u-first" required value="${esc(first)}"></label>
        <label>Last name <input type="text" id="u-last" required value="${esc(last)}"></label>
      </div>
      <label>Username <input type="text" id="u-login" required value="${esc(user ? user.login : '')}"
        pattern="[a-zA-Z0-9._\\-]{3,32}" title="3–32 characters: letters, digits, dot, hyphen, underscore"></label>
      <div class="two-col">
        <label>Phone <input type="text" id="u-phone" maxlength="40" value="${esc(user ? user.phone || '' : '')}"></label>
        <label>Address <input type="text" id="u-address" maxlength="200" value="${esc(user ? user.address || '' : '')}"></label>
      </div>
      ${isNew ? `<label>Password ${pwField('u-password', 'minlength="6" autocomplete="new-password"')}
        <div class="muted small" style="margin-top:5px">Leave blank — the user sets it at first sign-in.</div></label>` : ''}
      <label>Supervisor
        <select id="u-sup"><option value="">— none —</option>
          ${supervisors.map((s) => `<option value="${s.id}" ${user && user.supervisor_id === s.id ? 'selected' : ''}>${esc(s.full_name)}</option>`).join('')}
        </select>
      </label>
      <label>Role
        <select id="u-role">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${user && user.role === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      </label>
      <label id="u-pos-label">Position
        <select id="u-pos">${positionOptionList(positions, user ? user.position_id : null)}</select>
        <div id="u-pos-hint" class="field-hint hidden">No positions yet — add one on the Positions tab first.</div>
      </label>
      <div id="u-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" id="u-submit" class="btn btn-primary">${isNew ? 'Create' : 'Save'}</button>
      </div>
    </form>
  `);
  const hasActivePos = positions.some((p) => p.is_active) || (user && user.position_id);
  const roleSelect = $('#u-role');
  const sync = () => {
    const needPos = roleSelect.value === 'employee';
    $('#u-pos-label').style.display = needPos ? '' : 'none';
    const missing = needPos && !hasActivePos;
    $('#u-pos-hint').classList.toggle('hidden', !missing);
    $('#u-pos').style.display = missing ? 'none' : '';
    $('#u-submit').disabled = missing;
  };
  roleSelect.addEventListener('change', sync);
  sync();

  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = $('#u-role').value;
    const body = {
      first_name: $('#u-first').value,
      last_name: $('#u-last').value,
      login: $('#u-login').value,
      phone: $('#u-phone').value,
      address: $('#u-address').value,
      supervisor_id: $('#u-sup').value || null,
      role,
      position_id: role === 'employee' ? $('#u-pos').value || null : null,
    };
    if (isNew) body.password = $('#u-password').value;
    try {
      await api(isNew ? '/api/users' : `/api/users/${user.id}`, { method: isNew ? 'POST' : 'PUT', body });
      closeModal();
      toast(isNew ? 'Employee created' : 'Changes saved');
      renderEmployees();
    } catch (err) { showFormError('#u-error', err.message); }
  });
}

function openResetPasswordModal(user) {
  openModal(`
    <h3>Reset password: ${esc(user.full_name)}</h3>
    <p class="muted">Leave blank to have the user choose a new password at their next sign-in, or type one to set it directly.</p>
    <form id="reset-form">
      <label>New password ${pwField('r-password', 'minlength="6" autocomplete="new-password"')}</label>
      <div id="r-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Reset password</button>
      </div>
    </form>
  `);
  $('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/users/${user.id}/password`, { method: 'POST', body: { password: $('#r-password').value } });
      closeModal();
      toast($('#r-password').value ? 'Password set' : 'The user will set a password at next sign-in');
    } catch (err) { showFormError('#r-error', err.message); }
  });
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

async function renderPositions() {
  const [{ positions }, { sites }] = await Promise.all([api('/api/positions'), api('/api/sites')]);
  $('#main').innerHTML = `
    <div class="page-header">
      <h2>Positions</h2>
      <button id="btn-new-pos" class="btn btn-primary">+ Add position</button>
    </div>
    <div class="card">
      ${positions.length ? `<table>
        <thead><tr><th>Company</th><th>Division</th><th>Title</th><th>Permissions</th><th>Status</th><th style="width:200px"></th></tr></thead>
        <tbody>${positions.map((p) => `<tr>
          <td>${esc(p.company_name || '—')}</td>
          <td>${esc(p.site_name)}</td>
          <td>${esc(p.title)}</td>
          <td class="muted small">${esc(permSummary(p))}</td>
          <td><span class="badge ${p.is_active ? 'badge-active' : 'badge-inactive'}">${p.is_active ? 'Active' : 'Inactive'}</span></td>
          <td style="text-align:right; white-space:nowrap">
            <button class="btn btn-sm" data-action="edit" data-id="${p.id}">Edit</button>
            ${p.is_active
              ? `<button class="btn btn-sm btn-danger" data-action="deactivate" data-id="${p.id}">Deactivate</button>`
              : `<button class="btn btn-sm btn-success" data-action="restore" data-id="${p.id}">Restore</button>`}
          </td>
        </tr>`).join('')}</tbody>
      </table>` : '<div class="empty-state">No positions yet. Add a company and a division first, then create positions.</div>'}
    </div>
  `;
  $('#btn-new-pos').addEventListener('click', () => openPositionModal(null, sites));
  $('#main').onclick = async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.action === 'edit') return openPositionModal(positions.find((p) => p.id === id), sites);
    try {
      await api(`/api/positions/${id}/${btn.dataset.action}`, { method: 'POST', body: {} });
      toast('Saved');
      renderPositions();
    } catch (err) { toast(err.message); }
  };
}

function openPositionModal(pos, sites) {
  const isNew = !pos;
  const checkbox = (key) =>
    `<label class="checkline"><input type="checkbox" id="p-${key}" ${pos && pos[key] ? 'checked' : (key === 'perm_create' && isNew ? 'checked' : '')}> ${PERM_LABEL[key]}</label>`;
  openModal(`
    <h3>${isNew ? 'New position' : 'Edit position'}</h3>
    <form id="pos-form">
      ${isNew
        ? `<label>Division <select id="p-site">${optionList(sites, null, divisionLabel)}</select></label>`
        : `<label>Division <input type="text" value="${esc((pos.company_name ? pos.company_name + ' — ' : '') + pos.site_name)}" disabled></label>`}
      <label>Title <input type="text" id="p-title" required maxlength="120" value="${esc(pos ? pos.title : '')}"></label>
      <div class="perm-group">
        <div class="perm-group-title">Permissions</div>
        ${Object.keys(PERM_LABEL).map(checkbox).join('')}
      </div>
      <div id="p-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${isNew ? 'Create' : 'Save'}</button>
      </div>
    </form>
  `);
  $('#pos-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { title: $('#p-title').value };
    for (const key of Object.keys(PERM_LABEL)) body[key] = $(`#p-${key}`).checked;
    if (isNew) body.site_id = $('#p-site').value;
    try {
      await api(isNew ? '/api/positions' : `/api/positions/${pos.id}`, { method: isNew ? 'POST' : 'PUT', body });
      closeModal();
      toast('Saved');
      renderPositions();
    } catch (err) { showFormError('#p-error', err.message); }
  });
}

// ---------------------------------------------------------------------------
// Divisions (sites)
// ---------------------------------------------------------------------------

async function renderDivisions() {
  const [{ sites }, { companies }] = await Promise.all([api('/api/sites'), api('/api/companies')]);
  $('#main').innerHTML = `
    <div class="page-header">
      <h2>Divisions</h2>
      <button id="btn-new-div" class="btn btn-primary">+ Add division</button>
    </div>
    <div class="card">
      ${sites.length ? `<table>
        <thead><tr><th>Company</th><th>Name</th><th>Status</th><th style="width:200px"></th></tr></thead>
        <tbody>${sites.map((s) => `<tr>
          <td>${esc(s.company_name || '—')}</td>
          <td>${esc(s.name)}</td>
          <td><span class="badge ${s.is_active ? 'badge-active' : 'badge-inactive'}">${s.is_active ? 'Active' : 'Inactive'}</span></td>
          <td style="text-align:right; white-space:nowrap">
            <button class="btn btn-sm" data-action="edit" data-id="${s.id}">Edit</button>
            ${s.is_active
              ? `<button class="btn btn-sm btn-danger" data-action="deactivate" data-id="${s.id}">Deactivate</button>`
              : `<button class="btn btn-sm btn-success" data-action="restore" data-id="${s.id}">Restore</button>`}
            ${currentUser.is_super ? `<button class="btn btn-sm btn-danger" data-action="delete" data-id="${s.id}">Delete</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
      </table>` : '<div class="empty-state">No divisions yet. Add a company first.</div>'}
    </div>
  `;
  $('#btn-new-div').addEventListener('click', () => openDivisionModal(null, companies));
  $('#main').onclick = async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.action;
    if (act === 'edit') return openDivisionModal(sites.find((s) => s.id === id), companies);
    if (act === 'delete' && !confirm('Delete this division permanently?')) return;
    try {
      if (act === 'delete') await api(`/api/sites/${id}`, { method: 'DELETE' });
      else await api(`/api/sites/${id}/${act}`, { method: 'POST', body: {} });
      toast('Saved');
      renderDivisions();
    } catch (err) { toast(err.message); }
  };
}

function openDivisionModal(site, companies) {
  const isNew = !site;
  openModal(`
    <h3>${isNew ? 'New division' : 'Edit division'}</h3>
    <form id="div-form">
      <label>Company <select id="d-company">${optionList(companies, site ? site.company_id : null)}</select></label>
      <label>Name <input type="text" id="d-name" required maxlength="120" value="${esc(site ? site.name : '')}"></label>
      <div id="d-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `);
  $('#div-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(isNew ? '/api/sites' : `/api/sites/${site.id}`, {
        method: isNew ? 'POST' : 'PUT',
        body: { name: $('#d-name').value, company_id: $('#d-company').value || null },
      });
      closeModal();
      toast('Saved');
      renderDivisions();
    } catch (err) { showFormError('#d-error', err.message); }
  });
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

async function renderCompanies() {
  const { companies } = await api('/api/companies');
  $('#main').innerHTML = `
    <div class="page-header">
      <h2>Companies</h2>
      <button id="btn-new-co" class="btn btn-primary">+ Add company</button>
    </div>
    <div class="card">
      ${companies.length ? `<table>
        <thead><tr><th>Name</th><th>Status</th><th style="width:260px"></th></tr></thead>
        <tbody>${companies.map((c) => `<tr>
          <td>${esc(c.name)}</td>
          <td><span class="badge ${c.is_active ? 'badge-active' : 'badge-inactive'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
          <td style="text-align:right; white-space:nowrap">
            <button class="btn btn-sm" data-action="rename" data-id="${c.id}" data-name="${esc(c.name)}">Rename</button>
            ${c.is_active
              ? `<button class="btn btn-sm btn-danger" data-action="deactivate" data-id="${c.id}">Deactivate</button>`
              : `<button class="btn btn-sm btn-success" data-action="restore" data-id="${c.id}">Restore</button>`}
            ${currentUser.is_super ? `<button class="btn btn-sm btn-danger" data-action="delete" data-id="${c.id}">Delete</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
      </table>` : '<div class="empty-state">No companies yet.</div>'}
    </div>
  `;
  $('#btn-new-co').addEventListener('click', () => openCompanyModal(null));
  $('#main').onclick = async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.action;
    if (act === 'rename') return openCompanyModal({ id, name: btn.dataset.name });
    if (act === 'delete' && !confirm('Delete this company permanently?')) return;
    try {
      if (act === 'delete') await api(`/api/companies/${id}`, { method: 'DELETE' });
      else await api(`/api/companies/${id}/${act}`, { method: 'POST', body: {} });
      toast('Saved');
      renderCompanies();
    } catch (err) { toast(err.message); }
  };
}

function openCompanyModal(company) {
  const isNew = !company;
  openModal(`
    <h3>${isNew ? 'New company' : 'Rename company'}</h3>
    <form id="co-form">
      <label>Name <input type="text" id="c-name" required maxlength="120" value="${esc(company ? company.name : '')}"></label>
      <div id="c-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `);
  $('#co-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(isNew ? '/api/companies' : `/api/companies/${company.id}`, {
        method: isNew ? 'POST' : 'PUT',
        body: { name: $('#c-name').value },
      });
      closeModal();
      toast('Saved');
      renderCompanies();
    } catch (err) { showFormError('#c-error', err.message); }
  });
}

init();
