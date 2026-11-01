import {
  Building2,
  ChartColumn,
  CircleX,
  FileText,
  Inbox,
  Landmark,
  ListChecks,
  PlugZap,
  ScrollText,
  Settings,
} from 'lucide-react';
import type { NavItem } from '@/lib/nav';

export const NAV_ICONS: Record<NavItem['icon'], typeof Inbox> = {
  inbox: Inbox,
  'file-text': FileText,
  landmark: Landmark,
  'circle-x': CircleX,
  'list-checks': ListChecks,
  'building-2': Building2,
  'chart-column': ChartColumn,
  'plug-zap': PlugZap,
  settings: Settings,
  'scroll-text': ScrollText,
};
