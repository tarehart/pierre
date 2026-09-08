import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, File } from '../src';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

const FIFTY_LINES = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join(
  '\n'
);

async function waitForRenderedCode(container: HTMLElement): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (container.shadowRoot?.querySelector('code') != null) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for File windowed render');
}

function renderedLineNumbers(container: HTMLElement): number[] {
  // File renders gutter items with data-column-number (the 1-based line number).
  const nodes =
    container.shadowRoot?.querySelectorAll('[data-column-number]') ?? [];
  const set = new Set<number>();
  for (const n of Array.from(nodes)) {
    const v = n.getAttribute('data-column-number');
    if (v != null) {
      const num = Number.parseInt(v, 10);
      if (!Number.isNaN(num) && num > 0) set.add(num);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function expandSeparators(container: HTMLElement): Element[] {
  return Array.from(
    container.shadowRoot?.querySelectorAll('[data-expand-index]') ?? []
  );
}

describe('File windowed rendering', () => {
  test('renders only the window lines with expandable boundary separators', async () => {
    const { cleanup } = installDom();
    let instance: File | undefined;
    try {
      const fc = document.createElement('div');
      instance = new File({
        disableFileHeader: true,
        window: { start: 20, end: 30 },
      });
      instance.render({
        fileContainer: fc,
        file: { name: 'f.txt', contents: FIFTY_LINES },
      });
      await waitForRenderedCode(fc);

      const lines = renderedLineNumbers(fc);
      expect(lines).toContain(20);
      expect(lines).toContain(25);
      expect(lines).toContain(30);
      expect(lines).not.toContain(19);
      expect(lines).not.toContain(31);
      expect(expandSeparators(fc).length).toBeGreaterThan(0);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('the default windowed separator is pushed into both the gutter and content columns', async () => {
    // DiffHunksRenderer.pushSeparator pushes a built-in separator into BOTH
    // the gutter and content columns (style.css's default rule then hides the
    // content column's copy and shows the gutter's). The windowed File path
    // must mirror that invariant instead of pushing a bare, separator-less
    // gap into the gutter: a gutter gap alone carries no [data-separator] or
    // [data-separator-wrapper] at all, so the "N hidden lines" label and its
    // data-expand-button would be missing from layout and hit-testing (no
    // stylesheet is loaded in this jsdom harness, so both copies are present
    // in markup regardless of which one CSS would visually show).
    const { cleanup } = installDom();
    let instance: File | undefined;
    try {
      const fc = document.createElement('div');
      instance = new File({
        disableFileHeader: true,
        window: { start: 20, end: 30 },
      });
      instance.render({
        fileContainer: fc,
        file: { name: 'f.txt', contents: FIFTY_LINES },
      });
      await waitForRenderedCode(fc);

      const gutter = fc.shadowRoot?.querySelector('[data-gutter]');
      const content = fc.shadowRoot?.querySelector('[data-content]');
      expect(gutter).not.toBeNull();
      expect(content).not.toBeNull();

      const gutterSeparators = gutter!.querySelectorAll(
        '[data-separator="line-info"]'
      );
      const contentSeparators = content!.querySelectorAll(
        '[data-separator="line-info"]'
      );
      // Both columns carry the real separator (with its expand affordance),
      // not just the content column with a bare gap in the gutter.
      expect(gutterSeparators.length).toBeGreaterThan(0);
      expect(contentSeparators.length).toBe(gutterSeparators.length);
      for (const sep of Array.from(gutterSeparators)) {
        expect(sep.querySelector('[data-separator-wrapper]')).not.toBeNull();
        expect(sep.querySelector('[data-expand-button]')).not.toBeNull();
      }
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('clicking a separator (via expandHunk) reveals more lines in place', async () => {
    const { cleanup } = installDom();
    let instance: File | undefined;
    try {
      const fc = document.createElement('div');
      instance = new File({
        disableFileHeader: true,
        window: { start: 20, end: 30 },
      });
      instance.render({
        fileContainer: fc,
        file: { name: 'f.txt', contents: FIFTY_LINES },
      });
      await waitForRenderedCode(fc);

      expect(renderedLineNumbers(fc)).not.toContain(19);

      // The first separator is the above-window fold. Expanding 'down' reveals
      // lines just above the window.
      const firstExpandIndex = Number.parseInt(
        expandSeparators(fc)[0].getAttribute('data-expand-index')!,
        10
      );
      instance.expandHunk(firstExpandIndex, 'down', 3);
      await waitForRenderedCode(fc);

      const lines = renderedLineNumbers(fc);
      expect(lines).toContain(17);
      expect(lines).toContain(18);
      expect(lines).toContain(19);
      expect(lines).toContain(20); // window start still rendered
      // Below-window lines should still be folded.
      expect(lines).not.toContain(50);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('clearing window option restores the full file', async () => {
    const { cleanup } = installDom();
    let instance: File | undefined;
    try {
      const fc = document.createElement('div');
      const file = { name: 'f.txt', contents: FIFTY_LINES };
      instance = new File({
        disableFileHeader: true,
        window: { start: 20, end: 30 },
      });
      instance.render({ fileContainer: fc, file });
      await waitForRenderedCode(fc);
      expect(renderedLineNumbers(fc)).not.toContain(1);

      // Clear the window option by re-rendering without it.
      instance.setOptions({
        disableFileHeader: true,
      });
      instance.render({ fileContainer: fc, file, forceRender: true });
      await waitForRenderedCode(fc);

      const lines = renderedLineNumbers(fc);
      expect(lines).toContain(1);
      expect(lines).toContain(50);
      expect(expandSeparators(fc)).toHaveLength(0);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('onWindowExpand fires with fold and suppresses in-place reveal when handled', async () => {
    const { cleanup } = installDom();
    let instance: File | undefined;
    try {
      const fc = document.createElement('div');
      const calls: Array<{ boundary: string }> = [];
      instance = new File({
        disableFileHeader: true,
        window: { start: 20, end: 30 },
        onWindowExpand: (fold) => {
          calls.push({ boundary: fold.boundary });
          return true; // suppress in-place reveal
        },
      });
      instance.render({
        fileContainer: fc,
        file: { name: 'f.txt', contents: FIFTY_LINES },
      });
      await waitForRenderedCode(fc);

      const before = renderedLineNumbers(fc);
      const aboveIndex = Number.parseInt(
        expandSeparators(fc)[0].getAttribute('data-expand-index')!,
        10
      );
      instance.expandHunk(aboveIndex, 'down', 3);
      await waitForRenderedCode(fc);

      expect(calls).toHaveLength(1);
      expect(calls[0].boundary).toBe('above');
      // Handled → no reveal → line set unchanged.
      expect(renderedLineNumbers(fc)).toEqual(before);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('renderWindowSeparator supplies custom DOM for each fold', async () => {
    const { cleanup } = installDom();
    let instance: File | undefined;
    try {
      const fc = document.createElement('div');
      instance = new File({
        disableFileHeader: true,
        window: { start: 20, end: 30 },
        renderWindowSeparator: (fold) => {
          const el = document.createElement('button');
          el.setAttribute('data-custom-file-sep', fold.boundary);
          el.textContent = `${fold.collapsedLines} lines`;
          return el;
        },
      });
      instance.render({
        fileContainer: fc,
        file: { name: 'f.txt', contents: FIFTY_LINES },
      });
      await waitForRenderedCode(fc);

      const customs = fc.querySelectorAll('[data-custom-file-sep]');
      expect(customs.length).toBeGreaterThan(0);
      const boundaries = Array.from(customs).map((n) =>
        n.getAttribute('data-custom-file-sep')
      );
      expect(boundaries).toContain('above');
      expect(boundaries).toContain('below');
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
