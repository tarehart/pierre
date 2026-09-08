import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter } from '../src/highlighter/shared_highlighter';
import { renderWindowedFileHTML } from '../src/ssr/renderWindowedFile';
import type { FileContents } from '../src/types';

afterAll(async () => {
  await disposeHighlighter();
});

const FIFTY_LINES = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
function file(): FileContents {
  return { name: 'f.ts', contents: FIFTY_LINES.join('\n') + '\n' };
}

// Distinct one-based line numbers that rendered as real content rows.
function renderedLineNumbers(html: string): number[] {
  const nums = [...html.matchAll(/data-line="(\d+)"/g)].map((m) =>
    Number(m[1])
  );
  return [...new Set(nums)].sort((a, b) => a - b);
}

describe('renderWindowedFileHTML', () => {
  test('renders non-empty HTML on a cold process (no highlighter preloaded)', async () => {
    // On a cold start, FileRenderer.renderFile is synchronous and returns
    // undefined until an async highlight completes in the background;
    // renderWindowedFileHTML must await that highlight (like every sibling
    // preload function does) rather than reading the empty synchronous
    // result and returning ''.
    const html = await renderWindowedFileHTML({
      file: file(),
      window: { start: 20, end: 30 },
    });
    expect(html.length).toBeGreaterThan(0);
    expect(renderedLineNumbers(html)).toContain(25);
  });

  test('output includes the hydration wrapper preloadFile applies', async () => {
    const html = await renderWindowedFileHTML({
      file: file(),
      window: { start: 20, end: 30 },
    });
    // Matches the wrapper preloadFile applies: a <style> tag with the
    // highlighted CSS, and the data-dehydrated marker File.hydrate() needs to
    // recognize server-rendered markup instead of re-rendering from scratch.
    expect(html).toContain('<style');
    expect(html).toContain('data-dehydrated');
  });

  test('only the window renders, with expandable boundary separators', async () => {
    const html = await renderWindowedFileHTML({
      file: file(),
      window: { start: 20, end: 30 },
    });
    const lines = renderedLineNumbers(html);
    expect(lines).toContain(20);
    expect(lines).toContain(30);
    expect(lines).not.toContain(19);
    expect(lines).not.toContain(31);
    expect(html).toContain('data-expand-index');
  });
});
