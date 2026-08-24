import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter } from '../src/highlighter/shared_highlighter';
import { renderWindowedDiffHTML } from '../src/ssr/renderWindowedDiff';
import type { FileContents } from '../src/types';
import {
  createEmptyReveal,
  WINDOW_ABOVE_ID,
} from '../src/utils/computeWindowedDiffRows';

afterAll(async () => {
  await disposeHighlighter();
});

const OLD_LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
function files(): { oldFile: FileContents; newFile: FileContents } {
  const newLines = [...OLD_LINES];
  newLines[4] = 'line 5 CHANGED';
  newLines[29] = 'line 30 CHANGED';
  return {
    oldFile: { name: 'f.txt', contents: OLD_LINES.join('\n') + '\n' },
    newFile: { name: 'f.txt', contents: newLines.join('\n') + '\n' },
  };
}

// Distinct one-based new-line numbers that rendered as real content rows.
function renderedLineNumbers(html: string): number[] {
  const nums = [...html.matchAll(/data-line="(\d+)"/g)].map((m) =>
    Number(m[1])
  );
  return [...new Set(nums)].sort((a, b) => a - b);
}

function separatorCount(html: string): number {
  return (html.match(/data-separator="line-info"/g) ?? []).length;
}

describe('renderWindowedDiffHTML', () => {
  test('renders only the window and folds the rest behind expandable separators', async () => {
    const { oldFile, newFile } = files();
    const html = await renderWindowedDiffHTML({
      oldFile,
      newFile,
      window: { start: 25, end: 35 },
      options: { diffStyle: 'unified', hunkSeparators: 'line-info' },
    });

    expect(html).toContain('data-dehydrated');
    // The in-window change (line 30) renders; the out-of-window one (line 5)
    // does not appear as a content row.
    expect(renderedLineNumbers(html)).toContain(30);
    expect(renderedLineNumbers(html)).not.toContain(5);

    // Every windowed separator is natively expandable: it carries an expand
    // index and an expand button, because the underlying diff is non-partial.
    expect(separatorCount(html)).toBeGreaterThan(0);
    expect(html).toContain('data-expand-index');
    expect(html).toContain('data-expand-button');
    // No partial-hydration placeholder text: the counts are known exactly.
    expect(html).not.toContain('More unchanged context may be available');
  });

  test('folds offer both-direction expand arrows (host owns extent)', async () => {
    const { oldFile, newFile } = files();
    const html = await renderWindowedDiffHTML({
      oldFile,
      newFile,
      window: { start: 25, end: 35 },
      options: { diffStyle: 'unified', hunkSeparators: 'line-info' },
    });
    // No library-side expansion clamp: every fold with hidden lines can peel
    // both ways, so the both-arrows affordance is present.
    expect(html).toContain('data-expand-both');
  });

  test('a window at file start renders line 1 and has no leading fold', async () => {
    const { oldFile, newFile } = files();
    const html = await renderWindowedDiffHTML({
      oldFile,
      newFile,
      window: { start: 1, end: 10 },
      options: {
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        windowContextLines: 50,
      },
    });
    expect(renderedLineNumbers(html)).toContain(1);
    expect(html).not.toContain('data-separator-first');
  });

  test('revealing the above fold shows more context on re-render', async () => {
    const { oldFile, newFile } = files();
    const base = await renderWindowedDiffHTML({
      oldFile,
      newFile,
      window: { start: 25, end: 35 },
      options: {
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        windowContextLines: 50,
      },
    });
    expect(renderedLineNumbers(base)).not.toContain(24);

    const reveal = createEmptyReveal();
    reveal.set(WINDOW_ABOVE_ID, { fromStart: 0, fromEnd: 3 });
    const expanded = await renderWindowedDiffHTML({
      oldFile,
      newFile,
      window: { start: 25, end: 35 },
      reveal,
      options: {
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        windowContextLines: 50,
      },
    });
    const lines = renderedLineNumbers(expanded);
    expect(lines).toContain(22);
    expect(lines).toContain(23);
    expect(lines).toContain(24);
  });

  test('a whole-file window renders every line and no separators', async () => {
    const { oldFile, newFile } = files();
    const html = await renderWindowedDiffHTML({
      oldFile,
      newFile,
      window: { start: 1, end: 40 },
      options: {
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        windowContextLines: 50,
      },
    });
    expect(separatorCount(html)).toBe(0);
    expect(renderedLineNumbers(html)).toContain(1);
    expect(renderedLineNumbers(html)).toContain(40);
  });
});
