import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { Button } from './button';
import { useToast } from './toast';
import { Logo } from './logo';

const meta: Meta = { title: 'Base/Toast and logo' };
export default meta;

export const ToastTrigger: StoryObj = {
  render: function ToastTrigger() {
    const toast = useToast();
    return (
      <div className="row">
        <Logo />
        <Button onClick={() => toast({ message: 'Claim released.', onUndo: () => {} })}>Show toast</Button>
        <Button onClick={() => toast({ message: "Couldn't save. Try again.", tone: 'bad' })}>Show error</Button>
      </div>
    );
  },
};

export const ToastShown: StoryObj = {
  render: function ToastShown() {
    const toast = useToast();
    useEffect(() => toast({ message: 'Claim released.', onUndo: () => {} }), [toast]);
    return <Button>Release claim</Button>;
  },
};
