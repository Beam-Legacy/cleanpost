'use client';
/**
 * Demo time (DEC-18): hands the server's clock offset to the browser, so relative times ("2 days
 * ago") and client-side checks use the same date as the server. Always 0 outside local and preview.
 * Set during render, before the rest of the page renders.
 */
import { getOffset, setOffset } from '@cleanpost/clock';

export function ClockOffset({ ms }: { ms: number }) {
  if (getOffset() !== ms) setOffset(ms);
  return null;
}
