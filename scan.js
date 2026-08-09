// Bank-SMS screenshot scanning: OCR (Tesseract.js, lazy-loaded from CDN on first
// use) plus a deterministic text parser that also powers the paste-text fallback.
// A single screenshot may contain several stacked messages — the parser anchors
// on every "AED <amount>" occurrence and slices the text into one candidate per
// genuine transaction, filtering out balance/limit lines.

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

async function ensureTesseract(){
  if (window.Tesseract) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_CDN;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the OCR engine — check your internet connection.'));
    document.head.appendChild(s);
  });
}

export async function ocrImage(file, onProgress){
  await ensureTesseract();
  const worker = await window.Tesseract.createWorker('eng', 1, {
    logger: m => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); }
  });
  try {
    const { data } = await worker.recognize(file);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

const num = v => Number(v) || 0;

function toIsoDate(d, m, y){
  let year = Number(y); if (year < 100) year += 2000;
  const mm = String(Number(m)).padStart(2, '0'), dd = String(Number(d)).padStart(2, '0');
  if (Number(m) > 12 || Number(d) > 31) return null;
  return `${year}-${mm}-${dd}`;
}

// Parse raw SMS text (from OCR or paste) into transaction candidates.
export function parseSmsText(text){
  const t = String(text || '').replace(/\r/g, '');
  const candidates = [];
  const amountRx = /AED\s*([\d,]+(?:\.\d{1,2})?)/gi;
  const anchors = [];
  let m;
  while ((m = amountRx.exec(t)) !== null) {
    // Look only at the current sentence/line so a previous message's words
    // ("Available limit…") never bleed into this anchor's context.
    const before = t.slice(Math.max(0, m.index - 40), m.index).split(/[\n.!]/).pop();
    // Skip non-transaction amounts: available limit / balance / total due lines.
    if (/limit|balance|avail|outstanding|due|total/i.test(before)) continue;
    anchors.push({ index: m.index, end: amountRx.lastIndex, amount: num(m[1].replace(/,/g, '')) });
  }
  // Each anchor's segment starts at the sentence/line boundary before it (so a
  // previous message's tail — "Available limit AED 12,000." — stays with the
  // previous message) and runs until the next anchor's segment starts.
  const starts = anchors.map((a, i) => {
    const floor = i === 0 ? 0 : anchors[i - 1].end;
    const back = t.slice(floor, a.index);
    const bm = back.match(/[\s\S]*[.!\n]/);
    return floor + (bm ? bm[0].length : 0);
  });
  anchors.forEach((a, i) => {
    const segStart = starts[i];
    const segEnd = i + 1 < anchors.length ? starts[i + 1] : t.length;
    const seg = t.slice(segStart, segEnd);
    if (a.amount <= 0) return;

    const last4M = seg.match(/(?:ending(?:\s+(?:with|in))?|card\s*(?:no\.?|number)?\s*(?:[x*]+)?|[x*]{2,})\s*(\d{4})\b/i);
    const dateM = seg.match(/\b(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})\b/);
    const timeM = seg.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
    const vendorM = seg.match(/(?:\bat|@|\bto)\s+([A-Za-z0-9][A-Za-z0-9 &.'\-*]{2,40}?)(?=\s+on\b|\s+for\b|\s+using\b|[,.\n]|$)/i);

    const isCredit = /\b(refund|reversal|credited)\b/i.test(seg);
    const candidate = {
      amount: isCredit ? -a.amount : a.amount,
      vendor: vendorM ? vendorM[1].replace(/\s+/g, ' ').trim() : '',
      date: dateM ? toIsoDate(dateM[1], dateM[2], dateM[3]) : null,
      time: timeM ? `${String(Number(timeM[1])).padStart(2,'0')}:${timeM[2]}` : '',
      last4: last4M ? last4M[1] : '',
      isCredit,
      raw: seg.trim().slice(0, 220),
    };
    // A real transaction needs at least a vendor or a card/date pairing.
    if (!candidate.vendor && !candidate.last4 && !candidate.date) return;
    candidates.push(candidate);
  });
  return candidates;
}

// Stable fingerprint for duplicate detection: vendor + amount + date + time + last4.
export function fingerprintOf(c){
  const vn = (c.vendor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return [vn, (Number(c.amount) || 0).toFixed(2), c.date || '', c.time || '', c.last4 || ''].join('|');
}
