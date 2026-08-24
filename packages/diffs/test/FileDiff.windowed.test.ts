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

// Distinct one-based new-file line numbers currently rendered as content rows.
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

function expandSeparators(container: HTMLElement): Element[] {
  return Array.from(
    container.shadowRoot?.querySelectorAll('[data-expand-index]') ?? []
  );
}

describe('FileDiff windowed rendering (React SPA path)', () => {
  test('renders only the window with expandable folds, and hides out-of-window changes', async () => {
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

      const lines = renderedLineNumbers(fileContainer);
      // In-window change (line 30) renders; out-of-window change (line 5) does not.
      expect(lines).toContain(30);
      expect(lines).not.toContain(5);
      // Above + below boundary folds render as expandable separators.
      expect(expandSeparators(fileContainer).length).toBeGreaterThan(0);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('clicking a fold (via expandHunk) reveals more context and preserves the window', async () => {
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

      expect(renderedLineNumbers(fileContainer)).not.toContain(24);

      // The first separator is the above-window fold. InteractionManager routes
      // a click to expandHunk(expandIndex, direction); the above fold expands
      // down toward the window, revealing lines just above line 25.
      const firstIndex = Number.parseInt(
        expandSeparators(fileContainer)[0].getAttribute('data-expand-index')!,
        10
      );
      instance.expandHunk(firstIndex, 'down', 3);
      await waitForRenderedCode(fileContainer);

      const lines = renderedLineNumbers(fileContainer);
      expect(lines).toContain(24);
      expect(lines).toContain(23);
      expect(lines).toContain(22);
      // Still windowed: the below-window content stays folded.
      expect(lines).not.toContain(40);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('clearing the window option renders the whole diff again', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      const fileDiff = makeWindowedDiff();
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        window: { start: 25, end: 35 },
        windowContextLines: 50,
      });
      instance.render({ fileContainer, fileDiff });
      await waitForRenderedCode(fileContainer);
      expect(renderedLineNumbers(fileContainer)).not.toContain(5);

      instance.setOptions({
        disableFileHeader: true,
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        windowContextLines: 50,
      });
      // The React hook passes forceRender when options change (areOptionsEqual
      // is false); mirror that here so the option-driven repaint happens.
      instance.render({ fileContainer, fileDiff, forceRender: true });
      await waitForRenderedCode(fileContainer);

      // Whole diff now: both changes visible.
      const lines = renderedLineNumbers(fileContainer);
      expect(lines).toContain(5);
      expect(lines).toContain(30);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('split style windows with aligned columns and reveals on expand', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'split',
        hunkSeparators: 'line-info',
        window: { start: 25, end: 35 },
        windowContextLines: 50,
      });
      instance.render({ fileContainer, fileDiff: makeWindowedDiff() });
      await waitForRenderedCode(fileContainer);

      const lines = renderedLineNumbers(fileContainer);
      expect(lines).toContain(30);
      expect(lines).not.toContain(5);
      expect(expandSeparators(fileContainer).length).toBeGreaterThan(0);

      // Split renders two code columns; windowed folds must keep them the same
      // height, otherwise the deletion/addition sides drift out of alignment.
      const columns = Array.from(
        fileContainer.shadowRoot?.querySelectorAll('[data-code]') ?? []
      );
      expect(columns).toHaveLength(2);
      const rowCounts = columns.map(
        (col) => col.querySelectorAll('[data-line-index]').length
      );
      expect(rowCounts[0]).toBe(rowCounts[1]);

      // Expanding the above fold reveals context toward the window.
      const firstIndex = Number.parseInt(
        expandSeparators(fileContainer)[0].getAttribute('data-expand-index')!,
        10
      );
      instance.expandHunk(firstIndex, 'down', 3);
      await waitForRenderedCode(fileContainer);
      expect(renderedLineNumbers(fileContainer)).toContain(24);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('onWindowExpand fires with the fold and suppresses reveal when handled', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      const calls: Array<{ boundary: string; containsChanges: boolean }> = [];
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        // Return true to claim the click: the host would widen the window; here
        // we just record it and assert the built-in reveal did NOT run.
        onWindowExpand: (fold) => {
          calls.push({
            boundary: fold.boundary,
            containsChanges: fold.containsChanges,
          });
          return true;
        },
      });
      instance.render({ fileContainer, fileDiff: makeWindowedDiff() });
      await waitForRenderedCode(fileContainer);

      const before = renderedLineNumbers(fileContainer);
      const aboveIndex = Number.parseInt(
        expandSeparators(fileContainer)[0].getAttribute('data-expand-index')!,
        10
      );
      instance.expandHunk(aboveIndex, 'down', 3);
      await waitForRenderedCode(fileContainer);

      // The callback saw the above boundary fold, which hides the line-5 change.
      expect(calls).toHaveLength(1);
      expect(calls[0].boundary).toBe('above');
      expect(calls[0].containsChanges).toBe(true);
      // Handled === true suppressed the in-place reveal: no new rows appeared.
      expect(renderedLineNumbers(fileContainer)).toEqual(before);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('renderWindowSeparator supplies custom fold DOM in place of line-info', async () => {
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
        renderWindowSeparator: (fold) => {
          const el = document.createElement('button');
          el.setAttribute('data-custom-fold', fold.boundary);
          el.textContent = fold.containsChanges
            ? `${fold.collapsedLines} lines, changes above`
            : `${fold.collapsedLines} unchanged`;
          return el;
        },
      });
      instance.render({ fileContainer, fileDiff: makeWindowedDiff() });
      await waitForRenderedCode(fileContainer);

      // Custom separators are filled into slots as light-DOM children of the
      // container (not inside the shadow root).
      const containerCustom =
        fileContainer.querySelectorAll('[data-custom-fold]');
      expect(containerCustom.length).toBeGreaterThan(0);
      const boundaries = Array.from(containerCustom).map((n) =>
        n.getAttribute('data-custom-fold')
      );
      // The above boundary fold rendered its custom affordance.
      expect(boundaries).toContain('above');
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
