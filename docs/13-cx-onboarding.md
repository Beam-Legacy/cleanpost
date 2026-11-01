# 13 — Customer experience: onboarding, notifications, support

The customer is the billing company. Their customers are practices. Cleanpost succeeds when the billing company looks better to its clients.

## Tenant onboarding (billing company)

1. Signed agreement and BAA.
2. Tenant created by Cleanpost; admin invited; MFA enrolled.
3. Kickoff call (Julia): goals, baseline metrics (claims per biller, first-pass rate, days in A/R, denial rate) recorded in the tenant record so improvement can be shown later.
4. First client onboarded together (S-07), usually in Mode A, in "Review everything".
5. Two-week review period, then thresholds raised together based on data.
6. 30-day review: baseline vs now report, generated from S-14.

## Client go-live checklist (required before `live`)

- [ ] Practice, providers and locations complete; NPIs verified against NPPES
- [ ] Connection healthy (or manual adapter chosen deliberately)
- [ ] Dry-run pull reviewed: counts look right, 10 sample encounters spot-checked
- [ ] Payers mapped to Stedi payer IDs; timely filing days set
- [ ] Mode chosen; for B/C, PM electronic submission disabled or `markChargeBilled` supported
- [ ] For B: ERA enrollment status per payer visible; payers not yet enrolled run as C
- [ ] Adjustment mappings reviewed; no unmapped codes from the dry run
- [ ] Auto-release threshold set (or Review everything)
- [ ] Primary and backup biller assigned
- [ ] Practice informed (template email provided) of the go-live date

## In-product guidance

- Contextual "What's this?" popovers on every KPI, mode, threshold and adjustment code.
- Each work item explains why it exists and what resolving it does.
- First-week checklist panel for new users (work 10 items, use keyboard shortcuts, save a view).
- No product tours that block work.

## Notifications

In-app plus a daily email digest (no PHI in email). Immediate email only for: connection failed, out-of-balance remittance over a set amount, timely filing risk, SLA breach on priority 1. Users set quiet hours.

## Support

- In-app "Get help" opens a form that attaches the current screen route and record IDs (not PHI).
- Target first response: under 1 business hour during the pilot (Julia and James).
- Status page for platform incidents.
- Monthly check-in per tenant during the first 6 months.

## Client-facing value (for the billing company to show its practices)

- Monthly branded report (S-14 export) per client.
- Phase 2: read-only client portal (S-21).

## Measuring CX

- Time to first live client (target < 7 days from signature)
- Biller weekly active use; items resolved per biller per day
- Support tickets per 1,000 claims
- Tenant NPS quarterly
