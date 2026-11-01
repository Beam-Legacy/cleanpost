import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './button';
import { Field, Input } from './form';
import { ConfirmDialog, Drawer, Modal } from './overlay';

const meta: Meta = { title: 'Base/Overlays' };
export default meta;

const noop = () => {};

export const ModalOpen: StoryObj = {
  render: () => (
    <Modal
      open
      onOpenChange={noop}
      title="Save view"
      description="Saved views appear as chips after the type filters."
      footer={
        <>
          <Button>Cancel</Button>
          <Button variant="primary">Save view</Button>
        </>
      }
    >
      <Field label="Name">{(p) => <Input {...p} defaultValue="Aetna rejections" />}</Field>
    </Modal>
  ),
};

export const DrawerOpen: StoryObj = {
  render: () => (
    <Drawer open onOpenChange={noop} title="Notifications" footer={<Button>Mark all read</Button>}>
      <p>Nothing new since 8:02 am.</p>
    </Drawer>
  ),
};

export const ConfirmOpen: StoryObj = {
  render: () => (
    <ConfirmDialog
      open
      onOpenChange={noop}
      title="Release 41 claims?"
      description="They go to Tebra for tonight's 6:00 pm batch. This can't be undone from Cleanpost."
      confirmLabel="Release 41 claims"
      onConfirm={noop}
    />
  ),
};
