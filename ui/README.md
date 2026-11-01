# Cleanpost UI reference

Static HTML designs for every view in the Cleanpost View Inventory: the app, its emails and PDFs, and the marketing website. Open `index.html` in a browser. Each design sits beside its spec (purpose, data, actions, states, rules). All patient and practice data is synthetic.

## For Claude Code

- Treat these files as the visual and behavioral spec for `apps/web`. Build each view to match its frame; implement every state, action and rule in its spec block.
- **Do not ship this HTML.** Rebuild it as React components in `packages/ui` and pages in `apps/web`. `assets/components.css` names the component each class block becomes.
- **Tokens:** copy `assets/tokens.css` into `packages/ui/tokens.css` unchanged and map Tailwind colors to the CSS variables. `assets/tokens.json` is the same data for tooling.
- **Icons:** the `data-lucide` names map one-to-one to `lucide-react` components (`circle-check` → `CircleCheck`).
- **Shell:** `assets/shell.js` only exists to draw the sidebar and top bar in this reference; in the app it is the `AppShell` layout. Its nav list is the real navigation.
- **IDs:** each section's ID (W-01, C-08, ...) matches the inventory and `docs/09-ui-screens.md`. Reference the ID in commits and PR titles for the view you build.
- **Data:** the spec blocks name tables from `docs/02-data-model.md`. Where a frame and the data model disagree, the data model wins; flag the frame.
- **Mode A first:** views marked for Modes B and C (R-03 posting, CL-10 ERA enrollment) are designed but built after the pilot unless the plan changes.

## Files

| File | Covers |
| --- | --- |
| `shell.html` | App shell, global search, notifications, toasts, confirmations, loading, empty, error and access states (G-) |
| `auth.html` | Sign-in, two-factor, invites, profile (A-) |
| `work.html` | Work queue and every side panel variant (W-) |
| `claims.html` | Claims list, claim detail, editor, claim modals, patients and eligibility (C-, P-) |
| `money.html` | Remittances, posting and verification, denials, manual tasks (R-, D-, M-) |
| `clients.html` | Clients, onboarding wizard, integrations (CL-, O-, I-) |
| `admin.html` | Reports, settings, audit log, operator console, client portal (RP-, S-, OP-, CP-) |
| `outputs.html` | Emails and PDFs (E-, F-) |
| `website.html` | Marketing website (WEB-) |
| `assets/` | Tokens, component CSS, logo files, Lucide copy, reference helpers |
| `CONVENTIONS.md` | How the reference files are built |
