/**
 * M0 acceptance: every base component passes axe (WCAG 2.2 AA rules) in both themes.
 * Renders every story in every *.stories.tsx file, so a new component is covered once it has a story.
 */
import axe from 'axe-core';
import { composeStories } from '@storybook/react-vite';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

const modules = import.meta.glob<Record<string, unknown>>('../src/**/*.stories.tsx', { eager: true });

const RULE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, { runOnly: { type: 'tag', values: RULE_TAGS } });
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} (${n.failureSummary ?? ''})`).join('; ')}`,
  );
}

describe.each(['light', 'dark'])('%s theme', (theme) => {
  for (const [file, mod] of Object.entries(modules)) {
    const stories = composeStories(mod as Parameters<typeof composeStories>[0]);
    for (const [name, composed] of Object.entries(stories)) {
      const Story = composed as unknown as ComponentType<{ globals?: Record<string, unknown> }>;
      it(`${file.replace('../src/components/', '')} › ${name}`, async () => {
        document.documentElement.dataset.theme = theme;
        const screen = await render(<Story globals={{ theme }} />);
        // Let portals, effects and toasts mount.
        await new Promise((r) => setTimeout(r, 50));
        expect(await violations()).toEqual([]);
        await screen.unmount();
      });
    }
  }
});

describe('the axe harness', () => {
  it('reports a real contrast failure (control)', async () => {
    const screen = await render(<p style={{ color: '#dddddd', background: '#ffffff' }}>Low contrast text</p>);
    expect((await violations()).join('\n')).toContain('color-contrast');
    await screen.unmount();
  });
});
