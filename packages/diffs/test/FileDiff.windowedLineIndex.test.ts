import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, FileDiff, parseDiffFromFile } from '../src';
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

describe('FileDiff.getLineIndex in windowed mode resolves DOM-matching (dense) indexes', () => {
  test('getLineIndex(inWindowLine) matches the rendered gutter row data-line-index, so selector-based lookups succeed', async () => {
    // Regression test for review finding 1: densified line indices broke
    // selection DOM lookups. InteractionManager.targetForSelectionPoint builds
    // `[data-column-number="N"][data-line-index="u,s"]` from getLineIndex's
    // output. getLineIndex used to walk the diff's ORIGINAL (non-windowed)
    // hunk geometry, while the renderer wrote DENSIFIED indexes onto gutter
    // rows -- the two coordinate spaces disagreed and the selector matched
    // nothing.
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

      // line 30 (new-file, 1-based) is the in-window change.
      const computed = instance.getLineIndex(30, 'additions');
      expect(computed).not.toBeUndefined();
      const [unifiedIndex, splitIndex] = computed!;
      const selector = `[data-column-number="30"][data-line-index="${unifiedIndex},${splitIndex}"]`;
      const matches = fileContainer.shadowRoot?.querySelectorAll(selector);

      expect(matches?.length ?? 0).toBeGreaterThan(0);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('the selection-anchored gutter utility places on an in-window selection', async () => {
    // placeUtilityFromSelection -> targetForSelectionPoint uses the same
    // lookup. This is the concrete, user-visible consequence that used to
    // fail silently: after selecting an in-window line, the gutter-utility
    // slot should appear on that line's gutter row.
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
        enableGutterUtility: true,
        renderGutterUtility: () => document.createElement('button'),
      });
      instance.render({ fileContainer, fileDiff: makeWindowedDiff() });
      await waitForRenderedCode(fileContainer);

      instance.setSelectedLines({ start: 30, end: 30 });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const slot = fileContainer.shadowRoot?.querySelector(
        '[data-gutter-utility-slot]'
      );
      expect(slot).not.toBeNull();
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('getLineIndex for a line hidden behind a fold still falls back gracefully (no throw)', async () => {
    // A line outside the window (folded away) has no dense row at all. The
    // windowed lookup misses and getLineIndex falls through to the original
    // hunk-walk, matching pre-existing (non-windowed) behavior for that case
    // rather than throwing or returning a bogus dense index.
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

      // Line 5 is folded away (outside the window and its context).
      expect(() => instance!.getLineIndex(5, 'additions')).not.toThrow();
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
