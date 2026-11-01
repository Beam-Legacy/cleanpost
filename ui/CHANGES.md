# Changes made directly in this folder

These files were exported from the Cleanpost design source. The edits below were made here, in the repo, after export. If the designs are regenerated, apply each change at the source first, or the export will overwrite it. Remove an entry once the source has it.

## Nov 1, 2026 — Tebra copy matches Tebra's API

Reason: Tebra's API guide (April 2026) and public WSDL. See `docs/05-adapters.md` (Tebra: expected capabilities) and `docs/15-integrations-reference.md` (Tebra details).

| View | File | Was | Now |
| --- | --- | --- | --- |
| O-03 | clients.html | Tebra card: Hold charges "Not available"; Read claim status and payments "Official API"; Post payments "Official API"; note "Tebra has no way to hold charges, so Cleanpost scrubs before the practice's daily batch." | Hold charges "Official API"; Read claim status and payments "API and 835 upload" (`chip-ready`, `file-text`); Post payments "Manual"; note "Charges wait in Tebra's encounter review until Cleanpost releases them, so the practice must send encounters through Review. Tebra's API has no remittance files, so 835s are uploaded." |
| O-04 | clients.html | Intro "Create a dedicated API user in Tebra for Cleanpost, then paste the customer key the Tebra admin generates. We only use the permissions listed below." | "Create a dedicated user in Tebra for Cleanpost, then paste the customer key. Tebra requires API users to have the System Admin role; Cleanpost only uses the operations in the connection test." |
| O-04 | clients.html | Customer key help "In Tebra: Settings › API › Customer key. Only a Tebra system administrator can generate it." | "A Tebra system administrator asks Tebra Customer Care to turn on API access, then copies the key from My Account › Get Customer Key." |
| O-04 | clients.html | Connection test rows "Create payments · Permission granted" and "Hold charges · Not available in Tebra" | "Read remittances (835) · Upload files: not in Tebra's API" (`upload` icon, warning color) and "Hold and release charges · 12 encounters waiting in Review" (success) |
| O-04 | clients.html | Spec, Actions: "...steps to create a least-privilege API user and customer key" | "...steps to create a dedicated API user with the least privilege the PM allows, and to get the customer key; Tebra requires the System Admin role" |
| O-07 | clients.html | Intro ends "Tebra cannot hold charges, so Cleanpost scrubs before its 6:00 pm batch." | Ends "Each charge waits in Tebra's encounter review until Cleanpost releases it." |
| O-07 | clients.html | Mode B card "Payments come to Cleanpost and post into Tebra automatically." | "Payments come to Cleanpost; Tebra has no API for posting them, so Cleanpost prepares a posting worksheet for each payment." |
| I-04 | clients.html | Customer key help "In Tebra: Settings › API › Customer key." | "In Tebra: My Account › Get Customer Key (system administrators only)." |
| C-04 | claims.html | Timeline "Submitted through Stedi; charge marked billed in Tebra" | "Submitted through Stedi; Tebra's claim submission is off for this practice" |
| C-08 | claims.html | Change summary "· will be written back to Tebra"; callout "No blocking issues. Saving and releasing sends this claim to Tebra to go out in tonight's 6:00 pm batch." | "· becomes a task to make this change in Tebra"; "No blocking issues. Once the change is made in Tebra, Cleanpost releases this claim for tonight's 6:00 pm batch." |
| C-08 | claims.html | Spec, States: "PM write-back unavailable for this client: footer says \"will create a task to update Tebra\"." | "PM write-back unavailable for this client (Tebra): the change summary says each change becomes a task; Save and release creates the task and releases the claim once the next pull shows the change made in the PM." |
| R-04 | money.html | Stat "Read from: Tebra · Oct 21, 2:05 pm" | "Sources: 835 uploaded · Tebra read 2:05 pm" |
| R-04 | money.html | Spec, Data: "Parsed 835 (from the PM via pullRemittances, or uploaded);" | "Parsed 835 (from the PM via pullRemittances, or uploaded; always uploaded for Tebra, whose API has no remittance files);" |
| R-04 | money.html | Spec, States: (no case for missing codes) | Adds: "PM postings without adjustment codes (possible for Tebra; confirm in the Tebra test): the comparison checks amounts per line and shows \"Code not available from Tebra\" in place of the PM code." |
| D-02 | money.html | History "Denied in Cigna EFT 7730551 · Oct 21 · read from Tebra" | "Oct 21 · from uploaded 835" |
| WEB-05 | website.html | Tebra note "Official API. Holding charges before submission is not available." | "Official API. Charges wait in Tebra's encounter review until Cleanpost releases them; remittance files (835) are uploaded." |

Not changed, pending the Tebra test: W-20 and R-04 show Tebra adjustment codes (CONTR, PTRESP) on posted lines. Tebra's schema does return a contractual adjustment reason per line (Nov 1, 2026), so the designs are probably right; confirm what that reason holds before relying on it.
