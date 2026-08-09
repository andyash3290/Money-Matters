import { createDataAdapter } from './data-adapter.js';
import { DEFAULT_BUDGET_CONFIG, mergeBudgetConfig, effectiveBucket, bucketOf, ymOf, currentYm,
         monthRange, computeMonth, sinkingBalance, subCapSpend, computeAlerts } from './budget.js';
import { ocrImage, parseSmsText, fingerprintOf } from './scan.js';
import { fetchPriceAED } from './prices.js';

const THEME_KEY = 'expenseDashboard_theme';
const PALETTE = ['#6366f1','#06b6d4','#f59e0b','#ef4444','#10b981','#8b5cf6','#ec4899','#14b8a6','#f97316','#3b82f6','#84cc16','#a855f7','#eab308','#0ea5e9','#f43f5e','#22c55e'];
const ASSET_CATEGORY_LABELS = {bank_savings:'Bank Savings', fixed_deposit:'Fixed Deposit', stocks_funds:'Stocks & Funds', other:'Other'};
const ASSET_CATEGORY_ICONS = {bank_savings:'wallet', fixed_deposit:'lock', stocks_funds:'barchart', other:'gem'};

function icon(name, cls){ return `<svg class="icon ${cls||''}"><use href="#icon-${name}"></use></svg>`; }

const valueState = new Map();
function animateValue(el, to, formatter, duration=700){
  if (!el) return;
  const prev = valueState.get(el) || {value:0, gen:0};
  const gen = prev.gen + 1;
  const from = prev.value;
  valueState.set(el, {value:to, gen});
  if (Math.abs(to-from) < 0.005) { el.textContent = formatter(to); return; }
  const start = performance.now();
  function tick(now){
    if ((valueState.get(el)||{}).gen !== gen) return;
    const t = Math.min(1, (now-start)/duration);
    const eased = 1 - Math.pow(1-t, 3);
    el.textContent = formatter(from + (to-from)*eased);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

let adapter = null;
let transactions = [];
let assets = [];
let assetEntries = [];
let editingId = null;
let editingAssetId = null;
let activeAssetId = null;
let dateRange = {start:null, end:null};
let tableFilters = {search:'', type:'', category:'', method:''};
let sortState = {col:'date', dir:'desc'};
let currentPage = 1;
const PAGE_SIZE = 20;
let listenersWired = false;

let settingsDocs = [];
let budgetConfig = mergeBudgetConfig(null);
let cardMap = [];
let vendorRules = [];
let customCategories = [];
let budgetMonth = currentYm();
const selectedIds = new Set();
let scanCandidates = [];
let lastPriceFetchAt = 0;

function settingsGet(id){ const d = settingsDocs.find(s => s.id === id); return d ? d.data : null; }
function settingsSet(id, data){
  const next = settingsDocs.filter(s => s.id !== id).concat([{ id, data }]);
  adapter.settings.replaceAll(next);
}
function applySettingsDocs(items){
  settingsDocs = items;
  budgetConfig = mergeBudgetConfig(settingsGet('budgetConfig'));
  cardMap = settingsGet('cardMap') || [];
  vendorRules = settingsGet('vendorRules') || [];
  customCategories = settingsGet('categoryList') || [];
}

function allExpenseCategories(){
  return [...new Set([
    ...Object.keys(budgetConfig.categoryMap),
    ...transactions.filter(t => t.type === 'expense').map(t => (t.category || '').trim()).filter(Boolean),
    ...customCategories,
  ])].sort();
}
function sleeveCategories(){ return budgetConfig.savingsSleeves.map(s => s.label); }

function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s); }
function colorFor(name){
  let hash = 0;
  const str = String(name || '');
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}
function fmtMoney(n){
  const v = Number(n) || 0;
  return 'AED ' + v.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}
function fmtMonth(ym){
  const [y,m] = ym.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleString('en-US', {month:'short', year:'numeric'});
}
function isoDate(d){
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function formatShortDate(iso){ const [,m,d] = iso.split('-'); return `${d}/${m}`; }

function donutSvg(entries, centerText, baseTotal){
  const total = entries.reduce((s,e) => s+e.value, 0);
  const denom = Math.max(baseTotal || 0, total);
  const r=70, cx=90, cy=90, sw=28;
  const circ = 2*Math.PI*r;
  let cum = 0;
  let svg = `<svg viewBox="0 0 180 180" width="180" height="180">`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${sw}"/>`;
  if (total > 0 && denom > 0) {
    entries.forEach(e => {
      if (e.value <= 0) return;
      const len = (e.value/denom)*circ;
      svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${e.color}" stroke-width="${sw}" stroke-dasharray="${len} ${circ-len}" stroke-dashoffset="${-cum}" transform="rotate(-90 ${cx} ${cy})"/>`;
      cum += len;
    });
  }
  const label = centerText !== undefined ? centerText : (total > 0 ? fmtMoney(total) : 'No data');
  svg += `<text x="${cx}" y="${cy-2}" text-anchor="middle" class="donut-total">${escapeHtml(label)}</text>`;
  svg += `</svg>`;
  return svg;
}

// ---------- Expenses tab ----------

function allDates(){ return transactions.map(t => t.date).sort(); }

function applyPreset(preset){
  const today = new Date();
  const todayStr = isoDate(today);
  let start, end;
  if (preset === 'thisMonth') { start = isoDate(new Date(today.getFullYear(), today.getMonth(), 1)); end = todayStr; }
  else if (preset === 'lastMonth') {
    const m = today.getMonth(), y = today.getFullYear();
    const lm = m === 0 ? 11 : m - 1, ly = m === 0 ? y - 1 : y;
    start = isoDate(new Date(ly, lm, 1)); end = isoDate(new Date(ly, lm + 1, 0));
  } else if (preset === 'last3') { start = isoDate(new Date(today.getFullYear(), today.getMonth() - 2, 1)); end = todayStr; }
  else if (preset === 'thisYear') { start = isoDate(new Date(today.getFullYear(), 0, 1)); end = todayStr; }
  else { const ds = allDates(); start = ds[0] || todayStr; end = ds[ds.length-1] || todayStr; }
  dateRange = {start, end};
  document.getElementById('rangeStart').value = start;
  document.getElementById('rangeEnd').value = end;
  document.querySelectorAll('.presets button').forEach(b => b.classList.toggle('active', b.dataset.preset === preset));
  render();
}

function periodTransactions(){ return transactions.filter(t => t.date >= dateRange.start && t.date <= dateRange.end); }
function tableTransactions(){
  let list = periodTransactions();
  const f = tableFilters;
  if (f.search) {
    const s = f.search.toLowerCase();
    list = list.filter(t => (t.description||'').toLowerCase().includes(s) || (t.notes||'').toLowerCase().includes(s) || (t.category||'').toLowerCase().includes(s));
  }
  if (f.type) list = list.filter(t => t.type === f.type);
  if (f.category) list = list.filter(t => t.category === f.category);
  if (f.method) list = list.filter(t => t.method === f.method);
  list = list.slice().sort((a,b) => {
    let av = a[sortState.col], bv = b[sortState.col];
    if (sortState.col === 'amount') { av = Number(av); bv = Number(bv); }
    if (av < bv) return sortState.dir === 'asc' ? -1 : 1;
    if (av > bv) return sortState.dir === 'asc' ? 1 : -1;
    return 0;
  });
  return list;
}

function renderSummary(){
  const list = periodTransactions();
  const income = list.filter(t => t.type === 'income').reduce((s,t) => s + Number(t.amount), 0);
  const expense = list.filter(t => t.type === 'expense').reduce((s,t) => s + Number(t.amount), 0);
  const savings = income - expense;
  const rate = income > 0 ? (savings / income * 100) : 0;
  animateValue(document.getElementById('sumIncome'), income, fmtMoney);
  animateValue(document.getElementById('sumExpense'), expense, fmtMoney);
  const savEl = document.getElementById('sumSavings');
  animateValue(savEl, savings, fmtMoney);
  savEl.classList.toggle('negative', savings < 0);
  savEl.classList.toggle('positive', savings >= 0);
  const rateEl = document.getElementById('sumRate');
  animateValue(rateEl, rate, v => v.toFixed(1) + '%');
  rateEl.classList.toggle('negative', rate < 0);
  rateEl.classList.toggle('positive', rate >= 0);
}

function renderDonut(){
  const list = periodTransactions().filter(t => t.type === 'expense');
  const byCat = {};
  list.forEach(t => { byCat[t.category] = (byCat[t.category]||0) + Number(t.amount); });
  let sorted = Object.entries(byCat).sort((a,b) => b[1]-a[1]);
  let top = sorted.slice(0,7);
  const restSum = sorted.slice(7).reduce((s,e) => s+e[1], 0);
  if (restSum > 0) top.push(['Other', restSum]);
  const entries = top.map(([cat,val]) => ({label:cat, value:val, color: cat==='Other' ? '#94a3b8' : colorFor(cat)}));
  document.getElementById('donutWrap').innerHTML = donutSvg(entries);
  const total = entries.reduce((s,e)=>s+e.value,0);
  document.getElementById('donutLegend').innerHTML = entries.map(e => {
    const pct = total > 0 ? (e.value/total*100).toFixed(1) : '0';
    return `<div class="legend-item" data-cat="${escapeAttr(e.label)}"><span class="dot" style="background:${e.color}"></span>${escapeHtml(e.label)}<span class="legend-val">${fmtMoney(e.value)} (${pct}%)</span></div>`;
  }).join('') || '<div class="empty">No expenses in this period</div>';
  document.querySelectorAll('#donutLegend .legend-item').forEach(el => {
    el.addEventListener('click', () => {
      const cat = el.dataset.cat;
      if (cat === 'Other') return;
      tableFilters.category = cat;
      document.getElementById('filterCategory').value = cat;
      currentPage = 1;
      renderTable();
      document.querySelector('.table-section').scrollIntoView({behavior:'smooth'});
    });
  });
}

function renderMonthlyBar(){
  const list = periodTransactions();
  const byMonth = {};
  list.forEach(t => {
    const ym = t.date.slice(0,7);
    byMonth[ym] = byMonth[ym] || {income:0, expense:0};
    byMonth[ym][t.type] += Number(t.amount);
  });
  const months = Object.keys(byMonth).sort();
  if (months.length === 0) { document.getElementById('monthlyBarWrap').innerHTML = '<div class="empty">No data</div>'; return; }
  const maxVal = Math.max(1, ...months.map(m => Math.max(byMonth[m].income, byMonth[m].expense)));
  const chartH = 160, barW = 16, groupW = 56, gap = 10;
  const width = Math.max(300, months.length*groupW + gap);
  let svg = `<svg viewBox="0 0 ${width} 200" width="100%" height="200" preserveAspectRatio="xMinYMid meet">`;
  months.forEach((m,i) => {
    const {income, expense} = byMonth[m];
    const x0 = gap + i*groupW;
    const hInc = (income/maxVal)*chartH, hExp = (expense/maxVal)*chartH;
    const baseline = chartH + 10;
    svg += `<rect x="${x0}" y="${baseline-hInc}" width="${barW}" height="${hInc}" fill="#10b981" rx="2"/>`;
    svg += `<rect x="${x0+barW+4}" y="${baseline-hExp}" width="${barW}" height="${hExp}" fill="#ef4444" rx="2"/>`;
    svg += `<text x="${x0+barW+2}" y="${baseline+14}" text-anchor="middle" class="axis-label">${fmtMonth(m)}</text>`;
  });
  svg += `</svg>`;
  document.getElementById('monthlyBarWrap').innerHTML = svg;
}

function smoothPath(pts){
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)} L${pts[1][0].toFixed(1)},${pts[1][1].toFixed(1)}`;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i=0; i<pts.length-1; i++){
    const p0 = pts[i===0?0:i-1], p1 = pts[i], p2 = pts[i+1], p3 = pts[Math.min(i+2,pts.length-1)];
    const cp1x = p1[0]+(p2[0]-p0[0])/6, cp1y = p1[1]+(p2[1]-p0[1])/6;
    const cp2x = p2[0]-(p3[0]-p1[0])/6, cp2y = p2[1]-(p3[1]-p1[1])/6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

let chartIdSeq = 0;
function lineChartSvg(labels, values, color){
  const w=600, h=180, pad=30;
  const maxV = Math.max(1, ...values);
  const stepX = values.length > 1 ? (w-2*pad)/(values.length-1) : 0;
  const pts = values.map((v,i) => [pad + i*stepX, h-pad - (v/maxV)*(h-2*pad)]);
  const gradId = 'lineGrad' + (chartIdSeq++);
  let svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="200" preserveAspectRatio="xMinYMid meet">`;
  svg += `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.32"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`;
  svg += `<line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="var(--border)"/>`;
  if (pts.length > 0) {
    const linePath = smoothPath(pts);
    const areaPath = `${linePath} L${pts[pts.length-1][0].toFixed(1)},${h-pad} L${pts[0][0].toFixed(1)},${h-pad} Z`;
    svg += `<path d="${areaPath}" fill="url(#${gradId})" stroke="none"/>`;
    svg += `<path d="${linePath}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" filter="drop-shadow(0 2px 4px ${color}55)"/>`;
    const last = pts[pts.length-1];
    svg += `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4.5" fill="${color}" stroke="var(--card-bg)" stroke-width="2"/>`;
  }
  svg += `<text x="${pad}" y="${h-8}" class="axis-label">${labels[0] ? labels[0] : ''}</text>`;
  svg += `<text x="${w-pad}" y="${h-8}" text-anchor="end" class="axis-label">${labels[labels.length-1] ? labels[labels.length-1] : ''}</text>`;
  svg += `</svg>`;
  return svg;
}

function renderTrend(){
  const list = periodTransactions().filter(t => t.type === 'expense');
  const byDay = {};
  list.forEach(t => { byDay[t.date] = (byDay[t.date]||0) + Number(t.amount); });
  const start = dateRange.start, end = dateRange.end;
  if (!start || !end) { document.getElementById('trendWrap').innerHTML = '<div class="empty">No data</div>'; return; }
  const days = [];
  let d = new Date(start + 'T00:00:00');
  const endD = new Date(end + 'T00:00:00');
  while (d <= endD) { days.push(isoDate(d)); d.setDate(d.getDate()+1); }
  let labels = days, values = days.map(dt => byDay[dt] || 0);
  if (days.length > 45) {
    const weekly = [], weekLabels = [];
    for (let i=0; i<days.length; i+=7) {
      const chunk = days.slice(i, i+7);
      weekly.push(chunk.reduce((s,dt) => s+(byDay[dt]||0), 0));
      weekLabels.push(chunk[0]);
    }
    labels = weekLabels; values = weekly;
  }
  document.getElementById('trendWrap').innerHTML = lineChartSvg(labels.map(formatShortDate), values, '#6366f1');
}

function renderMethodBars(){
  const list = periodTransactions().filter(t => t.type === 'expense' && t.method);
  const byMethod = {};
  list.forEach(t => { byMethod[t.method] = (byMethod[t.method]||0) + Number(t.amount); });
  const entries = Object.entries(byMethod).sort((a,b) => b[1]-a[1]);
  const max = Math.max(1, ...entries.map(e => e[1]));
  document.getElementById('methodBars').innerHTML = entries.map(([m,v]) => `
    <div class="method-row">
      <div class="method-label">${escapeHtml(m)}</div>
      <div class="method-bar-track"><div class="method-bar-fill" style="width:${(v/max*100).toFixed(1)}%; background:${colorFor(m)}"></div></div>
      <div class="method-value">${fmtMoney(v)}</div>
    </div>`).join('') || '<div class="empty">No data</div>';
}

function renderTable(){
  const list = tableTransactions();
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const startIdx = (currentPage-1) * PAGE_SIZE;
  const pageItems = list.slice(startIdx, startIdx + PAGE_SIZE);
  document.getElementById('txTbody').innerHTML = pageItems.map(t => {
    const ovr = t.bucketOverride ? `<span class="ovr-badge" title="Bucket override: ${escapeAttr((bucketOf(budgetConfig, t.bucketOverride)||{}).label || t.bucketOverride)}">${icon('sliders')}</span>` : '';
    return `
    <tr>
      <td class="chk-col"><input type="checkbox" class="row-check" data-id="${t.id}" ${selectedIds.has(t.id)?'checked':''}></td>
      <td>${t.date}</td>
      <td><span class="badge ${t.type}">${t.type}</span></td>
      <td><span class="dot" style="background:${colorFor(t.category)}"></span> ${escapeHtml(t.category)}${ovr}</td>
      <td>${escapeHtml(t.description)}</td>
      <td class="amount ${t.type}">${fmtMoney(t.amount)}</td>
      <td>${escapeHtml(t.method)}</td>
      <td class="notes" title="${escapeAttr(t.notes)}">${escapeHtml(t.notes)}</td>
      <td class="actions">
        <button class="icon-btn edit-btn" data-id="${t.id}" title="Edit">${icon('edit')}</button>
        <button class="icon-btn delete-btn" data-id="${t.id}" title="Delete">${icon('trash')}</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">No transactions found</td></tr>';

  document.getElementById('pagination').innerHTML = `
    <button id="prevPage" ${currentPage<=1?'disabled':''}>Prev</button>
    <span>Page ${currentPage} of ${totalPages} (${list.length} entries)</span>
    <button id="nextPage" ${currentPage>=totalPages?'disabled':''}>Next</button>
  `;
  document.getElementById('prevPage').onclick = () => { currentPage--; renderTable(); };
  document.getElementById('nextPage').onclick = () => { currentPage++; renderTable(); };
  document.querySelectorAll('.edit-btn').forEach(b => b.onclick = () => openEditModal(b.dataset.id));
  document.querySelectorAll('.delete-btn').forEach(b => b.onclick = () => deleteTransaction(b.dataset.id));
  document.querySelectorAll('.row-check').forEach(cb => cb.onchange = () => {
    if (cb.checked) selectedIds.add(cb.dataset.id); else selectedIds.delete(cb.dataset.id);
    updateBulkBar();
  });
  const checkAll = document.getElementById('checkAll');
  checkAll.checked = pageItems.length > 0 && pageItems.every(t => selectedIds.has(t.id));
  checkAll.onchange = () => {
    pageItems.forEach(t => { if (checkAll.checked) selectedIds.add(t.id); else selectedIds.delete(t.id); });
    renderTable(); updateBulkBar();
  };
  updateSortIndicators();
}

function updateBulkBar(){
  const bar = document.getElementById('bulkBar');
  bar.classList.toggle('hidden', selectedIds.size === 0);
  document.getElementById('bulkCount').textContent = `${selectedIds.size} selected`;
  const spendables = budgetConfig.buckets.filter(b => !['unmapped'].includes(b.id));
  document.getElementById('bulkBucket').innerHTML = spendables.map(b => `<option value="${b.id}">${escapeHtml(b.label)}</option>`).join('');
  document.getElementById('bulkCategory').innerHTML = allExpenseCategories().map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
}

function updateSortIndicators(){
  document.querySelectorAll('#txTable th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc','sort-desc');
    if (th.dataset.sort === sortState.col) th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

function refreshOptionLists(){
  const cats = [...new Set(transactions.map(t => t.category))].sort();
  const methods = [...new Set(transactions.map(t => t.method).filter(Boolean))].sort();
  document.getElementById('filterCategory').innerHTML = '<option value="">All Categories</option>' + cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
  document.getElementById('filterMethod').innerHTML = '<option value="">All Methods</option>' + methods.map(m => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join('');
  document.getElementById('methodList').innerHTML = methods.map(m => `<option value="${escapeAttr(m)}">`).join('');
  document.getElementById('filterCategory').value = tableFilters.category;
  document.getElementById('filterMethod').value = tableFilters.method;
}

// Category dropdown is a fixed list per type; "+ Add new category" keeps it
// controlled but extensible (persisted to settings so it syncs).
function populateCategorySelect(type, selectedValue){
  const sel = document.getElementById('fCategory');
  let options;
  if (type === 'income') options = ['Income'];
  else if (type === 'savings') options = sleeveCategories();
  else options = allExpenseCategories();
  if (selectedValue && !options.includes(selectedValue)) options = [selectedValue, ...options];
  sel.innerHTML = options.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('') +
    (type === 'expense' ? '<option value="__new__">+ Add new category…</option>' : '');
  sel.value = selectedValue || options[0] || '';
}

function populateBucketSelect(tx){
  const wrap = document.getElementById('fBucketWrap');
  const sel = document.getElementById('fBucket');
  const type = document.getElementById('fType').value;
  wrap.style.display = type === 'income' ? 'none' : '';
  const autoBucket = effectiveBucket({ type, category: document.getElementById('fCategory').value, bucketOverride: null }, budgetConfig);
  const autoLabel = (bucketOf(budgetConfig, autoBucket) || {}).label || autoBucket || '—';
  sel.innerHTML = `<option value="auto">Auto — ${escapeHtml(autoLabel)}</option>` +
    budgetConfig.buckets.filter(b => b.id !== 'unmapped').map(b => `<option value="${b.id}">${escapeHtml(b.label)}</option>`).join('');
  sel.value = (tx && tx.bucketOverride) ? tx.bucketOverride : 'auto';
}

function updateSubtitle(){
  const ds = allDates();
  const el = document.getElementById('subtitle');
  if (ds.length === 0) { el.textContent = 'No transactions yet'; return; }
  el.textContent = `${transactions.length} transactions tracked • ${ds[0]} to ${ds[ds.length-1]}`;
}

function render(){
  updateSubtitle();
  renderSummary();
  renderDonut();
  renderMonthlyBar();
  renderTrend();
  renderMethodBars();
  renderTable();
  renderBudget();
}

function openAddModal(){
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Add Transaction';
  document.getElementById('txForm').reset();
  document.getElementById('fDate').value = isoDate(new Date());
  document.getElementById('fType').value = 'expense';
  populateCategorySelect('expense');
  populateBucketSelect(null);
  document.getElementById('modalOverlay').classList.remove('hidden');
  document.getElementById('fCategory').focus();
}
function openEditModal(id){
  const t = transactions.find(x => x.id === id);
  if (!t) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Transaction';
  document.getElementById('fType').value = t.type;
  document.getElementById('fDate').value = t.date;
  populateCategorySelect(t.type, t.category);
  document.getElementById('fDescription').value = t.description || '';
  document.getElementById('fAmount').value = t.amount;
  document.getElementById('fMethod').value = t.method || '';
  document.getElementById('fNotes').value = t.notes || '';
  populateBucketSelect(t);
  document.getElementById('modalOverlay').classList.remove('hidden');
}
function closeModal(){ document.getElementById('modalOverlay').classList.add('hidden'); editingId = null; }

function deleteTransaction(id){
  if (!confirm('Delete this transaction?')) return;
  adapter.transactions.remove(id);
}

function csvEscape(v){ const s = String(v ?? ''); if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"'; return s; }
function downloadFile(content, filename, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function exportCsv(){
  const list = tableTransactions();
  const header = ['Date','Type','Category','Description','Amount (AED)','Payment Method','Notes'];
  const rows = list.map(t => [t.date,t.type,t.category,t.description,t.amount,t.method,t.notes]);
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  downloadFile(csv, 'expenses_export.csv', 'text/csv');
}
function exportJsonBackup(){
  downloadFile(JSON.stringify({transactions, assets, assetEntries}, null, 2), 'expense_dashboard_backup.json', 'application/json');
}
function importJsonFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const txList = Array.isArray(data) ? data : data.transactions;
      if (!Array.isArray(txList)) throw new Error('Expected a transactions array');
      if (!confirm(`Import ${txList.length} transaction records? This will replace all current data.`)) return;
      adapter.transactions.replaceAll(txList);
      if (data.assets) adapter.assets.replaceAll(data.assets);
      if (data.assetEntries) adapter.assetEntries.replaceAll(data.assetEntries);
      applyPreset('all');
    } catch(e) { alert('Could not import file: ' + e.message); }
  };
  reader.readAsText(file);
}
function resetToImported(){
  if (!confirm('Reset all transactions back to the originally imported spreadsheet data? This discards any manual edits to transactions (accounts/investments are not affected).')) return;
  import('./seed-data.js').then(({SEED_TRANSACTIONS}) => adapter.transactions.replaceAll(SEED_TRANSACTIONS.slice()));
}

function setThemeButtonLabel(t){
  document.getElementById('themeToggle').innerHTML = (t === 'dark' ? icon('sun') + ' Light mode' : icon('moon') + ' Dark mode');
}
function loadTheme(){
  const t = localStorage.getItem(THEME_KEY) || 'light';
  document.documentElement.dataset.theme = t;
  setThemeButtonLabel(t);
}
function toggleTheme(){
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  setThemeButtonLabel(next);
  render(); renderNetWorth();
}

// ---------- Net Worth tab ----------

function currentBalance(assetId){ return computeBalanceAt(assetId, null); }

// A holding (ticker + shares) is valued live: shares × price in AED, preferring
// a manual override, then the last fetched price; falls back to entry balances.
function isHolding(a){ return !!(a.ticker && Number(a.shares) > 0); }
function holdingPriceAED(a){
  const manual = Number(a.manualPriceAED);
  if (manual > 0) return { price: manual, source: 'manual' };
  const last = Number(a.lastPriceAED);
  if (last > 0) return { price: last, source: 'live' };
  return null;
}
function assetValue(a){
  if (isHolding(a)) {
    const p = holdingPriceAED(a);
    if (p) return Number(a.shares) * p.price;
  }
  return currentBalance(a.id);
}
function computeBalanceAt(assetId, asOfDate){
  const entries = assetEntries
    .filter(e => e.assetId === assetId && (!asOfDate || e.date <= asOfDate))
    .slice()
    .sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  let balance = 0;
  for (const e of entries) {
    const amt = Number(e.amount) || 0;
    if (e.kind === 'snapshot') balance = amt;
    else if (e.kind === 'deposit' || e.kind === 'buy' || e.kind === 'interest' || e.kind === 'dividend') balance += amt;
    else if (e.kind === 'withdrawal' || e.kind === 'sell') balance -= amt;
  }
  return balance;
}

function renderNetWorthSummary(){
  const byCat = {bank_savings:0, fixed_deposit:0, stocks_funds:0, other:0};
  let total = 0;
  assets.forEach(a => { const bal = assetValue(a); byCat[a.category] = (byCat[a.category]||0) + bal; total += bal; });
  animateValue(document.getElementById('nwTotal'), total, fmtMoney);
  animateValue(document.getElementById('nwBank'), byCat.bank_savings, fmtMoney);
  animateValue(document.getElementById('nwFixed'), byCat.fixed_deposit, fmtMoney);
  animateValue(document.getElementById('nwStocks'), byCat.stocks_funds, fmtMoney);
}

function renderNetWorthDonut(){
  const byCat = {};
  assets.forEach(a => { byCat[a.category] = (byCat[a.category]||0) + assetValue(a); });
  const entries = Object.entries(byCat).filter(([,v]) => v > 0).map(([cat,val]) => ({label: ASSET_CATEGORY_LABELS[cat]||cat, value: val, color: colorFor(cat)}));
  document.getElementById('nwDonutWrap').innerHTML = donutSvg(entries);
  const total = entries.reduce((s,e)=>s+e.value,0);
  document.getElementById('nwDonutLegend').innerHTML = entries.map(e => {
    const pct = total > 0 ? (e.value/total*100).toFixed(1) : '0';
    return `<div class="legend-item"><span class="dot" style="background:${e.color}"></span>${escapeHtml(e.label)}<span class="legend-val">${fmtMoney(e.value)} (${pct}%)</span></div>`;
  }).join('') || '<div class="empty">No accounts yet</div>';
}

function renderNetWorthAccountBars(){
  const entries = assets.map(a => ({name:a.name, value:assetValue(a)})).sort((a,b) => b.value-a.value);
  const max = Math.max(1, ...entries.map(e => e.value));
  document.getElementById('nwAccountBars').innerHTML = entries.map(e => `
    <div class="method-row">
      <div class="method-label">${escapeHtml(e.name)}</div>
      <div class="method-bar-track"><div class="method-bar-fill" style="width:${Math.max(0,(e.value/max*100)).toFixed(1)}%; background:${colorFor(e.name)}"></div></div>
      <div class="method-value">${fmtMoney(e.value)}</div>
    </div>`).join('') || '<div class="empty">No accounts yet</div>';
}

function renderNetWorthTrend(){
  if (assets.length === 0 || assetEntries.length === 0) { document.getElementById('nwTrendWrap').innerHTML = '<div class="empty">Add a balance entry to see your trend</div>'; return; }
  const allEntryDates = assetEntries.map(e => e.date).sort();
  const start = allEntryDates[0];
  const today = isoDate(new Date());
  const months = [];
  let d = new Date(start.slice(0,7) + '-01T00:00:00');
  const endD = new Date(today.slice(0,7) + '-01T00:00:00');
  while (d <= endD) { months.push(isoDate(d).slice(0,7)); d.setMonth(d.getMonth()+1); }
  const values = months.map(ym => {
    const monthEnd = new Date(ym + '-01T00:00:00'); monthEnd.setMonth(monthEnd.getMonth()+1); monthEnd.setDate(0);
    const asOf = isoDate(monthEnd);
    return assets.reduce((s,a) => s + computeBalanceAt(a.id, asOf), 0);
  });
  document.getElementById('nwTrendWrap').innerHTML = lineChartSvg(months.map(fmtMonth), values, '#10b981');
}

function renderAssetGrid(){
  document.getElementById('assetGrid').innerHTML = assets.map(a => {
    const bal = assetValue(a);
    let holdingHtml = '';
    if (isHolding(a)) {
      const p = holdingPriceAED(a);
      const priceTxt = p ? `${Number(a.shares)} × ${fmtMoney(p.price)}${p.source==='manual'?' (manual)':''}` : `${Number(a.shares)} shares — no price yet`;
      let plHtml = '';
      const buy = Number(a.buyPriceAED);
      if (p && buy > 0) {
        const cost = Number(a.shares) * buy;
        const pl = bal - cost;
        const plPct = cost > 0 ? (pl / cost * 100) : 0;
        plHtml = `<span class="pl-chip ${pl >= 0 ? 'up' : 'down'}">${pl >= 0 ? '▲' : '▼'} ${fmtMoney(Math.abs(pl))} (${plPct.toFixed(1)}%)</span>`;
      }
      const staleTxt = (!Number(a.manualPriceAED) && a.lastPriceAt) ? `<span class="hint"> · ${escapeHtml(a.ticker)} @ ${new Date(a.lastPriceAt).toLocaleString([], {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'})}</span>` : '';
      holdingHtml = `<div class="holding-line">${escapeHtml(priceTxt)}${plHtml}${staleTxt}</div>`;
    }
    return `
    <div class="asset-card">
      <div class="asset-card-head">
        <div>
          <div class="asset-name">${escapeHtml(a.name)}</div>
          <div class="asset-meta">${escapeHtml(a.institution||'')}${a.ticker?` · ${escapeHtml(a.ticker)}${a.exchange?' ('+escapeHtml(a.exchange)+')':''}`:''}</div>
        </div>
        <span class="category-pill">${icon(ASSET_CATEGORY_ICONS[a.category]||'gem')}${escapeHtml(ASSET_CATEGORY_LABELS[a.category]||a.category)}</span>
      </div>
      <div class="asset-balance">${fmtMoney(bal)}</div>
      ${holdingHtml}
      <div class="asset-actions">
        <button class="icon-btn add-entry-btn" data-id="${a.id}">${icon('plus')} Entry</button>
        <button class="icon-btn history-btn" data-id="${a.id}">${icon('clock')} History</button>
        <button class="icon-btn edit-asset-btn" data-id="${a.id}">${icon('edit')} Edit</button>
        <button class="icon-btn delete-asset-btn" data-id="${a.id}">${icon('trash')} Delete</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">No accounts or investments yet. Click "+ Add Account/Investment" to start.</div>';

  document.querySelectorAll('.add-entry-btn').forEach(b => b.onclick = () => openEntryModal(b.dataset.id));
  document.querySelectorAll('.history-btn').forEach(b => b.onclick = () => openAssetDetail(b.dataset.id));
  document.querySelectorAll('.edit-asset-btn').forEach(b => b.onclick = () => openEditAssetModal(b.dataset.id));
  document.querySelectorAll('.delete-asset-btn').forEach(b => b.onclick = () => deleteAsset(b.dataset.id));
}

function renderNetWorth(){
  renderNetWorthSummary();
  renderNetWorthDonut();
  renderNetWorthAccountBars();
  renderNetWorthTrend();
  renderAssetGrid();
}

function openAddAssetModal(){
  editingAssetId = null;
  document.getElementById('assetModalTitle').textContent = 'Add Account/Investment';
  document.getElementById('assetForm').reset();
  document.getElementById('assetModalOverlay').classList.remove('hidden');
}
function openEditAssetModal(id){
  const a = assets.find(x => x.id === id);
  if (!a) return;
  editingAssetId = id;
  document.getElementById('assetModalTitle').textContent = 'Edit Account/Investment';
  document.getElementById('aName').value = a.name;
  document.getElementById('aCategory').value = a.category;
  document.getElementById('aInstitution').value = a.institution || '';
  document.getElementById('aTicker').value = a.ticker || '';
  document.getElementById('aExchange').value = a.exchange || '';
  document.getElementById('aShares').value = a.shares ?? '';
  document.getElementById('aBuyPrice').value = a.buyPriceAED ?? '';
  document.getElementById('aBuyDate').value = a.buyDate || '';
  document.getElementById('aManualPrice').value = a.manualPriceAED ?? '';
  document.getElementById('assetModalOverlay').classList.remove('hidden');
}
function closeAssetModal(){ document.getElementById('assetModalOverlay').classList.add('hidden'); editingAssetId = null; }
function deleteAsset(id){
  if (!confirm('Delete this account/investment and all its history?')) return;
  assetEntries.filter(e => e.assetId === id).forEach(e => adapter.assetEntries.remove(e.id));
  adapter.assets.remove(id);
}

function openEntryModal(assetId){
  activeAssetId = assetId;
  document.getElementById('entryForm').reset();
  document.getElementById('eDate').value = isoDate(new Date());
  document.getElementById('eKind').value = 'snapshot';
  document.getElementById('entryModalTitle').textContent = 'Add Entry — ' + (assets.find(a=>a.id===assetId)||{}).name;
  document.getElementById('entryModalOverlay').classList.remove('hidden');
}
function closeEntryModal(){ document.getElementById('entryModalOverlay').classList.add('hidden'); activeAssetId = null; }

function openAssetDetail(assetId){
  const a = assets.find(x => x.id === assetId);
  if (!a) return;
  document.getElementById('assetDetailTitle').textContent = a.name + ' — History';
  const entries = assetEntries.filter(e => e.assetId === assetId).slice().sort((x,y) => x.date < y.date ? 1 : -1);
  document.getElementById('assetDetailBody').innerHTML = `
    <table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Note</th><th></th></tr></thead><tbody>
    ${entries.map(e => `<tr>
        <td>${e.date}</td>
        <td>${escapeHtml(e.kind)}</td>
        <td>${fmtMoney(e.amount)}</td>
        <td>${escapeHtml(e.note||'')}</td>
        <td><button class="icon-btn delete-entry-btn" data-id="${e.id}" title="Delete">${icon('trash')}</button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">No entries yet</td></tr>'}
    </tbody></table>`;
  document.querySelectorAll('.delete-entry-btn').forEach(b => b.onclick = () => {
    if (confirm('Delete this entry?')) { adapter.assetEntries.remove(b.dataset.id); openAssetDetail(assetId); }
  });
  document.getElementById('assetDetailOverlay').classList.remove('hidden');
}

// ---------- Budget tab ----------

function fmtMoney0(n){ return 'AED ' + (Number(n)||0).toLocaleString('en-US', {maximumFractionDigits:0}); }

function aggregateMonths(months){
  const results = months.map(m => computeMonth(transactions, budgetConfig, m));
  const agg = { income:0, spent:0, logged:0, byBucket:{}, bySleeve:{} };
  for (const r of results) {
    agg.income += r.income; agg.spent += r.spent; agg.logged += r.logged;
    for (const [b, rec] of Object.entries(r.byBucket)) {
      const t = agg.byBucket[b] || (agg.byBucket[b] = { spent:0, byCategory:{} });
      t.spent += rec.spent;
      for (const [c, v] of Object.entries(rec.byCategory)) t.byCategory[c] = (t.byCategory[c]||0) + v;
    }
    for (const [k, v] of Object.entries(r.bySleeve)) agg.bySleeve[k] = (agg.bySleeve[k]||0) + v;
  }
  agg.residual = agg.income - agg.spent;
  agg.savingsDisplay = agg.logged > 0 ? agg.logged : agg.residual;
  return agg;
}

function fillClass(spent, budget){
  if (budget <= 0) return spent > 0 ? 'red' : 'green';
  const pct = spent / budget;
  if (pct > 1) return 'red';
  if (pct >= 0.8) return 'amber';
  return 'green';
}

function paceLabel(fillFrac, paceFrac){
  const d = fillFrac - paceFrac;
  if (d > 0.05) return { txt: 'ahead of pace', cls: 'pace-bad' };
  if (d < -0.05) return { txt: 'behind pace', cls: 'pace-good' };
  return { txt: 'on pace', cls: 'pace-ok' };
}

function renderBudget(){
  if (!document.getElementById('budgetTiles') || !adapter) return;
  const cfg = budgetConfig;
  const now = new Date();
  const nowYm = currentYm(now);
  const allTime = budgetMonth === 'all';
  const months = allTime ? monthRange(cfg.firstMonth, nowYm) : [budgetMonth];
  const n = Math.max(1, months.length);
  const agg = aggregateMonths(months);
  const isCur = !allTime && budgetMonth === nowYm;
  const day = now.getDate(), daysIn = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const paceFrac = isCur ? day / daysIn : 1;
  const baseline = cfg.monthlyIncome * n;
  const savTarget = bucketOf(cfg, 'savings_investment').budget * n;
  const sinkBal = sinkingBalance(transactions, cfg, allTime ? nowYm : budgetMonth);
  const projected = isCur ? agg.spent / Math.max(day,1) * daysIn : agg.spent;

  document.getElementById('budgetAllTimeBtn').classList.toggle('active', allTime);

  // Tiles
  const savPct = savTarget > 0 ? (agg.savingsDisplay / savTarget * 100) : 0;
  document.getElementById('budgetTiles').innerHTML = `
    <div class="card"><div class="card-icon income">${icon('trending-up')}</div><div class="card-label">Income ${isCur?'MTD':''}</div><div class="card-value">${fmtMoney0(agg.income)}</div></div>
    <div class="card"><div class="card-icon expense">${icon('trending-down')}</div><div class="card-label">Spent ${isCur?'MTD':''}</div><div class="card-value">${fmtMoney0(agg.spent)}</div></div>
    <div class="card"><div class="card-icon rate">${icon('clock')}</div><div class="card-label">Projected month-end</div><div class="card-value">${isCur ? fmtMoney0(projected) : '—'}</div></div>
    <div class="card"><div class="card-icon savings">${icon('wallet')}</div><div class="card-label">Savings vs ${fmtMoney0(savTarget)}</div><div class="card-value ${agg.savingsDisplay>=0?'positive':'negative'}">${fmtMoney0(agg.savingsDisplay)} <span class="tile-sub">(${savPct.toFixed(0)}%)</span></div></div>
    <div class="card"><div class="card-icon networth">${icon('landmark')}</div><div class="card-label">Sinking Fund balance</div><div class="card-value ${sinkBal>=0?'positive':'negative'}">${fmtMoney0(sinkBal)}</div></div>`;

  // Donut — % of income consumed per bucket, savings as the remaining arc
  const donutEntries = cfg.buckets
    .filter(b => b.id !== 'savings_investment')
    .map(b => ({ label: b.label, value: Math.max(0, (agg.byBucket[b.id]||{}).spent || 0), color: b.color }))
    .filter(e => e.value > 0);
  if (agg.savingsDisplay > 0) donutEntries.push({ label: 'Savings & Investment', value: agg.savingsDisplay, color: bucketOf(cfg,'savings_investment').color });
  const spentPct = baseline > 0 ? Math.round(agg.spent / baseline * 100) : 0;
  document.getElementById('budgetDonutWrap').innerHTML = donutSvg(donutEntries, `${spentPct}% spent`, baseline);
  document.getElementById('budgetDonutLegend').innerHTML = donutEntries.map(e => {
    const pct = baseline > 0 ? (e.value / baseline * 100).toFixed(1) : '0';
    return `<div class="legend-item"><span class="dot" style="background:${e.color}"></span>${escapeHtml(e.label)}<span class="legend-val">${fmtMoney0(e.value)} (${pct}% of income)</span></div>`;
  }).join('') || '<div class="empty">No data for this month</div>';

  // Savings panel — residual vs logged side by side, plus the three sleeves
  const sleeves = cfg.savingsSleeves.map(s => {
    const loggedAmt = agg.bySleeve[s.label] || 0;
    const target = s.target * n;
    return `<div class="sleeve-row">
      <div class="sleeve-label">${escapeHtml(s.label)}</div>
      <div class="method-bar-track"><div class="method-bar-fill ${loggedAmt >= target ? 'green-bg' : ''}" style="width:${Math.min(100, target>0 ? loggedAmt/target*100 : 0).toFixed(1)}%; background:${bucketOf(cfg,'savings_investment').color}"></div></div>
      <div class="sleeve-vals">${fmtMoney0(loggedAmt)} / ${fmtMoney0(target)}</div>
    </div>`;
  }).join('');
  document.getElementById('savingsPanel').innerHTML = `
    <div class="savings-headline ${agg.savingsDisplay>=0?'positive':'negative'}">${fmtMoney0(agg.savingsDisplay)} <span class="tile-sub">of ${fmtMoney0(savTarget)} target</span></div>
    <div class="savings-duo">
      <div><span class="hint">Residual (income − expenses)</span><br><strong>${fmtMoney0(agg.residual)}</strong></div>
      <div><span class="hint">Logged transfers</span><br><strong>${fmtMoney0(agg.logged)}</strong>${agg.logged>0?`<span class="hint"> gap ${fmtMoney0(agg.residual-agg.logged)}</span>`:''}</div>
    </div>
    <div class="sleeves">${sleeves}</div>
    ${agg.logged>0?'':'<div class="hint-block">Showing the residual — log actual transfers with the "Savings & Investment" transaction type to track intended vs actual.</div>'}`;

  // Bucket bars
  let barsHtml = '';
  for (const b of cfg.buckets) {
    const spent = (agg.byBucket[b.id]||{}).spent || 0;
    if (b.id === 'unmapped' && spent === 0) continue;
    const isSavings = b.id === 'savings_investment';
    const isSinking = !!b.rolling;
    const value = isSavings ? agg.savingsDisplay : spent;
    const budget = b.budget * n;
    const fillFrac = budget > 0 ? Math.max(0, value / budget) : (value > 0 ? 1 : 0);
    let cls;
    if (isSavings) cls = fillFrac >= paceFrac * 0.999 ? 'green' : (fillFrac >= paceFrac * 0.6 ? 'amber' : 'red');
    else if (isSinking) cls = sinkBal < 0 ? 'red' : 'green';
    else cls = fillClass(value, budget);
    const pctTxt = budget > 0 ? `${(fillFrac*100).toFixed(0)}%` : (value > 0 ? '—' : '0%');
    let paceHtml = '';
    if (isCur && budget > 0 && !isSinking && b.id !== 'debt_service') {
      const p = isSavings
        ? (fillFrac >= paceFrac - 0.05 ? {txt:'on track', cls:'pace-good'} : {txt:'behind target', cls:'pace-bad'})
        : paceLabel(fillFrac, paceFrac);
      paceHtml = `<span class="pace-chip ${p.cls}">${p.txt}</span>`;
    }
    const warnHtml = b.id === 'unmapped' ? `<span class="pace-chip pace-bad">${icon('alert')} unmapped</span>` : '';
    const balHtml = isSinking ? `<span class="pace-chip ${sinkBal>=0?'pace-good':'pace-bad'}">balance ${fmtMoney0(sinkBal)}</span>` : '';

    // Detail: category breakdown + sub-caps
    const byCat = Object.entries((agg.byBucket[b.id]||{}).byCategory || {}).sort((a,c) => c[1]-a[1]);
    const catRows = byCat.map(([c,v]) => `<div class="cat-row"><span class="dot" style="background:${colorFor(c)}"></span>${escapeHtml(c)}<span class="legend-val">${fmtMoney0(v)}</span></div>`).join('') || '<div class="empty">Nothing here this period</div>';
    let capsHtml = '';
    const defs = cfg.subCaps[b.id] || [];
    if (defs.length) {
      const byCatMap = (agg.byBucket[b.id]||{}).byCategory || {};
      const capSpends = defs.map(d => d.categories.reduce((s,c) => s + (byCatMap[c]||0), 0));
      const nonBufferSum = defs.reduce((s,d,i) => d.buffer ? s : s + capSpends[i], 0);
      capsHtml = '<div class="subcaps">' + defs.map((d,i) => {
        const sp = d.buffer ? Math.max(0, spent - nonBufferSum) : capSpends[i];
        const isFloor = d.floor != null;
        const limit = (isFloor ? d.floor : d.cap) * n;
        const frac = limit > 0 ? sp / limit : 0;
        const cCls = isFloor ? (sp >= limit * paceFrac ? 'green' : 'amber') : fillClass(sp, limit);
        return `<div class="subcap-row">
          <div class="subcap-label">${escapeHtml(d.label)} <span class="hint">${isFloor ? '≥' : '≤'} ${fmtMoney0(limit)}</span></div>
          <div class="method-bar-track"><div class="bucket-fill ${cCls}" style="width:${Math.min(100, frac*100).toFixed(1)}%"></div></div>
          <div class="sleeve-vals">${fmtMoney0(sp)}</div>
        </div>`;
      }).join('') + '</div>';
    }

    barsHtml += `
    <div class="bucket-row" data-bucket="${b.id}">
      <button type="button" class="bucket-head">
        <span class="dot" style="background:${b.color}"></span>
        <span class="bucket-name">${escapeHtml(b.label)}${b.legacy ? ' <span class="hint">(legacy)</span>' : ''}</span>
        ${paceHtml}${balHtml}${warnHtml}
        <span class="bucket-nums">${fmtMoney0(value)} / ${budget>0?fmtMoney0(budget):'0'} <span class="hint">(${pctTxt})</span></span>
        ${icon('chevron','chev')}
      </button>
      <div class="bucket-track">
        <div class="bucket-fill ${cls}" style="width:${Math.min(100, fillFrac*100).toFixed(1)}%"></div>
        ${isCur && budget>0 && !isSinking ? `<div class="pace-line" style="left:${(paceFrac*100).toFixed(1)}%"></div>` : ''}
      </div>
      <div class="bucket-detail hidden">${catRows}${capsHtml}</div>
    </div>`;
  }
  document.getElementById('bucketBars').innerHTML = barsHtml;
  document.querySelectorAll('.bucket-head').forEach(h => h.onclick = () => {
    h.parentElement.querySelector('.bucket-detail').classList.toggle('hidden');
    h.parentElement.classList.toggle('open');
  });

  renderBudgetTrend();

  // Leak alerts (month view only — pick a month for actionable alerts)
  const alertsEl = document.getElementById('leakAlerts');
  if (allTime) {
    alertsEl.innerHTML = '<div class="empty">Pick a specific month to see its leak alerts.</div>';
  } else {
    const alerts = computeAlerts(transactions, cfg, budgetMonth, now);
    alertsEl.innerHTML = alerts.map(a => `
      <div class="alert-row ${a.sev}">${icon(a.sev==='info'?'search':'alert')}<span>${escapeHtml(a.text)}</span></div>
    `).join('') || `<div class="alert-row ok">${icon('check')}<span>No leaks detected — all buckets look healthy.</span></div>`;
  }
}

function renderBudgetTrend(){
  const cfg = budgetConfig;
  const months = monthRange(cfg.firstMonth, currentYm());
  if (!months.length) { document.getElementById('budgetTrendWrap').innerHTML = '<div class="empty">No data</div>'; return; }
  const stackOrder = cfg.buckets.filter(b => b.id !== 'savings_investment');
  const savB = bucketOf(cfg, 'savings_investment');
  const results = months.map(m => computeMonth(transactions, cfg, m));
  const totals = results.map(r => Math.max(0, r.spent) + Math.max(0, r.savingsDisplay));
  const yMax = Math.max(cfg.monthlyIncome, ...totals) * 1.1;
  const barW = 30, gap = 16, padL = 8, padB = 26, chartH = 190;
  const w = padL*2 + months.length * (barW + gap);
  const h = chartH + padB + 10;
  let svg = `<svg viewBox="0 0 ${w} ${h}" width="${Math.max(320, w)}" height="${h}" preserveAspectRatio="xMinYMid meet">`;
  const incomeY = 10 + chartH - (cfg.monthlyIncome / yMax) * chartH;
  months.forEach((m, i) => {
    const r = results[i];
    const x = padL + i * (barW + gap);
    let y = 10 + chartH;
    for (const b of stackOrder) {
      const v = Math.max(0, (r.byBucket[b.id]||{}).spent || 0);
      if (v <= 0) continue;
      const hh = (v / yMax) * chartH;
      y -= hh;
      svg += `<rect x="${x}" y="${y.toFixed(1)}" width="${barW}" height="${hh.toFixed(1)}" fill="${b.color}" rx="1.5"/>`;
    }
    const sv = Math.max(0, r.savingsDisplay);
    if (sv > 0) {
      const hh = (sv / yMax) * chartH;
      y -= hh;
      svg += `<rect x="${x}" y="${y.toFixed(1)}" width="${barW}" height="${hh.toFixed(1)}" fill="${savB.color}" opacity="0.55" rx="1.5"/>`;
    }
    svg += `<text x="${x + barW/2}" y="${10 + chartH + 14}" text-anchor="middle" class="axis-label">${fmtMonth(m)}</text>`;
  });
  svg += `<line x1="${padL}" y1="${incomeY.toFixed(1)}" x2="${w-padL}" y2="${incomeY.toFixed(1)}" stroke="var(--text-soft)" stroke-dasharray="5 4" stroke-width="1.2"/>`;
  svg += `<text x="${w-padL}" y="${(incomeY-4).toFixed(1)}" text-anchor="end" class="axis-label">${fmtMoney0(cfg.monthlyIncome)}</text>`;
  svg += `</svg>`;
  document.getElementById('budgetTrendWrap').innerHTML = svg;
  document.getElementById('budgetTrendLegend').innerHTML = [...stackOrder, savB]
    .map(b => `<span class="trend-chip"><span class="dot" style="background:${b.color}"></span>${escapeHtml(b.label)}</span>`).join('');
}

// ---------- Budget settings ----------

function openSettings(){
  const cfg = budgetConfig;
  const cats = allExpenseCategories();
  const methods = [...new Set([...transactions.map(t => t.method).filter(Boolean), ...cardMap.map(c => c.method)])].sort();
  const bucketOpts = sel => cfg.buckets.filter(b => b.id !== 'unmapped').map(b => `<option value="${b.id}" ${sel===b.id?'selected':''}>${escapeHtml(b.label)}</option>`).join('');
  const subCapRows = bid => (cfg.subCaps[bid]||[]).map((d,i) => `
    <div class="settings-row"><label>${escapeHtml(d.label)} <span class="hint">${d.floor!=null?'floor':'cap'}</span></label>
    <input type="number" class="set-subcap" data-bucket="${bid}" data-idx="${i}" value="${d.floor!=null?d.floor:d.cap}"></div>`).join('');

  document.getElementById('settingsBody').innerHTML = `
    <h4>Income &amp; bucket budgets (AED/month)</h4>
    <div class="settings-row"><label>Monthly income baseline</label><input type="number" id="setIncome" value="${cfg.monthlyIncome}"></div>
    ${cfg.buckets.filter(b => b.id!=='unmapped').map(b => `
      <div class="settings-row"><label><span class="dot" style="background:${b.color}"></span> ${escapeHtml(b.label)}</label>
      <input type="number" class="set-budget" data-bucket="${b.id}" value="${b.budget}"></div>`).join('')}
    <div class="hint-block" id="setBudgetSum"></div>
    <h4>Category → bucket mapping</h4>
    <div class="settings-scroll">
    ${cats.map(c => `<div class="settings-row"><label>${escapeHtml(c)}</label>
      <select class="set-map" data-cat="${escapeAttr(c)}">${bucketOpts(cfg.categoryMap[c])}<option value="" ${!cfg.categoryMap[c]?'selected':''}>— Unmapped —</option></select></div>`).join('')}
    </div>
    <h4>Sub-caps — Food</h4>${subCapRows('food')}
    <h4>Sub-caps — Lifestyle &amp; Personal</h4>${subCapRows('lifestyle_personal')}
    <h4>Card → payment method</h4>
    <div id="cardMapRows">${cardMap.map((c,i) => `
      <div class="settings-row card-map-row"><input type="text" class="cm-last4" maxlength="4" placeholder="last 4" value="${escapeAttr(c.last4)}">
      <input type="text" class="cm-method" placeholder="payment method" list="cmMethods" value="${escapeAttr(c.method)}">
      <button type="button" class="icon-btn cm-del">${icon('trash')}</button></div>`).join('')}</div>
    <datalist id="cmMethods">${methods.map(m => `<option value="${escapeAttr(m)}">`).join('')}</datalist>
    <button type="button" class="icon-btn" id="cardMapAdd">${icon('plus')} Add card</button>
    <h4>Vendor auto-categorisation rules</h4>
    <div id="vendorRuleRows">${vendorRules.map(r => `
      <div class="settings-row card-map-row"><input type="text" class="vr-pattern" placeholder="vendor contains…" value="${escapeAttr(r.pattern)}">
      <select class="vr-cat">${cats.map(c => `<option value="${escapeAttr(c)}" ${r.category===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}</select>
      <button type="button" class="icon-btn vr-del">${icon('trash')}</button></div>`).join('')}</div>
    <button type="button" class="icon-btn" id="vendorRuleAdd">${icon('plus')} Add rule</button>
    <h4>Advanced</h4>
    <div class="settings-row"><label>Sinking Fund opening balance (Feb 2026)</label><input type="number" id="setSinkOpen" value="${cfg.sinkingFundOpeningBalance}"></div>
    <div class="settings-row"><label>Price proxy URL <span class="hint">{url} = target</span></label><input type="text" id="setProxy" value="${escapeAttr(cfg.priceProxy)}"></div>`;

  const updateSum = () => {
    const total = [...document.querySelectorAll('.set-budget')].reduce((s,el) => s + (parseFloat(el.value)||0), 0);
    const inc = parseFloat(document.getElementById('setIncome').value) || 0;
    const el = document.getElementById('setBudgetSum');
    el.textContent = `Buckets sum to ${fmtMoney0(total)} vs income ${fmtMoney0(inc)} (${total===inc?'exact match ✓':(total>inc?fmtMoney0(total-inc)+' over':fmtMoney0(inc-total)+' unallocated')})`;
  };
  document.querySelectorAll('.set-budget').forEach(el => el.addEventListener('input', updateSum));
  document.getElementById('setIncome').addEventListener('input', updateSum);
  updateSum();

  const wireRowDeletes = () => {
    document.querySelectorAll('.cm-del').forEach(b => b.onclick = () => b.closest('.card-map-row').remove());
    document.querySelectorAll('.vr-del').forEach(b => b.onclick = () => b.closest('.card-map-row').remove());
  };
  wireRowDeletes();
  document.getElementById('cardMapAdd').onclick = () => {
    document.getElementById('cardMapRows').insertAdjacentHTML('beforeend',
      `<div class="settings-row card-map-row"><input type="text" class="cm-last4" maxlength="4" placeholder="last 4">
       <input type="text" class="cm-method" placeholder="payment method" list="cmMethods">
       <button type="button" class="icon-btn cm-del">${icon('trash')}</button></div>`);
    wireRowDeletes();
  };
  document.getElementById('vendorRuleAdd').onclick = () => {
    document.getElementById('vendorRuleRows').insertAdjacentHTML('beforeend',
      `<div class="settings-row card-map-row"><input type="text" class="vr-pattern" placeholder="vendor contains…">
       <select class="vr-cat">${cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('')}</select>
       <button type="button" class="icon-btn vr-del">${icon('trash')}</button></div>`);
    wireRowDeletes();
  };
  document.getElementById('settingsOverlay').classList.remove('hidden');
}

function saveSettings(){
  const cfg = structuredClone(budgetConfig);
  cfg.monthlyIncome = parseFloat(document.getElementById('setIncome').value) || cfg.monthlyIncome;
  document.querySelectorAll('.set-budget').forEach(el => {
    const b = cfg.buckets.find(x => x.id === el.dataset.bucket);
    if (b) b.budget = parseFloat(el.value) || 0;
  });
  const newMap = {};
  document.querySelectorAll('.set-map').forEach(el => { if (el.value) newMap[el.dataset.cat] = el.value; });
  cfg.categoryMap = newMap;
  document.querySelectorAll('.set-subcap').forEach(el => {
    const d = (cfg.subCaps[el.dataset.bucket]||[])[Number(el.dataset.idx)];
    if (!d) return;
    const v = parseFloat(el.value) || 0;
    if (d.floor != null) d.floor = v; else d.cap = v;
  });
  cfg.sinkingFundOpeningBalance = parseFloat(document.getElementById('setSinkOpen').value) || 0;
  cfg.priceProxy = document.getElementById('setProxy').value.trim() || cfg.priceProxy;

  const cards = [...document.querySelectorAll('#cardMapRows .card-map-row')].map(r => ({
    last4: r.querySelector('.cm-last4').value.trim(),
    method: r.querySelector('.cm-method').value.trim(),
  })).filter(c => /^\d{4}$/.test(c.last4) && c.method);
  const rules = [...document.querySelectorAll('#vendorRuleRows .card-map-row')].map(r => ({
    pattern: r.querySelector('.vr-pattern').value.trim(),
    category: r.querySelector('.vr-cat').value,
  })).filter(r => r.pattern);

  settingsSet('budgetConfig', {
    monthlyIncome: cfg.monthlyIncome,
    buckets: cfg.buckets.map(b => ({ id: b.id, budget: b.budget })),
    categoryMap: cfg.categoryMap,
    subCaps: cfg.subCaps,
    sinkingFundOpeningBalance: cfg.sinkingFundOpeningBalance,
    priceProxy: cfg.priceProxy,
  });
  settingsSet('cardMap', cards);
  settingsSet('vendorRules', rules);
  document.getElementById('settingsOverlay').classList.add('hidden');
}

// ---------- Data clean-up ----------

function normDesc(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function levenshtein(a, b){
  if (Math.abs(a.length - b.length) > 2) return 99;
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return dp[m][n];
}

function computeDescGroups(){
  const byNorm = new Map();
  for (const t of transactions) {
    if (t.type === 'income') continue;
    const raw = (t.description || '').trim();
    if (!raw) continue;
    const k = normDesc(raw);
    if (!byNorm.has(k)) byNorm.set(k, new Map());
    const inner = byNorm.get(k);
    inner.set(raw, (inner.get(raw) || 0) + 1);
  }
  const keys = [...byNorm.keys()];
  const parent = new Map(keys.map(k => [k, k]));
  const find = k => { let r = k; while (parent.get(r) !== r) r = parent.get(r); parent.set(k, r); return r; };
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++)
      if (keys[i][0] === keys[j][0] && levenshtein(keys[i], keys[j]) <= 2)
        parent.set(find(keys[i]), find(keys[j]));
  const clusters = new Map();
  for (const k of keys) {
    const r = find(k);
    if (!clusters.has(r)) clusters.set(r, new Map());
    for (const [raw, c] of byNorm.get(k)) clusters.get(r).set(raw, (clusters.get(r).get(raw)||0) + c);
  }
  return [...clusters.values()]
    .filter(m => m.size >= 2)
    .map(m => [...m.entries()].sort((a,b) => b[1]-a[1]))
    .sort((a,b) => b.reduce((s,e)=>s+e[1],0) - a.reduce((s,e)=>s+e[1],0))
    .slice(0, 25);
}

function computeCrossCategory(){
  const map = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    const raw = (t.description || '').trim();
    if (!raw) continue;
    const k = normDesc(raw);
    if (!map.has(k)) map.set(k, { sample: raw, cats: new Map() });
    const rec = map.get(k);
    rec.cats.set(t.category, (rec.cats.get(t.category)||0) + 1);
  }
  return [...map.values()].filter(r => r.cats.size >= 2).slice(0, 25);
}

function openCleanup(){
  const groups = computeDescGroups();
  const cross = computeCrossCategory();
  const cats = allExpenseCategories();
  const body = document.getElementById('cleanupBody');
  body.innerHTML = `
    <h4>Suspected duplicate labels</h4>
    ${groups.length ? groups.map((g, gi) => `
      <div class="cleanup-group" data-gi="${gi}">
        ${g.map(([raw, count], i) => `
          <label class="cleanup-opt"><input type="radio" name="grp${gi}" value="${escapeAttr(raw)}" ${i===0?'checked':''}>
          ${escapeHtml(raw)} <span class="hint">(${count}×)</span></label>`).join('')}
        <button type="button" class="icon-btn merge-btn" data-gi="${gi}">${icon('check')} Merge into selected</button>
      </div>`).join('') : '<div class="empty">No near-duplicate description labels found.</div>'}
    <h4>Same description, different categories</h4>
    ${cross.length ? cross.map((r, ri) => `
      <div class="cleanup-group" data-ri="${ri}">
        <div><strong>${escapeHtml(r.sample)}</strong> — ${[...r.cats.entries()].map(([c,n]) => `${escapeHtml(c)} (${n}×)`).join(', ')}</div>
        <div style="display:flex; gap:8px; margin-top:6px;">
          <select class="cross-cat-sel">${cats.map(c => `<option value="${escapeAttr(c)}" ${r.cats.has(c) && [...r.cats.entries()].sort((a,b)=>b[1]-a[1])[0][0]===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}</select>
          <button type="button" class="icon-btn cross-apply-btn" data-ri="${ri}">${icon('check')} Unify</button>
        </div>
      </div>`).join('') : '<div class="empty">No cross-category descriptions found.</div>'}`;

  body.querySelectorAll('.merge-btn').forEach(btn => btn.onclick = () => {
    const gi = Number(btn.dataset.gi);
    const canonical = body.querySelector(`input[name="grp${gi}"]:checked`).value;
    const norms = new Set(groups[gi].map(([raw]) => normDesc(raw)));
    let count = 0;
    for (const t of transactions) {
      const raw = (t.description || '').trim();
      if (raw && raw !== canonical && norms.has(normDesc(raw))) { adapter.transactions.update(t.id, { description: canonical }); count++; }
    }
    btn.textContent = `Merged ${count} rows ✓`;
    btn.disabled = true;
  });
  body.querySelectorAll('.cross-apply-btn').forEach(btn => btn.onclick = () => {
    const ri = Number(btn.dataset.ri);
    const target = btn.parentElement.querySelector('.cross-cat-sel').value;
    const key = normDesc(cross[ri].sample);
    let count = 0;
    for (const t of transactions) {
      if (t.type === 'expense' && normDesc(t.description) === key && t.category !== target) { adapter.transactions.update(t.id, { category: target }); count++; }
    }
    btn.textContent = `Unified ${count} rows ✓`;
    btn.disabled = true;
  });
  document.getElementById('cleanupOverlay').classList.remove('hidden');
}

// ---------- SMS scan ----------

function openScan(){
  scanCandidates = [];
  document.getElementById('scanResults').innerHTML = '';
  document.getElementById('scanProgress').textContent = '';
  document.getElementById('scanText').value = '';
  document.getElementById('scanFiles').value = '';
  document.getElementById('scanInsertBtn').classList.add('hidden');
  document.getElementById('scanOverlay').classList.remove('hidden');
}

function showScanCandidates(raw){
  const fpExisting = new Set(transactions.map(t => t.fingerprint).filter(Boolean));
  const seen = new Set();
  const cats = allExpenseCategories();
  const methods = [...new Set([...transactions.map(t => t.method).filter(Boolean), ...cardMap.map(c => c.method)])].sort();
  scanCandidates = raw.map(c => {
    const fp = fingerprintOf(c);
    const dup = fpExisting.has(fp) || seen.has(fp);
    seen.add(fp);
    const rule = vendorRules.find(r => c.vendor && r.pattern && c.vendor.toLowerCase().includes(r.pattern.toLowerCase()));
    const card = cardMap.find(cm => cm.last4 && cm.last4 === c.last4);
    return { ...c, fp, dup, category: rule ? rule.category : 'Misc Expenses', method: card ? card.method : '' };
  });
  document.getElementById('scanResults').innerHTML = scanCandidates.length ? scanCandidates.map((c, i) => `
    <div class="scan-card ${c.dup ? 'dup' : ''}">
      <div class="scan-card-head">
        <label><input type="checkbox" class="sc-use" data-i="${i}" ${c.dup ? '' : 'checked'}> Use</label>
        ${c.dup ? `<span class="dup-badge">${icon('alert')} already recorded — skipped</span>` : ''}
        ${c.isCredit ? '<span class="badge income">refund/credit</span>' : ''}
      </div>
      <div class="scan-grid">
        <label>Date<input type="date" class="sc-date" data-i="${i}" value="${c.date || isoDate(new Date())}"></label>
        <label>Amount<input type="number" step="0.01" class="sc-amount" data-i="${i}" value="${c.amount}"></label>
        <label>Description<input type="text" class="sc-desc" data-i="${i}" value="${escapeAttr(c.vendor || '')}"></label>
        <label>Category<select class="sc-cat" data-i="${i}">${cats.map(x => `<option value="${escapeAttr(x)}" ${x===c.category?'selected':''}>${escapeHtml(x)}</option>`).join('')}</select></label>
        <label>Method<select class="sc-method" data-i="${i}"><option value="">—</option>${methods.map(m => `<option value="${escapeAttr(m)}" ${m===c.method?'selected':''}>${escapeHtml(m)}</option>`).join('')}</select></label>
        <label class="sc-remember-wrap"><input type="checkbox" class="sc-remember" data-i="${i}"> Always categorise this vendor like this</label>
      </div>
      <div class="scan-raw hint">${escapeHtml(c.raw || '')}${c.last4 ? ` · card •${c.last4}` : ''}${c.time ? ` · ${c.time}` : ''}</div>
    </div>`).join('') : '<div class="empty">No transactions recognised. Try the paste-text option, or a sharper screenshot.</div>';
  document.getElementById('scanInsertBtn').classList.toggle('hidden', scanCandidates.length === 0);
}

async function runScanFiles(files){
  const progress = document.getElementById('scanProgress');
  let allCandidates = [];
  for (let i = 0; i < files.length; i++) {
    progress.textContent = `Reading image ${i+1} of ${files.length}…`;
    try {
      const text = await ocrImage(files[i], p => { progress.textContent = `Reading image ${i+1} of ${files.length}… ${(p*100).toFixed(0)}%`; });
      allCandidates = allCandidates.concat(parseSmsText(text));
    } catch (e) {
      progress.textContent = `Image ${i+1} failed: ${e.message}`;
      return;
    }
  }
  progress.textContent = `Found ${allCandidates.length} candidate transaction(s).`;
  showScanCandidates(allCandidates);
}

function insertScanCandidates(){
  let added = 0, newRules = [...vendorRules];
  document.querySelectorAll('.sc-use').forEach(cb => {
    if (!cb.checked) return;
    const i = Number(cb.dataset.i);
    const c = scanCandidates[i];
    const get = cls => document.querySelector(`.${cls}[data-i="${i}"]`);
    const desc = get('sc-desc').value.trim();
    const category = get('sc-cat').value;
    const tx = {
      type: 'expense',
      date: get('sc-date').value,
      category,
      description: desc,
      amount: parseFloat(get('sc-amount').value) || 0,
      method: get('sc-method').value,
      notes: `SMS scan${c.time ? ' ' + c.time : ''}${c.last4 ? ' · card •' + c.last4 : ''}`,
      fingerprint: c.fp,
      source: 'scan',
      bucketOverride: null,
    };
    adapter.transactions.add(tx);
    added++;
    if (get('sc-remember').checked && desc && !newRules.some(r => r.pattern.toLowerCase() === desc.toLowerCase())) {
      newRules.push({ pattern: desc, category });
    }
  });
  if (newRules.length !== vendorRules.length) settingsSet('vendorRules', newRules);
  document.getElementById('scanOverlay').classList.add('hidden');
  if (added) alert(`Added ${added} transaction(s).`);
}

// ---------- Live prices ----------

async function refreshPrices(manual){
  const holdings = assets.filter(isHolding);
  const statusEl = document.getElementById('priceStatus');
  if (!holdings.length) { if (manual) statusEl.textContent = 'No holdings with tickers yet'; return; }
  if (!manual && Date.now() - lastPriceFetchAt < 10 * 60 * 1000) return;
  lastPriceFetchAt = Date.now();
  statusEl.textContent = 'Fetching prices…';
  const errs = [];
  for (const a of holdings) {
    try {
      const q = await fetchPriceAED(a.ticker, budgetConfig.priceProxy);
      adapter.assets.update(a.id, { lastPrice: q.price, lastCurrency: q.currency, lastPriceAED: q.priceAED, lastPriceAt: Date.now() });
    } catch (e) { errs.push(`${a.ticker}: ${e.message}`); }
  }
  statusEl.textContent = errs.length
    ? `Could not fetch ${errs.length} of ${holdings.length} — using last known/manual prices. (${errs[0]})`
    : `Prices updated ${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · Yahoo Finance`;
}

// ---------- Wiring ----------

function wireEventListeners(){
  window.addEventListener('scroll', () => {
    document.querySelector('.topbar').classList.toggle('scrolled', window.scrollY > 8);
  }, {passive:true});

  document.querySelectorAll('#txTable th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortState.col === col) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      else { sortState.col = col; sortState.dir = 'asc'; }
      currentPage = 1;
      renderTable();
    });
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'networth') refreshPrices(false);
    });
  });

  // Budget tab toolbar
  const monthInput = document.getElementById('budgetMonth');
  monthInput.value = currentYm();
  monthInput.max = currentYm();
  monthInput.addEventListener('change', () => {
    if (monthInput.value) { budgetMonth = monthInput.value; renderBudget(); }
  });
  document.getElementById('budgetAllTimeBtn').addEventListener('click', () => {
    budgetMonth = budgetMonth === 'all' ? (monthInput.value || currentYm()) : 'all';
    renderBudget();
  });
  document.getElementById('openSettingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsCancelBtn').addEventListener('click', () => document.getElementById('settingsOverlay').classList.add('hidden'));
  document.getElementById('settingsSaveBtn').addEventListener('click', saveSettings);
  document.getElementById('settingsResetBtn').addEventListener('click', () => {
    if (!confirm('Reset budgets, mapping and sub-caps to the defaults? Card map and vendor rules are kept.')) return;
    settingsSet('budgetConfig', null);
    document.getElementById('settingsOverlay').classList.add('hidden');
  });
  document.getElementById('openCleanupBtn').addEventListener('click', openCleanup);
  document.getElementById('cleanupCloseBtn').addEventListener('click', () => document.getElementById('cleanupOverlay').classList.add('hidden'));

  // Scan modal
  document.getElementById('scanBtn').addEventListener('click', openScan);
  document.getElementById('scanCancelBtn').addEventListener('click', () => document.getElementById('scanOverlay').classList.add('hidden'));
  document.getElementById('scanModeImage').addEventListener('click', () => {
    document.getElementById('scanModeImage').classList.add('active');
    document.getElementById('scanModeText').classList.remove('active');
    document.getElementById('scanImagePane').classList.remove('hidden');
    document.getElementById('scanTextPane').classList.add('hidden');
  });
  document.getElementById('scanModeText').addEventListener('click', () => {
    document.getElementById('scanModeText').classList.add('active');
    document.getElementById('scanModeImage').classList.remove('active');
    document.getElementById('scanTextPane').classList.remove('hidden');
    document.getElementById('scanImagePane').classList.add('hidden');
  });
  document.getElementById('scanFiles').addEventListener('change', e => {
    if (e.target.files.length) runScanFiles([...e.target.files]);
  });
  document.getElementById('scanParseBtn').addEventListener('click', () => {
    const cands = parseSmsText(document.getElementById('scanText').value);
    document.getElementById('scanProgress').textContent = '';
    showScanCandidates(cands);
  });
  document.getElementById('scanInsertBtn').addEventListener('click', insertScanCandidates);

  // Bulk actions
  document.getElementById('bulkApplyBucket').addEventListener('click', () => {
    const b = document.getElementById('bulkBucket').value;
    selectedIds.forEach(id => adapter.transactions.update(id, { bucketOverride: b }));
    selectedIds.clear(); updateBulkBar();
  });
  document.getElementById('bulkClearOverride').addEventListener('click', () => {
    selectedIds.forEach(id => adapter.transactions.update(id, { bucketOverride: null }));
    selectedIds.clear(); updateBulkBar();
  });
  document.getElementById('bulkApplyCategory').addEventListener('click', () => {
    const c = document.getElementById('bulkCategory').value;
    selectedIds.forEach(id => adapter.transactions.update(id, { category: c }));
    selectedIds.clear(); updateBulkBar();
  });
  document.getElementById('bulkCancel').addEventListener('click', () => { selectedIds.clear(); renderTable(); updateBulkBar(); });

  document.getElementById('refreshPricesBtn').addEventListener('click', () => refreshPrices(true));

  document.getElementById('searchBox').addEventListener('input', e => { tableFilters.search = e.target.value; currentPage = 1; renderTable(); });
  document.getElementById('filterType').addEventListener('change', e => { tableFilters.type = e.target.value; currentPage = 1; renderTable(); });
  document.getElementById('filterCategory').addEventListener('change', e => { tableFilters.category = e.target.value; currentPage = 1; renderTable(); });
  document.getElementById('filterMethod').addEventListener('change', e => { tableFilters.method = e.target.value; currentPage = 1; renderTable(); });
  document.getElementById('clearFilters').addEventListener('click', () => {
    tableFilters = {search:'', type:'', category:'', method:''};
    document.getElementById('searchBox').value = '';
    document.getElementById('filterType').value = '';
    document.getElementById('filterCategory').value = '';
    document.getElementById('filterMethod').value = '';
    currentPage = 1; renderTable();
  });
  document.getElementById('applyRange').addEventListener('click', () => {
    const s = document.getElementById('rangeStart').value;
    const e = document.getElementById('rangeEnd').value;
    if (s && e && s <= e) {
      dateRange = {start:s, end:e};
      document.querySelectorAll('.presets button').forEach(b => b.classList.remove('active'));
      currentPage = 1; render();
    }
  });
  document.querySelectorAll('.presets button').forEach(b => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  document.getElementById('addBtn').addEventListener('click', openAddModal);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', e => { if (e.target.id === 'modalOverlay') closeModal(); });
  document.getElementById('exportCsv').addEventListener('click', exportCsv);
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('exportJsonBtn').addEventListener('click', exportJsonBackup);
  document.getElementById('resetBtn').addEventListener('click', resetToImported);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', e => { if (e.target.files[0]) importJsonFile(e.target.files[0]); e.target.value=''; });
  document.getElementById('signoutBtn').addEventListener('click', () => adapter.auth.signOut());

  document.getElementById('fType').addEventListener('change', () => {
    populateCategorySelect(document.getElementById('fType').value);
    populateBucketSelect(null);
  });
  document.getElementById('fCategory').addEventListener('change', () => {
    const sel = document.getElementById('fCategory');
    if (sel.value === '__new__') {
      const name = (prompt('New category name:') || '').trim();
      if (name) {
        if (!customCategories.includes(name)) { customCategories = [...customCategories, name]; settingsSet('categoryList', customCategories); }
        populateCategorySelect('expense', name);
      } else populateCategorySelect('expense');
    }
    populateBucketSelect(editingId ? transactions.find(x => x.id === editingId) : null);
  });

  document.getElementById('txForm').addEventListener('submit', e => {
    e.preventDefault();
    const bucketSel = document.getElementById('fBucket').value;
    const payload = {
      type: document.getElementById('fType').value,
      date: document.getElementById('fDate').value,
      category: document.getElementById('fCategory').value.trim(),
      description: document.getElementById('fDescription').value.trim(),
      amount: parseFloat(document.getElementById('fAmount').value) || 0,
      method: document.getElementById('fMethod').value.trim(),
      notes: document.getElementById('fNotes').value.trim(),
      bucketOverride: (bucketSel && bucketSel !== 'auto') ? bucketSel : null,
    };
    if (payload.category === '__new__') { alert('Pick or create a category first.'); return; }
    if (editingId) adapter.transactions.update(editingId, payload);
    else adapter.transactions.add(payload);
    closeModal();
  });

  document.getElementById('addAssetBtn').addEventListener('click', openAddAssetModal);
  document.getElementById('assetCancelBtn').addEventListener('click', closeAssetModal);
  document.getElementById('assetModalOverlay').addEventListener('click', e => { if (e.target.id === 'assetModalOverlay') closeAssetModal(); });
  document.getElementById('assetForm').addEventListener('submit', e => {
    e.preventDefault();
    const numOrNull = id => { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? null : v; };
    const payload = {
      name: document.getElementById('aName').value.trim(),
      category: document.getElementById('aCategory').value,
      institution: document.getElementById('aInstitution').value.trim(),
      ticker: document.getElementById('aTicker').value.trim(),
      exchange: document.getElementById('aExchange').value.trim(),
      shares: numOrNull('aShares'),
      buyPriceAED: numOrNull('aBuyPrice'),
      buyDate: document.getElementById('aBuyDate').value || '',
      manualPriceAED: numOrNull('aManualPrice'),
    };
    if (editingAssetId) adapter.assets.update(editingAssetId, payload);
    else adapter.assets.add(payload);
    closeAssetModal();
  });

  document.getElementById('entryCancelBtn').addEventListener('click', closeEntryModal);
  document.getElementById('entryModalOverlay').addEventListener('click', e => { if (e.target.id === 'entryModalOverlay') closeEntryModal(); });
  document.getElementById('entryForm').addEventListener('submit', e => {
    e.preventDefault();
    const payload = {
      assetId: activeAssetId,
      kind: document.getElementById('eKind').value,
      date: document.getElementById('eDate').value,
      amount: parseFloat(document.getElementById('eAmount').value) || 0,
      note: document.getElementById('eNote').value.trim(),
    };
    adapter.assetEntries.add(payload);
    closeEntryModal();
  });

  document.getElementById('assetDetailCloseBtn').addEventListener('click', () => document.getElementById('assetDetailOverlay').classList.add('hidden'));
  document.getElementById('assetDetailOverlay').addEventListener('click', e => { if (e.target.id === 'assetDetailOverlay') document.getElementById('assetDetailOverlay').classList.add('hidden'); });
}

// ---------- Boot ----------

async function init(){
  loadTheme();
  adapter = await createDataAdapter();
  document.getElementById('syncBadge').textContent = adapter.mode === 'cloud' ? 'Cloud sync' : 'Local only';
  document.getElementById('syncBadge').className = 'sync-badge ' + adapter.mode;
  document.getElementById('signoutBtn').classList.toggle('hidden', adapter.mode !== 'cloud');

  document.getElementById('signinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('siEmail').value;
    const password = document.getElementById('siPassword').value;
    const errEl = document.getElementById('siError');
    errEl.textContent = '';
    try { await adapter.auth.signIn(email, password); }
    catch(err) { errEl.textContent = 'Sign-in failed: ' + err.message; }
  });

  adapter.auth.onAuthChange((user) => {
    if (user) {
      document.getElementById('signinScreen').classList.add('hidden');
      document.getElementById('mainApp').classList.remove('hidden');
      if (!listenersWired) { wireEventListeners(); listenersWired = true; }
      adapter.settings.subscribe(items => { applySettingsDocs(items); refreshOptionLists(); render(); renderNetWorth(); });
      adapter.transactions.subscribe(items => { transactions = items; refreshOptionLists(); render(); });
      adapter.assets.subscribe(items => { assets = items; renderNetWorth(); });
      adapter.assetEntries.subscribe(items => { assetEntries = items; renderNetWorth(); });
      applyPreset('thisMonth');
    } else {
      document.getElementById('mainApp').classList.add('hidden');
      document.getElementById('signinScreen').classList.remove('hidden');
    }
  });
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
