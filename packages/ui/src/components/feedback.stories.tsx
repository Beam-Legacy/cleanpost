import type { Meta, StoryObj } from '@storybook/react-vite';
import { CircleCheck } from 'lucide-react';
import { Button } from './button';
import { EmptyState, ErrorState, SkeletonRows } from './feedback';

const meta: Meta = { title: 'Base/States' };
export default meta;

export const Empty: StoryObj = {
  render: () => (
    <EmptyState title="Nothing needs you right now" tone="good" icon={<CircleCheck />}>
      412 claims went out automatically today.
    </EmptyState>
  ),
};

export const Error: StoryObj = {
  render: () => (
    <ErrorState title="This list didn't load" action={<Button variant="primary">Try again</Button>}>
      Your data is safe. The server didn't answer in time.
    </ErrorState>
  ),
};

export const Loading: StoryObj = { render: () => <SkeletonRows rows={4} label="Loading work items" /> };
