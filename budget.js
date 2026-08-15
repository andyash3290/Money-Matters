// Budget bucket layer — config defaults, category→bucket mapping, and the pure
// computation engine. Nothing in this file mutates data; everything derives live
// from (transactions, config), so editing the config recomputes all history.

export const DEFAULT_BUDGET_CONFIG = {
  version: 2,
  monthlyIncome: 45200,
  firstMonth: '2026-02',
  sinkingFundOpeningBalance: 0,
  priceProxy: 'https://corsproxy.io/?url={url}',

  buckets: [
    { id:'housing_utilities',  label:'Housing & Utilities',  budget:6366,  color:'#06b6d4', rollover:false },
    { id:'food',               label:'Food',                 budget:4900,  color:'#10b981', rollover:false },
    { id:'transport',          label:'Transport',            budget:900,   color:'#f59e0b', rollover:false },
    { id:'lifestyle_personal', label:'Lifestyle & Personal', budget:4555,  color:'#ec4899', rollover:false },
    { id:'sinking_fund',       label:'Sinking Fund',         budget:6500,  color:'#8b5cf6', rolling:true },
    { id:'savings_investment', label:'Savings & Investment', budget:21979, color:'#6366f1', computed:'residual' },
    { id:'debt_service',       label:'Debt Service',         budget:0,     color:'#ef4444', legacy:true, alertOnAnySpend:true },
    { id:'unmapped',           label:'Unmapped',             budget:0,     color:'#94a3b8', warning:true },
  ],

  categoryMap: {
    'House Rent':'housing_utilities',  'Dewa':'housing_utilities',
    'Mobile/Elife':'housing_utilities','Home Cleaning':'housing_utilities',
    'Laundry':'housing_utilities',
    'Grocery & Household':'food', 'Food Delivery':'food', 'Eating Out':'food', 'Coffee':'food',
    'Petrol':'transport', 'Taxi':'transport', 'Jeep Expenses':'transport',
    'Subscription':'lifestyle_personal',   'Gym Fee':'lifestyle_personal',
    'Supplements':'lifestyle_personal',    'Health Expenses':'lifestyle_personal',
    'Anand Parlor Expenses':'lifestyle_personal', 'Asha Parlour Expenses':'lifestyle_personal',
    'Clothes':'lifestyle_personal', 'Entertainment':'lifestyle_personal',
    'Vape/Cig':'lifestyle_personal',
    'Travel exp.':'sinking_fund', 'India Expenses':'sinking_fund',
    'Social Obligation':'sinking_fund', 'Misc Expenses':'sinking_fund',
    'Loan Instalment':'debt_service',
  },

  subCaps: {
    food: [
      { label:'Grocery & Household', categories:['Grocery & Household'], floor:1400 },
      { label:'Delivery + Eating Out + Coffee',
        categories:['Food Delivery','Eating Out','Coffee'], cap:3500 },
    ],
    lifestyle_personal: [
      { label:'Subscription',           categories:['Subscription'],                    cap:400 },
      { label:'Gym Fee',                categories:['Gym Fee'],                         cap:700 },
      { label:'Supplements + Health',   categories:['Supplements','Health Expenses'],   cap:1000 },
      { label:'Parlour (Anand + Asha)', categories:['Anand Parlor Expenses','Asha Parlour Expenses'], cap:700 },
      { label:'Clothes',                categories:['Clothes'],                         cap:500 },
      { label:'Entertainment',          categories:['Entertainment'],                   cap:400 },
      { label:'Vape/Cig',               categories:['Vape/Cig'],                        cap:455 },
      { label:'Unallocated buffer',     categories:[], cap:400, buffer:true },
    ],
  },

  savingsSleeves: [
    { id:'market',   label:'Market (VWRA via IBKR)',        target:15000 },
    { id:'goal',     label:'Goal sleeve (watch / vehicle)', target:3500 },
    { id:'overflow', label:'Sinking-fund overflow buffer',  target:3479 },
  ],

  // Who a transaction belongs to. `joint` is the fallback for anything the
  // derivation can't attribute to a named person.
  people: [
    { id:'joint', label:'Joint / Household', color:'#6366f1' },
    { id:'anand', label:'Anand',             color:'#06b6d4' },
    { id:'asha',  label:'Asha',              color:'#ec4899' },
  ],

  recurring: {
    minMonths: 3,           // seen in this many distinct months to count as recurring
    changeThresholdPct: 15, // price-change alert trigger
    minChangeAED: 75,       // ignore % swings on trivial amounts (a 64% jump on a AED 11 tea isn't news)
    maxPriceAlerts: 5,
    activeWithinMonths: 3,  // still considered live if seen this recently — tolerates a skipped month of logging
  },

  alertRules: {
    largeTransactionThreshold: 2000,
    maxSubscriptionCharges: 8,
    projectionGraceDays: 5,
  },
};

const num = v => Number(v) || 0;
const money = n => 'AED ' + (Number(n)||0).toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0});

// Deep-merge persisted settings edits over the defaults. Bucket budgets, the
// category map, sub-cap amounts and sleeves are all user-editable in Settings.
export function mergeBudgetConfig(saved){
  const d = structuredClone(DEFAULT_BUDGET_CONFIG);
  if (!saved) return d;
  const out = { ...d, ...saved };
  out.buckets = d.buckets.map(b => ({ ...b, ...((saved.buckets || []).find(x => x.id === b.id) || {}) }));
  out.categoryMap = { ...d.categoryMap, ...(saved.categoryMap || {}) };
  out.subCaps = saved.subCaps || d.subCaps;
  out.savingsSleeves = saved.savingsSleeves || d.savingsSleeves;
  out.people = saved.people || d.people;
  out.recurring = { ...d.recurring, ...(saved.recurring || {}) };
  out.alertRules = { ...d.alertRules, ...(saved.alertRules || {}) };
  return out;
}

export function bucketOf(cfg, id){ return cfg.buckets.find(b => b.id === id); }

// Card payments are transfers between your money and your card balance — they
// are neither income nor spend, so they stay out of every bucket total.
export function isSpendRow(t){ return t.type === 'expense' || t.type === 'savings'; }

// The effective bucket for any transaction. Priority: income/transfer → none;
// manual override → always wins; savings-type rows → savings bucket; else map.
export function effectiveBucket(tx, cfg){
  if (tx.type === 'income' || tx.type === 'cardpayment') return null;
  if (tx.bucketOverride) return tx.bucketOverride;
  if (tx.type === 'savings') return 'savings_investment';
  return cfg.categoryMap[(tx.category || '').trim()] || 'unmapped';
}

// Whose spend this is. An explicit tag always wins; otherwise infer from the
// category ("Asha Parlour Expenses") or a name in the description ("Asha - Dinner").
export function effectivePerson(tx, cfg){
  if (tx.person) return tx.person;
  const hay = ((tx.category || '') + ' ' + (tx.description || '')).toLowerCase();
  for (const p of (cfg.people || [])) {
    if (p.id === 'joint') continue;
    if (new RegExp(`\\b${p.id}\\b`, 'i').test(hay)) return p.id;
  }
  return 'joint';
}

export function ymOf(t){ return (t.date || '').slice(0, 7); }
export function currentYm(now){ const d = now || new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
export function prevYm(ym){
  let [y, m] = ym.split('-').map(Number);
  m--; if (m < 1){ m = 12; y--; }
  return `${y}-${String(m).padStart(2,'0')}`;
}

export function monthRange(a, b){
  const out = [];
  if (!a || !b || b < a) return out;
  let [y, m] = a.split('-').map(Number);
  const [ey, em] = b.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2,'0')}`);
    m++; if (m > 12){ m = 1; y++; }
    if (out.length > 600) break;
  }
  return out;
}

// One month's totals: income, spend per bucket with category breakdown, logged
// savings (explicit 'savings' rows + anything overridden into the savings
// bucket), and the residual. Signed sums, so negative refund rows reduce totals.
// opts.excludeOneOff drops rows flagged as one-offs to expose the run-rate.
export function computeMonth(txs, cfg, ym, opts){
  const excludeOneOff = !!(opts && opts.excludeOneOff);
  let income = 0, spent = 0, logged = 0, oneOffIncome = 0, oneOffSpend = 0;
  const byBucket = {}, bySleeve = {}, byPerson = {};
  for (const t of txs) {
    if (ymOf(t) !== ym) continue;
    if (t.type === 'cardpayment') continue;
    const amt = num(t.amount);
    if (t.type === 'income'){
      if (t.oneOff) { oneOffIncome += amt; if (excludeOneOff) continue; }
      income += amt;
      continue;
    }
    if (t.oneOff) { oneOffSpend += amt; if (excludeOneOff) continue; }
    const b = effectiveBucket(t, cfg);
    const rec = byBucket[b] || (byBucket[b] = { spent: 0, byCategory: {} });
    rec.spent += amt;
    const cat = (t.category || '(none)').trim() || '(none)';
    rec.byCategory[cat] = (rec.byCategory[cat] || 0) + amt;
    if (b === 'savings_investment'){ logged += amt; bySleeve[cat] = (bySleeve[cat] || 0) + amt; }
    else {
      spent += amt;
      const p = effectivePerson(t, cfg);
      byPerson[p] = (byPerson[p] || 0) + amt;
    }
  }
  const residual = income - spent;
  return { ym, income, spent, logged, oneOffIncome, oneOffSpend, bySleeve, byBucket, byPerson,
           residual, savingsDisplay: logged > 0 ? logged : residual };
}

export function spendInBucket(txs, cfg, ym, bucketId){
  let s = 0;
  for (const t of txs) {
    if (t.type === 'income' || t.type === 'cardpayment' || ymOf(t) !== ym) continue;
    if (effectiveBucket(t, cfg) === bucketId) s += num(t.amount);
  }
  return s;
}

// Rolling sinking-fund balance: opening + 6,500 accrual per elapsed month minus
// that month's sinking spend. Never resets; only a negative balance is a problem.
export function sinkingBalance(txs, cfg, throughYm){
  const budget = bucketOf(cfg, 'sinking_fund').budget;
  let bal = num(cfg.sinkingFundOpeningBalance);
  for (const ym of monthRange(cfg.firstMonth, throughYm)) {
    bal += budget;
    bal -= spendInBucket(txs, cfg, ym, 'sinking_fund');
  }
  return bal;
}

// Unspent budget carried into `ym` for a rollover-enabled bucket: the sum of
// (budget − spend) over every prior month. Deficits carry too, so overspending
// one month genuinely tightens the next.
export function bucketCarry(txs, cfg, bucketId, ym){
  const b = bucketOf(cfg, bucketId);
  if (!b || !b.rollover) return 0;
  const start = cfg.firstMonth;
  const end = prevYm(ym);
  if (end < start) return 0;
  let carry = 0;
  for (const m of monthRange(start, end)) carry += b.budget - spendInBucket(txs, cfg, m, bucketId);
  return carry;
}

export function subCapSpend(monthResult, bucketId, capDef){
  const byCat = (monthResult.byBucket[bucketId] || {}).byCategory || {};
  return capDef.categories.reduce((s, c) => s + (byCat[c] || 0), 0);
}

function normKey(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Find charges that repeat monthly (rent, Dewa, subscriptions, instalments) so
// we can project the rest of the month and flag price changes. One-offs are
// excluded by definition.
export function detectRecurring(txs, cfg, throughYm, endedKeys){
  const minMonths = (cfg.recurring && cfg.recurring.minMonths) || 3;
  const ended = new Set(endedKeys || []);
  const end = throughYm || currentYm();
  const groups = new Map();
  for (const t of txs) {
    if (t.type !== 'expense' || t.oneOff) continue;
    if (!num(t.amount)) continue; // zero rows are placeholders, not price changes
    const ym = ymOf(t);
    if (!ym || ym > end) continue;
    const cat = (t.category || '').trim();
    const desc = (t.description || '').trim();
    const key = cat + '|' + normKey(desc);
    if (!groups.has(key)) groups.set(key, { key, category: cat, label: desc || cat, byMonth: new Map() });
    const g = groups.get(key);
    g.byMonth.set(ym, (g.byMonth.get(ym) || 0) + num(t.amount));
  }
  const out = [];
  const withinN = (cfg.recurring && cfg.recurring.activeWithinMonths) || 3;
  const activeWindow = [];
  let cursor = end;
  for (let i = 0; i < withinN; i++) { activeWindow.push(cursor); cursor = prevYm(cursor); }
  for (const g of groups.values()) {
    if (g.byMonth.size < minMonths) continue;
    const months = [...g.byMonth.entries()].map(([ym, amount]) => ({ ym, amount })).sort((a,b) => a.ym < b.ym ? -1 : 1);
    const amounts = months.map(x => x.amount);
    const recent = amounts.slice(-3).slice().sort((a,b) => a-b);
    const typical = recent[Math.floor(recent.length/2)];
    const latest = months[months.length-1];
    const previous = months[months.length-2];
    const changePct = previous && previous.amount ? (latest.amount - previous.amount) / Math.abs(previous.amount) * 100 : 0;
    const first = amounts[0];
    const trendPct = first ? (latest.amount - first) / Math.abs(first) * 100 : 0;
    out.push({
      key: g.key, label: g.label, category: g.category, months, typical,
      latest, previous, changePct, trendPct,
      ended: ended.has(g.key),
      active: !ended.has(g.key) && activeWindow.some(m => g.byMonth.has(m)),
      postedThisMonth: g.byMonth.has(end) ? g.byMonth.get(end) : null,
    });
  }
  return out.sort((a,b) => b.typical - a.typical);
}

// Month-end projection that understands commitments. Instead of extrapolating
// everything linearly (which spikes the moment rent posts on day 1), it adds up
// recurring charges still due this month and only run-rates the discretionary
// remainder.
export function computeProjection(txs, cfg, ym, now, endedKeys){
  const m = computeMonth(txs, cfg, ym);
  if (ym !== currentYm(now)) {
    return { projected: m.spent, spent: m.spent, isCurrent: false, committedRemaining: 0, discretionaryRunRate: 0, pending: [] };
  }
  const day = now.getDate();
  const daysIn = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const recurring = detectRecurring(txs, cfg, ym, endedKeys).filter(r => r.active);
  let committedRemaining = 0, recurringPosted = 0;
  const pending = [];
  for (const r of recurring) {
    if (r.postedThisMonth != null) { recurringPosted += r.postedThisMonth; continue; }
    // A legacy bucket budgeted at zero is a finished obligation (a paid-off
    // loan): its history shouldn't be projected forward as a future commitment.
    const bId = cfg.categoryMap[r.category];
    const bucket = bId ? bucketOf(cfg, bId) : null;
    if (bucket && bucket.legacy && bucket.budget <= 0) continue;
    committedRemaining += r.typical;
    pending.push({ label: r.label, category: r.category, amount: r.typical });
  }
  const discretionarySoFar = Math.max(0, m.spent - recurringPosted);
  const discretionaryRunRate = discretionarySoFar / Math.max(day, 1) * daysIn;
  return {
    projected: recurringPosted + committedRemaining + discretionaryRunRate,
    spent: m.spent, isCurrent: true, day, daysIn,
    committedRemaining, discretionaryRunRate, discretionarySoFar, recurringPosted,
    pending: pending.sort((a,b) => b.amount - a.amount),
  };
}

// Credit-card statement cycles. Calendar-month cycles: everything spent in month
// M forms the statement due on `dueDay` of month M+1. Tracking starts at
// `trackFrom` (+ any opening balance) so historical months with no logged
// payments don't show as enormous fake debt.
export function computeCards(txs, cards, ym, now){
  const today = now || new Date();
  const spendIn = (method, m) => txs.reduce((s,t) => s + ((t.type === 'expense' && t.method === method && ymOf(t) === m) ? num(t.amount) : 0), 0);
  const paidIn  = (method, m) => txs.reduce((s,t) => s + ((t.type === 'cardpayment' && t.method === method && ymOf(t) === m) ? num(t.amount) : 0), 0);

  return (cards || []).filter(c => c.method).map(c => {
    const trackFrom = c.trackFrom || ym;
    const cycleSpend = spendIn(c.method, ym);
    const previous = prevYm(ym);
    const statementAmount = trackFrom <= previous ? spendIn(c.method, previous) : 0;
    const paidThisMonth = paidIn(c.method, ym);

    let outstanding = num(c.openingBalance);
    for (const m of monthRange(trackFrom, ym)) outstanding += spendIn(c.method, m) - paidIn(c.method, m);

    let status = 'none';
    if (statementAmount > 0) {
      if (paidThisMonth >= statementAmount - 0.5) status = 'paid';
      else if (paidThisMonth > 0) status = 'partial';
      else status = 'unpaid';
    }
    const dueDay = Math.min(Math.max(1, num(c.dueDay) || 20), 28);
    const [y, mm] = ym.split('-').map(Number);
    const dueDate = new Date(y, mm-1, dueDay);
    const daysToDue = Math.round((dueDate - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    const limit = num(c.creditLimit);
    return {
      method: c.method, dueDay, dueDate, daysToDue, limit,
      cycleSpend, statementAmount, paidThisMonth, outstanding, status,
      utilisation: limit > 0 ? outstanding / limit * 100 : null,
      isCurrentMonth: ym === currentYm(today),
    };
  });
}

// Leak alerts for one month. `frac` prorates every pace comparison for the
// current month so lumpy day-1 costs (rent) never false-alarm; a grace window
// suppresses linear projections in the first few days.
export function computeAlerts(txs, cfg, ym, now, endedKeys){
  const m = computeMonth(txs, cfg, ym);
  const alerts = [];
  const isCur = ym === currentYm(now);
  const day = now.getDate();
  const daysIn = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const frac = isCur ? day / daysIn : 1;
  const grace = isCur && day < (cfg.alertRules.projectionGraceDays || 5);
  const proj = computeProjection(txs, cfg, ym, now, endedKeys);

  for (const b of cfg.buckets) {
    if (['savings_investment','sinking_fund','debt_service','unmapped'].includes(b.id)) continue;
    const spent = (m.byBucket[b.id] || {}).spent || 0;
    const budget = b.budget + (b.rollover ? bucketCarry(txs, cfg, b.id, ym) : 0);
    if (budget > 0 && spent > 0 && !grace) {
      const projected = isCur ? spent / Math.max(day, 1) * daysIn : spent;
      if (projected > budget) {
        alerts.push({ sev: spent > budget ? 'red' : 'amber',
          text: `${b.label} ${spent > budget ? 'is over budget' : 'is projected to breach'}: ${isCur ? 'heading for ' + money(projected) : money(spent)} vs ${money(budget)}` });
      }
    }
  }

  const foodCats = (m.byBucket.food || {}).byCategory || {};
  const comboDef = (cfg.subCaps.food || []).find(c => c.cap);
  const floorDef = (cfg.subCaps.food || []).find(c => c.floor);
  const combo = comboDef ? comboDef.categories.reduce((s,c) => s + (foodCats[c]||0), 0) : 0;
  const comboCap = comboDef ? comboDef.cap : 3500;
  const grocery = floorDef ? floorDef.categories.reduce((s,c) => s + (foodCats[c]||0), 0) : 0;
  const floor = floorDef ? floorDef.floor : 1400;
  if (!grace && combo > comboCap * frac) {
    alerts.push({ sev: combo > comboCap ? 'red' : 'amber',
      text: `Delivery + Eating Out + Coffee at ${money(combo)} — ${combo > comboCap ? 'over' : 'tracking above'} the ${money(comboCap)} cap` });
  }
  if (!grace && grocery < floor * frac && combo > comboCap * frac * 0.8) {
    alerts.push({ sev: 'amber',
      text: `Grocery ${money(grocery)} is under the ${money(floor)} floor while delivery runs hot — delivery is substituting cooking` });
  }

  // Price-change alerts on recurring charges (the Dewa-creeping-up case). Only
  // increases alert: cost creep is actionable, a dip usually just means a bill
  // hasn't landed yet or the month is still filling in. Decreases stay visible
  // as ▼ chips in the Recurring panel instead of shouting here.
  const rc = cfg.recurring || {};
  const threshold = rc.changeThresholdPct || 15;
  const minAED = rc.minChangeAED != null ? rc.minChangeAED : 75;
  const priceAlerts = [];
  for (const r of detectRecurring(txs, cfg, ym, endedKeys)) {
    if (!r.active || r.postedThisMonth == null || !r.previous) continue;
    const delta = r.latest.amount - r.previous.amount;
    if (delta <= 0) continue;
    if (r.changePct < threshold || delta < minAED) continue;
    const trend = r.trendPct >= threshold && r.months.length >= 3
      ? ` (+${r.trendPct.toFixed(0)}% since ${r.months[0].ym})` : '';
    priceAlerts.push({ delta, sev: 'amber',
      text: `${r.label} rose ${r.changePct.toFixed(0)}% — ${money(r.previous.amount)} → ${money(r.latest.amount)}${trend}` });
  }
  priceAlerts.sort((a,b) => b.delta - a.delta).slice(0, rc.maxPriceAlerts || 5)
    .forEach(a => alerts.push({ sev: a.sev, text: a.text }));

  const subCount = txs.filter(t => t.type === 'expense' && ymOf(t) === ym && (t.category||'').trim() === 'Subscription' && num(t.amount) > 0).length;
  if (subCount > (cfg.alertRules.maxSubscriptionCharges || 8)) {
    alerts.push({ sev: 'amber', text: `${subCount} separate subscription charges this month (watch limit: ${cfg.alertRules.maxSubscriptionCharges})` });
  }

  const debt = (m.byBucket.debt_service || {}).spent || 0;
  if (debt > 0) alerts.push({ sev: 'red', text: `Debt Service spend of ${money(debt)} — this bucket's budget is 0` });

  const un = (m.byBucket.unmapped || {}).spent || 0;
  if (un !== 0) alerts.push({ sev: 'amber', text: `${money(un)} sits in Unmapped — assign those categories a bucket in Budget Settings` });

  const sb = sinkingBalance(txs, cfg, ym);
  if (sb < 0) alerts.push({ sev: 'red', text: `Sinking Fund balance is negative: ${money(sb)}` });

  if (isCur && !grace && proj.projected > cfg.monthlyIncome) {
    alerts.push({ sev: 'red', text: `Projected month-end spend ${money(proj.projected)} exceeds income ${money(cfg.monthlyIncome)}` });
  }

  for (const t of txs) {
    if (t.type === 'expense' && ymOf(t) === ym && !t.oneOff && num(t.amount) > (cfg.alertRules.largeTransactionThreshold || 2000)) {
      alerts.push({ sev: 'info', txId: t.id,
        text: `Large transaction: ${t.date} · ${t.description || t.category} — ${money(num(t.amount))}` });
    }
  }

  const rank = { red: 0, amber: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.sev] - rank[b.sev]);
}
