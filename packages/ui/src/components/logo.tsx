/** Cobalt rounded square with a check over a double rule ("posted and balanced"), docs/10-design-system.md. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--cobalt)" />
      <path
        d="M9 14.2l4.3 4.3L23 8.8"
        fill="none"
        stroke="var(--on-cobalt)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 22.6h14M9 26h14" fill="none" stroke="var(--on-cobalt)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="side-brand" style={{ padding: 0 }}>
      <LogoMark />
      <span>cleanpost</span>
    </span>
  );
}
