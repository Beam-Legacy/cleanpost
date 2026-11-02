/** "Lastname, F." as lists and panels show a patient (W-01, C-01). */
export const patientLabel = (p: { lastName: string; firstName: string } | null) =>
  p ? `${p.lastName}, ${p.firstName.slice(0, 1)}.` : null;
