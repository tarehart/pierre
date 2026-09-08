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
  return parseDiffFromFile(
    { name: 'f.txt', contents: OLD.join('\n') + '\n' },
    { name: 'f.txt', contents: next.join('\n') + '\n' }
  );
}

async function waitForSettled(container: HTMLElement): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  void container;
}

describe('FileDiff windowed rendering recovers from an empty resolved window', () => {
  test('a window entirely past the end of a shrunk file still renders one recoverable fold', async () => {
    // Regression test for review finding 6. clampWindow returns an empty
    // range when the requested window no longer maps onto the file (e.g. a
    // host holding a stale window after the diffed file shrank).
    // iterateWindowedDiff's callback-driven model only attaches a fold to a
    // KEPT row, so an all-hidden window (no kept row at all) never invoked
    // the callback and the fold -- the reader's only way back -- silently
    // never rendered: a permanently blank diff with no expander. The file
    // (non-diff) windowing engine avoids this because it walks its row model
    // directly rather than through a per-kept-row callback. Fixed by having
    // DiffHunksRenderer detect the same all-folded case from the raw model
    // and push the fold(s) directly, reusing the expand index
    // iterateWindowedDiff already assigned each one.
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        window: { start: 100, end: 200 },
        windowContextLines: 50,
      });
      instance.render({ fileContainer, fileDiff: makeWindowedDiff() });
      await waitForSettled(fileContainer);

      const pre = fileContainer.shadowRoot?.querySelector('pre');
      expect(pre).not.toBeUndefined();
      const expandButtons = fileContainer.shadowRoot?.querySelectorAll(
        '[data-expand-button]'
      );
      expect(expandButtons?.length ?? 0).toBeGreaterThan(0);

      // The fold is genuinely clickable and recovers real content.
      const expandIndex = Number.parseInt(
        fileContainer.shadowRoot
          ?.querySelector('[data-expand-index]')
          ?.getAttribute('data-expand-index') ?? '',
        10
      );
      expect(Number.isNaN(expandIndex)).toBe(false);
      instance.expandHunk(expandIndex, 'down', 5);
      await waitForSettled(fileContainer);

      const linesAfter = Array.from(
        fileContainer.shadowRoot?.querySelectorAll('[data-line]') ?? []
      )
        .map((el) => Number.parseInt(el.getAttribute('data-line') ?? '', 10))
        .filter((n) => !Number.isNaN(n));
      expect(linesAfter.length).toBeGreaterThan(0);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
