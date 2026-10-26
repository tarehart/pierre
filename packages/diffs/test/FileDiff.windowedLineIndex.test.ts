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
    // Regression test: densified line indices broke
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
    // A line outside the window (folded away) has no dense row at all; the
    // windowed lookup places it between its rendered neighbors rather than
    // throwing.
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

  test('unified: every rendered row gets a distinct data-line-index, so selecting a context line highlights one row', async () => {
    // A context row carries both a deletion and an addition side but is one
    // unified row. Its addition side must share the deletion side's dense
    // unified slot; giving it the next slot collided with the following row's
    // index, and InteractionManager highlights every row whose unified index
    // falls in the selected range.
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

      // Line 29 is unchanged context directly above the line-30 change, whose
      // deletion row is the one its index used to collide with.
      instance.setSelectedLines({ start: 29, end: 29 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const selected = Array.from(
        fileContainer.shadowRoot?.querySelectorAll(
          '[data-content] > [data-line][data-selected-line]'
        ) ?? []
      );
      expect(selected.map((row) => row.getAttribute('data-line'))).toEqual([
        '29',
      ]);

      const contentRows = Array.from(
        fileContainer.shadowRoot?.querySelectorAll(
          '[data-content] > [data-line][data-line-index]'
        ) ?? []
      );
      expect(contentRows.length).toBeGreaterThan(0);
      const unifiedIndexes = contentRows.map((row) =>
        Number.parseInt(
          row.getAttribute('data-line-index')!.split(',')[0] ?? '',
          10
        )
      );
      expect(new Set(unifiedIndexes).size).toBe(unifiedIndexes.length);
      // Dense and contiguous: 0..n-1 in DOM order.
      expect(unifiedIndexes).toEqual(unifiedIndexes.map((_, i) => i));
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('selecting folded lines highlights only the visible rows inside the range', async () => {
    // A folded line has no rendered row. Its index must not alias a visible
    // row's dense index, and a range reaching into a fold should still cover
    // the visible rows it spans.
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
      const selectedLines = async (): Promise<string[]> => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Array.from(
          fileContainer.shadowRoot?.querySelectorAll(
            '[data-content] > [data-line][data-selected-line]'
          ) ?? []
        ).map((row) => row.getAttribute('data-line') ?? '');
      };

      // Line 5 is a change folded away above the window.
      instance.setSelectedLines({ start: 5, end: 5 });
      expect(await selectedLines()).toEqual([]);

      // 20 is folded above the window, 27 is visible.
      instance.setSelectedLines({ start: 20, end: 27 });
      expect(await selectedLines()).toEqual(['25', '26', '27']);

      // 33 is visible, 38 is folded below the window.
      instance.setSelectedLines({ start: 33, end: 38 });
      expect(await selectedLines()).toEqual(['33', '34', '35']);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
