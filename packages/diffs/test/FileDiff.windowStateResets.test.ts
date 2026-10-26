import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, FileDiff, parseDiffFromFile } from '../src';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

const OLD = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
function makeDiff(changedLines: number[]) {
  const next = [...OLD];
  for (const line of changedLines) {
    next[line - 1] = `line ${line} CHANGED`;
  }
  return parseDiffFromFile(
    { name: 'f.txt', contents: OLD.join('\n') + '\n' },
    { name: 'f.txt', contents: next.join('\n') + '\n' }
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('FileDiff windowed state across input changes', () => {
  test('custom fold separators re-render when a new diff changes a fold but not its size', async () => {
    // Split mode: a paired change is one row, so the above fold hides 24 rows
    // whether or not line 5 changed; only containsChanges differs.
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'split',
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        renderWindowSeparator: (fold) => {
          const el = document.createElement('span');
          el.setAttribute('data-fold-label', fold.boundary);
          el.textContent = `${fold.collapsedLines}:${fold.containsChanges}`;
          return el;
        },
      });
      const aboveLabel = (): string | null | undefined =>
        fileContainer.querySelector('[data-fold-label="above"]')?.textContent;

      instance.render({ fileContainer, fileDiff: makeDiff([5, 30]) });
      await settle();
      expect(aboveLabel()).toBe('24:true');

      instance.render({ fileContainer, fileDiff: makeDiff([30]) });
      await settle();
      expect(aboveLabel()).toBe('24:false');
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
