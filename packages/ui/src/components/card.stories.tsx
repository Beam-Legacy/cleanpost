import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './button';
import { Card, CardBody, CardFoot, CardHead, KpiRow, KpiTile } from './card';

const meta: Meta = { title: 'Base/Card' };
export default meta;

export const Basic: StoryObj = {
  render: () => (
    <Card style={{ maxWidth: 520 }}>
      <CardHead title="Connection test">
        <span className="subtle">Today 2:41 pm</span>
      </CardHead>
      <CardBody>Everything Tebra allows is working.</CardBody>
      <CardFoot>
        <Button variant="primary">Continue</Button>
      </CardFoot>
    </Card>
  ),
};

export const Kpis: StoryObj = {
  render: () => (
    <KpiRow label="Today">
      <KpiTile label="Due today" value="18" />
      <KpiTile label="Overdue" value="3" tone="bad" />
      <KpiTile label="Posted today" value="$38,214" tone="good" />
      <KpiTile label="Released without review today" value="71%" delta={{ text: '+4 pts vs last week', tone: 'good' }} />
    </KpiRow>
  ),
};
