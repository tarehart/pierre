import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, FileDiff, parseDiffFromFile } from '../src';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

// A single-hunk diff with an unchanged run in the middle, so a non-partial
// diff still gets a real (expandable) separator between the two changes.
function createTwoHunkDiff() {
  const oldLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  const newLines = [...oldLines];
  newLines[2] = 'line 3 CHANGED';
  newLines[50] = 'line 51 CHANGED';
  return parseDiffFromFile(
    { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
    { name: 'f.txt', contents: newLines.join('\n') + '\n' }
  );
}

async function waitForRenderedCode(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (container.shadowRoot?.querySelector('code') != null) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for FileDiff render');
}

describe('FileDiff hunkSeparators:fn (deprecated, non-windowed) keeps its shipped slot placement', () => {
  test('slots stay in the gutter and are never wrapped in an expand-button region', async () => {
    // Regression test for review finding 2. Windowing repurposed the
    // separatorType === 'custom' branch (which getDiffHunksRendererOptions
    // maps hunkSeparators: fn to, regardless of windowing) to move the slot
    // into the content column and wrap it in a role="button" data-expand-
    // button region whenever expandIndex != null -- which is always, for a
    // non-partial diff. That changed shipped behavior for a host that never
    // asked for windowing: its element used to be the WHOLE separator (an
    // unwrapped slot in the gutter, matching both columns), and now
    // (unfixed) it is nested inside Pierre's own clickable region and moved
    // out of the gutter.
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        // Shipped (deprecated) API: no `window` option at all.
        hunkSeparators: () => {
          const span = document.createElement('span');
          span.textContent = 'custom separator';
          return span;
        },
      });
      instance.render({ fileContainer, fileDiff: createTwoHunkDiff() });
      await waitForRenderedCode(fileContainer);

      const slots = Array.from(
        fileContainer.shadowRoot?.querySelectorAll('slot') ?? []
      );
      expect(slots.length).toBeGreaterThan(0);

      // None of the deprecated API's slots are nested inside the
      // windowed-only expand-button wrapper.
      for (const slot of slots) {
        expect(slot.closest('[data-expand-button]')).toBeNull();
      }
      // At least one slot instance still renders in the gutter, matching the
      // pre-windowing placement (both gutter and content columns get the
      // separator; the host's element is the whole thing, not a content-only
      // fragment).
      const anyInGutter = slots.some(
        (slot) => slot.closest('[data-gutter]') != null
      );
      expect(anyInGutter).toBe(true);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
