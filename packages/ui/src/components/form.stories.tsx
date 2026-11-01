import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Checkbox, Field, Input, Select, Switch, Textarea } from './form';

const meta: Meta = { title: 'Base/Form' };
export default meta;

export const Fields: StoryObj = {
  render: () => (
    <div className="form-grid" style={{ maxWidth: 720 }}>
      <Field label="Work email" help="We'll send a link to sign in.">
        {(p) => <Input {...p} type="email" defaultValue="dana@northwindbilling.com" />}
      </Field>
      <Field label="Customer key" error="Tebra rejected this key.">
        {(p) => <Input {...p} mono defaultValue="7Q2X-PLACEHOLDER" />}
      </Field>
      <Field label="Role">
        {(p) => (
          <Select {...p} defaultValue="biller">
            <option value="admin">Admin</option>
            <option value="biller">Biller</option>
            <option value="viewer">Viewer</option>
          </Select>
        )}
      </Field>
      <Field label="Note">{(p) => <Textarea {...p} defaultValue="Called payer; reprocessing." />}</Field>
    </div>
  ),
};

export const Toggles: StoryObj = {
  render: function Toggles() {
    const [on, setOn] = useState(true);
    return (
      <div className="stack">
        <Checkbox label="Use for every client on Tebra" defaultChecked />
        <Switch label="Review everything for the first 2 weeks" checked={on} onCheckedChange={setOn} />
      </div>
    );
  },
};
