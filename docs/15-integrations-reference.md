# 15 — Integrations reference

Verify every endpoint and field against current vendor documentation before implementing. Items marked (verify) were not confirmed when this spec was written.

## Stedi (clearinghouse)

- Docs: https://www.stedi.com/docs/healthcare
- Pricing (Oct 2026, pay-as-you-go, no monthly minimum, signed BAA on paid plans): eligibility $0.30→$0.08, claim submission $0.30→$0.10, ERA $0.20→$0.08 per adjudicated claim, claim status $0.30→$0.08, 277CA free, enrollment API free, payers API free, member ID card payer lookup $0.20. Volume discounts above $1,000/month spend.
- Professional claims: `POST https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/professionalclaims/v3/submission` (JSON in Change Healthcare's format; Stedi translates to 837P).
- Institutional claims: `POST .../change/medicalnetwork/institutionalclaims/v1/submission`.
- Eligibility (270/271), claim status (276/277), 835 ERA retrieval, transaction enrollment, payers list: see docs (verify exact paths).
- 277CA and 835 delivered by webhook ("transaction processed" events); fetch full content via API.
- Correlation: our `patientControlNumber` comes back in 277CA and 835 (CLP01); per-line `lineItemControlNumber` (REF*6R) comes back for line matching.
- Sandbox: free test keys; mock eligibility; test claims return a 277CA but no 835 (hence `apps/payer-sim`).
- ERA enrollment: providers must enroll per payer; a provider receives ERAs from only one clearinghouse per payer.
- Also available: SFTP for X12 files, Stedi Lockbox for paper mail ($49/lockbox/month).

## PM systems

| PM | Access path | Cost to us | Notes |
| --- | --- | --- | --- |
| Tebra (Kareo) | SOAP Web Services API 2.1 (`webservice.kareo.com`); customer key plus a Tebra user login on every call | API access is part of the practice's subscription; no metered fee | Reads patients, charges, encounters, payments, transactions; updates encounter status; creates encounters and payment headers. No ERAs. FHIR API is read-only clinical. Details below. |
| athenaOne | Proprietary REST API (`api.athenahealth.com/v1/{practiceid}`), FHIR R4 | Marketplace partner approval, security review; per-call fees for proprietary APIs | athena often posts remits as part of its service; Mode A verify-only fits. |
| AdvancedMD | Vendor API (terms to confirm) | Unknown | Managed third-party API exists |
| ModMed | Partner-gated write API | Unknown | Specialty-heavy (derm, ortho, GI, ophthalmology) |
| SimplePractice | No official public API | — | Managed API or browser automation |
| Others | Research per design partner | | |

## Tebra details

Source: Tebra's "API Integration Technical Guide" (Web Services API 2.1, updated April 2026) and the public WSDL at `https://webservice.kareo.com/services/soap/2.1/KareoServices.svc?wsdl` (checked Nov 1, 2026). Re-check both before building the adapter.

- **Test access:** Tebra publishes no sandbox or developer account. API access belongs to a Tebra customer account: a system administrator of that account opens a Customer Care case to enable the customer key, then copies it from My Account › Get Customer Key. The key covers the whole account. Plan: a test practice holding synthetic patients only in the design partner's account, and a request to Tebra for a developer or demo account.
- **API user:** must have the System Admin role (accounts created after May 2016) or Account Administrator permission (billing-company accounts and older accounts). This is broader than our least-privilege rule; record it in the adapter README and state it in O-04.
- **Billing-company accounts:** one Tebra account can hold several practices. Calls select one by `PracticeName` or `PracticeID`; Cleanpost maps one connection per practice, sharing `pm_account_ref`.
- **Operations in the WSDL:** Get (AllPatients, Appointment, Appointments, AppointmentReasons, Charges, CustomerIdFromKey, EncounterDetails, ExternalVendors, Patient, Patients, Payments, PracticeResourceSchedules, PracticeResourceTimeOffs, Practices, ProcedureCodes, ProviderSchedules, ProviderTimeOffs, Providers, ServiceLocations, Throttles, Transactions); Create (Appointment, AppointmentReason, Document, Encounter, Patient, Payment); Update (Appointment, AppointmentStatus, EncounterStatus, Patient, PatientsExternalID, PrimaryPatientCase); Delete (Appointment, Document); RegisterExternalVendor.
- **Not available:** ERAs or 835 files, claim submission control, editing an encounter or its charges, posting a payment to specific lines with adjustments.
- **Behaviour that matters:**
  - `GetCharges` can include unapproved encounters (`IncludeUnapprovedCharges = T`) and filter by `EncounterStatus` (Draft, Review, Approved, Rejected). Each charge carries a status: Completed, Pending, Ready, Error – Rejection, Error – Denial, Error – No Response, Undefined.
  - `UpdateEncounterStatus` works only on encounters in Draft or Review and sets Draft, Review, Approved or Rejected.
  - `CreatePayment` records a payment header (patient, insurance plan, amount, method, reference number, post and adjudication dates) with no allocation to charges.
  - Every Get needs at least one filter; date filters come in pairs; the default window is the last 7 days.
- **Rate limits (per Tebra account, subject to change; `GetThrottles` reports current values):** 1 call per second for GetCharges, GetPayments, GetTransactions, GetPatients, GetAppointments, UpdatePatient; 1 per ½ second for GetEncounterDetails, UpdateEncounterStatus, CreatePayments, CreateEncounter, CreatePatient, GetPractices, GetProviders, GetServiceLocations, GetProcedureCode; 1 per ¼ second for GetPatient and SearchPatient; 1 per 5 seconds for GetAllPatients. Over the limit: HTTP 429 naming the endpoint.
- **Polling:** Tebra asks integrations to poll as rarely as possible (its example: every 2 hours rather than every 5 minutes), filter narrowly (by practice and date) and run heavy queries after hours.
- **Support:** Customer Care cases, with the request and response XML; Tebra supports only its own side.
- **Managed third-party APIs** for Tebra exist (level 2). Not planned; each would need a BAA and a terms review.

## X12 quick reference

- 837P/837I: loops 2000A billing provider, 2000B subscriber, 2000C patient, 2300 claim (CLM01 patient control number, CLM05-3 frequency code 1/7/8), 2400 service lines (REF*6R line control number), 2320/2430 prior payer for secondaries.
- 835: BPR payment, TRN trace, CLP claim (CLP02 status: 1 primary, 2 secondary, 3 tertiary, 4 denied, 19/20/21 processed as primary/secondary/tertiary forwarded, 22 reversal), CAS adjustments (group CO/PR/OA/PI/CR + CARC + amount), SVC lines, LQ remarks (RARC), PLB provider adjustments.
- 277CA: claim-level acceptance or rejection with status category codes (A1/A2 acknowledged/accepted, A3/A7 rejected).

## Code sets and sources

| Code set | Source | License |
| --- | --- | --- |
| ICD-10-CM | CMS (annual, Oct 1) | Free |
| HCPCS Level II | CMS (quarterly) | Free |
| CPT | AMA | **License required** to display descriptions or ship code tables; codes pulled from client PMs only until licensed |
| CARC / RARC | X12 (published code lists) | Check X12 terms for redistribution; store codes with our own plain-language labels |
| NCCI PTP and MUE edits | CMS (quarterly) | Free |
| Place of service | CMS | Free |
| NPI registry | NPPES API | Free |

## File adapter: charge CSV template

```
encounter_id,patient_id,patient_last,patient_first,dob,sex,payer_name,member_id,group_number,relationship,dos,rendering_npi,location_id,pos,dx1,dx2,dx3,dx4,line_id,code,mod1,mod2,mod3,mod4,units,charge,dx_pointers
E10021,P5532,Rivera,Ana,1984-03-12,F,Aetna,W123456789,GRP001,self,2026-10-27,1234567893,L1,11,M54.50,,,,1,99213,,,,,1,145.00,1
```
(Synthetic example values.)
