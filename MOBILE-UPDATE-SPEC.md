# Spec for updating mobile.html in Claude Design

Paste this into Claude Design against your existing Money Matters mobile project.
It only covers what does **not** already flow through automatically.

## Background it needs to know

`mobile.html` imports these from the same folder and must keep doing so:
`budget.js`, `data-adapter.js`, `scan.js`, `seed-data.js`, `firebase-config.js`.

All the maths lives in `budget.js`. Do not reimplement any of it — import it.
Anything already coming from there (bucket budgets, alerts, sinking-fund
balance, price-change alerts) is already correct in the app and needs no work.

## New data fields on a transaction (all optional, all additive)

| Field | Values | Meaning |
|---|---|---|
| `person` | `'anand'` \| `'asha'` \| `'joint'` \| absent | Who the spend belongs to. If absent it is **derived** at read time — never write a guess. |
| `oneOff` | `true` \| absent | Excluded from run-rate and recurring detection. |
| `type` | adds `'cardpayment'` | A credit-card bill payment. Not income, not spend. |

Existing rows have none of these and must keep working untouched.

## 1. Person tag on the entry sheet

Add a three-way selector (Joint / Anand / Asha) to the add & edit sheets,
below Method.

- Default it to `effectivePerson(tx, cfg)` imported from `budget.js`, which
  infers from the category and description (so "Asha - Snacks" preselects Asha).
- Only write `person` when the user actually changes it away from the derived
  value; otherwise leave the field absent so derivation keeps working.
- Hide the selector for Income and Card payment types.

## 2. One-off toggle

A single checkbox/switch labelled "One-off" with subtext "excluded from
run-rate", on the add & edit sheets. Hide it for Card payment.

Then on the Budget tab, add a small toggle "Exclude one-offs" that re-renders
using `computeMonth(txs, cfg, ym, { excludeOneOff: true })`.

## 3. Card payment type + a Cards view

Add `Card payment` as a fourth type chip alongside Expense / Income / Savings.
When selected: hide category, person, bucket and one-off; keep amount, date,
method (the card), description, notes.

Add a **Cards** view. Import `computeCards(txs, cards, ym, now)` from
`budget.js`. It returns per card: `method, dueDay, dueDate, daysToDue, limit,
cycleSpend, statementAmount, paidThisMonth, outstanding, status, utilisation,
isCurrentMonth`, where `status` is `'paid' | 'partial' | 'unpaid' | 'none'`.

Card config lives in the settings doc with id `cards`:
`[{ method, dueDay, creditLimit, trackFrom, openingBalance }]`.

Per card show: outstanding (large), status chip, last statement, paid this
month, spent this cycle, utilisation bar if a limit is set, and a "Log payment"
button that opens the entry sheet pre-filled as a card payment for that method
with the amount still owed.

Only show the live "Due in N days" countdown when `isCurrentMonth` is true —
otherwise show the cycle name, or a closed statement reads as "56 days overdue".

## 4. Recurring charges list

Import `detectRecurring(txs, cfg, ym, endedKeys)`. Show `.filter(r => r.active)`
as a list: label, category, typical amount, a 6-point sparkline from
`r.months`, and a ▲/▼ percentage chip when `Math.abs(r.changePct)` is at or
above `cfg.recurring.changeThresholdPct`. Mark rows where
`r.postedThisMonth == null` as "not yet this month".

Give each row a small ✕ that appends `r.key` to the settings doc
`endedRecurring` (an array of keys) — this is how a finished commitment like a
paid-off loan stops being projected forward.

## 5. Projection on Home

Replace the "N/day avg" figure with `computeProjection(txs, cfg, ym, now,
endedKeys)`. Use `.projected` as the headline and show the split underneath:
`{committedRemaining} still committed · {discretionaryRunRate} run-rate`.

This matters a lot — on a month with one small expense the old average said
AED 620 where the real answer was AED 12,421, because rent and bills hadn't
posted yet.

## 6. Rollover carry

For any bucket where `bucketCarry(txs, cfg, bucketId, ym)` is non-zero, show a
chip reading e.g. "+AED 850 carried" and use `budget + carry` as the
denominator for the percentage.

Do **not** add a rollover on/off control to mobile. That flag lives in the
`bucketRollover` settings doc and is edited in the web app only.

## Important: settings writes

Writing a settings doc replaces the **whole** settings collection, and the local
copy only refreshes on the next Firestore snapshot. If you write two docs in a
row from the same stale snapshot, the second silently erases the first.

Batch all settings changes from one user action into a single write.

Also: when saving a budget edit, preserve every key already in the
`budgetConfig` doc that you did not intentionally change.
