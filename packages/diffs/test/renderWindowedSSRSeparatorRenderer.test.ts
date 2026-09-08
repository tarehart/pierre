import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter } from '../src/highlighter/shared_highlighter';
import { renderWindowedDiffHTML } from '../src/ssr/renderWindowedDiff';
import { renderWindowedFileHTML } from '../src/ssr/renderWindowedFile';
import type { FileContents } from '../src/types';

afterAll(async () => {
  await disposeHighlighter();
});

const OLD_LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
function diffFiles(): { oldFile: FileContents; newFile: FileContents } {
  const newLines = [...OLD_LINES];
  newLines[4] = 'line 5 CHANGED';
  newLines[29] = 'line 30 CHANGED';
  return {
    oldFile: { name: 'f.txt', contents: OLD_LINES.join('\n') + '\n' },
    newFile: { name: 'f.txt', contents: newLines.join('\n') + '\n' },
  };
}

describe('SSR windowed rendering forwards hasSeparatorRenderer for a host renderWindowSeparator', () => {
  test('renderWindowedDiffHTML emits an empty custom slot, not the built-in separator, when the host owns rendering', async () => {
    // Regression test for review finding 4. renderWindowedDiffHTML passed
    // only {window, reveal} to setWindowState, so a host supplying
    // renderWindowSeparator got built-in line-info separators from the
    // server and custom slots from the client after hydration: different
    // structure and height, causing a hydration mismatch/jump, with the
    // slotted element having no matching slot to land in.
    const { oldFile, newFile } = diffFiles();
    const html = await renderWindowedDiffHTML({
      oldFile,
      newFile,
      window: { start: 25, end: 35 },
      options: {
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        renderWindowSeparator: () => document.createElement('button'),
      },
    });

    expect(html).not.toContain('data-separator="line-info"');
    expect(html).toContain('data-separator="custom"');
  });

  test('renderWindowedFileHTML emits an empty custom slot, not the built-in separator, when the host owns rendering', async () => {
    const file: FileContents = {
      name: 'f.txt',
      contents: OLD_LINES.join('\n') + '\n',
    };
    const html = await renderWindowedFileHTML({
      file,
      window: { start: 10, end: 20 },
      options: {
        renderWindowSeparator: () => document.createElement('button'),
      },
    });

    expect(html).not.toContain('data-separator="line-info"');
    expect(html).toContain('data-separator="custom"');
  });
});
