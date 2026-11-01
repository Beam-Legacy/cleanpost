# Tebra adapter

Status: **skeleton** (types and mapping; no live calls). Built in M6 against a test practice. Facts and sources: `docs/15-integrations-reference.md` (Tebra details) and `docs/05-adapters.md` (expected capabilities).

## Access

1. A Tebra system administrator for the practice's account opens a Customer Care case to turn on API access.
2. They copy the customer key from My Account › Get Customer Key.
3. They create a dedicated user for Cleanpost. Tebra requires API users to have the System Admin role (broader than our least-privilege rule; recorded in `docs/17-decisions.md` DEC-08).
4. Credentials go to the secrets manager; `connections.credentials_secret_ref` holds the reference. One customer key covers the whole account, so practices in one billing-company account share `pm_account_ref` and one rate limiter.

## What the schema already tells us (Nov 1, 2026)

- `GetCharges` returns, per charge line and per insurance order, allowed amount, payment, contractual adjustment with its reason, secondary adjustment with its reason, deductible, coinsurance and copay, plus the payment reference and posting date. This should make the posting match line by line (`map.ts` `mapChargeToPosting`).
- `GetCharges` has no diagnosis codes (only `EncounterDiagnosisID1-4`); diagnoses come from `GetEncounterDetails`.
- Rendering provider is an ID, not an NPI; map it through `GetProviders`.
- No ERA or 835 access: remittance files are uploaded (level 3).

## Open questions for the Tebra test

- Does the practice route encounters through Review, so `UpdateEncounterStatus` can hold and release?
- What text does `PrimaryInsuranceInsuranceContractAdjustmentReason` carry (a CARC, Tebra's own code, or free text)?
- What CLM01 (patient control number) does Tebra send to payers?
- Can billers download raw 835 files?
- Rate limits and polling as documented, under real load.
