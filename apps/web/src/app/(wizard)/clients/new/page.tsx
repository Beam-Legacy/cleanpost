import { redirect } from 'next/navigation';

/** CL-01 Add client starts the wizard at O-01. */
export default function NewClientPage() {
  redirect('/clients/new/practice');
}
