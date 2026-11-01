/**
 * Tebra SOAP Web Services 2.1 types used by the adapter, from the public WSDL and its schemas
 * (https://webservice.kareo.com/services/soap/2.1/KareoServices.svc?wsdl, checked Nov 1, 2026).
 * Tebra returns every value as a string. Only fields the adapter reads are listed.
 */
export interface TebraRequestHeader {
  ClientVersion?: string;
  CustomerKey: string;
  User: string;
  Password: string;
}

/** Draft | Review | Approved | Rejected (UpdateEncounterStatus works only from Draft or Review). */
export type TebraEncounterStatus = 'Draft' | 'Review' | 'Approved' | 'Rejected';

/** GetCharges filter (ChargeFilter). Date filters come in pairs; at least one filter is required. */
export interface TebraChargeFilter {
  PracticeName: string;
  FromLastModifiedDate?: string;
  ToLastModifiedDate?: string;
  FromServiceDate?: string;
  ToServiceDate?: string;
  IncludeUnapprovedCharges?: 'T' | 'F';
  EncounterStatus?: TebraEncounterStatus;
}

/** One charge line (ChargeData). Primary/secondary/tertiary insurance fields repeat per order. */
export interface TebraChargeData {
  ID: string;
  EncounterID: string;
  EncounterProcedureID: string;
  EncounterStatus: string;
  PatientID: string;
  PracticeID: string;
  PracticeName: string;
  ServiceStartDate: string;
  PostingDate: string;
  LastModifiedDate: string;
  ProcedureCode: string;
  ProcedureModifier1?: string;
  ProcedureModifier2?: string;
  ProcedureModifier3?: string;
  ProcedureModifier4?: string;
  Units: string;
  UnitCharge: string;
  TotalCharges: string;
  RenderingProviderID: string;
  ServiceLocationPlaceOfServiceCode?: string;
  /** Completed | Pending | Ready | Error – Rejection | Error – Denial | Error – No Response | Undefined */
  Status: string;
  PrimaryInsuranceCompanyName?: string;
  PrimaryInsuranceInsuranceAllowed?: string;
  PrimaryInsuranceInsurancePayment?: string;
  PrimaryInsuranceInsuranceContractAdjustment?: string;
  PrimaryInsuranceInsuranceContractAdjustmentReason?: string;
  PrimaryInsuranceInsuranceDeductible?: string;
  PrimaryInsuranceInsuranceCoinsurance?: string;
  PrimaryInsuranceInsuranceCopay?: string;
  PrimaryInsuranceInsuranceSecondaryAdjustment?: string;
  PrimaryInsuranceInsuranceSecondaryAdjustmentReason?: string;
  PrimaryInsurancePaymentRef?: string;
  PrimaryInsurancePaymentPostingDate?: string;
}
