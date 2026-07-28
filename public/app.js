const listView = document.getElementById('list-view');
const detailView = document.getElementById('detail-view');
const settingsView = document.getElementById('settings-view');
const cascadesTbody = document.getElementById('cascades-tbody');
const buyOrdersTbody = document.getElementById('buy-orders-tbody');
const sellOrdersTbody = document.getElementById('sell-orders-tbody');
const cascadeHeader = document.getElementById('cascade-header');
const cascadeActions = document.getElementById('cascade-actions');
const listError = document.getElementById('list-error');
const detailError = document.getElementById('detail-error');
const modeBadge = document.getElementById('mode-badge');
const userEmailEl = document.getElementById('user-email');
const createForm = document.getElementById('create-form');
const createError = document.getElementById('create-error');
const newCascadeBtn = document.getElementById('new-cascade-btn');
const cancelCreateBtn = document.getElementById('cancel-create-btn');
const newTemplateBtn = document.getElementById('new-template-btn');
const templateForm = document.getElementById('template-form');
const templateError = document.getElementById('template-error');
const templateRowsTbody = document.getElementById('template-rows-tbody');
const templateAddRowBtn = document.getElementById('template-add-row-btn');
const cancelTemplateBtn = document.getElementById('cancel-template-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsBackBtn = document.getElementById('settings-back-btn');
const logoutBtn = document.getElementById('logout-btn');
const settingsForm = document.getElementById('settings-form');
const settingsError = document.getElementById('settings-error');
const settingsSuccess = document.getElementById('settings-success');
const settingsKeyStatus = document.getElementById('settings-key-status');
const settingsTestBtn = document.getElementById('settings-test-btn');
const settingsTestResult = document.getElementById('settings-test-result');
const adminView = document.getElementById('admin-view');
const adminBtn = document.getElementById('admin-btn');
const adminBackBtn = document.getElementById('admin-back-btn');
const adminError = document.getElementById('admin-error');
const adminLinkBox = document.getElementById('admin-link-box');
const inviteForm = document.getElementById('invite-form');
const adminUsersTbody = document.getElementById('admin-users-tbody');
const backtestBtn = document.getElementById('backtest-btn');
const backtestView = document.getElementById('backtest-view');
const backtestBackBtn = document.getElementById('backtest-back-btn');
const backtestListError = document.getElementById('backtest-list-error');
const backtestsTbody = document.getElementById('backtests-tbody');
const newBacktestPctBtn = document.getElementById('new-backtest-pct-btn');
const newBacktestManualBtn = document.getElementById('new-backtest-manual-btn');
const backtestPctForm = document.getElementById('backtest-pct-form');
const backtestPctError = document.getElementById('backtest-pct-error');
const cancelBacktestPctBtn = document.getElementById('cancel-backtest-pct-btn');
const backtestManualForm = document.getElementById('backtest-manual-form');
const backtestManualError = document.getElementById('backtest-manual-error');
const backtestManualRowsTbody = document.getElementById('backtest-manual-rows-tbody');
const backtestManualAddRowBtn = document.getElementById('backtest-manual-add-row-btn');
const cancelBacktestManualBtn = document.getElementById('cancel-backtest-manual-btn');
const backtestDetailView = document.getElementById('backtest-detail-view');
const backtestDetailBackBtn = document.getElementById('backtest-detail-back-btn');
const backtestDetailError = document.getElementById('backtest-detail-error');
const backtestDetailHeader = document.getElementById('backtest-detail-header');
const backtestDetailActions = document.getElementById('backtest-detail-actions');
const backtestDetailLevelsTbody = document.getElementById('backtest-detail-levels-tbody');
const chartPanel = document.getElementById('chart-panel');
const chartSymbolInput = document.getElementById('chart-symbol-input');
const chartLoadBtn = document.getElementById('chart-load-btn');
const tradingviewContainer = document.getElementById('tradingview-chart-container');
const chartCoinList = document.getElementById('chart-coin-list');

let currentCascadeId = null;
let currentBacktestId = null;
let tradingViewScriptLoaded = false;
let chartPanelInitialized = false;
let isAdminUser = false;

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    // no body
  }
  if (!res.ok) {
    throw new Error((body && body.error) || `Request failed (${res.status})`);
  }
  return body;
}

function fmtNum(n, digits = 8) {
  if (n === null || n === undefined) return '—';
  const num = Number(n);
  if (Number.isNaN(num)) return '—';
  return num.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

const BUY_STATUS_LABELS = {
  pending: 'Pending',
  placed: 'Placed',
  filled: 'Filled',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  trigger_armed: 'Waiting for Trigger (Gate.io)',
};

const SELL_STATUS_LABELS = {
  none: '—',
  placed: 'Placed',
  filled: 'Filled',
};

function statusPill(status, labelMap) {
  const label = (labelMap && labelMap[status]) || status.replace(/_/g, ' ');
  return `<span class="status-pill status-${status}">${label}</span>`;
}

async function loadStatus() {
  try {
    const status = await api('/status');
    modeBadge.textContent = status.dryRun ? 'DRY RUN' : 'LIVE';
    modeBadge.className = 'badge ' + (status.dryRun ? 'dry-run' : 'live');
    userEmailEl.textContent = status.email || '';
    adminBtn.hidden = !status.isAdmin;
    isAdminUser = status.isAdmin;
    chartPanel.hidden = !isAdminUser;
    if (status.isAdmin && !chartPanelInitialized) {
      chartPanelInitialized = true;
      renderChart(chartSymbolInput.value);
      loadTrendingCoins();
    }
  } catch (err) {
    modeBadge.textContent = 'unknown';
  }
}

function showSettingsView() {
  listView.hidden = true;
  detailView.hidden = true;
  adminView.hidden = true;
  backtestView.hidden = true;
  backtestDetailView.hidden = true;
  settingsView.hidden = false;
  chartPanel.hidden = true;
  loadSettings();
}

function hideSettingsView() {
  settingsView.hidden = true;
  showList();
}

function showAdminView() {
  listView.hidden = true;
  detailView.hidden = true;
  settingsView.hidden = true;
  backtestView.hidden = true;
  backtestDetailView.hidden = true;
  adminView.hidden = false;
  chartPanel.hidden = true;
  loadAdminUsers();
}

function hideAdminView() {
  adminView.hidden = true;
  showList();
}

async function loadAdminUsers() {
  adminError.hidden = true;
  try {
    const users = await api('/admin/users');
    renderAdminUsers(users);
  } catch (err) {
    adminError.textContent = err.message;
    adminError.hidden = false;
  }
}

function renderAdminUsers(users) {
  if (!users.length) {
    adminUsersTbody.innerHTML = '<tr><td colspan="6" class="empty">No users.</td></tr>';
    return;
  }

  adminUsersTbody.innerHTML = users
    .map(
      (u) => `
        <tr>
          <td>${u.email}</td>
          <td>${u.isAdmin ? 'Yes' : '—'}</td>
          <td>${u.dryRun ? 'Yes' : 'No'}</td>
          <td>${u.apiKeyConfigured ? 'Configured' : '—'}</td>
          <td>${fmtDate(u.createdAt)}</td>
          <td><button class="btn" data-reset-email="${u.email}">Send reset link</button></td>
        </tr>
      `
    )
    .join('');

  adminUsersTbody.querySelectorAll('button[data-reset-email]').forEach((btn) => {
    btn.addEventListener('click', () => handleSendResetLink(btn.dataset.resetEmail));
  });
}

function showAdminLink(label, result) {
  adminLinkBox.innerHTML = `${label} <strong>${result.email}</strong> (expires in ${result.expiresIn}):<br>
    <input type="text" readonly value="${result.link}" style="width:100%;margin-top:0.4rem;padding:0.4rem;font-size:0.85rem;" onclick="this.select()" />`;
  adminLinkBox.hidden = false;
}

async function handleInviteSubmit(event) {
  event.preventDefault();
  adminError.hidden = true;
  adminLinkBox.hidden = true;

  const email = document.getElementById('a-invite-email').value.trim();
  const isAdmin = document.getElementById('a-invite-admin').checked;

  try {
    const result = await api('/admin/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, isAdmin }),
    });
    inviteForm.reset();
    showAdminLink('Invite link for', result);
    await loadAdminUsers();
  } catch (err) {
    adminError.textContent = err.message;
    adminError.hidden = false;
  }
}

async function handleSendResetLink(email) {
  adminError.hidden = true;
  adminLinkBox.hidden = true;
  try {
    const result = await api('/admin/reset-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    showAdminLink('Reset link for', result);
  } catch (err) {
    adminError.textContent = err.message;
    adminError.hidden = false;
  }
}

async function loadSettings() {
  settingsError.hidden = true;
  settingsSuccess.hidden = true;
  settingsTestResult.hidden = true;
  try {
    const settings = await api('/settings');
    document.getElementById('s-dry-run').checked = settings.dryRun;
    settingsKeyStatus.textContent = settings.apiKeyConfigured
      ? `API key configured (ending in ${settings.gateApiKeyLast4})`
      : 'No API key configured yet';
  } catch (err) {
    settingsError.textContent = err.message;
    settingsError.hidden = false;
  }
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  settingsError.hidden = true;
  settingsSuccess.hidden = true;

  const apiKey = document.getElementById('s-api-key').value.trim();
  const apiSecret = document.getElementById('s-api-secret').value.trim();
  const dryRun = document.getElementById('s-dry-run').checked;

  const payload = { dry_run: dryRun };
  if (apiKey || apiSecret) {
    if (!apiKey || !apiSecret) {
      settingsError.textContent = 'Provide both API key and secret together';
      settingsError.hidden = false;
      return;
    }
    payload.gate_api_key = apiKey;
    payload.gate_api_secret = apiSecret;
  }

  try {
    await api('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    document.getElementById('s-api-key').value = '';
    document.getElementById('s-api-secret').value = '';
    await loadSettings();
    await loadStatus();
    settingsSuccess.textContent = 'Settings saved.';
    settingsSuccess.hidden = false;
  } catch (err) {
    settingsError.textContent = err.message;
    settingsError.hidden = false;
  }
}

async function handleTestApiKey() {
  settingsTestResult.hidden = true;
  const apiKey = document.getElementById('s-api-key').value.trim();
  const apiSecret = document.getElementById('s-api-secret').value.trim();
  const payload = apiKey || apiSecret ? { gate_api_key: apiKey, gate_api_secret: apiSecret } : {};

  settingsTestBtn.disabled = true;
  try {
    const result = await api('/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    settingsTestResult.textContent = `✅ Connected — ${fmtNum(result.usdtAvailable, 2)} USDT available.`;
    settingsTestResult.className = 'success';
  } catch (err) {
    settingsTestResult.textContent = `❌ ${err.message}`;
    settingsTestResult.className = 'error';
  } finally {
    settingsTestResult.hidden = false;
    settingsTestBtn.disabled = false;
  }
}

async function handleLogout() {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
}

async function loadCascadeList() {
  listError.hidden = true;
  try {
    const cascades = await api('/cascades');
    renderCascadeList(cascades);
  } catch (err) {
    listError.textContent = err.message;
    listError.hidden = false;
  }
}

function renderCascadeList(cascades) {
  if (!cascades.length) {
    cascadesTbody.innerHTML = '<tr><td colspan="6" class="empty">No cascades yet.</td></tr>';
    return;
  }

  cascadesTbody.innerHTML = cascades
    .map(
      (c) => `
        <tr data-id="${c.id}">
          <td>${c.symbol}</td>
          <td>${statusPill(c.status)}</td>
          <td>${fmtNum(c.base_price)}</td>
          <td>${c.num_levels}</td>
          <td>${fmtDate(c.created_at)}</td>
          <td>&rsaquo;</td>
        </tr>
      `
    )
    .join('');

  [...cascadesTbody.querySelectorAll('tr[data-id]')].forEach((row) => {
    row.addEventListener('click', () => showDetail(row.dataset.id));
  });
}

function showList() {
  currentCascadeId = null;
  detailView.hidden = true;
  settingsView.hidden = true;
  adminView.hidden = true;
  backtestView.hidden = true;
  backtestDetailView.hidden = true;
  listView.hidden = false;
  chartPanel.hidden = !isAdminUser;
  loadCascadeList();
}

async function showDetail(id) {
  currentCascadeId = id;
  listView.hidden = true;
  settingsView.hidden = true;
  adminView.hidden = true;
  backtestView.hidden = true;
  backtestDetailView.hidden = true;
  detailView.hidden = false;
  chartPanel.hidden = !isAdminUser;
  await loadDetail(id);
}

async function loadDetail(id) {
  detailError.hidden = true;
  try {
    const cascade = await api(`/cascades/${id}`);
    renderDetail(cascade);
  } catch (err) {
    detailError.textContent = err.message;
    detailError.hidden = false;
  }
}

function renderDetail(cascade) {
  const fields = [
    ['Symbol', cascade.symbol],
    ['Status', statusPill(cascade.status)],
    ['Trigger Price', fmtNum(cascade.trigger_price)],
    ['Base Price', fmtNum(cascade.base_price)],
    ['Base Amount USDT', fmtNum(cascade.base_amount_usdt, 2)],
  ];
  if (cascade.is_manual) {
    fields.push(['Created Via', 'Manual Template']);
  } else {
    fields.push(
      ['Price Step %', fmtNum(cascade.price_step_pct, 2)],
      ['Amount Step %', fmtNum(cascade.amount_step_pct, 2)],
      ['Take-Profit Base %', fmtNum(cascade.take_profit_base_pct, 2)],
      ['Take-Profit Step %', fmtNum(cascade.take_profit_step_pct, 2)]
    );
  }
  fields.push(['Created', fmtDate(cascade.created_at)], ['Updated', fmtDate(cascade.updated_at)]);

  cascadeHeader.innerHTML = fields
    .map(
      ([label, value]) => `
        <div>
          <div class="field-label">${label}</div>
          <div class="field-value">${value}</div>
        </div>
      `
    )
    .join('');

  cascadeActions.innerHTML = renderActionButtons(cascade.status);
  wireActionButtons(cascade.id);

  renderBuyOrders(cascade);
  renderSellOrders(cascade);
}

function levelActionButtons(level, side) {
  const buttons = [];
  const isLive = side === 'buy' ? level.status === 'placed' : level.sell_status === 'placed';
  const isEditable = side === 'buy' ? ['pending', 'placed'].includes(level.status) : level.sell_status === 'placed';

  if (isEditable) {
    buttons.push(`<button class="btn" data-level-action="edit" data-side="${side}">Edit</button>`);
  }
  if (isLive) {
    buttons.push(`<button class="btn danger" data-level-action="cancel" data-side="${side}">Cancel</button>`);
  }
  return buttons.join(' ');
}

function renderBuyOrders(cascade) {
  if (!cascade.levels.length) {
    buyOrdersTbody.innerHTML = '<tr><td colspan="7" class="empty">No levels.</td></tr>';
    return;
  }

  buyOrdersTbody.innerHTML = cascade.levels
    .map((l) => {
      const price = l.filled_price ?? l.target_price;
      const quantity = l.filled_amount ?? l.amount_usdt / l.target_price;
      return `
        <tr data-level-id="${l.id}">
          <td>${l.level_index}</td>
          <td>${cascade.symbol}</td>
          <td>${fmtNum(price)}</td>
          <td>${fmtNum(quantity)}</td>
          <td>${fmtNum(l.amount_usdt, 2)} USDT</td>
          <td>${statusPill(l.status, BUY_STATUS_LABELS)}${l.skip_reason ? ` <span class="field-label">(${l.skip_reason.replace(/_/g, ' ')})</span>` : ''}</td>
          <td>${levelActionButtons(l, 'buy')}</td>
        </tr>
      `;
    })
    .join('');

  wireLevelActions(cascade, buyOrdersTbody, 'buy');
}

function renderSellOrders(cascade) {
  const sellLevels = cascade.levels.filter((l) => l.sell_status === 'placed' || l.sell_status === 'filled');

  if (!sellLevels.length) {
    sellOrdersTbody.innerHTML = '<tr><td colspan="7" class="empty">No sell orders yet.</td></tr>';
    return;
  }

  sellOrdersTbody.innerHTML = sellLevels
    .map((l) => {
      const amount = l.filled_amount != null && l.sell_target_price != null ? l.filled_amount * l.sell_target_price : null;
      return `
        <tr data-level-id="${l.id}">
          <td>${l.level_index}</td>
          <td>${cascade.symbol}</td>
          <td>${fmtNum(l.sell_target_price)}</td>
          <td>${fmtNum(l.filled_amount)}</td>
          <td>${fmtNum(amount, 2)} USDT</td>
          <td>${statusPill(l.sell_status, SELL_STATUS_LABELS)}</td>
          <td>${levelActionButtons(l, 'sell')}</td>
        </tr>
      `;
    })
    .join('');

  wireLevelActions(cascade, sellOrdersTbody, 'sell');
}

function wireLevelActions(cascade, tbody, side) {
  tbody.querySelectorAll('button[data-level-action]').forEach((btn) => {
    const row = btn.closest('tr[data-level-id]');
    const levelId = row.dataset.levelId;
    const level = cascade.levels.find((l) => l.id === levelId);
    btn.addEventListener('click', () => {
      if (btn.dataset.levelAction === 'edit') handleLevelEdit(cascade.id, level, side);
      if (btn.dataset.levelAction === 'cancel') handleLevelCancel(cascade.id, level, side);
    });
  });
}

async function handleLevelEdit(cascadeId, level, side) {
  detailError.hidden = true;
  try {
    let body;
    if (side === 'sell') {
      const newPrice = prompt('New sell price:', level.sell_target_price);
      if (newPrice === null) return;
      body = { sell_target_price: Number(newPrice) };
    } else {
      const newPrice = prompt('New buy price:', level.target_price);
      if (newPrice === null) return;
      const newAmount = prompt('New amount (USDT):', level.amount_usdt);
      if (newAmount === null) return;
      body = { target_price: Number(newPrice), amount_usdt: Number(newAmount) };
    }

    await api(`/cascades/${cascadeId}/levels/${level.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadDetail(cascadeId);
  } catch (err) {
    detailError.textContent = err.message;
    detailError.hidden = false;
  }
}

async function handleLevelCancel(cascadeId, level, side) {
  if (!confirm(`Cancel this level's resting ${side} order?`)) return;
  detailError.hidden = true;
  try {
    await api(`/cascades/${cascadeId}/levels/${level.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side }),
    });
    await loadDetail(cascadeId);
  } catch (err) {
    detailError.textContent = err.message;
    detailError.hidden = false;
  }
}

function renderActionButtons(status) {
  const buttons = [];
  if (status === 'active' || status === 'pending_trigger') {
    buttons.push('<button class="btn" data-action="hold">Hold</button>');
  }
  if (status === 'held') {
    buttons.push('<button class="btn primary" data-action="resume">Resume</button>');
  }
  if (status === 'active' || status === 'pending_trigger' || status === 'held') {
    buttons.push('<button class="btn danger" data-action="cancel">Cancel</button>');
  }
  buttons.push('<button class="btn danger" data-action="delete">Delete</button>');
  return buttons.join('');
}

function wireActionButtons(id) {
  cascadeActions.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleAction(id, btn.dataset.action));
  });
}

async function handleAction(id, action) {
  const confirmations = {
    cancel: 'Cancel this cascade? Any resting buy/sell orders will be cancelled on the exchange.',
    delete: 'Delete this cascade permanently? Resting orders will be cancelled first, and this cannot be undone.',
  };
  if (confirmations[action] && !confirm(confirmations[action])) return;

  detailError.hidden = true;
  cascadeActions.querySelectorAll('button').forEach((b) => (b.disabled = true));

  try {
    if (action === 'hold') await api(`/cascades/${id}/hold`, { method: 'POST' });
    if (action === 'resume') await api(`/cascades/${id}/resume`, { method: 'POST' });
    if (action === 'cancel') await api(`/cascades/${id}/cancel`, { method: 'POST' });
    if (action === 'delete') {
      await api(`/cascades/${id}`, { method: 'DELETE' });
      showList();
      return;
    }
    await loadDetail(id);
  } catch (err) {
    detailError.textContent = err.message;
    detailError.hidden = false;
    cascadeActions.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

function showCreateForm() {
  hideTemplateForm();
  createError.hidden = true;
  createForm.reset();
  createForm.hidden = false;
  newCascadeBtn.hidden = true;
}

function hideCreateForm() {
  createForm.hidden = true;
  newCascadeBtn.hidden = false;
}

function numOrUndefined(value) {
  return value === '' ? undefined : Number(value);
}

async function handleCreateSubmit(event) {
  event.preventDefault();
  createError.hidden = true;

  const payload = {
    symbol: document.getElementById('f-symbol').value.trim().toUpperCase(),
    trigger_price: numOrUndefined(document.getElementById('f-trigger_price').value) ?? null,
    base_price: numOrUndefined(document.getElementById('f-base_price').value),
    base_amount_usdt: numOrUndefined(document.getElementById('f-base_amount_usdt').value),
    price_step_pct: numOrUndefined(document.getElementById('f-price_step_pct').value),
    amount_step_pct: numOrUndefined(document.getElementById('f-amount_step_pct').value),
    num_levels: numOrUndefined(document.getElementById('f-num_levels').value),
    take_profit_base_pct: numOrUndefined(document.getElementById('f-take_profit_base_pct').value),
    take_profit_step_pct: numOrUndefined(document.getElementById('f-take_profit_step_pct').value),
  };

  const submitBtn = createForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const cascade = await api('/cascades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    hideCreateForm();
    await showDetail(cascade.id);
  } catch (err) {
    createError.textContent = err.message;
    createError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
}

newCascadeBtn.addEventListener('click', showCreateForm);
cancelCreateBtn.addEventListener('click', hideCreateForm);
createForm.addEventListener('submit', handleCreateSubmit);

function addTemplateRow() {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td class="template-row-num"></td>
    <td><input type="number" step="any" class="t-buy-price" required /></td>
    <td><input type="number" step="any" class="t-amount" required /></td>
    <td><input type="number" step="any" class="t-sell-price" required /></td>
    <td><button type="button" class="btn danger t-remove-row">✕</button></td>
  `;
  row.querySelector('.t-remove-row').addEventListener('click', () => {
    if (templateRowsTbody.querySelectorAll('tr').length > 1) {
      row.remove();
      renumberTemplateRows();
    }
  });
  templateRowsTbody.appendChild(row);
  renumberTemplateRows();
}

function renumberTemplateRows() {
  templateRowsTbody.querySelectorAll('tr').forEach((row, idx) => {
    row.querySelector('.template-row-num').textContent = idx + 1;
  });
}

function showTemplateForm() {
  hideCreateForm();
  templateError.hidden = true;
  templateForm.reset();
  templateRowsTbody.innerHTML = '';
  for (let i = 0; i < 5; i++) addTemplateRow();
  templateForm.hidden = false;
  newTemplateBtn.hidden = true;
}

function hideTemplateForm() {
  templateForm.hidden = true;
  newTemplateBtn.hidden = false;
}

async function handleTemplateSubmit(event) {
  event.preventDefault();
  templateError.hidden = true;

  const symbol = document.getElementById('t-symbol').value.trim().toUpperCase();
  const triggerPriceRaw = document.getElementById('t-trigger_price').value;
  const rows = [...templateRowsTbody.querySelectorAll('tr')];
  const levels = rows.map((row) => ({
    target_price: Number(row.querySelector('.t-buy-price').value),
    amount_usdt: Number(row.querySelector('.t-amount').value),
    sell_price: Number(row.querySelector('.t-sell-price').value),
  }));

  const payload = {
    symbol,
    trigger_price: triggerPriceRaw === '' ? null : Number(triggerPriceRaw),
    levels,
  };

  const submitBtn = templateForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const cascade = await api('/cascades/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    hideTemplateForm();
    await showDetail(cascade.id);
  } catch (err) {
    templateError.textContent = err.message;
    templateError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
}

newTemplateBtn.addEventListener('click', showTemplateForm);
cancelTemplateBtn.addEventListener('click', hideTemplateForm);
templateForm.addEventListener('submit', handleTemplateSubmit);
templateAddRowBtn.addEventListener('click', addTemplateRow);

document.getElementById('refresh-list-btn').addEventListener('click', loadCascadeList);
document.getElementById('back-btn').addEventListener('click', showList);

settingsBtn.addEventListener('click', showSettingsView);
settingsBackBtn.addEventListener('click', hideSettingsView);
logoutBtn.addEventListener('click', handleLogout);
settingsForm.addEventListener('submit', handleSettingsSubmit);
settingsTestBtn.addEventListener('click', handleTestApiKey);

adminBtn.addEventListener('click', showAdminView);
adminBackBtn.addEventListener('click', hideAdminView);
inviteForm.addEventListener('submit', handleInviteSubmit);

// --- Backtests ---------------------------------------------------------

function toUnixSeconds(datetimeLocalValue) {
  return Math.floor(new Date(datetimeLocalValue).getTime() / 1000);
}

/** Formats a Date as a datetime-local input value ("YYYY-MM-DDTHH:mm") in local time, for prefilling sensible defaults. */
function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function showBacktestView() {
  listView.hidden = true;
  detailView.hidden = true;
  settingsView.hidden = true;
  adminView.hidden = true;
  backtestDetailView.hidden = true;
  backtestView.hidden = false;
  chartPanel.hidden = true;
  loadBacktestList();
}

function hideBacktestView() {
  backtestView.hidden = true;
  showList();
}

async function loadBacktestList() {
  backtestListError.hidden = true;
  try {
    const backtests = await api('/backtests');
    renderBacktestList(backtests);
  } catch (err) {
    backtestListError.textContent = err.message;
    backtestListError.hidden = false;
  }
}

function outcomeLabel(bt) {
  if (bt.outcome === 'never_armed') return 'Never Armed';
  if (bt.outcome === 'no_data') return 'No Data';
  return `${fmtNum(bt.roi_pct, 2)}%`;
}

function renderBacktestList(backtests) {
  if (!backtests.length) {
    backtestsTbody.innerHTML = '<tr><td colspan="7" class="empty">No backtests yet.</td></tr>';
    return;
  }

  backtestsTbody.innerHTML = backtests
    .map(
      (bt) => `
        <tr data-id="${bt.id}">
          <td>${bt.symbol}</td>
          <td>${bt.interval}</td>
          <td>${fmtDate(new Date(bt.from_time * 1000).toISOString())} &rarr; ${fmtDate(new Date(bt.to_time * 1000).toISOString())}</td>
          <td>${outcomeLabel(bt)}</td>
          <td>${bt.fills_count}/${bt.skips_count}</td>
          <td>${fmtDate(bt.created_at)}</td>
          <td><button class="btn danger" data-delete-id="${bt.id}">Delete</button></td>
        </tr>
      `
    )
    .join('');

  backtestsTbody.querySelectorAll('tr[data-id]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete-id]')) return;
      showBacktestDetail(row.dataset.id);
    });
  });
  backtestsTbody.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm('Delete this backtest?')) return;
      try {
        await api(`/backtests/${btn.dataset.deleteId}`, { method: 'DELETE' });
        await loadBacktestList();
      } catch (err) {
        backtestListError.textContent = err.message;
        backtestListError.hidden = false;
      }
    });
  });
}

async function showBacktestDetail(id) {
  currentBacktestId = id;
  backtestView.hidden = true;
  backtestDetailView.hidden = false;
  chartPanel.hidden = true;
  await loadBacktestDetail(id);
}

function hideBacktestDetailView() {
  currentBacktestId = null;
  backtestDetailView.hidden = true;
  showBacktestView();
}

async function loadBacktestDetail(id) {
  backtestDetailError.hidden = true;
  try {
    const bt = await api(`/backtests/${id}`);
    renderBacktestDetail(bt);
  } catch (err) {
    backtestDetailError.textContent = err.message;
    backtestDetailError.hidden = false;
  }
}

function renderBacktestDetail(bt) {
  const s = bt.results.summary;
  const fields = [
    ['Symbol', bt.symbol],
    ['Interval', bt.interval],
    ['From', fmtDate(new Date(bt.from_time * 1000).toISOString())],
    ['To', fmtDate(new Date(bt.to_time * 1000).toISOString())],
    ['Fee %', fmtNum(bt.fee_pct, 2)],
    ['Outcome', outcomeLabel(bt)],
  ];
  if (bt.results.armed && bt.results.armedAt) {
    fields.push(['Armed At', `${fmtDate(new Date(bt.results.armedAt.time * 1000).toISOString())} @ ${fmtNum(bt.results.armedAt.price)}`]);
  }
  if (bt.is_manual) {
    fields.push(['Created Via', 'Manual Template']);
  } else {
    fields.push(
      ['Base Price', fmtNum(bt.config.base_price)],
      ['Price Step %', fmtNum(bt.config.price_step_pct, 2)],
      ['Amount Step %', fmtNum(bt.config.amount_step_pct, 2)]
    );
  }
  fields.push(
    ['ROI %', fmtNum(s.roiPct, 2) + '%'],
    ['Realized PnL (USDT)', fmtNum(s.realizedPnlUsdt, 4)],
    ['Unrealized PnL (USDT)', fmtNum(s.unrealizedPnlUsdt, 4)],
    ['Total Invested (USDT)', fmtNum(s.totalInvestedUsdt, 2)],
    ['Fills / Skips', `${s.fillsCount} / ${s.skipsCount}`],
    ['Created', fmtDate(bt.created_at)]
  );

  backtestDetailHeader.innerHTML = fields
    .map(
      ([label, value]) => `
        <div>
          <div class="field-label">${label}</div>
          <div class="field-value">${value}</div>
        </div>
      `
    )
    .join('');

  backtestDetailActions.innerHTML = `<button class="btn danger" id="backtest-detail-delete-btn">Delete Backtest</button>`;
  document.getElementById('backtest-detail-delete-btn').addEventListener('click', async () => {
    if (!confirm('Delete this backtest?')) return;
    try {
      await api(`/backtests/${bt.id}`, { method: 'DELETE' });
      hideBacktestDetailView();
    } catch (err) {
      backtestDetailError.textContent = err.message;
      backtestDetailError.hidden = false;
    }
  });

  backtestDetailLevelsTbody.innerHTML = bt.results.levels
    .map(
      (l) => `
        <tr>
          <td>${l.level_index}</td>
          <td>${fmtNum(l.target_price)}</td>
          <td>${statusPill(l.status, BUY_STATUS_LABELS)}${l.skip_reason ? ` <span class="field-label">(${l.skip_reason.replace(/_/g, ' ')})</span>` : ''}</td>
          <td>${l.fill_time ? fmtDate(new Date(l.fill_time * 1000).toISOString()) : '—'}</td>
          <td>${l.sell_price != null ? fmtNum(l.sell_price) : '—'}</td>
          <td>${statusPill(l.sell_status, SELL_STATUS_LABELS)}</td>
          <td>${l.sell_time ? fmtDate(new Date(l.sell_time * 1000).toISOString()) : '—'}</td>
          <td>${l.pnl_usdt != null ? fmtNum(l.pnl_usdt, 4) : '—'}</td>
        </tr>
      `
    )
    .join('');
}

function showBacktestPctForm() {
  hideBacktestManualForm();
  backtestPctError.hidden = true;
  backtestPctForm.reset();
  document.getElementById('bp-to').value = toDatetimeLocalValue(new Date());
  document.getElementById('bp-from').value = toDatetimeLocalValue(new Date(Date.now() - 7 * 24 * 3600 * 1000));
  document.getElementById('bp-fee_pct').value = 0.2;
  backtestPctForm.hidden = false;
  newBacktestPctBtn.hidden = true;
}

function hideBacktestPctForm() {
  backtestPctForm.hidden = true;
  newBacktestPctBtn.hidden = false;
}

function addBacktestManualRow() {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td class="template-row-num"></td>
    <td><input type="number" step="any" class="bm-buy-price" required /></td>
    <td><input type="number" step="any" class="bm-amount" required /></td>
    <td><input type="number" step="any" class="bm-sell-price" required /></td>
    <td><button type="button" class="btn danger bm-remove-row">✕</button></td>
  `;
  row.querySelector('.bm-remove-row').addEventListener('click', () => {
    if (backtestManualRowsTbody.querySelectorAll('tr').length > 1) {
      row.remove();
      renumberBacktestManualRows();
    }
  });
  backtestManualRowsTbody.appendChild(row);
  renumberBacktestManualRows();
}

function renumberBacktestManualRows() {
  backtestManualRowsTbody.querySelectorAll('tr').forEach((row, idx) => {
    row.querySelector('.template-row-num').textContent = idx + 1;
  });
}

function showBacktestManualForm() {
  hideBacktestPctForm();
  backtestManualError.hidden = true;
  backtestManualForm.reset();
  document.getElementById('bm-to').value = toDatetimeLocalValue(new Date());
  document.getElementById('bm-from').value = toDatetimeLocalValue(new Date(Date.now() - 7 * 24 * 3600 * 1000));
  document.getElementById('bm-fee_pct').value = 0.2;
  backtestManualRowsTbody.innerHTML = '';
  for (let i = 0; i < 5; i++) addBacktestManualRow();
  backtestManualForm.hidden = false;
  newBacktestManualBtn.hidden = true;
}

function hideBacktestManualForm() {
  backtestManualForm.hidden = true;
  newBacktestManualBtn.hidden = false;
}

async function handleBacktestPctSubmit(event) {
  event.preventDefault();
  backtestPctError.hidden = true;

  const triggerPriceRaw = document.getElementById('bp-trigger_price').value;
  const payload = {
    symbol: document.getElementById('bp-symbol').value.trim().toUpperCase(),
    interval: document.getElementById('bp-interval').value,
    from_time: toUnixSeconds(document.getElementById('bp-from').value),
    to_time: toUnixSeconds(document.getElementById('bp-to').value),
    fee_pct: numOrUndefined(document.getElementById('bp-fee_pct').value),
    trigger_price: triggerPriceRaw === '' ? null : Number(triggerPriceRaw),
    is_manual: false,
    num_levels: numOrUndefined(document.getElementById('bp-num_levels').value),
    base_price: numOrUndefined(document.getElementById('bp-base_price').value),
    base_amount_usdt: numOrUndefined(document.getElementById('bp-base_amount_usdt').value),
    price_step_pct: numOrUndefined(document.getElementById('bp-price_step_pct').value),
    amount_step_pct: numOrUndefined(document.getElementById('bp-amount_step_pct').value),
    take_profit_base_pct: numOrUndefined(document.getElementById('bp-take_profit_base_pct').value),
    take_profit_step_pct: numOrUndefined(document.getElementById('bp-take_profit_step_pct').value),
  };

  const submitBtn = backtestPctForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const result = await api('/backtests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    hideBacktestPctForm();
    await showBacktestDetail(result.id);
  } catch (err) {
    backtestPctError.textContent = err.message;
    backtestPctError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleBacktestManualSubmit(event) {
  event.preventDefault();
  backtestManualError.hidden = true;

  const triggerPriceRaw = document.getElementById('bm-trigger_price').value;
  const rows = [...backtestManualRowsTbody.querySelectorAll('tr')];
  const levels = rows.map((row) => ({
    target_price: Number(row.querySelector('.bm-buy-price').value),
    amount_usdt: Number(row.querySelector('.bm-amount').value),
    sell_price: Number(row.querySelector('.bm-sell-price').value),
  }));

  const payload = {
    symbol: document.getElementById('bm-symbol').value.trim().toUpperCase(),
    interval: document.getElementById('bm-interval').value,
    from_time: toUnixSeconds(document.getElementById('bm-from').value),
    to_time: toUnixSeconds(document.getElementById('bm-to').value),
    fee_pct: numOrUndefined(document.getElementById('bm-fee_pct').value),
    trigger_price: triggerPriceRaw === '' ? null : Number(triggerPriceRaw),
    is_manual: true,
    levels,
  };

  const submitBtn = backtestManualForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const result = await api('/backtests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    hideBacktestManualForm();
    await showBacktestDetail(result.id);
  } catch (err) {
    backtestManualError.textContent = err.message;
    backtestManualError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
}

backtestBtn.addEventListener('click', showBacktestView);
backtestBackBtn.addEventListener('click', hideBacktestView);
backtestDetailBackBtn.addEventListener('click', hideBacktestDetailView);
document.getElementById('refresh-backtests-btn').addEventListener('click', loadBacktestList);

newBacktestPctBtn.addEventListener('click', showBacktestPctForm);
cancelBacktestPctBtn.addEventListener('click', hideBacktestPctForm);
backtestPctForm.addEventListener('submit', handleBacktestPctSubmit);

newBacktestManualBtn.addEventListener('click', showBacktestManualForm);
cancelBacktestManualBtn.addEventListener('click', hideBacktestManualForm);
backtestManualForm.addEventListener('submit', handleBacktestManualSubmit);
backtestManualAddRowBtn.addEventListener('click', addBacktestManualRow);

function loadTradingViewScript() {
  return new Promise((resolve, reject) => {
    if (window.TradingView) return resolve();
    if (tradingViewScriptLoaded) {
      // Already injected, just wait for it to finish loading.
      const check = setInterval(() => {
        if (window.TradingView) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      return;
    }
    tradingViewScriptLoaded = true;
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function toTradingViewSymbol(raw) {
  const QUOTE = 'USDT';
  let s = (raw || '').trim().toUpperCase().replace(/[\s_-]/g, '');
  if (!s) s = 'BTC';
  if (!s.endsWith(QUOTE)) s = `${s}${QUOTE}`;
  return `GATEIO:${s}`;
}

async function renderChart(rawSymbol) {
  try {
    await loadTradingViewScript();
  } catch (err) {
    tradingviewContainer.innerHTML = '<div class="error">Could not load TradingView widget script.</div>';
    return;
  }
  tradingviewContainer.innerHTML = '';
  const isDark = document.documentElement.classList.contains('dark') ||
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  new window.TradingView.widget({
    autosize: true,
    symbol: toTradingViewSymbol(rawSymbol),
    interval: '15',
    timezone: 'Etc/UTC',
    theme: isDark ? 'dark' : 'light',
    style: '1',
    locale: 'en',
    container_id: 'tradingview-chart-container',
  });
}

async function loadTrendingCoins() {
  try {
    const coins = await api('/admin/market/trending');
    renderCoinList(coins);
  } catch (err) {
    chartCoinList.innerHTML = `<div class="empty">${err.message}</div>`;
  }
}

function renderCoinList(coins) {
  if (!coins.length) {
    chartCoinList.innerHTML = '<div class="empty">No data.</div>';
    return;
  }

  chartCoinList.innerHTML = coins
    .map((c) => {
      const base = c.symbol.replace('_USDT', '');
      const changeClass = c.changePct > 0 ? 'up' : c.changePct < 0 ? 'down' : '';
      const changeSign = c.changePct > 0 ? '+' : '';
      return `
        <div class="chart-coin-item" data-symbol="${c.symbol}">
          <span class="coin-symbol">${base}</span>
          <span class="coin-price">${fmtNum(c.last, 4)}</span>
          <span class="coin-change ${changeClass}">${changeSign}${fmtNum(c.changePct, 2)}%</span>
        </div>
      `;
    })
    .join('');

  chartCoinList.querySelectorAll('[data-symbol]').forEach((el) => {
    el.addEventListener('click', () => {
      chartSymbolInput.value = el.dataset.symbol;
      renderChart(el.dataset.symbol);
    });
  });
}

chartLoadBtn.addEventListener('click', () => renderChart(chartSymbolInput.value));

loadStatus();
loadCascadeList();

setInterval(() => {
  if (currentCascadeId) {
    loadDetail(currentCascadeId);
  } else {
    loadCascadeList();
  }
}, 15000);
