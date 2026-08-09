// Live holding prices. Source: Yahoo Finance quote endpoint (broadest coverage
// across mixed exchanges) fetched through a configurable CORS proxy, since a
// static PWA has no backend. FX conversion to AED uses the USD peg (3.6725)
// plus frankfurter.app (ECB) for non-USD currencies. Every failure degrades
// gracefully — the app keeps the last stored price and flags it stale.

const USD_AED = 3.6725;
const fxCache = new Map();

export function proxied(target, proxyTemplate){
  const tpl = proxyTemplate || 'https://corsproxy.io/?url={url}';
  return tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(target)) : tpl + encodeURIComponent(target);
}

export async function fetchQuote(symbol, proxyTemplate){
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const resp = await fetch(proxied(target, proxyTemplate), { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`price source returned ${resp.status}`);
  const j = await resp.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error('no price in response');
  return { price: meta.regularMarketPrice, currency: meta.currency || 'USD', exchange: meta.exchangeName || '' };
}

export async function fxToAED(ccy, proxyTemplate){
  if (!ccy) return USD_AED;
  if (ccy === 'GBp' || ccy === 'GBX') return (await fxToAED('GBP', proxyTemplate)) / 100;
  const c = ccy.toUpperCase();
  if (c === 'AED') return 1;
  if (c === 'USD') return USD_AED;
  if (fxCache.has(c)) return fxCache.get(c);
  const resp = await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(c)}&to=USD`, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`FX lookup failed for ${c}`);
  const j = await resp.json();
  const usd = j?.rates?.USD;
  if (typeof usd !== 'number') throw new Error(`no USD rate for ${c}`);
  const rate = usd * USD_AED;
  fxCache.set(c, rate);
  return rate;
}

// Fetch one holding's price and convert to AED. Returns {price, currency, priceAED}.
export async function fetchPriceAED(symbol, proxyTemplate){
  const q = await fetchQuote(symbol, proxyTemplate);
  const fx = await fxToAED(q.currency, proxyTemplate);
  return { ...q, priceAED: q.price * fx };
}
