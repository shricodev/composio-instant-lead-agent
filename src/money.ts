// Exact USD arithmetic. Composio reports Instant charges as decimal strings with
// up to 12 fractional digits, so amounts are held as bigint pico-dollars
// (1 USD = 10^12 pUSD). Never floats.

const SCALE = 12;
const ONE_USD = 10n ** BigInt(SCALE);

export type Pico = bigint;

export function usdToPico(usd: string): Pico {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(usd.trim());
  if (!m) throw new Error(`Invalid USD amount: "${usd}"`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > SCALE && /[1-9]/.test(frac.slice(SCALE))) {
    throw new Error(`USD amount has more than ${SCALE} significant decimals: "${usd}"`);
  }
  return BigInt(whole) * ONE_USD + BigInt(frac.slice(0, SCALE).padEnd(SCALE, "0"));
}

/** Format pico-USD as a plain decimal string, trimming trailing zeros (min 2 dp). */
export function picoToUsd(p: Pico): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const whole = abs / ONE_USD;
  let frac = (abs % ONE_USD).toString().padStart(SCALE, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
