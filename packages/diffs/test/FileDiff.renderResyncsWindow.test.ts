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

describe('FileDiff.render re-syncs windowed render state from current options', () => {
  test('assigning options directly (bypassing setOptions) then rendering picks up the new window', async () => {
    // Regression test for review finding 5. syncWindowState previously ran
    // only in the constructor and setOptions. mergeOptions (used by
    // setThemeType) and a host assigning `options` directly -- the demo's
    // own `{...instance.options, window}` pattern -- both update
    // this.options without going through setOptions, so render() kept
    // rendering the OLD window. File.render already calls syncWindowState on
    // every render for the same reason.
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      const fileDiff = makeWindowedDiff();
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        window: { start: 1, end: 10 },
        windowContextLines: 50,
      });
      instance.render({ fileContainer, fileDiff });
      await waitForRenderedCode(fileContainer);
      expect(renderedLineNumbers(fileContainer)).toContain(5);
      expect(renderedLineNumbers(fileContainer)).not.toContain(30);

      instance.options = {
        ...instance.options,
        window: { start: 25, end: 35 },
      };
      instance.render({ fileContainer, fileDiff, forceRender: true });
      await waitForRenderedCode(fileContainer);

      const lines = renderedLineNumbers(fileContainer);
      expect(lines).toContain(30);
      expect(lines).not.toContain(5);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
