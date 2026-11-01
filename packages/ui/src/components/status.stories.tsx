import type { Meta, StoryObj } from '@storybook/react-vite';
import { Avatar, CodeChip, CountBadge, Dot, DueChip, Kbd, ModeBadge, PriorityMarker, STATUS, StatusChip, Tag, type Status } from './status';

const meta: Meta = { title: 'Base/Status' };
export default meta;

export const AllStatuses: StoryObj = {
  render: () => (
    <div className="row">
      {(Object.keys(STATUS) as Status[]).map((s) => (
        <StatusChip key={s} status={s} />
      ))}
    </div>
  ),
};

export const Badges: StoryObj = {
  render: () => (
    <div className="stack">
      <div className="row">
        <ModeBadge mode="A" />
        <ModeBadge mode="B" long />
        <CodeChip code="CO-45" meaning="Amount above the contracted rate, written off" />
        <CodeChip code="CO-4" meaning="Modifier inconsistent with procedure" tone="bad" />
        <span className="code">LFM-26-004812</span>
      </div>
      <div className="row">
        <DueChip>2 d</DueChip>
        <DueChip state="soon">4 h</DueChip>
        <DueChip state="over">Overdue</DueChip>
        <PriorityMarker priority={1} />
        <PriorityMarker priority={2} />
        <PriorityMarker priority={3} />
        <Dot tone="good" label="Healthy" />
        <Dot tone="warn" label="Degraded" />
        <Dot tone="bad" label="Failed" />
      </div>
      <div className="row">
        <CountBadge count={23} label="23 items" />
        <CountBadge count={4} strong label="4 items" />
        <Kbd>J</Kbd>
        <Tag>MVP</Tag>
        <Avatar name="Dana Reyes" />
        <Avatar name="Marcus Lee" size="sm" />
      </div>
    </div>
  ),
};
