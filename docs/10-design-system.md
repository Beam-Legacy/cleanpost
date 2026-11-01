# 10 — Design system

The source of truth for visual design is the **Cleanpost Design System** (tokens, brand book, logos, component guidance) and the UI reference in `ui/`. This doc summarizes what the code must follow. If this doc and `ui/assets/tokens.css` disagree, the tokens file wins.

## Character

Precise, calm, sure of its numbers: a well-kept ledger. Neutrals carry the interface, cobalt marks what you can act on, and status colors appear only when something needs a person or has reached a final outcome. Dense where people work (queue, tables, side panel); roomy where they decide (onboarding, settings) and on the website.

## Tokens

Copy `ui/assets/tokens.css` into `packages/ui/tokens.css` unchanged and map Tailwind theme colors to the CSS variables. Never use raw hex values in components.

| Role | Tokens |
| --- | --- |
| Grounds | `canvas`, `surface`, `surface-sunken` |
| Text | `ink`, `ink-muted`, `ink-subtle` (captions only) |
| Lines | `border` (decorative), `border-control` (inputs, 3:1) |
| Brand and action | `cobalt`, `cobalt-hover`, `on-cobalt`, `cobalt-tint`; `cobalt-soft` for website graphics only |
| Outcomes | `success`, `warning`, `danger` and their `-tint` backgrounds; reserved for status |
| Charts | `chart-1` to `chart-5`, in order |

Light and dark values are defined for every token; both pass WCAG 2.2 AA for every text pairing named in the design system.

## Type

- `display`: Schibsted Grotesk 600/700. Website headlines, onboarding step titles, sign-in.
- `sans`: Public Sans 400/500/600. All product UI.
- `mono`: IBM Plex Mono 400/500. Codes and identifiers only (CPT/HCPCS, ICD-10, modifiers, CARC/RARC, NPIs, trace and control numbers).
- Scale: display-xl 56/60, display-l 40/44, display-m 28/34, title-l 22/28, title-m 17/24, body 14/21, body-dense 13/18, label 13/18 500, caption 12/16, overline 11/16 600 uppercase +0.06em, figure-l 28/34, figure-m 18/24, code 12/18 500.
- Tabular figures on every number in tables, tiles and headers.

## Status vocabulary

Every chip shows an icon and a word; color is never the only signal.

| Status | Style | Lucide icon |
| --- | --- | --- |
| Draft, Closed, Voided | outline, ink-muted | circle-dashed |
| Built, Submitted, Accepted, Reversed | surface-sunken, ink-muted | clock |
| Ready | cobalt-tint, cobalt | send |
| Needs review, Blocked, Partially paid, Due soon | warning-tint, warning | triangle-alert |
| Rejected, Denied, Overdue, Failed, Out of balance | danger-tint, danger | circle-x |
| Paid, Posted, Balanced, Healthy | success-tint, success | circle-check |

Mode badges (A, B, C) use the code style on `surface` with a `border` outline and a tooltip.

## Layout

- 4px grid; spacing 4, 8, 12, 16, 24, 32, 64.
- App shell: sidebar 240px (64px collapsed), top bar 56px, page padding 24px, content up to 1440px. Side panel 480px, resizable 400–720.
- Radii: 4 (codes, badges), 6 (buttons, inputs), 10 (cards, panels), 14 (modals), pill (status chips, counts).
- Borders separate surfaces. `shadow-overlay` only on menus, popovers, side panel, modals, toasts.
- Density per user: Compact (32px rows, default for billers) and Comfortable (44px rows).
- Desktop first. The app reads at tablet width; on phones it offers sign-in, notifications and reports only. The website is fully responsive.

## Components

The component classes in `ui/assets/components.css` each map to one React component in `packages/ui` (names in that file's comments): AppShell, Sidebar, TopBar, Button, IconButton, StatusChip, ModeBadge, CodeChip, Card, KpiTile, DataTable, Tabs, Segmented, FilterBar, FilterChip, Field, Input, Select, Checkbox, Switch, Slider, SidePanel, Modal, Drawer, Popover, Menu, Toast, Banner, Callout, Suggestion, FindingRow, ConfidenceMeter, Timeline, KeyValue, BalanceBar, Stepper, EmptyState, ErrorState, Skeleton, BarList, Sparkline. Build them on shadcn/ui (Radix) primitives and restyle with the tokens.

## Icons

Lucide (`lucide-react`), 16px in dense UI and 20px elsewhere, 1.5px stroke. `sparkles` is reserved for AI suggestions, always with the word "Suggested". Icon-only buttons need `aria-label` and a tooltip. No emoji.

## Writing

Plain words before codes ("Coverage ended before this visit", then `CO-27`). Lead with the action. Name who or what did something. Sentence case everywhere; uppercase only in overline labels. Buttons name outcomes ("Release claim"); toasts repeat them ("Claim released."). Formats: `$1,284.50`, `94.2%`, `Oct 29, 2026`, `2:14 pm PT`. Patient names in lists as "Last, F.".

## Motion and accessibility

- 150ms ease-out for hover, panel open and toasts; no animation on tables, numbers or charts; honor `prefers-reduced-motion`.
- WCAG 2.2 AA in both themes; 2px solid cobalt focus ring with 2px offset on every interactive element; full keyboard operation with remappable queue shortcuts; targets at least 24×24px in the app and 44×44px on the website; every chart has a table view; axe checks in CI.

## Logo

Cobalt rounded square with a white check over a double rule ("posted and balanced"), next to "cleanpost" in lowercase Schibsted Grotesk 700, −0.02em. Files: `ui/assets/logo/`. Client-facing reports carry the billing company's logo, not Cleanpost's.
