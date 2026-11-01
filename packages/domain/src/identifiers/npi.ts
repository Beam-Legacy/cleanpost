/**
 * NPI check digit: Luhn over the 9-digit base with the 80840 prefix (docs/06-rules-and-ai.md,
 * structural scrub). Pure functions.
 */
function luhnSum(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum;
}

/** The check digit for a 9-digit NPI base. */
export function npiCheckDigit(base9: string): number {
  if (!/^\d{9}$/.test(base9)) throw new Error('NPI base must be 9 digits');
  return (10 - (luhnSum(`80840${base9}`) % 10)) % 10;
}

export function isValidNpi(npi: string): boolean {
  return /^\d{10}$/.test(npi) && npiCheckDigit(npi.slice(0, 9)) === Number(npi[9]);
}

/** A valid NPI from a 9-digit base (synthetic data). */
export function npiFromBase(base9: string): string {
  return `${base9}${npiCheckDigit(base9)}`;
}
