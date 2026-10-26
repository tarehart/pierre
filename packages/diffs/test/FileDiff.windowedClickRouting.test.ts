import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, FileDiff, parseDiffFromFile } from '../src';
import type { HunkSeparators } from '../src/types';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

const OLD = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
function makeWindowedDiff() {
  const next = [...OLD];
  next[4] = 'line 5 CHANGED';
  next[29] = 'line 30 CHANGED';
  return parseDiffFromFile(
    { name: 'f.txt', contents: OLD.join('\n') + '\n' },
    { name: 'f.txt', contents: next.join('\n') + '\n' }
  );
}

async function waitForRenderedCode(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (container.shadowRoot?.querySelector('code') != null) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for windowed FileDiff render');
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

// Finds the first rendered fold's expand button and dispatches a real click
// on it -- the same path a reader's mouse click takes through
// InteractionManager.handlePointerClick -- rather than calling
// instance.expandHunk directly, which bypasses the click router entirely and
// therefore cannot detect this class of bug (see
// FileDiff.windowedSeparatorModes.test.ts, which does exactly that and passes
// even when the router itself is broken).
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

describe('FileDiff windowed fold click routing', () => {
  test.each(['simple', 'metadata'] as const)(
    "hunkSeparators: '%s' -- a real click on the fold's expand button reveals hidden lines",
    async (hunkSeparators: Exclude<HunkSeparators, 'custom'>) => {
      const { cleanup } = installDom();
      let instance: FileDiff<string> | undefined;
      try {
        const fileContainer = document.createElement('div');
        instance = new FileDiff<string>({
          disableFileHeader: true,
          diffStyle: 'unified',
          hunkSeparators,
          window: { start: 25, end: 35 },
          windowContextLines: 50,
        });
        instance.render({ fileContainer, fileDiff: makeWindowedDiff() });
        await waitForRenderedCode(fileContainer);

        // The fold looks interactive: the renderer emits a line-info-shaped
        // separator with an expand button for any windowed fold, regardless
        // of hunkSeparators mode (DiffHunksRenderer.pushSeparator's
        // isWindowedFold exception to the simple/metadata early-return).
        const button = fileContainer.shadowRoot?.querySelector(
          '[data-expand-button]'
        );
        expect(button).not.toBeNull();

        const before = renderedLineNumbers(fileContainer);
        expect(before).not.toContain(24);

        clickFirstExpandButton(fileContainer);
        await waitForRenderedCode(fileContainer);

        // A real click must reach expandHunk through
        // InteractionManager.handlePointerClick and reveal lines just above
        // the window (24, 23, 22), exactly as instance.expandHunk(idx, 'down',
        // 3) would -- but driven through the actual DOM click path a reader
        // uses, not a direct method call.
        const after = renderedLineNumbers(fileContainer);
        expect(after).toContain(24);
        expect(after).toContain(23);
        expect(after).toContain(22);
      } finally {
        instance?.cleanUp();
        cleanup();
      }
    }
  );

  test("positive control: hunkSeparators 'line-info' -- a real click already works", async () => {
    // Proves the harness can actually detect a working click: same window,
    // same click path, only hunkSeparators differs. If this test were to
    // fail, the simple/metadata failures above would be meaningless (the
    // harness itself would be broken, not the product).
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        window: { start: 25, end: 35 },
        windowContextLines: 50,
      });
      instance.render({ fileContainer, fileDiff: makeWindowedDiff() });
      await waitForRenderedCode(fileContainer);

      const before = renderedLineNumbers(fileContainer);
      expect(before).not.toContain(24);

      clickFirstExpandButton(fileContainer);
      await waitForRenderedCode(fileContainer);

      const after = renderedLineNumbers(fileContainer);
      expect(after).toContain(24);
      expect(after).toContain(23);
      expect(after).toContain(22);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
