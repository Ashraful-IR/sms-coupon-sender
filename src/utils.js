// Accepts 01XXXXXXXXX, 1XXXXXXXXX (Excel stripped the 0), 8801XXXXXXXXX, +8801XXXXXXXXX
function normalizeMsisdn(raw) {
  let n = String(raw || '').replace(/[\s\-+()]/g, '');
  if (/^01[3-9]\d{8}$/.test(n)) n = '88' + n;
  else if (/^1[3-9]\d{8}$/.test(n)) n = '880' + n;
  return /^8801[3-9]\d{8}$/.test(n) ? n : null;
}

function render(template, row) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (row[key] !== undefined ? String(row[key]).trim() : ''));
}

module.exports = { normalizeMsisdn, render };
