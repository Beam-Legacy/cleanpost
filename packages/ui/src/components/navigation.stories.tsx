import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { FilterChip, KeyValue, Segmented, Stepper, Tabs, Timeline } from './navigation';

const meta: Meta = { title: 'Base/Navigation' };
export default meta;

export const TabsAndFilters: StoryObj = {
  render: function TabsAndFilters() {
    const [density, setDensity] = useState<'compact' | 'comfortable'>('compact');
    return (
      <div className="stack">
        <Tabs
          label="Claim"
          tabs={[
            { value: 'summary', label: 'Summary', content: <p>Summary</p> },
            { value: 'lines', label: 'Lines', content: <p>Lines</p> },
            { value: 'timeline', label: 'Timeline', content: <p>Timeline</p> },
          ]}
        />
        <div className="filters">
          <FilterChip label="All" count={23} on />
          <FilterChip label="Claim review" count={9} />
          <FilterChip label="Denials" count={6} />
        </div>
        <Segmented
          label="Density"
          value={density}
          onChange={setDensity}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'comfortable', label: 'Comfortable' },
          ]}
        />
      </div>
    );
  },
};

export const Progress: StoryObj = {
  render: () => (
    <div className="grid-2">
      <Stepper
        steps={['Practice', 'Providers and locations', 'PM system', 'Connect', 'Dry run']}
        current={3}
      />
      <div className="stack">
        <Timeline
          label="Claim timeline"
          events={[
            { title: '277CA accepted by Availity', meta: 'PM sync · Oct 28, 2:14 pm', tone: 'good' },
            { title: 'Released in Tebra', meta: 'Approved by Dana R. · Oct 27, 4:40 pm', tone: 'info' },
            { title: 'Needs review: modifier 25', meta: 'Rule set v14 · Oct 27, 9:02 am', tone: 'warn' },
          ]}
        />
        <KeyValue
          items={[
            ['Payer', 'UnitedHealthcare'],
            [
              'Control number',
              <span key="c" className="code">
                LFM-26-004812
              </span>,
            ],
          ]}
        />
        <KeyValue
          figures
          items={[
            ['Claims', '9'],
            ['Lines matching', '18'],
          ]}
        />
      </div>
    </div>
  ),
};
