const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const dialog = $('#dialog');
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 7h6M9 11h6M9 15h3"/>',
  bowl: '<path d="M3 12h18c-1 6-4 8-9 8s-8-2-9-8ZM8 4v4M12 3v5M16 4v4M6 21h12"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  table: '<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 3v2M16 3v2M8 19v2M16 19v2M1 10h1M22 10h1M1 14h1M22 14h1"/>',
  more: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  stock: '<path d="m3 7 9-4 9 4v10l-9 4-9-4V7Z"/><path d="m3 7 9 4 9-4M12 11v10M7 5l9 4"/>',
  spending: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 13h5M7 3v2"/>',
  chart: '<path d="M4 3v17h17M8 15v-4M13 15V7M18 15V4"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none"/><circle cx="16" cy="17" r="3" fill="currentColor" stroke="none"/>',
  print: '<path d="M7 8V3h10v5M7 17H4V9h16v8h-3"/><path d="M7 14h10v7H7zM17 11h.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14l-1 7Z"/>',
};
const icon = name => `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${paths[name] || paths.receipt}</svg></span>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money = value => new Intl.NumberFormat('en-IN', {style:'currency',currency:'INR',maximumFractionDigits:Number(value || 0) % 100 ? 2 : 0}).format(Number(value || 0) / 100);
const quantity = value => new Intl.NumberFormat('en-IN', {maximumFractionDigits:3}).format(Number(value || 0));
const today = () => {const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part => [part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
const timeLabel = value => value ? new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',minute:'2-digit'}).format(new Date(value)) : '';
const dateLabel = value => value ? new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',year:'numeric'}).format(new Date(value)) : '';
const dateTimeLabel = value => value ? `${dateLabel(value)} · ${timeLabel(value)}` : '';
const clone = value => JSON.parse(JSON.stringify(value));

let auth = null;
let state = null;
let view = 'billing';
let search = '';
let category = 'All';
let selectedDate = today();
let history = [];
let historyPage = 1;
let historyMore = false;
let historyLoaded = false;
let saving = false;
let dirty = false;
let draft = emptyDraft();
let toastTimer;
let paymentMethod = 'UPI';
let lastStateAt = null;
const pending = new Map();

function emptyDraft() { return {id:null,number:null,version:0,status:'Open',tableId:null,lines:[],total:0,payment:null}; }
function totalOf(bill = draft) { return bill.lines.reduce((sum,line) => sum + Number(line.price) * Number(line.qty), 0); }
function currentCount() { return draft.lines.reduce((sum,line) => sum + Number(line.qty), 0); }
function tableName(id) { return state?.tables.find(table => table.id === id)?.name || 'No table'; }
function billNumber(bill) { return bill.number ? `Bill #${bill.number}` : 'New bill'; }
function billPreview(bill) { return bill.lines.map(line => `${line.qty} × ${line.name}${line.variant ? ` (${line.variant})` : ''}`).join(', '); }
function setDraft(bill) { draft = clone(bill); dirty = false; }
function showToast(message, error = false) {
  const toast = $('#toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast${error ? ' error' : ''}`;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 8000 : 4500);
}
function errorText(error) { return error?.message || 'Something went wrong. Please try again.'; }
async function request(path, options = {}) {
  let response;
  try { response = await fetch(path, {credentials:'same-origin',...options}); }
  catch { throw Object.assign(new Error('Could not reach the server. Your current bill is still here. Check your connection, then try again.'), {uncertain:true}); }
  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error('The server did not return a usable reply. Your bill is still here; try again to check whether it saved.'), {uncertain:true}); }
  if (!response.ok) throw Object.assign(new Error(result.error || 'Could not complete this action. Please try again.'), {status:response.status,code:result.code});
  return result;
}
async function mutate(key, path, body) {
  const fingerprint = JSON.stringify(body);
  const unresolved = unresolvedOperation();
  if (unresolved && (unresolved.key !== key || unresolved.fingerprint !== fingerprint)) throw Object.assign(new Error('The previous save still needs checking. Check that save before making another change.'), {operationKey:unresolved.key});
  let operation = pending.get(key);
  if (!operation || operation.fingerprint !== fingerprint) {
    operation = {key,path,body:clone(body),fingerprint,requestId:crypto.randomUUID(),uncertain:false};
    pending.set(key,operation);
  }
  try {
    const result = await request(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,requestId:operation.requestId})});
    pending.delete(key);
    return result;
  } catch (error) {
    if (error.status && error.status < 500) pending.delete(key);
    else {operation.uncertain = true;error.operationKey = key;}
    throw error;
  }
}
function unresolvedOperation() {return [...pending.values()].find(operation => operation.uncertain);}
function showRecovery(operation = unresolvedOperation()) {
  if (!operation) return;
  if (state) render();
  openDialog('Check the previous save', `<p>The server’s reply was not confirmed. Keep this page open and check the original save before changing any details.</p><p>Checking uses the same request, so it will not create a second bill, payment or purchase.</p><button class="button primary full" data-action="retry-save" data-key="${esc(operation.key)}" data-mutate>Check previous save</button><p class="payment-received-note">Your entered details are kept here while the result is checked.</p>`);
}
function busy(active) {
  saving = active;
  document.querySelectorAll('[data-mutate],.food-button,.quantity-control button,.table-button').forEach(button => {
    if (active && !button.disabled) {button.dataset.busyDisabled = 'true';button.disabled = true;}
    if (!active && button.dataset.busyDisabled === 'true') {button.disabled = false;delete button.dataset.busyDisabled;}
  });
}
async function loadState({renderPage = true} = {}) {
  const next = await request(`/api/state?date=${encodeURIComponent(selectedDate)}`);
  state = next;
  lastStateAt = new Date();
  if (renderPage) render();
  return next;
}
async function refresh() {
  try { await loadState({renderPage:false});if (view === 'today') await loadHistory();else render();showToast('Up to date.'); }
  catch (error) { showToast(errorText(error),true); }
}

function renderLogin(error = '') {
  app.innerHTML = `<div class="login-shell">
    <section class="login-story"><div class="brand"><span class="brand-mark">S</span><div class="brand-name">Sattyz Kitchen<small>Your everyday counter</small></div></div>
      <div class="login-copy"><p class="eyebrow">LESS WORK. MORE SERVING.</p><h1>A little simpler.<br>A lot easier.</h1><p>Good food, happy tables, and bills that take just a few taps.</p><div class="login-steps"><span><b>1</b> Pick the food</span><span><b>2</b> Take payment</span><span><b>3</b> Print the bill</span></div></div>
      <div class="login-story-foot">Made for the way your kitchen works.</div>
    </section>
    <main class="login-panel"><div class="login-card"><p class="eyebrow">WELCOME BACK</p><h2>Let’s open the counter.</h2><p>Sign in to see your menu, open bills and today’s numbers.</p>
      ${error ? `<div class="error-box" role="alert">${esc(error)}</div>` : ''}
      ${auth?.googleConfigured ? `<a class="button secondary full" href="/api/google/start"><span class="google-letter" aria-hidden="true">G</span> Continue with Google</a>` : ''}
      ${auth?.localLogin || auth?.temporaryLogin ? `<form id="login-form" class="login-local"><label class="field">${auth.temporaryLogin?'Temporary test password':'Local development password'}<input name="password" type="password" autocomplete="current-password" required minlength="12" placeholder="Enter your password"></label><button class="button primary full" type="submit" data-mutate>${auth.temporaryLogin?'Start testing':'Sign in'}</button><p class="support-text">${auth.temporaryLogin?`Testing access expires ${esc(dateTimeLabel(auth.temporaryUntil))}. Test bills are saved in the hosted database.`:'Local preview only. The hosted app uses the owner’s Google account.'}</p></form>` : ''}
      ${!auth?.googleConfigured && !auth?.localLogin && !auth?.temporaryLogin ? `<div class="helper-banner">${icon('info')}<span>Owner sign-in has not been connected yet. Finish setting up Google sign-in before opening the counter.</span></div>` : ''}
      <p class="login-bottom">Your bills stay together, wherever you sign in.</p>
    </div></main></div>`;
}
function render() {
  if (!auth?.user) return renderLogin();
  if (!state) return;
  const nav = [ ['billing','plus','New bill'], ['open','receipt','Open bills'], ['more','more','More'] ];
  const currentNav = ['billing','open'].includes(view) ? view : 'more';
  const name = state.settings?.name || 'Sattyz Kitchen';
  const labels = {billing:'The counter',open:'Open bills',more:'A little more',today:'Today',stock:'Stock',spending:'Spending',menu:'Your menu',tables:'Tables',settings:'Settings'};
  app.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">S</span><div class="brand-name">${esc(name)}<small>Simple billing</small></div></div><p class="nav-label">YOUR COUNTER</p><nav class="primary-nav" aria-label="Main navigation">${nav.map(([id,image,label]) => `<button class="nav-button${currentNav === id ? ' active' : ''}" data-action="${id === 'billing' ? 'new-bill' : 'navigate'}" data-view="${id}" ${id === 'billing' ? 'data-mutate' : ''} aria-label="${label}" ${currentNav === id ? 'aria-current="page"' : ''}>${icon(image)}<span>${label}</span>${id === 'open' && state.openBills.length ? `<span class="nav-count">${state.openBills.length}</span>` : ''}</button>`).join('')}</nav><div class="sidebar-foot"><div class="online-note"><span class="status-dot"></span> Online counter</div><div class="owner-line">${esc(auth.user.name || 'Owner')}</div><button class="logout-button" data-action="logout">Sign out</button></div></aside>
    <div class="workspace"><header class="topbar"><div><div class="topbar-title">${esc(labels[view] || 'Sattyz Kitchen')}</div><div class="topbar-date">${new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',weekday:'long',day:'numeric',month:'long'}).format(new Date())}</div></div><button class="topbar-badge" data-action="${unresolvedOperation() ? 'check-save' : 'refresh'}" aria-label="${unresolvedOperation() ? 'Check previous save' : 'Refresh online records'}"><span class="status-dot"></span> ${unresolvedOperation() ? 'Save needs checking' : 'Online · Refresh'}</button></header><main class="main-content" id="main-content">${contentForView()}</main></div>
    ${view === 'billing' && draft.lines.length ? `<button class="mobile-cart-button" data-action="view-cart"><span>${icon('receipt')} View bill · ${currentCount()} ${currentCount() === 1 ? 'item' : 'items'}</span><strong>${esc(money(totalOf()))}</strong></button>` : ''}</div>`;
  if (saving) busy(true);
}
function heading(title,description,actions = '',back = true) {
  return `${back ? `<button class="back-link" data-action="navigate" data-view="more">${icon('back')} More</button>` : ''}<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
}
function contentForView() {
  if (view === 'billing') return renderBilling();
  if (view === 'open') return renderOpenBills();
  if (view === 'more') return renderMore();
  if (view === 'today') return renderToday();
  if (view === 'stock') return renderStock();
  if (view === 'spending') return renderSpending();
  if (view === 'menu') return renderMenuManagement();
  if (view === 'tables') return renderTablesManagement();
  if (view === 'settings') return renderSettings();
  return '';
}
function emptyState(image,title,description,action = '') {
  return `<div class="empty-state">${icon(image)}<h3>${title}</h3><p>${description}</p>${action}</div>`;
}
function renderBilling() {
  const categories = ['All',...new Set(state.menu.filter(item => item.available).map(item => item.category))];
  if (!categories.includes(category)) category = 'All';
  return `${heading('Let’s make a bill.','Tap the food. We’ll do the adding up.',draft.id ? `<button class="button secondary" data-action="new-bill" data-mutate>${icon('plus')} New bill</button>` : '',false)}
    <div class="bill-layout"><section class="menu-panel" aria-label="Menu"><div class="search-box">${icon('search')}<input class="search-input" id="menu-search" type="search" placeholder="Find a dish…" value="${esc(search)}" aria-label="Find a dish" autocomplete="off"></div><div class="category-row" role="group" aria-label="Menu categories">${categories.map(name => `<button class="category-button${name === category ? ' active' : ''}" data-action="category" data-category="${esc(name)}" aria-pressed="${name === category}">${esc(name)}</button>`).join('')}</div><div id="menu-results">${renderMenuResults()}</div></section>${renderCart()}</div>`;
}
function renderMenuResults() {
  const term = search.trim().toLocaleLowerCase();
  const items = state.menu.filter(item => item.available && (category === 'All' || item.category === category) && `${item.name} ${item.variant || ''} ${item.category}`.toLocaleLowerCase().includes(term));
  return `<div class="menu-count"><span>${items.length} ${items.length === 1 ? 'dish' : 'dishes'}${category !== 'All' ? ` in ${esc(category)}` : ' on the menu'}</span><span>Tap to add ${icon('plus')}</span></div>${items.length ? `<div class="menu-grid">${items.map(item => { const count = draft.lines.filter(line => line.menuId === item.id).reduce((sum,line) => sum + line.qty,0); return `<button class="food-button" data-action="add-item" data-id="${esc(item.id)}" aria-label="Add ${esc(item.name)}${item.variant ? `, ${esc(item.variant)}` : ''}, ${esc(money(item.price))}" ${draft.status !== 'Open' ? 'disabled' : ''}><span class="food-category">${esc(item.category)}</span>${count ? `<span class="food-added">${count} added</span>` : ''}<span class="food-name">${esc(item.name)}</span><span class="food-variant">${esc(item.variant || 'Standard serve')}</span><span class="food-bottom"><span class="food-price">${esc(money(item.price))}</span><span class="food-add" aria-hidden="true">+</span></span></button>`; }).join('')}</div>` : emptyState('search','No dishes found.','Try another name or choose a different category.')}`;
}
function renderCart() {
  const paid = draft.status === 'Paid';
  const closed = draft.status !== 'Open';
  return `<aside class="cart-panel" id="current-bill" aria-label="Current bill"><div class="cart-head"><div class="cart-title"><h2>Your bill</h2><span class="bill-label">${esc(billNumber(draft))}</span></div><button class="table-button" data-action="choose-table" ${draft.status !== 'Open' ? 'disabled' : ''}><span>${icon('table')} ${esc(tableName(draft.tableId))}</span><span>${draft.tableId ? 'Change' : 'Choose table'} ${icon('arrow')}</span></button></div>
    ${draft.lines.length ? `<div class="cart-lines">${draft.lines.map((line,index) => `<div class="cart-line"><div><div class="cart-item-name">${esc(line.name)}</div><div class="cart-variant">${esc(line.variant || '')}${line.variant ? ' · ' : ''}${esc(money(line.price))} each</div>${!paid ? `<div class="quantity-control"><button data-action="quantity" data-index="${index}" data-delta="-1" aria-label="Remove one ${esc(line.name)}">−</button><span aria-label="Quantity ${line.qty}">${line.qty}</span><button data-action="quantity" data-index="${index}" data-delta="1" aria-label="Add one ${esc(line.name)}">+</button></div>` : `<div class="cart-variant">Quantity: ${line.qty}</div>`}</div><div class="cart-line-price">${esc(money(line.price * line.qty))}</div></div>`).join('')}</div>` : `<div class="cart-empty">${icon('bowl')}<h3>What’s cooking?</h3><p>Tap a dish to start your bill.<br>A table is always optional.</p></div>`}
    <div class="cart-bottom"><div class="total-row"><span>Total${draft.lines.length ? ` · ${currentCount()} ${currentCount() === 1 ? 'item' : 'items'}` : ''}</span><strong>${esc(money(totalOf()))}</strong></div>
      ${closed ? `<button class="button primary full" data-action="print-current">${icon('print')} Print bill</button><button class="button secondary full" data-action="new-bill" data-mutate>${icon('plus')} New bill</button><p class="cart-save-state">${esc(draft.status)}${paid ? ` · ${esc(draft.payment?.method || '')}` : ''}</p>` : `<button class="button primary full" data-action="take-payment" data-mutate ${!draft.lines.length ? 'disabled' : ''}>Take payment ${icon('arrow')}</button><button class="button secondary full" data-action="save-later" data-mutate ${!draft.lines.length ? 'disabled' : ''}>Save for later</button><p class="cart-save-state">${dirty ? 'Changes not saved yet' : draft.id ? 'Saved online' : 'A fresh start. Add your first dish.'}</p>`}
      ${draft.id && !dirty && !paid ? `<button class="text-button quiet full" data-action="print-current">${icon('print')} Print unpaid bill</button>` : ''}
    </div></aside>`;
}
function renderOpenBills() {
  return `${heading('Pick up where you left off.','Open a bill to add food, change its table or take payment.',`<button class="button primary" data-action="new-bill" data-mutate>${icon('plus')} New bill</button>`,false)}${state.openBills.length ? `<div class="card-grid">${state.openBills.map(bill => `<article class="open-bill-card"><div class="card-top"><span class="badge open">Unpaid</span><small>${esc(timeLabel(bill.createdAt))}</small></div><h3>${esc(bill.tableId ? tableName(bill.tableId) : billNumber(bill))}</h3><small>${esc(bill.tableId ? billNumber(bill) : 'No table')}</small><div class="card-amount">${esc(money(bill.total))}</div><p class="item-preview">${esc(billPreview(bill))}</p><button class="button secondary full" data-action="open-bill" data-id="${esc(bill.id)}">Open bill ${icon('arrow')}</button></article>`).join('')}</div>` : emptyState('receipt','No open bills.','Everything is clear. Start a new bill when the next order comes in.',`<button class="button primary" data-action="new-bill" data-mutate>${icon('plus')} Make a bill</button>`)}`;
}
function renderMore() {
  const items = [ ['today','chart','Today','Sales, payments and your saved bills.'],['stock','stock','Stock','See what’s low. Add what you bought.'],['spending','spending','Spending','Keep track of everyday expenses.'],['menu','bowl','Your menu','Change a price or add a new dish.'],['tables','table','Tables','Set up your dining space.'],['settings','settings','Settings','Your shop, printer paper and HDFC device.'] ];
  return `${heading('Everything else, right here.','A few useful things for running your kitchen.','',false)}<div class="more-grid">${items.map(([id,image,title,description]) => `<button class="more-button" data-action="navigate" data-view="${id}">${icon(image)}<h2>${title}</h2><p>${description}</p></button>`).join('')}</div><div class="section-panel"><div class="list-row"><div><div class="list-title">${esc(auth.user.name || 'Owner')}</div><div class="list-meta">${esc(auth.user.email || 'Signed in for this preview')}</div></div><button class="list-action" data-action="logout">Sign out</button></div></div>`;
}
function renderToday() {
  const s = state.summary;
  const cards = [ ['Paid sales',money(s.sales),`${s.paidCount} paid ${s.paidCount === 1 ? 'bill' : 'bills'}`,'highlight'], ['UPI received',money(s.upi),'Cashier-confirmed HDFC payments',''],['Cash & card',money(Number(s.cash) + Number(s.card)),`${money(s.cash)} cash · ${money(s.card)} card`,''],['Spending',money(s.spending),'Includes stock purchases once',''],['Still unpaid',money(s.unpaid),`${state.openBills.length} currently open bills`,''],['Low stock',String(state.stock.filter(item => item.quantity <= item.lowAt).length),'Items at or below their reminder level',''] ];
  const bills = historyLoaded ? history : state.recentBills;
  return `${heading('How’s the day going?','A clear view of the money coming in and going out.',`<label class="visually-hidden" for="report-date">Date</label><input class="date-input" id="report-date" type="date" value="${esc(selectedDate)}" aria-label="Report date">`)}<div class="metrics">${cards.map(([label,value,detail,highlight]) => `<article class="metric-card ${highlight}"><div class="metric-label">${label}${icon(label === 'Low stock' ? 'stock' : label === 'Spending' ? 'spending' : 'receipt')}</div><div class="metric-value">${esc(value)}</div><div class="metric-detail">${esc(detail)}</div></article>`).join('')}</div><p class="support-text">${esc(selectedDate)} · Indian time · Updated ${esc(timeLabel(lastStateAt))}. Unpaid bills and stock show the current position. Sales less spending is not a full profit calculation.</p>
    <section class="section-panel"><div class="section-panel-head"><div><h2>Saved bills</h2><p>Open a bill to see the details or print it again.</p></div><span class="badge">${esc(selectedDate)}</span></div>${bills.length ? bills.map(bill => `<div class="list-row"><div><div class="list-title">${esc(billNumber(bill))} ${bill.tableId ? `· ${esc(tableName(bill.tableId))}` : '· No table'}</div><div class="list-meta">${esc(timeLabel(bill.createdAt))} · <span class="badge ${bill.status.toLowerCase()}">${esc(bill.status)}</span> ${bill.payment ? `· ${esc(bill.payment.method)}` : ''}</div></div><div class="list-side"><span class="list-amount">${esc(money(bill.total))}</span><button class="list-action" data-action="bill-details" data-id="${esc(bill.id)}">View</button></div></div>`).join('') : `<div class="list-row"><p class="muted">No bills for this date.</p></div>`}${!historyLoaded || historyMore ? `<div class="load-more"><button class="button secondary small" data-action="more-history">${historyLoaded ? 'Load more bills' : 'View all bills'}</button></div>` : ''}</section>`;
}
function renderStock() {
  return `${heading('A well-stocked kitchen.','Add purchases and keep an eye on what’s running low.',`<button class="button primary" data-action="stock-form">${icon('plus')} Add item</button>`)}<div class="helper-banner">${icon('info')}<span>Stock is maintained here. Bills do not deduct ingredients automatically. A stock purchase also appears in Spending, once.</span></div>${state.stock.length ? `<div class="card-grid">${state.stock.map(item => `<article class="stock-card${item.quantity <= item.lowAt ? ' low' : ''}"><div class="card-top"><h3>${esc(item.name)}</h3>${item.quantity <= item.lowAt ? '<span class="badge open">Running low</span>' : '<span class="badge paid">In stock</span>'}</div><small>Low-stock reminder at ${esc(quantity(item.lowAt))} ${esc(item.unit)}</small><div class="stock-quantity">${esc(quantity(item.quantity))} <small>${esc(item.unit)} available</small></div><div class="stock-actions"><button class="button soft small" data-action="purchase-form" data-id="${esc(item.id)}">${icon('plus')} Add stock</button><button class="button secondary small" data-action="adjust-form" data-id="${esc(item.id)}">Adjust</button></div><button class="text-button quiet" data-action="stock-form" data-id="${esc(item.id)}">Edit item</button></article>`).join('')}</div>` : emptyState('stock','Start with one stock item.','Add rice, chicken, milk or anything else you want to keep track of.',`<button class="button primary" data-action="stock-form">${icon('plus')} Add stock item</button>`)}`;
}
function renderSpending() {
  return `${heading('Small spends, all together.','Record rent, bills and the other costs of running your kitchen.',`<input class="date-input" id="report-date" type="date" value="${esc(selectedDate)}" aria-label="Spending date"><button class="button primary" data-action="expense-form">${icon('plus')} Add spending</button>`)}<div class="helper-banner">${icon('info')}<span>Stock purchases are already included. Add them through Stock so the purchase is counted once.</span></div>${state.expenses.length ? `<section class="section-panel"><div class="section-panel-head"><h2>Spending · ${esc(selectedDate)}</h2><span class="badge">${state.expenses.length} of ${state.coverage?.expenseCount ?? state.expenses.length}</span></div>${state.expenses.map(expense => `<div class="list-row"><div><div class="list-title">${esc(expense.category)}${expense.source === 'stock' ? ' <span class="badge">Stock purchase</span>' : ''}</div><div class="list-meta">${esc(expense.date)} · ${esc(expense.method)}${expense.note ? ` · ${esc(expense.note)}` : ''}${expense.quantity ? ` · ${esc(quantity(expense.quantity))} ${esc(state.stock.find(item => item.id === expense.stockId)?.unit || '')}` : ''}</div></div><div class="list-side"><span class="list-amount">${esc(money(expense.amount))}</span>${expense.source !== 'stock' ? `<button class="list-action" data-action="expense-form" data-id="${esc(expense.id)}">Edit</button>` : ''}</div></div>`).join('')}</section>` : emptyState('spending','No spending for this date.','Choose another date or add a cost when you pay it.',`<button class="button primary" data-action="expense-form">${icon('plus')} Add spending</button>`)}`;
}
function renderMenuManagement() {
  return `${heading('Your food. Your prices.','The original Sattyz menu, ready for everyday billing.',`<button class="button primary" data-action="menu-form">${icon('plus')} Add dish</button>`)}<div class="helper-banner">${icon('info')}<span>Changing a menu price does not change saved bills. Prices are used as entered. This version does not calculate GST.</span></div><div class="search-box">${icon('search')}<input class="search-input" type="search" id="admin-menu-search" placeholder="Find a dish to edit…" aria-label="Find a dish to edit" autocomplete="off"></div><section class="section-panel" id="admin-menu-results">${renderAdminMenuRows('')}</section>`;
}
function renderAdminMenuRows(term) {
  const items = state.menu.filter(item => `${item.name} ${item.category} ${item.variant}`.toLowerCase().includes(term.toLowerCase()));
  return items.length ? items.map(item => `<div class="list-row"><div><div class="list-title">${esc(item.name)} ${!item.available ? '<span class="badge">Hidden</span>' : ''}</div><div class="list-meta">${esc(item.category)}${item.variant ? ` · ${esc(item.variant)}` : ''}</div></div><div class="list-side"><span class="list-amount">${esc(money(item.price))}</span><button class="list-action" data-action="menu-form" data-id="${esc(item.id)}">Edit</button></div></div>`).join('') : `<div class="list-row"><p class="muted">No matching dishes.</p></div>`;
}
function renderTablesManagement() {
  return `${heading('Make room for everyone.','Table names are all you need. Every bill can also have no table.',`<button class="button primary" data-action="table-form">${icon('plus')} Add table</button>`)}${state.tables.length ? `<div class="table-management">${state.tables.map(table => {const occupied = state.openBills.find(bill => bill.tableId === table.id); return `<article class="table-management-card">${icon('table')}<h3>${esc(table.name)}</h3><span class="badge ${occupied ? 'open' : 'paid'}">${occupied ? `In use · ${esc(billNumber(occupied))}` : 'Available'}</span><div><button class="text-button quiet" data-action="table-form" data-id="${esc(table.id)}">Rename table</button></div></article>`;}).join('')}</div>` : emptyState('table','No tables yet.','Add tables if you need them. You can always bill without one.',`<button class="button primary" data-action="table-form">${icon('plus')} Add table</button>`)}`;
}
function renderSettings() {
  const s = state.settings;
  return `${heading('Set it once. Get on with serving.','A few details for your bills and payment records.')}<form id="settings-form" class="settings-form"><h2 class="settings-subheading">On your receipt</h2><div class="form-grid"><label class="field wide">Shop name<input name="name" value="${esc(s.name)}" maxlength="100" required></label><label class="field wide">Address<textarea name="address" maxlength="400" placeholder="Your restaurant address">${esc(s.address)}</textarea></label><label class="field">Phone number<input name="phone" value="${esc(s.phone)}" maxlength="40" autocomplete="tel"></label><label class="field">Printer paper width<select name="paperWidth"><option value="58" ${Number(s.paperWidth) === 58 ? 'selected' : ''}>58 mm · Small receipt</option><option value="80" ${Number(s.paperWidth) === 80 ? 'selected' : ''}>80 mm · Wide receipt</option></select></label></div><hr class="settings-divider"><h2 class="settings-subheading">HDFC payment device</h2><label class="field">Device name<input name="hdfcDevice" value="${esc(s.hdfcDevice || 'HDFC soundbox / POS')}" maxlength="100" required><small>This name is saved with payments. Confirm receipt on HDFC before marking a bill paid.</small></label><div class="helper-banner">${icon('print')}<span>Install the printer on the device you use for billing. Choose it in the browser’s print dialog and match the paper width. The website does not send commands to a private-network printer.</span></div><button class="button primary" type="submit" data-mutate>${icon('check')} Save settings</button></form>`;
}

function openDialog(title, body) {
  if (dialog.open) dialog.close();
  dialog.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="dialog-close" data-action="close-dialog" aria-label="Close dialog">×</button></div><div class="dialog-body">${body}<div id="dialog-error" role="alert"></div></div>`;
  dialog.showModal();
}
function dialogError(error) {
  const box = $('#dialog-error');
  if (box) {box.className = 'error-box dialog-error';box.textContent = errorText(error);}
  else showToast(errorText(error),true);
}
function field(label,name,value = '',options = {}) {
  return `<label class="field${options.wide ? ' wide' : ''}">${label}<input name="${name}" value="${esc(value)}" type="${options.type || 'text'}" ${options.required === false ? '' : 'required'} ${options.min !== undefined ? `min="${options.min}"` : ''} ${options.step ? `step="${options.step}"` : ''} ${options.maxlength ? `maxlength="${options.maxlength}"` : ''} ${options.placeholder ? `placeholder="${esc(options.placeholder)}"` : ''}>${options.help ? `<small>${options.help}</small>` : ''}</label>`;
}
function methodField(value = 'Cash') {return `<label class="field">Paid with<select name="method">${['Cash','UPI','Card'].map(method => `<option ${method === value ? 'selected' : ''}>${method}</option>`).join('')}</select></label>`;}
function formButtons(label) {return `<div class="form-actions"><button class="button secondary" type="button" data-action="close-dialog">Cancel</button><button class="button primary" type="submit" data-mutate>${label}</button></div>`;}
function openTablePicker() {
  openDialog('Choose a table', `<p>Only if this bill belongs to a table.</p><div class="table-grid"><button class="table-option no-table${!draft.tableId ? ' selected' : ''}" data-action="set-table" data-id="">No table <small>For any order without a table</small></button>${state.tables.map(table => {const bill = state.openBills.find(b => b.tableId === table.id && b.id !== draft.id);return `<button class="table-option${draft.tableId === table.id ? ' selected' : ''}" data-action="set-table" data-id="${esc(table.id)}" ${bill ? 'disabled' : ''}>${esc(table.name)}<small>${bill ? `In use · ${esc(billNumber(bill))}` : 'Available'}</small></button>`;}).join('')}</div>`);
}
function openMenuForm(id) {
  const item = state.menu.find(row => row.id === id) || {name:'',category:'',variant:'',price:0,available:true};
  openDialog(id ? 'Edit dish' : 'Add a dish', `<form id="menu-form" data-id="${esc(id || '')}">${field('Dish name','name',item.name,{maxlength:120})}<div class="form-grid">${field('Category','category',item.category,{maxlength:80})}${field('Size or variant','variant',item.variant,{required:false,maxlength:80})}${field('Price (₹)','price',item.price ? (item.price/100).toFixed(2) : '',{type:'number',min:0,step:'0.01',wide:true})}</div><label class="check-field" style="margin-top:18px"><input name="available" type="checkbox" ${item.available ? 'checked' : ''}> Show on the billing menu</label>${formButtons('Save dish')}</form>`);
}
function openStockForm(id) {
  const item = state.stock.find(row => row.id === id) || {name:'',unit:'kg',lowAt:1};
  openDialog(id ? 'Edit stock item' : 'Add a stock item', `<form id="stock-form" data-id="${esc(id || '')}">${field('Item name','name',item.name,{maxlength:100,placeholder:'For example, Rice'})}<div class="form-grid">${field('Unit','unit',item.unit,{maxlength:20,help:'kg, litres, pieces…'})}${field('Remind me when below','lowAt',item.lowAt,{type:'number',min:0,step:'0.001'})}</div><p class="support-text">${id ? 'This changes the item details, not the quantity.' : 'The item starts at zero. Add stock to record a purchase or use Adjust for your opening count.'}</p>${formButtons('Save item')}</form>`);
}
function openPurchaseForm(id) {
  const item = state.stock.find(row => row.id === id);
  if (!item) return;
  openDialog(`Add ${esc(item.name)}`, `<form id="purchase-form" data-id="${esc(id)}"><p class="muted">This purchase will update stock and record spending once.</p><div class="form-grid">${field(`Quantity (${esc(item.unit)})`,'quantity','',{type:'number',min:'0.001',step:'0.001'})}${field('Total paid (₹)','amount','',{type:'number',min:0,step:'0.01'})}${field('Purchase date','date',today(),{type:'date'})}${methodField()}</div>${field('Note','note','',{required:false,maxlength:300,placeholder:'Shop or purchase details'})}${formButtons('Add stock & spending')}</form>`);
}
function openAdjustForm(id) {
  const item = state.stock.find(row => row.id === id);
  if (!item) return;
  openDialog(`Adjust ${esc(item.name)}`, `<form id="adjust-form" data-id="${esc(id)}"><p>Currently ${esc(quantity(item.quantity))} ${esc(item.unit)}. Use a minus number to remove stock, or a plus number to add it. This does not record spending.</p>${field(`Change in quantity (${esc(item.unit)})`,'delta','',{type:'number',step:'0.001',placeholder:'For example, -2 or 5'})}${field('Reason','note','',{maxlength:300,placeholder:'Opening count, wastage or count correction'})}${formButtons('Save adjustment')}</form>`);
}
function openExpenseForm(id) {
  const item = state.expenses.find(row => row.id === id) || {category:'',amount:0,date:today(),method:'Cash',note:''};
  if (item.source === 'stock') return showToast('This spending belongs to a stock purchase.',true);
  openDialog(id ? 'Edit spending' : 'Add spending', `<form id="expense-form" data-id="${esc(id || '')}">${field('What was it for?','category',item.category,{maxlength:80,placeholder:'Rent, electricity, transport…'})}<div class="form-grid">${field('Amount (₹)','amount',item.amount ? (item.amount/100).toFixed(2) : '',{type:'number',min:'0.01',step:'0.01'})}${field('Date paid','date',item.date,{type:'date'})}${methodField(item.method)}</div>${field('Note','note',item.note,{required:false,maxlength:300})}${formButtons('Save spending')}</form>`);
}
function openTableForm(id) {
  const item = state.tables.find(row => row.id === id);
  openDialog(id ? 'Rename table' : 'Add a table', `<form id="table-form" data-id="${esc(id || '')}">${field('Table name','name',item?.name || '',{maxlength:50,placeholder:'Table 1'})}${formButtons('Save table')}</form>`);
}

async function saveCurrent() {
  if (draft.status !== 'Open') return draft;
  if (!draft.lines.length) throw new Error('Add at least one dish before saving a bill.');
  if (draft.id && !dirty) return draft;
  const body = {id:draft.id || null,version:draft.version || 0,tableId:draft.tableId || null,lines:draft.lines.map(line => ({menuId:line.menuId,qty:line.qty,...(line.lineId ? {lineId:line.lineId} : {})}))};
  const result = await mutate('save-bill','/api/bills/save',body);
  setDraft(result.bill);
  return draft;
}
async function startNewBill() {
  if (draft.status === 'Open' && dirty && draft.lines.length) await saveCurrent();
  if (draft.status === 'Open' && draft.id && dirty && !draft.lines.length) throw new Error('The empty draft has not been saved. Add a dish or cancel the saved bill before starting another.');
  draft = emptyDraft(); dirty = false; search = ''; category = 'All'; view = 'billing';
  await loadState();
}
async function openSavedBill(id) {
  if (draft.id === id && dirty) {view = 'billing';render();window.scrollTo({top:0,behavior:'smooth'});return;}
  if (draft.id !== id && draft.status === 'Open' && dirty && draft.lines.length) await saveCurrent();
  const bill = await request(`/api/bills/${encodeURIComponent(id)}`);
  if (bill.status === 'Paid' || bill.status === 'Cancelled') return openBillDetails(bill);
  setDraft(bill); view = 'billing'; render(); window.scrollTo({top:0,behavior:'smooth'});
}
function openPayment() {
  paymentMethod = 'UPI';
  renderPaymentDialog();
}
function renderPaymentDialog() {
  const total = draft.total ?? totalOf();
  const label = paymentMethod === 'Cash' ? 'Check you have received the full amount in cash.' : paymentMethod === 'Card' ? 'Enter the amount on the HDFC POS machine. Check the successful transaction on the machine before confirming here.' : 'Ask the customer to pay using your HDFC QR or POS. Check the specific successful payment and amount on your HDFC device or merchant app.';
  openDialog('Take payment', `<p class="payment-caption">${esc(billNumber(draft))}${draft.tableId ? ` · ${esc(tableName(draft.tableId))}` : ' · No table'}</p><div class="payment-total">${esc(money(total))}</div><p class="payment-caption">Full bill amount</p><div class="pill-choice-row" role="group" aria-label="Payment method">${['UPI','Cash','Card'].map(method => `<button class="pill-choice${method === paymentMethod ? ' selected' : ''}" data-action="payment-method" data-method="${method}" aria-pressed="${method === paymentMethod}">${method}</button>`).join('')}</div><div class="payment-instruction">${label}</div><form id="payment-form"><details class="extra-details"><summary>Add reference or change device</summary>${paymentMethod !== 'Cash' ? `${field('Payment device','device',state.settings.hdfcDevice || 'HDFC soundbox / POS',{maxlength:100})}${field('Transaction reference','reference','',{required:false,maxlength:100,placeholder:'Optional HDFC transaction ID'})}` : ''}</details><button class="button primary full" type="submit" data-mutate>${icon('check')} Payment received · ${esc(money(total))}</button><p class="payment-received-note">You are confirming receipt. The website has not checked with the bank.</p></form>`);
}
function showPaid(bill) {
  openDialog('Payment saved', `<div class="paid-check">${icon('check')}</div><h3 class="success-title">That’s paid.</h3><p class="success-copy">${esc(money(bill.total))} · ${esc(bill.payment?.method || '')}<br>${esc(billNumber(bill))} is saved online.</p><button class="button primary full" data-action="print-current">${icon('print')} Print bill</button><button class="button secondary full" data-action="paid-new-bill" data-mutate>${icon('plus')} New bill</button><p class="payment-received-note">You can find this bill again in More → Today.</p>`);
}
function openBillDetails(bill) {
  openDialog(esc(billNumber(bill)), `<div class="card-top"><span class="badge ${esc(bill.status.toLowerCase())}">${esc(bill.status)}</span><span class="muted">${esc(tableName(bill.tableId))}</span></div><p class="dialog-date">${esc(dateTimeLabel(bill.createdAt))}</p><div class="receipt-preview">${bill.lines.map(line => `<div class="receipt-preview-row"><span>${line.qty} × ${esc(line.name)}${line.variant ? ` <small>${esc(line.variant)}</small>` : ''}</span><strong>${esc(money(line.total ?? line.price*line.qty))}</strong></div>`).join('')}<div class="receipt-preview-total"><span>Total</span><span>${esc(money(bill.total))}</span></div></div>${bill.payment ? `<p class="support-text">${esc(bill.payment.method)} · ${esc(bill.payment.device || 'Cash')}<br>Confirmed by ${esc(bill.payment.confirmedBy || 'cashier')} · ${esc(dateTimeLabel(bill.payment.receivedAt))}${bill.payment.reference ? `<br>Reference: ${esc(bill.payment.reference)}` : ''}<br>Cashier-confirmed payment</p>` : ''}<button class="button primary full" data-action="print-bill" data-id="${esc(bill.id)}">${icon('print')} ${bill.status === 'Paid' ? 'Print bill again' : 'Print unpaid bill'}</button>${bill.status === 'Open' ? `<button class="button secondary full" data-action="open-bill" data-id="${esc(bill.id)}">Open and edit bill</button><button class="text-button quiet" data-action="cancel-bill-dialog" data-id="${esc(bill.id)}" data-version="${bill.version}">Cancel this unpaid bill</button>` : ''}`);
}
function printBill(bill) {
  const s = bill.receipt || state.settings;
  const width = Number(state.settings.paperWidth) === 80 ? 76 : 54;
  $('#print-root').style.setProperty('--paper-width',`${width}mm`);
  $('#print-root').innerHTML = `<article class="print-receipt"><div class="print-center"><h1>${esc(s.name || 'Sattyz Kitchen')}</h1>${s.address ? `<p>${esc(s.address)}</p>` : ''}${s.phone ? `<p>${esc(s.phone)}</p>` : ''}<hr class="print-rule"><p><strong>${bill.status === 'Paid' ? 'PAID BILL' : bill.status === 'Cancelled' ? 'CANCELLED BILL' : 'UNPAID BILL'}</strong></p></div><p>${esc(billNumber(bill))}<br>${esc(dateTimeLabel(bill.createdAt))}<br>${esc(tableName(bill.tableId))}</p><hr class="print-rule"><table aria-label="Bill items"><tbody>${bill.lines.map(line => `<tr><td>${esc(line.name)}${line.variant ? `<br>${esc(line.variant)}` : ''}<br>${line.qty} × ${esc(money(line.price))}</td><td>${esc(money(line.total ?? line.price*line.qty))}</td></tr>`).join('')}</tbody></table><hr class="print-rule"><div class="print-row print-total"><span>TOTAL</span><span>${esc(money(bill.total))}</span></div>${bill.payment ? `<p>Paid: ${esc(bill.payment.method)}<br>${esc(bill.payment.device || '')}${bill.payment.reference ? `<br>Ref: ${esc(bill.payment.reference)}` : ''}<br>${esc(dateTimeLabel(bill.payment.receivedAt))}</p>` : ''}<hr class="print-rule"><p class="print-center">Thank you. See you again!</p></article>`;
  window.print();
}
async function loadHistory(more = false) {
  const nextPage = more && historyLoaded ? historyPage + 1 : 1;
  const result = await request(`/api/bills?date=${encodeURIComponent(selectedDate)}&page=${nextPage}`);
  history = nextPage === 1 ? result.bills : [...history,...result.bills];
  historyPage = nextPage; historyMore = result.hasMore; historyLoaded = true;
  render();
}
function rupees(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw new Error('Enter an amount with no more than two decimal places.');
  const [whole,fraction = ''] = String(value).split('.');
  const result = Number(whole)*100 + Number(fraction.padEnd(2,'0'));
  if (!Number.isSafeInteger(result)) throw new Error('This amount is too large.');
  return result;
}
async function savedForm(key,path,body,message) {
  await mutate(key,path,body);
  dialog.close(); await loadState(); showToast(message);
}

app.addEventListener('input', event => {
  if (event.target.id === 'menu-search') {search = event.target.value;$('#menu-results').innerHTML = renderMenuResults();}
  if (event.target.id === 'admin-menu-search') $('#admin-menu-results').innerHTML = renderAdminMenuRows(event.target.value);
});
app.addEventListener('change', async event => {
  if (event.target.id !== 'report-date') return;
  selectedDate = event.target.value || today(); historyLoaded = false; history = []; historyPage = 1;
  try {await loadState();if(view === 'today') await loadHistory();} catch (error) {showToast(errorText(error),true);}
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (saving && !['close-dialog','view-cart'].includes(action)) return;
  if (unresolvedOperation() && !['retry-save','check-save','close-dialog','view-cart','refresh','navigate','bill-details','print-current','print-bill','more-history'].includes(action)) return showRecovery();
  try {
    if (action === 'check-save') return showRecovery();
    if (action === 'retry-save') {
      const operation = pending.get(button.dataset.key);
      if (!operation) return dialog.close();
      busy(true);
      const result = await mutate(operation.key,operation.path,operation.body);
      if (result.bill) setDraft(result.bill);
      dialog.close();await loadState();
      if(result.bill?.status === 'Paid') showPaid(result.bill);
      else showToast('The original save is confirmed. You can continue.');
      return;
    }
    if (action === 'close-dialog') return dialog.close();
    if (action === 'refresh') return refresh();
    if (action === 'navigate') {
      view = button.dataset.view;
      render(); window.scrollTo({top:0,behavior:'smooth'});
      if (view === 'today') await loadHistory();
      return;
    }
    if (action === 'category') {category = button.dataset.category;render();return;}
    if (action === 'add-item') {
      if (draft.status !== 'Open') return;
      const item = state.menu.find(row => row.id === button.dataset.id);
      if (!item?.available) return;
      const line = draft.lines.find(row => row.menuId === item.id && row.price === item.price);
      if (line) line.qty += 1;
      else draft.lines.push({menuId:item.id,name:item.name,variant:item.variant,price:item.price,qty:1,total:item.price});
      dirty = true;render();return;
    }
    if (action === 'quantity') {
      const index = Number(button.dataset.index),line = draft.lines[index];
      if (!line || draft.status !== 'Open') return;
      if (line.qty === 1 && Number(button.dataset.delta) < 0 && draft.id && draft.lines.length === 1) {
        openDialog('Remove the whole bill?', `<p>A saved bill needs at least one item. You can cancel this unpaid bill if the order is no longer needed.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Keep bill</button><button class="button danger" data-action="cancel-bill" data-id="${esc(draft.id)}" data-version="${draft.version}" data-mutate>Cancel bill</button></div>`);
        return;
      }
      line.qty += Number(button.dataset.delta);
      if (line.qty <= 0) draft.lines.splice(index,1);
      dirty = true;render();return;
    }
    if (action === 'choose-table') return openTablePicker();
    if (action === 'set-table') {draft.tableId = button.dataset.id || null;dirty = true;dialog.close();render();return;}
    if (action === 'view-cart') return $('#current-bill').scrollIntoView({behavior:'smooth',block:'start'});
    if (action === 'new-bill' || action === 'paid-new-bill') {busy(true);await startNewBill();dialog.close();window.scrollTo({top:0,behavior:'smooth'});return;}
    if (action === 'save-later') {busy(true);await saveCurrent();draft = emptyDraft();dirty = false;await loadState();showToast('Bill saved. Find it in Open bills.');return;}
    if (action === 'take-payment') {busy(true);await saveCurrent();await loadState();openPayment();return;}
    if (action === 'payment-method') {paymentMethod = button.dataset.method;renderPaymentDialog();return;}
    if (action === 'open-bill') {busy(true);dialog.close();await openSavedBill(button.dataset.id);return;}
    if (action === 'bill-details') {openBillDetails(await request(`/api/bills/${encodeURIComponent(button.dataset.id)}`));return;}
    if (action === 'print-current') return printBill(draft);
    if (action === 'print-bill') return printBill(await request(`/api/bills/${encodeURIComponent(button.dataset.id)}`));
    if (action === 'more-history') return loadHistory(true);
    if (action === 'menu-form') return openMenuForm(button.dataset.id);
    if (action === 'stock-form') return openStockForm(button.dataset.id);
    if (action === 'purchase-form') return openPurchaseForm(button.dataset.id);
    if (action === 'adjust-form') return openAdjustForm(button.dataset.id);
    if (action === 'expense-form') return openExpenseForm(button.dataset.id);
    if (action === 'table-form') return openTableForm(button.dataset.id);
    if (action === 'cancel-bill-dialog') {
      openDialog('Cancel unpaid bill?', `<p>This will cancel the bill and free its table. It will stay in the saved history.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Keep bill</button><button class="button danger" data-action="cancel-bill" data-id="${esc(button.dataset.id)}" data-version="${esc(button.dataset.version)}" data-mutate>Cancel bill</button></div>`);return;
    }
    if (action === 'cancel-bill') {
      busy(true);await mutate(`cancel-${button.dataset.id}`,`/api/bills/${encodeURIComponent(button.dataset.id)}/cancel`,{version:Number(button.dataset.version)});
      if (draft.id === button.dataset.id) {draft = emptyDraft();dirty = false;}
      dialog.close();await loadState();showToast('Bill cancelled.');return;
    }
    if (action === 'logout') {
      if (draft.status === 'Open' && dirty && draft.lines.length) await saveCurrent();
      await request('/api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      auth.user = null;state = null;draft = emptyDraft();dirty = false;pending.clear();dialog.close();renderLogin();
    }
  } catch (error) {
    if (error.operationKey && pending.get(error.operationKey)?.uncertain) showRecovery(pending.get(error.operationKey));
    else if (error.status === 409 && draft.id && ['STALE_BILL','BILL_CLOSED','INVALID_LINE'].includes(error.code)) {
      openDialog('This bill has changed', `<p>${esc(errorText(error))}</p><p>Your current choices are still here. Keep them for review, or load the latest saved bill.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Keep my draft</button><button class="button primary" data-action="load-latest" data-id="${esc(draft.id)}">Load saved bill</button></div>`);
    } else if (dialog.open) dialogError(error);
    else showToast(errorText(error),true);
  } finally {busy(false);}
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action="load-latest"]');
  if (!button) return;
  try {const bill = await request(`/api/bills/${encodeURIComponent(button.dataset.id)}`);setDraft(bill);dialog.close();render();} catch (error) {dialogError(error);}
});

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (saving) return;
  const fields = new FormData(form),value = name => String(fields.get(name) || '').trim();
  const id = form.dataset.id || undefined;
  busy(true);
  try {
    if (form.id === 'login-form') {
      await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:fields.get('password')})});
      auth = await request('/api/auth');await loadState();return;
    }
    if (form.id === 'payment-form') {
      const result = await mutate(`pay-${draft.id}`,`/api/bills/${encodeURIComponent(draft.id)}/pay`,{version:draft.version,method:paymentMethod,device:paymentMethod === 'Cash' ? '' : value('device') || state.settings.hdfcDevice || 'HDFC soundbox / POS',reference:paymentMethod === 'Cash' ? '' : value('reference')});
      setDraft(result.bill);historyLoaded = false;await loadState();showPaid(draft);return;
    }
    if (form.id === 'menu-form') return await savedForm('menu','/api/menu/save',{...(id ? {id} : {}),name:value('name'),category:value('category'),variant:value('variant'),price:rupees(value('price')),available:fields.has('available')},'Menu saved. Existing bills keep their prices.');
    if (form.id === 'table-form') return await savedForm('table','/api/tables/save',{...(id ? {id} : {}),name:value('name')},'Table saved.');
    if (form.id === 'stock-form') return await savedForm('stock','/api/stock/save',{...(id ? {id} : {}),name:value('name'),unit:value('unit'),lowAt:Number(value('lowAt'))},'Stock item saved.');
    if (form.id === 'purchase-form') return await savedForm('purchase','/api/stock/purchase',{stockId:id,quantity:Number(value('quantity')),amount:rupees(value('amount')),date:value('date'),method:value('method'),note:value('note')},'Stock added. Spending recorded once.');
    if (form.id === 'adjust-form') return await savedForm('adjust','/api/stock/adjust',{stockId:id,delta:Number(value('delta')),note:value('note')},'Stock adjusted. No spending added.');
    if (form.id === 'expense-form') return await savedForm('expense','/api/expenses/save',{...(id ? {id} : {}),date:value('date'),category:value('category'),amount:rupees(value('amount')),note:value('note'),method:value('method')},'Spending saved.');
    if (form.id === 'settings-form') {
      await mutate('settings','/api/settings',{name:value('name'),address:value('address'),phone:value('phone'),paperWidth:Number(value('paperWidth')),hdfcDevice:value('hdfcDevice')});
      await loadState();showToast('Settings saved.');return;
    }
  } catch (error) {
    if (error.operationKey && pending.get(error.operationKey)?.uncertain) showRecovery(pending.get(error.operationKey));
    else if (form.id === 'login-form') renderLogin(errorText(error));
    else if (dialog.open) dialogError(error);
    else showToast(errorText(error),true);
  } finally {busy(false);}
});
window.addEventListener('beforeunload', event => {
  if ((dirty && draft.lines.length) || unresolvedOperation()) {event.preventDefault();event.returnValue = '';}
});
dialog.addEventListener('click', event => {
  if (event.target === dialog) {const box = dialog.getBoundingClientRect();if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();}
});

async function boot() {
  try {
    auth = await request('/api/auth');
    if (!auth.user) return renderLogin(new URLSearchParams(location.search).get('error') || '');
    await loadState();
  } catch (error) {
    app.innerHTML = `<main class="fatal-panel"><span class="brand-mark">S</span><h1 style="margin-top:24px">Let’s reconnect.</h1><p class="muted">${esc(errorText(error))}</p><button class="button primary" id="retry-boot">Try again</button></main>`;
    $('#retry-boot').addEventListener('click',boot);
  }
}
boot();
