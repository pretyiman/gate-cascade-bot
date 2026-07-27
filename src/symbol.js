const QUOTE = 'USDT';

/**
 * Accepts a bare coin ticker ("doge", "DOGE"), a pair with any separator/case
 * ("doge_usdt", "Doge_Usdt"), or a pair with no separator ("dogeusdt", "DOGEUSDT")
 * and normalizes all of them to Gate.io's expected "BASE_USDT" format.
 */
function normalizeSymbol(raw) {
  if (typeof raw !== 'string') return raw;

  const s = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!s) return s;

  if (s.includes('_')) {
    const [base, quote] = s.split('_');
    return base && quote ? `${base}_${quote}` : s;
  }

  if (s.endsWith(QUOTE) && s.length > QUOTE.length) {
    return `${s.slice(0, -QUOTE.length)}_${QUOTE}`;
  }

  return `${s}_${QUOTE}`;
}

module.exports = { normalizeSymbol };
