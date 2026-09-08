import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, FileDiff, parseDiffFromFile } from '../src';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

// Deletion side has 60 lines ending WITHOUT a trailing newline (its last
// line, "old-final", carries no newline); addition side has 61 lines and
// DOES end with one. Sized so a window can sit far from the file's end
// while densified indices diverge heavily from the real (large) split-index
// geometry.
function makeNoTrailingNewlineDiff() {
  const oldLines = Array.from({ length: 59 }, (_, i) => `line ${i + 1}`);
  oldLines.push('old-final');
  const newLines = [...oldLines];
  newLines[4] = 'line 5 CHANGED';
  newLines.push('new-final-extra');
  return parseDiffFromFile(
    { name: 'f.txt', contents: oldLines.join('\n') },
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
  throw new Error('Timed out waiting for windowed FileDiff render');
}

describe('FileDiff windowed no-newline marker placement', () => {
  test('split diffStyle: sanity, the fixture shows the marker without windowing', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'split',
        hunkSeparators: 'line-info',
      });
      instance.render({ fileContainer, fileDiff: makeNoTrailingNewlineDiff() });
      await waitForRenderedCode(fileContainer);
      const markers =
        fileContainer.shadowRoot?.querySelectorAll('[data-no-newline]');
      expect(markers?.length ?? 0).toBe(1);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('split diffStyle: a window far from EOF shows no marker', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'split',
        hunkSeparators: 'line-info',
        window: { start: 1, end: 10 },
        windowContextLines: 50,
      });
      instance.render({ fileContainer, fileDiff: makeNoTrailingNewlineDiff() });
      await waitForRenderedCode(fileContainer);
      const markers =
        fileContainer.shadowRoot?.querySelectorAll('[data-no-newline]');
      expect(markers?.length ?? 0).toBe(0);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('split diffStyle: a window that includes the final line shows the marker exactly once, on the deletion side only', async () => {
    // Regression test for review finding 7. isFinalSplitHunkRow/
    // isFinalHunkRow compared densified splitLineIndex/unifiedLineIndex
    // (redensified for windowed rendering) against the diff's ORIGINAL hunk
    // geometry (hunk.splitLineStart + hunk.splitLineCount - 1) -- two
    // unrelated coordinate spaces once windowed, so the marker either did
    // not appear at all or, when both sides were checked with a single
    // shared boolean, could duplicate onto an unrelated row on the other
    // side. Fixed by comparing each side's own (densification-untouched)
    // lineIndex against the hunk's content-index bounds when windowed,
    // independently per side.
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'split',
        hunkSeparators: 'line-info',
        window: { start: 55, end: 61 },
        windowContextLines: 50,
      });
      instance.render({ fileContainer, fileDiff: makeNoTrailingNewlineDiff() });
      await waitForRenderedCode(fileContainer);
      const markers =
        fileContainer.shadowRoot?.querySelectorAll('[data-no-newline]');
      expect(markers?.length ?? 0).toBe(1);
      expect(markers?.[0]?.getAttribute('data-line-type')).toBe(
        'change-deletion'
      );
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('unified diffStyle: a window that includes the final line shows the marker', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        window: { start: 55, end: 61 },
        windowContextLines: 50,
      });
      instance.render({ fileContainer, fileDiff: makeNoTrailingNewlineDiff() });
      await waitForRenderedCode(fileContainer);
      const markers =
        fileContainer.shadowRoot?.querySelectorAll('[data-no-newline]');
      expect(markers?.length ?? 0).toBe(1);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
