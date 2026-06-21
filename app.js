import { createDataAdapter } from './data-adapter.js';

const THEME_KEY = 'expenseDashboard_theme';
const PALETTE = ['#6366f1','#06b6d4','#f59e0b','#ef4444','#10b981','#8b5cf6','#ec4899','#14b8a6','#f97316','#3b82f6','#84cc16','#a855f7','#eab308','#0ea5e9','#f43f5e','#22c55e'];
const ASSET_CATEGORY_LABELS = {bank_savings:'Bank Savings', fixed_deposit:'Fixed Deposit', stocks_funds:'Stocks & Funds', other:'Other'};
const ASSET_CATEGORY_ICONS = {bank_savings:'wallet', fixed_deposit:'lock', stocks_funds:'barchart', other:'gem'};

function icon(name, cls){ return `<svg class="icon ${cls||''}"><use href="#icon-${name}"></use></svg>`; }

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

function donutSvg(entries, opts){
  const total = entries.reduce((s,e) => s+e.value, 0);
  const r=70, cx=90, cy=90, sw=28;
  const circ = 2*Math.PI*r;
  let cum = 0;
  let svg = `<svg viewBox="0 0 180 180" width="180" height="180">`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${sw}"/>`;
  if (total > 0) {
    entries.forEach(e => {
      const len = (e.value/total)*circ;
      svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${e.color}" stroke-width="${sw}" stroke-dasharray="${len} ${circ-len}" stroke-dashoffset="${-cum}" transform="rotate(-90 ${cx} ${cy})"/>`;
      cum += len;
    });
  }
  svg += `<text x="${cx}" y="${cy-2}" text-anchor="middle" class="donut-total">${total>0?fmtMoney(total):'No data'}</text>`;
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
  document.getElementById('sumIncome').textContent = fmtMoney(income);
  document.getElementById('sumExpense').textContent = fmtMoney(expense);
  const savEl = document.getElementById('sumSavings');
  savEl.textContent = fmtMoney(savings);
  savEl.classList.toggle('negative', savings < 0);
  savEl.classList.toggle('positive', savings >= 0);
  const rateEl = document.getElementById('sumRate');
  rateEl.textContent = rate.toFixed(1) + '%';
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

function lineChartSvg(labels, values, color){
  const w=600, h=180, pad=30;
  const maxV = Math.max(1, ...values);
  const stepX = values.length > 1 ? (w-2*pad)/(values.length-1) : 0;
  const pts = values.map((v,i) => [pad + i*stepX, h-pad - (v/maxV)*(h-2*pad)]);
  let svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="200" preserveAspectRatio="xMinYMid meet">`;
  svg += `<line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="var(--border)"/>`;
  if (pts.length > 0) {
    const linePath = pts.map((p,i) => (i===0?'M':'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const areaPath = linePath + ` L${pts[pts.length-1][0].toFixed(1)},${h-pad} L${pts[0][0].toFixed(1)},${h-pad} Z`;
    svg += `<path d="${areaPath}" fill="${color}22" stroke="none"/>`;
    svg += `<path d="${linePath}" fill="none" stroke="${color}" stroke-width="2"/>`;
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
  document.getElementById('txTbody').innerHTML = pageItems.map(t => `
    <tr>
      <td>${t.date}</td>
      <td><span class="badge ${t.type}">${t.type}</span></td>
      <td><span class="dot" style="background:${colorFor(t.category)}"></span> ${escapeHtml(t.category)}</td>
      <td>${escapeHtml(t.description)}</td>
      <td class="amount ${t.type}">${fmtMoney(t.amount)}</td>
      <td>${escapeHtml(t.method)}</td>
      <td class="notes" title="${escapeAttr(t.notes)}">${escapeHtml(t.notes)}</td>
      <td class="actions">
        <button class="icon-btn edit-btn" data-id="${t.id}" title="Edit">${icon('edit')}</button>
        <button class="icon-btn delete-btn" data-id="${t.id}" title="Delete">${icon('trash')}</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No transactions found</td></tr>';

  document.getElementById('pagination').innerHTML = `
    <button id="prevPage" ${currentPage<=1?'disabled':''}>Prev</button>
    <span>Page ${currentPage} of ${totalPages} (${list.length} entries)</span>
    <button id="nextPage" ${currentPage>=totalPages?'disabled':''}>Next</button>
  `;
  document.getElementById('prevPage').onclick = () => { currentPage--; renderTable(); };
  document.getElementById('nextPage').onclick = () => { currentPage++; renderTable(); };
  document.querySelectorAll('.edit-btn').forEach(b => b.onclick = () => openEditModal(b.dataset.id));
  document.querySelectorAll('.delete-btn').forEach(b => b.onclick = () => deleteTransaction(b.dataset.id));
  updateSortIndicators();
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
  document.getElementById('categoryList').innerHTML = cats.map(c => `<option value="${escapeAttr(c)}">`).join('');
  document.getElementById('methodList').innerHTML = methods.map(m => `<option value="${escapeAttr(m)}">`).join('');
  document.getElementById('filterCategory').value = tableFilters.category;
  document.getElementById('filterMethod').value = tableFilters.method;
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
}

function openAddModal(){
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Add Transaction';
  document.getElementById('txForm').reset();
  document.getElementById('fDate').value = isoDate(new Date());
  document.getElementById('fType').value = 'expense';
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
  document.getElementById('fCategory').value = t.category;
  document.getElementById('fDescription').value = t.description || '';
  document.getElementById('fAmount').value = t.amount;
  document.getElementById('fMethod').value = t.method || '';
  document.getElementById('fNotes').value = t.notes || '';
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
  assets.forEach(a => { const bal = currentBalance(a.id); byCat[a.category] = (byCat[a.category]||0) + bal; total += bal; });
  document.getElementById('nwTotal').textContent = fmtMoney(total);
  document.getElementById('nwBank').textContent = fmtMoney(byCat.bank_savings);
  document.getElementById('nwFixed').textContent = fmtMoney(byCat.fixed_deposit);
  document.getElementById('nwStocks').textContent = fmtMoney(byCat.stocks_funds);
}

function renderNetWorthDonut(){
  const byCat = {};
  assets.forEach(a => { byCat[a.category] = (byCat[a.category]||0) + currentBalance(a.id); });
  const entries = Object.entries(byCat).filter(([,v]) => v > 0).map(([cat,val]) => ({label: ASSET_CATEGORY_LABELS[cat]||cat, value: val, color: colorFor(cat)}));
  document.getElementById('nwDonutWrap').innerHTML = donutSvg(entries);
  const total = entries.reduce((s,e)=>s+e.value,0);
  document.getElementById('nwDonutLegend').innerHTML = entries.map(e => {
    const pct = total > 0 ? (e.value/total*100).toFixed(1) : '0';
    return `<div class="legend-item"><span class="dot" style="background:${e.color}"></span>${escapeHtml(e.label)}<span class="legend-val">${fmtMoney(e.value)} (${pct}%)</span></div>`;
  }).join('') || '<div class="empty">No accounts yet</div>';
}

function renderNetWorthAccountBars(){
  const entries = assets.map(a => ({name:a.name, value:currentBalance(a.id)})).sort((a,b) => b.value-a.value);
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
    const bal = currentBalance(a.id);
    return `
    <div class="asset-card">
      <div class="asset-card-head">
        <div>
          <div class="asset-name">${escapeHtml(a.name)}</div>
          <div class="asset-meta">${escapeHtml(a.institution||'')}</div>
        </div>
        <span class="category-pill">${icon(ASSET_CATEGORY_ICONS[a.category]||'gem')}${escapeHtml(ASSET_CATEGORY_LABELS[a.category]||a.category)}</span>
      </div>
      <div class="asset-balance">${fmtMoney(bal)}</div>
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

// ---------- Wiring ----------

function wireEventListeners(){
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
    });
  });

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

  document.getElementById('txForm').addEventListener('submit', e => {
    e.preventDefault();
    const payload = {
      type: document.getElementById('fType').value,
      date: document.getElementById('fDate').value,
      category: document.getElementById('fCategory').value.trim(),
      description: document.getElementById('fDescription').value.trim(),
      amount: parseFloat(document.getElementById('fAmount').value) || 0,
      method: document.getElementById('fMethod').value.trim(),
      notes: document.getElementById('fNotes').value.trim(),
    };
    if (editingId) adapter.transactions.update(editingId, payload);
    else adapter.transactions.add(payload);
    closeModal();
  });

  document.getElementById('addAssetBtn').addEventListener('click', openAddAssetModal);
  document.getElementById('assetCancelBtn').addEventListener('click', closeAssetModal);
  document.getElementById('assetModalOverlay').addEventListener('click', e => { if (e.target.id === 'assetModalOverlay') closeAssetModal(); });
  document.getElementById('assetForm').addEventListener('submit', e => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('aName').value.trim(),
      category: document.getElementById('aCategory').value,
      institution: document.getElementById('aInstitution').value.trim(),
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
