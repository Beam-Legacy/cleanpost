'use client';
/** Settings sections (S-01 to S-14): one secondary nav on the left, as in the designs. */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BellRing,
  Building2,
  Gauge,
  GitCompare,
  Image,
  ListChecks,
  ReceiptText,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { SETTINGS_SECTIONS } from './sections';

const ICON = {
  users: Users,
  automation: Gauge,
  rules: ListChecks,
  mappings: GitCompare,
  notifications: BellRing,
  branding: Image,
  usage: ReceiptText,
  security: ShieldCheck,
  company: Building2,
} as const;

export function SettingsNav() {
  const path = usePathname();
  return (
    <nav className="card settings-nav" aria-label="Settings sections">
      {SETTINGS_SECTIONS.map((s) => {
        const Icon = ICON[s.key];
        const active = path === `/settings/${s.key}` || path.startsWith(`/settings/${s.key}/`);
        return (
          <Link
            key={s.key}
            href={`/settings/${s.key}`}
            className={`nav-item${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon aria-hidden />
            <span>{s.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
