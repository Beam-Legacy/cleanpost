import type { Preview } from '@storybook/react-vite';
import '../src/styles/index.css';
import { ToastProvider } from '../src/components/toast';
import { TooltipProvider } from '../src/components/tooltip';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Color theme',
      toolbar: { title: 'Theme', items: ['light', 'dark'], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [
    (Story, context) => {
      document.documentElement.dataset.theme = String(context.globals.theme ?? 'light');
      return (
        <TooltipProvider>
          <ToastProvider>
            <div style={{ padding: 24, background: 'var(--canvas)' }}>
              <Story />
            </div>
          </ToastProvider>
        </TooltipProvider>
      );
    },
  ],
  parameters: {
    // Fail stories on accessibility violations, in Storybook and in the browser test.
    a11y: { test: 'error' },
  },
};

export default preview;
