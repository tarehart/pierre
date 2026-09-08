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

describe('FileDiff windowed folds render and expand in simple/metadata separator modes', () => {
  for (const mode of ['simple', 'metadata'] as const) {
    test(`${mode} mode: both the above and below boundary folds render and expand`, async () => {
      // Regression test for review finding 3. iterateWindowedDiff's "after"
      // fold branch in DiffHunksRenderer was gated on
      // hunkSeparators !== 'simple' && !== 'metadata' while the "before"
      // branch was not, so a trailing (below-window, or interior-after) fold
      // silently rendered nothing in those two modes. Separately (found while
      // probing this one): pushSeparator's metadata/simple early-return
      // branches are written for the whole-file walk's own semantics
      // (metadata needs hunkSpecs; simple skips hunkIndex 0) and skipped a
      // windowed fold's rendering entirely, in EITHER direction, because a
      // fold carries neither. Both are fixed: a windowed fold always renders
      // with a line-info-shaped label and expand button in these modes,
      // regardless of boundary.
      const { cleanup } = installDom();
      let instance: FileDiff<string> | undefined;
      try {
        const fileContainer = document.createElement('div');
        instance = new FileDiff<string>({
          disableFileHeader: true,
          diffStyle: 'unified',
          hunkSeparators: mode,
          window: { start: 25, end: 35 },
          windowContextLines: 50,
        });
        instance.render({ fileContainer, fileDiff: makeWindowedDiff() });
        await waitForRenderedCode(fileContainer);

        const separators = Array.from(
          fileContainer.shadowRoot?.querySelectorAll('[data-separator]') ?? []
        );
        const hasFirst = separators.some((s) =>
          s.hasAttribute('data-separator-first')
        );
        const hasLast = separators.some((s) =>
          s.hasAttribute('data-separator-last')
        );
        expect(hasFirst).toBe(true);
        expect(hasLast).toBe(true);

        const expandButtons = fileContainer.shadowRoot?.querySelectorAll(
          '[data-expand-button]'
        );
        expect(expandButtons?.length ?? 0).toBeGreaterThan(0);

        // The below fold is genuinely clickable end to end: expanding it
        // reveals lines beyond the window's original end (35).
        const belowSeparator = separators.find((s) =>
          s.hasAttribute('data-separator-last')
        );
        const belowIndex = Number.parseInt(
          belowSeparator?.getAttribute('data-expand-index') ?? '',
          10
        );
        expect(Number.isNaN(belowIndex)).toBe(false);
        instance.expandHunk(belowIndex, 'up', 3);
        await waitForRenderedCode(fileContainer);

        const linesAfter = Array.from(
          fileContainer.shadowRoot?.querySelectorAll('[data-line]') ?? []
        )
          .map((el) => Number.parseInt(el.getAttribute('data-line') ?? '', 10))
          .filter((n) => !Number.isNaN(n));
        expect(linesAfter).toContain(36);
      } finally {
        instance?.cleanUp();
        cleanup();
      }
    });
  }
});
