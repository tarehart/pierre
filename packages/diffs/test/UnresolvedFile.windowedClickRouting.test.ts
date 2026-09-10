import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter } from '../src';
import { UnresolvedFile } from '../src/components/UnresolvedFile';
import { DEFAULT_THEMES } from '../src/constants';
import type { FileContents, HunkSeparators } from '../src/types';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

// 60 unchanged lines with one small merge conflict in the middle (around
// line 30), giving enough surrounding context that a window around the
// conflict produces above and below boundary folds -- the same shape as the
// FileDiff windowed click-routing tests, but through UnresolvedFile's own
// syncInteractionOptions override, which carries a byte-for-byte copy of the
// same gate FileDiff has.
function makeUnresolvedFile(): FileContents {
  const lines: string[] = [];
  for (let i = 1; i <= 29; i++) {
    lines.push(`line ${i}`);
  }
  lines.push('<<<<<<< HEAD');
  lines.push('const value = 1;');
  lines.push('=======');
  lines.push('const value = 2;');
  lines.push('>>>>>>> feature');
  for (let i = 35; i <= 60; i++) {
    lines.push(`line ${i}`);
  }
  return { name: 'conflict.ts', contents: lines.join('\n') + '\n' };
}

async function waitForRenderedCode(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (container.shadowRoot?.querySelector('code') != null) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for windowed UnresolvedFile render');
}

function renderedLineNumbers(container: HTMLElement): number[] {
  const nodes = container.shadowRoot?.querySelectorAll('[data-line]') ?? [];
  const set = new Set<number>();
  for (const node of Array.from(nodes)) {
    const value = node.getAttribute('data-line');
    if (value != null) {
      set.add(Number.parseInt(value, 10));
    }
  }
  return [...set].sort((a, b) => a - b);
}

// Dispatches a real click on the fold's expand button -- the same path a
// reader's mouse click takes through InteractionManager.handlePointerClick --
// rather than calling instance.expandHunk directly.
function clickFirstExpandButton(container: HTMLElement): void {
  const button = container.shadowRoot?.querySelector('[data-expand-button]');
  if (button == null) {
    throw new Error('clickFirstExpandButton: no [data-expand-button] found');
  }
  button.dispatchEvent(
    new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    })
  );
}

describe('UnresolvedFile windowed fold click routing', () => {
  test.each(['simple', 'metadata'] as const)(
    "hunkSeparators: '%s' -- a real click on the fold's expand button reveals hidden lines",
    async (hunkSeparators: Exclude<HunkSeparators, 'custom'>) => {
      const { cleanup } = installDom();
      let instance: UnresolvedFile | undefined;
      try {
        const fileContainer = document.createElement('div');
        instance = new UnresolvedFile(
          {
            theme: DEFAULT_THEMES,
            disableFileHeader: true,
            hunkSeparators,
            window: { start: 28, end: 34 },
            windowContextLines: 50,
          },
          undefined,
          true
        );
        instance.render({
          file: makeUnresolvedFile(),
          fileContainer,
        });
        await waitForRenderedCode(fileContainer);

        // The fold looks interactive regardless of hunkSeparators mode, same
        // as FileDiff (UnresolvedFile shares the DiffHunksRenderer windowing
        // pipeline via UnresolvedFileHunksRenderer).
        const button = fileContainer.shadowRoot?.querySelector(
          '[data-expand-button]'
        );
        expect(button).not.toBeNull();

        const before = renderedLineNumbers(fileContainer);
        expect(before).not.toContain(27);

        clickFirstExpandButton(fileContainer);
        await waitForRenderedCode(fileContainer);

        // A real click must reach expandHunk through
        // InteractionManager.handlePointerClick and reveal lines just above
        // the window.
        const after = renderedLineNumbers(fileContainer);
        expect(after).toContain(27);
        expect(after).toContain(26);
        expect(after).toContain(25);
      } finally {
        instance?.cleanUp();
        cleanup();
      }
    }
  );

  test("positive control: hunkSeparators 'line-info' -- a real click already works", async () => {
    const { cleanup } = installDom();
    let instance: UnresolvedFile | undefined;
    try {
      const fileContainer = document.createElement('div');
      instance = new UnresolvedFile(
        {
          theme: DEFAULT_THEMES,
          disableFileHeader: true,
          hunkSeparators: 'line-info',
          window: { start: 28, end: 34 },
          windowContextLines: 50,
        },
        undefined,
        true
      );
      instance.render({
        file: makeUnresolvedFile(),
        fileContainer,
      });
      await waitForRenderedCode(fileContainer);

      const before = renderedLineNumbers(fileContainer);
      expect(before).not.toContain(27);

      clickFirstExpandButton(fileContainer);
      await waitForRenderedCode(fileContainer);

      const after = renderedLineNumbers(fileContainer);
      expect(after).toContain(27);
      expect(after).toContain(26);
      expect(after).toContain(25);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
