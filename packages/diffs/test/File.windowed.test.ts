import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, File } from '../src';
import { preloadFile } from '../src/ssr';
import { installDom } from './domHarness';
import {
  click,
  FIFTY_LINES,
  queryAll,
  renderedLineNumbers,
  waitForRenderedCode,
  withFile,
} from './windowedHarness';

afterAll(async () => {
  await disposeHighlighter();
});

// File gutter rows carry the one-based line number in data-column-number.
function fileLines(container: HTMLElement): number[] {
  return renderedLineNumbers(container, 'data-column-number');
}

function clickAboveFold(container: HTMLElement): void {
  click(
    container.shadowRoot?.querySelector(
      '[data-separator-first] [data-expand-button]'
    )
  );
}

const WINDOW = { start: 20, end: 30 };

// Fixture (withFile): a 50-line file.
describe('File windowed rendering', () => {
  test('renders only the window lines with expandable boundary separators', async () => {
    await withFile({ window: WINDOW }, ({ fileContainer }) => {
      const lines = fileLines(fileContainer);
      expect(lines).toContain(20);
      expect(lines).toContain(25);
      expect(lines).toContain(30);
      expect(lines).not.toContain(19);
      expect(lines).not.toContain(31);
      expect(
        queryAll(fileContainer, '[data-expand-index]').length
      ).toBeGreaterThan(0);
    });
  });

  test('the default windowed separator is pushed into both the gutter and content columns', async () => {
    // Both columns carry the real separator, with its label and expand
    // button, not a bare gap in the gutter. No stylesheet is loaded here, so
    // both copies are in the markup whichever one CSS would show.
    await withFile({ window: WINDOW }, ({ fileContainer }) => {
      const gutter = fileContainer.shadowRoot?.querySelector('[data-gutter]');
      const content = fileContainer.shadowRoot?.querySelector('[data-content]');
      expect(gutter).not.toBeNull();
      expect(content).not.toBeNull();

      const gutterSeparators = gutter!.querySelectorAll(
        '[data-separator="line-info"]'
      );
      const contentSeparators = content!.querySelectorAll(
        '[data-separator="line-info"]'
      );
      expect(gutterSeparators.length).toBeGreaterThan(0);
      expect(contentSeparators.length).toBe(gutterSeparators.length);
      for (const sep of Array.from(gutterSeparators)) {
        expect(sep.querySelector('[data-separator-wrapper]')).not.toBeNull();
        expect(sep.querySelector('[data-expand-button]')).not.toBeNull();
      }
    });
  });

  test('clicking a separator reveals more lines in place', async () => {
    await withFile({ window: WINDOW }, async ({ fileContainer }) => {
      expect(fileLines(fileContainer)).not.toContain(19);

      clickAboveFold(fileContainer);
      await waitForRenderedCode(fileContainer);

      const lines = fileLines(fileContainer);
      expect(lines).toContain(17);
      expect(lines).toContain(18);
      expect(lines).toContain(19);
      expect(lines).toContain(20);
      // Below-window lines stay folded.
      expect(lines).not.toContain(50);
    });
  });

  test('clearing window option restores the full file', async () => {
    await withFile({ window: WINDOW }, async ({ instance, fileContainer }) => {
      expect(fileLines(fileContainer)).not.toContain(1);

      instance.setOptions({ disableFileHeader: true });
      instance.render({
        fileContainer,
        file: { name: 'f.txt', contents: FIFTY_LINES },
        forceRender: true,
      });
      await waitForRenderedCode(fileContainer);

      const lines = fileLines(fileContainer);
      expect(lines).toContain(1);
      expect(lines).toContain(50);
      expect(queryAll(fileContainer, '[data-expand-index]')).toHaveLength(0);
    });
  });

  test('a real step click calls onWindowExpand with (fold, expansionLineCount); true suppresses the reveal', async () => {
    const calls: Array<[string, number]> = [];
    await withFile(
      {
        window: WINDOW,
        onWindowExpand: (fold, lineCount) => {
          calls.push([fold.boundary, lineCount]);
          return true;
        },
      },
      async ({ fileContainer }) => {
        const before = fileLines(fileContainer);
        clickAboveFold(fileContainer);
        await waitForRenderedCode(fileContainer);

        // The File default step is 10.
        expect(calls).toEqual([['above', 10]]);
        expect(fileLines(fileContainer)).toEqual(before);
      }
    );
  });

  test('a label-text click, expand-all and shift-click report expansionLineCount, Infinity and Infinity; a falsy return reveals in place', async () => {
    const calls: Array<[string, number]> = [];
    await withFile(
      {
        window: WINDOW,
        expansionLineCount: 4,
        onWindowExpand: (fold, lineCount) => {
          calls.push([fold.boundary, lineCount]);
        },
      },
      async ({ fileContainer }) => {
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-last] [data-unmodified-lines]'
          )
        );
        await waitForRenderedCode(fileContainer);
        expect(fileLines(fileContainer).at(-1)).toBe(34);
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-first] [data-expand-all-button]'
          )
        );
        await waitForRenderedCode(fileContainer);
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-last] [data-expand-button]'
          ),
          { shiftKey: true }
        );
        await waitForRenderedCode(fileContainer);
        expect(calls).toEqual([
          ['below', 4],
          ['above', Number.POSITIVE_INFINITY],
          ['below', Number.POSITIVE_INFINITY],
        ]);
        const lines = fileLines(fileContainer);
        expect(lines[0]).toBe(1);
        expect(lines.at(-1)).toBe(50);
      }
    );
  });

  test('renderWindowSeparator supplies custom DOM for each fold', async () => {
    await withFile(
      {
        window: WINDOW,
        renderWindowSeparator: (fold) => {
          const el = document.createElement('button');
          el.setAttribute('data-custom-file-sep', fold.boundary);
          el.textContent = `${fold.collapsedLines} lines`;
          return el;
        },
      },
      ({ fileContainer }) => {
        const customs = fileContainer.querySelectorAll(
          '[data-custom-file-sep]'
        );
        expect(customs.length).toBeGreaterThan(0);
        const boundaries = Array.from(customs).map((n) =>
          n.getAttribute('data-custom-file-sep')
        );
        expect(boundaries).toContain('above');
        expect(boundaries).toContain('below');
      }
    );
  });

  test.each([
    ['with a render in between', true],
    ['with no render in between', false],
  ] as const)(
    'clearing and re-setting the same window %s starts with fresh folds, as FileDiff does',
    async (_label, renderBetween) => {
      const options = { disableFileHeader: true, window: WINDOW };
      await withFile(options, async ({ instance, fileContainer }) => {
        clickAboveFold(fileContainer);
        await waitForRenderedCode(fileContainer);
        expect(fileLines(fileContainer)).toContain(17);

        instance.setOptions({ disableFileHeader: true });
        if (renderBetween) {
          instance.rerender();
          await waitForRenderedCode(fileContainer);
        }
        instance.setOptions(options);
        instance.rerender();
        await waitForRenderedCode(fileContainer);
        expect(fileLines(fileContainer)).not.toContain(19);
      });
    }
  );

  test('clearing the window removes host separator elements from the container', async () => {
    await withFile(
      {
        window: WINDOW,
        renderWindowSeparator: () => document.createElement('button'),
      },
      async ({ instance, fileContainer }) => {
        expect(
          fileContainer.querySelectorAll('[data-window-file-sep]').length
        ).toBe(2);

        instance.setOptions({ disableFileHeader: true });
        instance.rerender();
        await waitForRenderedCode(fileContainer);
        expect(
          fileContainer.querySelectorAll('[data-window-file-sep]').length
        ).toBe(0);
      }
    );
  });
});

// File's fold handler is private: `expandHunk` is not File API (it takes a
// fold index, unlike FileDiff.expandHunk, and does nothing without a window).
export function assertFileHasNoExpandHunk(file: File): void {
  // @ts-expect-error File has no public expandHunk.
  file.expandHunk(0, 'down');
}

describe('File windowing matches FileDiff', () => {
  function expandAllButtons(container: HTMLElement, side: 'first' | 'last') {
    return queryAll(
      container,
      `[data-content] > [data-separator-${side}] [data-expand-all-button]`
    );
  }

  test('expansionLineCount sets how many lines one click reveals', async () => {
    await withFile(
      { window: WINDOW, expansionLineCount: 3 },
      async ({ fileContainer }) => {
        clickAboveFold(fileContainer);
        await waitForRenderedCode(fileContainer);
        const lines = fileLines(fileContainer);
        expect(lines).toContain(17);
        expect(lines).not.toContain(16);
      }
    );
  });

  test('without expansionLineCount one click still reveals 10 lines', async () => {
    await withFile({ window: WINDOW }, async ({ fileContainer }) => {
      clickAboveFold(fileContainer);
      await waitForRenderedCode(fileContainer);
      const lines = fileLines(fileContainer);
      expect(lines).toContain(10);
      expect(lines).not.toContain(9);
    });
  });

  test('a fold larger than one step offers "Expand all", which opens it whole', async () => {
    await withFile({ window: WINDOW }, async ({ fileContainer }) => {
      // Above: lines 1-19, below: 31-50; both larger than the 10-line step.
      expect(expandAllButtons(fileContainer, 'first')).toHaveLength(1);
      expect(expandAllButtons(fileContainer, 'last')).toHaveLength(1);
      click(expandAllButtons(fileContainer, 'first')[0]);
      await waitForRenderedCode(fileContainer);
      expect(fileLines(fileContainer).slice(0, 2)).toEqual([1, 2]);
      expect(fileLines(fileContainer)).not.toContain(31);
    });
  });

  test('a fold no larger than one step has no "Expand all"', async () => {
    await withFile(
      { window: WINDOW, expansionLineCount: 100 },
      ({ fileContainer }) => {
        expect(expandAllButtons(fileContainer, 'first')).toHaveLength(0);
        expect(expandAllButtons(fileContainer, 'last')).toHaveLength(0);
      }
    );
  });

  test('renderWindowSeparator may return a DocumentFragment or null', async () => {
    await withFile(
      {
        window: WINDOW,
        renderWindowSeparator: (fold) => {
          if (fold.boundary === 'below') {
            return null;
          }
          const fragment = document.createDocumentFragment();
          const label = document.createElement('span');
          label.setAttribute('data-fragment-sep', '');
          label.textContent = `${fold.collapsedLines} lines`;
          fragment.appendChild(label);
          return fragment;
        },
      },
      async ({ fileContainer }) => {
        const label = fileContainer.querySelector('[data-fragment-sep]');
        expect(label).not.toBeNull();
        // Slotted into the above fold's slot through a wrapper element.
        const slotName = label?.parentElement?.getAttribute('slot');
        expect(
          fileContainer.shadowRoot?.querySelector(`slot[name="${slotName}"]`)
        ).not.toBeNull();
        // The null below fold renders nothing.
        expect(
          fileContainer.querySelectorAll('[data-window-file-sep]')
        ).toHaveLength(1);
      }
    );
  });
});

describe('hydrating a windowed File over prerendered HTML', () => {
  test('renders the window instead of adopting the full prerendered file', async () => {
    const { cleanup } = installDom();
    const file = { name: 'f.txt', contents: FIFTY_LINES };
    const fileContainer = document.createElement('div');
    document.body.appendChild(fileContainer);
    const { prerenderedHTML } = await preloadFile({
      file,
      options: { disableFileHeader: true },
    });
    const instance = new File({ disableFileHeader: true, window: WINDOW });
    try {
      instance.hydrate({ fileContainer, file, prerenderedHTML });
      await waitForRenderedCode(fileContainer);
      const lines = fileLines(fileContainer);
      expect(lines[0]).toBe(20);
      expect(lines).not.toContain(1);
    } finally {
      instance.cleanUp();
      cleanup();
    }
  });
});

describe('File renderWindowSeparator host elements', () => {
  test('are kept across renders while the fold and the hook stay the same, and redrawn when the hook changes', async () => {
    const hook = (text: string) => (fold: { boundary: string }) => {
      const el = document.createElement('span');
      el.setAttribute('data-host-label', `${fold.boundary}:${text}`);
      return el;
    };
    const first = hook('A');
    await withFile(
      { window: WINDOW, renderWindowSeparator: first },
      async ({ instance, fileContainer }) => {
        const above = () =>
          fileContainer.querySelector('[data-host-label^="above"]');
        const before = above();
        expect(before).not.toBeNull();
        instance.rerender();
        await waitForRenderedCode(fileContainer);
        expect(above()).toBe(before);
        instance.setOptions({
          ...instance.options,
          renderWindowSeparator: hook('B'),
        });
        instance.rerender();
        await waitForRenderedCode(fileContainer);
        expect(above()?.getAttribute('data-host-label')).toBe('above:B');
      }
    );
  });
});

describe('File.expandWindowFold opens a fold by its id', () => {
  test('reveals toward the window with the File step, without onWindowExpand', async () => {
    const calls: unknown[] = [];
    await withFile(
      {
        window: WINDOW,
        onWindowExpand: () => {
          calls.push(1);
          return true;
        },
      },
      async ({ instance, fileContainer }) => {
        expect(instance.expandWindowFold('window:above', 'down')).toBe(true);
        await waitForRenderedCode(fileContainer);
        // The default File step is 10: 10-19 open above the 20-30 window.
        expect(fileLines(fileContainer)[0]).toBe(10);
        expect(calls).toHaveLength(0);
        expect(instance.expandWindowFold('window:middle', 'both')).toBe(false);
        expect(
          instance.expandWindowFold(
            'window:above',
            'down',
            Number.POSITIVE_INFINITY
          )
        ).toBe(true);
        await waitForRenderedCode(fileContainer);
        expect(fileLines(fileContainer)[0]).toBe(1);
        expect(instance.expandWindowFold('window:above', 'down')).toBe(false);
      }
    );
  });
});

describe('File.expandWindowFold edge cases', () => {
  test('rejects counts that open nothing', async () => {
    await withFile({ window: WINDOW }, async ({ instance, fileContainer }) => {
      for (const count of [0, -5, Number.NaN]) {
        expect(instance.expandWindowFold('window:above', 'down', count)).toBe(
          false
        );
      }
      expect(instance.expandWindowFold('window:above', 'down', 2)).toBe(true);
      await waitForRenderedCode(fileContainer);
      expect(fileLines(fileContainer)[0]).toBe(18);
    });
  });

  test('a changed window offers no fold until it renders', async () => {
    await withFile({ window: WINDOW }, ({ instance }) => {
      // Window 1-30 has no above fold; the old 20-30 render had one.
      instance.setOptions({
        ...instance.options,
        window: { start: 1, end: 30 },
      });
      expect(instance.expandWindowFold('window:above', 'down')).toBe(false);
    });
  });
});
