const listView = document.getElementById('list-view');
const detailView = document.getElementById('detail-view');
const cascadesTbody = document.getElementById('cascades-tbody');
const buyOrdersTbody = document.getElementById('buy-orders-tbody');
const sellOrdersTbody = document.getElementById('sell-orders-tbody');
const cascadeHeader = document.getElementById('cascade-header');
const cascadeActions = document.getElementById('cascade-actions');
const listError = document.getElementById('list-error');
const detailError = document.getElementById('detail-error');
const modeBadge = document.getElementById('mode-badge');
const createForm = document.getElementById('create-form');
const createError = document.getElementById('create-error');
const newCascadeBtn = document.getElementById('new-cascade-btn');
const cancelCreateBtn = document.getElementById('cancel-create-btn');

let currentCascadeId = null;

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
  trigger_placed: 'Waiting for Trigger',
  trigger_failed: 'Trigger Failed',
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
  } catch (err) {
    modeBadge.textContent = 'unknown';
  }
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
  listView.hidden = false;
  loadCascadeList();
}

async function showDetail(id) {
  currentCascadeId = id;
  listView.hidden = true;
  detailView.hidden = false;
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
  cascadeHeader.innerHTML = [
    ['Symbol', cascade.symbol],
    ['Status', statusPill(cascade.status)],
    ['Trigger Price', fmtNum(cascade.trigger_price)],
    ['Base Price', fmtNum(cascade.base_price)],
    ['Base Amount USDT', fmtNum(cascade.base_amount_usdt, 2)],
    ['Price Step %', fmtNum(cascade.price_step_pct, 2)],
    ['Amount Step %', fmtNum(cascade.amount_step_pct, 2)],
    ['Take-Profit Base %', fmtNum(cascade.take_profit_base_pct, 2)],
    ['Take-Profit Step %', fmtNum(cascade.take_profit_step_pct, 2)],
    ['Created', fmtDate(cascade.created_at)],
    ['Updated', fmtDate(cascade.updated_at)],
  ]
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

document.getElementById('refresh-list-btn').addEventListener('click', loadCascadeList);
document.getElementById('back-btn').addEventListener('click', showList);

loadStatus();
loadCascadeList();

setInterval(() => {
  if (currentCascadeId) {
    loadDetail(currentCascadeId);
  } else {
    loadCascadeList();
  }
}, 15000);
