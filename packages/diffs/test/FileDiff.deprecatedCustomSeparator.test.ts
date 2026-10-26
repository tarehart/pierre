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
    // Windowed folds with a renderWindowSeparator hook put their slot in the
    // content column inside an expand-button region. The deprecated
    // hunkSeparators fn API (no `window`) must keep its shipped markup: the
    // host's element is the whole separator, an unwrapped slot in both
    // columns, on a wrapper that still carries data-expand-index.
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
      // Both columns' separator wrappers keep the expand index they carried
      // before windowing existed.
      const separators = slots.map((slot) => slot.closest('[data-separator]'));
      for (const separator of separators) {
        expect(separator?.getAttribute('data-expand-index')).not.toBeNull();
      }
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});

describe('FileDiff window + deprecated hunkSeparators fn', () => {
  test('windowed folds fall back to an expandable line-info separator and never call the fn', async () => {
    // The fn receives HunkData for real diff hunks; a windowed fold is not
    // one, so like 'simple' and 'metadata' the fold renders the built-in
    // line-info separator instead.
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      let fnCalls = 0;
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        window: { start: 20, end: 30 },
        hunkSeparators: () => {
          fnCalls++;
          return document.createElement('span');
        },
      });
      instance.render({ fileContainer, fileDiff: createTwoHunkDiff() });
      await waitForRenderedCode(fileContainer);

      const folds = fileContainer.shadowRoot?.querySelectorAll(
        '[data-content] > [data-separator][data-expand-index]'
      );
      expect(folds?.length ?? 0).toBeGreaterThan(0);
      for (const fold of Array.from(folds ?? [])) {
        expect(fold.getAttribute('data-separator')).toBe('line-info');
      }
      const button = fileContainer.shadowRoot?.querySelector(
        '[data-separator-first] [data-expand-button]'
      );
      expect(button).not.toBeNull();
      expect(fnCalls).toBe(0);

      // A real click opens the fold through the normal routing.
      const lineCount = (): number =>
        fileContainer.shadowRoot?.querySelectorAll(
          '[data-content] > [data-line]'
        ).length ?? 0;
      const before = lineCount();
      button?.dispatchEvent(
        new window.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      );
      await waitForRenderedCode(fileContainer);
      expect(lineCount()).toBeGreaterThan(before);
      expect(fnCalls).toBe(0);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
