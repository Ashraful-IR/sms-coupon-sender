// Accepts 01XXXXXXXXX, 1XXXXXXXXX (Excel stripped the 0), 8801XXXXXXXXX, +8801XXXXXXXXX
function normalizeMsisdn(raw) {
  let n = String(raw || '').replace(/[\s\-+()]/g, '');
  if (/^01[3-9]\d{8}$/.test(n)) n = '88' + n;
  else if (/^1[3-9]\d{8}$/.test(n)) n = '880' + n;
  return /^8801[3-9]\d{8}$/.test(n) ? n : null;
}

// {stage} renders in the SMS as a Bangla ordinal: 1 -> ১ম, 2 -> ২য়, 3 -> ৩য়, 4 -> ৪র্থ,
// 5 -> ৫ম, 6 -> ৬ষ্ঠ, any other number -> <digits>ম. The result CSV keeps the raw column
// value; only the rendered message body is converted.
const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
const BN_SUFFIX = { 1: 'ম', 2: 'য়', 3: 'য়', 4: 'র্থ', 6: 'ষ্ঠ' };

function toBanglaOrdinal(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const n = Number(raw);
  // Only a plain number is converted; anything else ("stage 2", "প্রথম", "2nd") passes through untouched.
  if (!Number.isInteger(n) || n < 1 || String(n) !== raw) return raw;
  const digits = String(n).split('').map((d) => BN_DIGITS[Number(d)]).join('');
  return digits + (BN_SUFFIX[n] || 'ম');
}

function render(template, row) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (row[key] === undefined) return '';
    const value = key === 'stage' ? toBanglaOrdinal(row[key]) : row[key];
    return String(value).trim();
  });
}

module.exports = { normalizeMsisdn, render, toBanglaOrdinal };
