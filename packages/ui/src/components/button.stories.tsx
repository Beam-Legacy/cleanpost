import type { Meta, StoryObj } from '@storybook/react-vite';
import { Pencil, Send } from 'lucide-react';
import { Button, IconButton } from './button';
import { Kbd } from './status';

const meta: Meta = { title: 'Base/Button' };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="row">
      <Button variant="primary">
        <Send aria-hidden />
        Release claim
      </Button>
      <Button>Save draft</Button>
      <Button variant="ghost">Full claim</Button>
      <Button variant="danger">Void claim</Button>
      <Button variant="primary" disabled>
        Release claim
      </Button>
    </div>
  ),
};

export const Sizes: StoryObj = {
  render: () => (
    <div className="row">
      <Button size="sm">Small</Button>
      <Button>Medium</Button>
      <Button size="lg" variant="primary">
        Large
      </Button>
      <Button variant="primary">
        Approve <Kbd>A</Kbd>
      </Button>
    </div>
  ),
};

export const IconButtons: StoryObj = {
  render: () => (
    <div className="row">
      <IconButton label="Edit claim" icon={<Pencil aria-hidden />} />
      <IconButton label="Edit claim" ghost icon={<Pencil aria-hidden />} />
    </div>
  ),
};
