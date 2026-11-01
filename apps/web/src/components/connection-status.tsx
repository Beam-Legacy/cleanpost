import { Dot, StatusChip, type Status } from '@cleanpost/ui';

const CHIP: Record<string, Status> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  failed: 'Failed',
  setup: 'Setup',
  testing: 'Testing',
  paused: 'Paused',
};

export function ConnectionChip({ status }: { status: string }) {
  return <StatusChip status={CHIP[status] ?? 'Setup'} />;
}

/** CL-01 health dot: green healthy, amber degraded or setup, red failed. Always with its word. */
export function ConnectionDot({ status }: { status: string | null }) {
  if (!status) return <span className="subtle">No connection</span>;
  const tone = status === 'healthy' ? 'good' : status === 'failed' ? 'bad' : 'warn';
  const label = CHIP[status] ?? status;
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <Dot tone={tone} label={label} />
      {label}
    </span>
  );
}
