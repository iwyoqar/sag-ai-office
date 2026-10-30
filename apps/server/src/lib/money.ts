// Money without floating point. Amounts are integers in minor units (UZS tiyin, USD cents …) and travel through the
// API as decimal strings ("1250000.00"). Exchange rates are integers scaled by 10^8. All arithmetic is BigInt.
export const RATE_SCALE = 100_000_000n; // rate × 10^8

const DECIMAL = /^(-)?(\d{1,15})(?:\.(\d+))?$/;

/** "1250000.5" → 125000050n for 2 minor units. Rejects more decimals than the currency has, exponents, spaces. */
export function parseAmount(text: string, minorUnits: number): bigint {
  const m = DECIMAL.exec(text.trim());
  if (!m) throw new Error(`invalid amount: ${text}`);
  const frac = m[3] ?? "";
  if (frac.length > minorUnits) throw new Error(`too many decimals for this currency: ${text}`);
  const v = BigInt(m[2]) * 10n ** BigInt(minorUnits) + BigInt((frac + "0".repeat(minorUnits)).slice(0, minorUnits) || "0");
  return m[1] ? -v : v;
}

/** 125000050n, 2 → "1250000.50" */
export function formatAmount(minor: bigint, minorUnits: number): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const base = 10n ** BigInt(minorUnits);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(minorUnits, "0");
  return `${neg ? "-" : ""}${whole}${minorUnits ? `.${frac}` : ""}`;
}

/** "12650.5" → 1265050000000n (rate × 10^8); at most 8 decimals, strictly positive. */
export function parseRate(text: string): bigint {
  const r = parseAmount(text, 8);
  if (r <= 0n) throw new Error("exchange rate must be positive");
  return r;
}

/** Integer division rounding half to even (banker's rounding), for any signs. */
export function divRoundHalfEven(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("division by zero");
  if (d < 0n) { n = -n; d = -d; }
  const q = n / d; // truncates toward zero
  const r = n % d;
  const twice = 2n * (r < 0n ? -r : r);
  if (twice < d) return q;
  if (twice > d) return n < 0n ? q - 1n : q + 1n;
  return q % 2n === 0n ? q : n < 0n ? q - 1n : q + 1n;
}

/**
 * Converts an amount to the reporting currency: `rateE8` = reporting units per 1 original unit × 10^8.
 * Minor units of both currencies are respected; rounded once, half-even.
 */
export function convert(amountMinor: bigint, fromMinorUnits: number, rateE8: bigint, toMinorUnits: number): bigint {
  // amount / 10^from × rate / 10^8 × 10^to
  const num = amountMinor * rateE8 * 10n ** BigInt(toMinorUnits);
  const den = RATE_SCALE * 10n ** BigInt(fromMinorUnits);
  return divRoundHalfEven(num, den);
}
