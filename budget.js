// Budget bucket layer — config defaults, category→bucket mapping, and the pure
// computation engine. Nothing in this file mutates data; everything derives live
// from (transactions, config), so editing the config recomputes all history.

export const DEFAULT_BUDGET_CONFIG = {
  version: 1,
  monthlyIncome: 45200,
  firstMonth: '2026-02',
  sinkingFundOpeningBalance: 0,
  priceProxy: 'https://corsproxy.io/?url={url}',

  buckets: [
    { id:'housing_utilities',  label:'Housing & Utilities',  budget:6366,  color:'#06b6d4' },
    { id:'food',               label:'Food',                 budget:4900,  color:'#10b981' },
    { id:'transport',          label:'Transport',            budget:900,   color:'#f59e0b' },
    { id:'lifestyle_personal', label:'Lifestyle & Personal', budget:4555,  color:'#ec4899' },
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
  out.alertRules = { ...d.alertRules, ...(saved.alertRules || {}) };
  return out;
}

export function bucketOf(cfg, id){ return cfg.buckets.find(b => b.id === id); }

// The effective bucket for any transaction. Priority: income → none;
// manual override → always wins; savings-type rows → savings bucket; else map.
export function effectiveBucket(tx, cfg){
  if (tx.type === 'income') return null;
  if (tx.bucketOverride) return tx.bucketOverride;
  if (tx.type === 'savings') return 'savings_investment';
  return cfg.categoryMap[(tx.category || '').trim()] || 'unmapped';
}

export function ymOf(t){ return (t.date || '').slice(0, 7); }
export function currentYm(now){ const d = now || new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }

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
export function computeMonth(txs, cfg, ym){
  let income = 0, spent = 0, logged = 0;
  const byBucket = {}, bySleeve = {};
  for (const t of txs) {
    if (ymOf(t) !== ym) continue;
    if (t.type === 'income'){ income += num(t.amount); continue; }
    const b = effectiveBucket(t, cfg), amt = num(t.amount);
    const rec = byBucket[b] || (byBucket[b] = { spent: 0, byCategory: {} });
    rec.spent += amt;
    const cat = (t.category || '(none)').trim() || '(none)';
    rec.byCategory[cat] = (rec.byCategory[cat] || 0) + amt;
    if (b === 'savings_investment'){ logged += amt; bySleeve[cat] = (bySleeve[cat] || 0) + amt; }
    else spent += amt;
  }
  const residual = income - spent;
  return { ym, income, spent, logged, bySleeve, byBucket, residual,
           savingsDisplay: logged > 0 ? logged : residual };
}

export function spendInBucket(txs, cfg, ym, bucketId){
  let s = 0;
  for (const t of txs) {
    if (t.type === 'income' || ymOf(t) !== ym) continue;
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

export function subCapSpend(monthResult, bucketId, capDef){
  const byCat = (monthResult.byBucket[bucketId] || {}).byCategory || {};
  return capDef.categories.reduce((s, c) => s + (byCat[c] || 0), 0);
}

// Leak alerts for one month. `frac` prorates every pace comparison for the
// current month so lumpy day-1 costs (rent) never false-alarm; a grace window
// suppresses linear projections in the first few days.
export function computeAlerts(txs, cfg, ym, now){
  const m = computeMonth(txs, cfg, ym);
  const alerts = [];
  const isCur = ym === currentYm(now);
  const day = now.getDate();
  const daysIn = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const frac = isCur ? day / daysIn : 1;
  const grace = isCur && day < (cfg.alertRules.projectionGraceDays || 5);

  for (const b of cfg.buckets) {
    if (['savings_investment','sinking_fund','debt_service','unmapped'].includes(b.id)) continue;
    const spent = (m.byBucket[b.id] || {}).spent || 0;
    if (b.budget > 0 && spent > 0 && !grace) {
      const projected = isCur ? spent / Math.max(day, 1) * daysIn : spent;
      if (projected > b.budget) {
        alerts.push({ sev: spent > b.budget ? 'red' : 'amber',
          text: `${b.label} ${spent > b.budget ? 'is over budget' : 'is projected to breach'}: ${isCur ? 'heading for ' + money(projected) : money(spent)} vs ${money(b.budget)}` });
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

  for (const t of txs) {
    if (t.type === 'expense' && ymOf(t) === ym && num(t.amount) > (cfg.alertRules.largeTransactionThreshold || 2000)) {
      alerts.push({ sev: 'info', text: `Large transaction: ${t.date} · ${t.description || t.category} — ${money(num(t.amount))}` });
    }
  }

  const rank = { red: 0, amber: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.sev] - rank[b.sev]);
}
