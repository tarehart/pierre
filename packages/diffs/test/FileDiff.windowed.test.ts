import { afterAll, describe, expect, test } from 'bun:test';

import {
  disposeHighlighter,
  FileDiff,
  parseDiffFromFile,
  type WindowFold,
} from '../src';
import { preloadFileDiff } from '../src/ssr';
import { installDom } from './domHarness';
import {
  click,
  INTERIOR_FOLD_SELECTOR,
  makeDiff,
  makeWindowedDiff,
  numberedLines,
  queryAll,
  range,
  renderedLineNumbers,
  settle,
  waitForRenderedCode,
  withFileDiff,
} from './windowedHarness';

afterAll(async () => {
  await disposeHighlighter();
});

// A built-in separator is pushed into both the gutter and content columns, so
// [data-expand-index] matches twice per fold. Keep one element per fold, in
// DOM order.
function distinctFoldSeparators(container: HTMLElement): Element[] {
  const seen = new Set<string>();
  const out: Element[] = [];
  for (const el of queryAll(container, '[data-expand-index]')) {
    const index = el.getAttribute('data-expand-index');
    if (index == null || seen.has(index)) {
      continue;
    }
    seen.add(index);
    out.push(el);
  }
  return out;
}

function firstExpandIndex(container: HTMLElement): number {
  return Number.parseInt(
    queryAll(container, '[data-expand-index]')[0]?.getAttribute(
      'data-expand-index'
    ) ?? '',
    10
  );
}

describe('FileDiff windowed rendering', () => {
  test('interior folds expand both ways and carry no edge markers in the rendered DOM', async () => {
    // Reads the DOM attributes InteractionManager derives a click's direction
    // from (data-expand-up/-down/-both, data-separator-first/-last).
    await withFileDiff(
      { window: { start: 1, end: 40 }, windowContextLines: 3 },
      ({ fileContainer }) => {
        // A whole-file window has no boundary folds, only interior ones.
        const folds = distinctFoldSeparators(fileContainer);
        expect(folds.length).toBeGreaterThan(0);
        for (const fold of folds) {
          expect(fold.hasAttribute('data-separator-first')).toBe(false);
          expect(fold.hasAttribute('data-separator-last')).toBe(false);
          expect(fold.querySelector('[data-expand-both]')).not.toBeNull();
          expect(fold.querySelector('[data-expand-up]')).toBeNull();
          expect(fold.querySelector('[data-expand-down]')).toBeNull();
        }
      }
    );
  });

  test('above and below boundary folds expand toward the window, not both directions', async () => {
    await withFileDiff(
      { window: { start: 25, end: 35 }, windowContextLines: 50 },
      ({ fileContainer }) => {
        // Exactly an above fold (lines 1-24, including the line-5 change) and
        // a below fold (36-40); generous context leaves no interior fold.
        const folds = distinctFoldSeparators(fileContainer);
        expect(folds).toHaveLength(2);
        const [above, below] = folds;

        // data-separator-first lets style.css zero the top margin.
        expect(above.hasAttribute('data-separator-first')).toBe(true);
        expect(above.hasAttribute('data-separator-last')).toBe(false);
        expect(above.querySelector('[data-expand-down]')).not.toBeNull();
        expect(above.querySelector('[data-expand-both]')).toBeNull();
        expect(above.querySelector('[data-expand-up]')).toBeNull();

        expect(below.hasAttribute('data-separator-first')).toBe(false);
        expect(below.hasAttribute('data-separator-last')).toBe(true);
        expect(below.querySelector('[data-expand-up]')).not.toBeNull();
        expect(below.querySelector('[data-expand-both]')).toBeNull();
        expect(below.querySelector('[data-expand-down]')).toBeNull();
      }
    );
  });

  test.each(['split', 'unified'] as const)(
    "%s: a 'both' click on a boundary fold (its label text) opens only the window side",
    async (diffStyle) => {
      await withFileDiff(
        { diffStyle, window: { start: 25, end: 35 }, windowContextLines: 50 },
        async ({ instance, fileContainer }) => {
          const index = (side: 'first' | 'last') =>
            Number(
              fileContainer.shadowRoot
                ?.querySelector(`[data-separator-${side}][data-expand-index]`)
                ?.getAttribute('data-expand-index')
            );
          const above = index('first');
          const below = index('last');
          instance.expandHunk(above, 'both', 3);
          await settle();
          instance.expandHunk(below, 'both', 2);
          await settle();
          // 22-24 next to the window, 36-37 below it; nothing from the far
          // edges (1-3 at the file start, 39-40 at its end).
          expect(renderedLineNumbers(fileContainer)).toEqual(range(22, 37));
        }
      );
    }
  );

  test('windowContextLines reaches the renderer: a small vs. large value changes what folds', async () => {
    // Over a whole-file window, the 24-line unchanged run between the changes
    // at 5 and 30 folds its middle with 3 context lines but stays expanded
    // with 20. Line 15, mid-run, tells the two apart.
    async function renderWithContextLines(
      windowContextLines: number
    ): Promise<number[]> {
      let lines: number[] = [];
      await withFileDiff(
        { window: { start: 1, end: 40 }, windowContextLines },
        ({ fileContainer }) => {
          lines = renderedLineNumbers(fileContainer);
        }
      );
      return lines;
    }

    const small = await renderWithContextLines(3);
    const large = await renderWithContextLines(20);
    expect(small).toContain(30);
    expect(large).toContain(30);
    expect(small).not.toContain(15);
    expect(large).toContain(15);
  });

  // Every separator mode renders windowed folds with a line-info label and an
  // expand button, and a real click (through InteractionManager's router, not
  // a direct expandHunk call) opens them.
  test.each(['line-info', 'simple', 'metadata'] as const)(
    "hunkSeparators '%s': a real click on either boundary fold reveals lines toward the window",
    async (hunkSeparators) => {
      await withFileDiff(
        {
          hunkSeparators,
          window: { start: 25, end: 35 },
          windowContextLines: 50,
        },
        async ({ fileContainer }) => {
          const aboveButton = '[data-separator-first] [data-expand-button]';
          const belowButton = '[data-separator-last] [data-expand-button]';
          expect(queryAll(fileContainer, aboveButton).length).toBeGreaterThan(
            0
          );
          expect(queryAll(fileContainer, belowButton).length).toBeGreaterThan(
            0
          );
          const before = renderedLineNumbers(fileContainer);
          expect(before).not.toContain(24);
          expect(before).not.toContain(36);

          click(fileContainer.shadowRoot?.querySelector(aboveButton));
          await waitForRenderedCode(fileContainer);
          const afterAbove = renderedLineNumbers(fileContainer);
          expect(afterAbove).toContain(24);
          expect(afterAbove).toContain(23);
          expect(afterAbove).toContain(22);
          // The below fold is untouched: the window is preserved.
          expect(afterAbove).not.toContain(40);

          click(fileContainer.shadowRoot?.querySelector(belowButton));
          await waitForRenderedCode(fileContainer);
          expect(renderedLineNumbers(fileContainer)).toContain(36);
        }
      );
    }
  );

  test('a windowContextLines change starts the folds afresh', async () => {
    await withFileDiff(
      { window: { start: 1, end: 40 }, windowContextLines: 3 },
      async ({ instance, fileContainer }) => {
        // Changes at 5 and 30: the run between them folds 9-26.
        const interior = queryAll(fileContainer, INTERIOR_FOLD_SELECTOR)[0];
        instance.expandHunk(
          Number(interior.getAttribute('data-expand-index')),
          'both',
          2
        );
        await settle();
        expect(renderedLineNumbers(fileContainer)).toContain(10);
        instance.setOptions({ ...instance.options, windowContextLines: 4 });
        instance.rerender();
        await settle();
        // A fresh 4-line context shows 6-9 and 26-29 and folds 10-25; the
        // earlier reveal does not carry over to the renumbered fold.
        const shown = renderedLineNumbers(fileContainer);
        expect(shown).toContain(9);
        expect(shown).toContain(26);
        expect(shown).not.toContain(10);
        expect(shown).not.toContain(25);
      }
    );
  });

  test('clearing the window option renders the whole diff again', async () => {
    const fileDiff = makeWindowedDiff();
    await withFileDiff(
      { window: { start: 25, end: 35 }, windowContextLines: 50 },
      async ({ instance, fileContainer }) => {
        expect(renderedLineNumbers(fileContainer)).not.toContain(5);

        instance.setOptions({
          disableFileHeader: true,
          diffStyle: 'unified',
          hunkSeparators: 'line-info',
          windowContextLines: 50,
        });
        // The React hook passes forceRender when options change; mirror that.
        instance.render({ fileContainer, fileDiff, forceRender: true });
        await waitForRenderedCode(fileContainer);

        const lines = renderedLineNumbers(fileContainer);
        expect(lines).toContain(5);
        expect(lines).toContain(30);
      },
      { fileDiff }
    );
  });

  test('render re-syncs the window when options are assigned directly, bypassing setOptions', async () => {
    // mergeOptions (used by setThemeType) and a host assigning `options`
    // both update this.options without going through setOptions.
    const fileDiff = makeWindowedDiff();
    await withFileDiff(
      { window: { start: 1, end: 10 }, windowContextLines: 50 },
      async ({ instance, fileContainer }) => {
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
      },
      { fileDiff }
    );
  });

  test('a real step click on a boundary fold calls onWindowExpand with (fold, expansionLineCount); true suppresses the reveal', async () => {
    const calls: Array<{ fold: WindowFold; lineCount: number }> = [];
    await withFileDiff(
      {
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        expansionLineCount: 3,
        // Returning true claims the click (a host would widen the window).
        onWindowExpand: (fold, lineCount) => {
          calls.push({ fold, lineCount });
          return true;
        },
      },
      async ({ fileContainer }) => {
        const before = renderedLineNumbers(fileContainer);
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-first] [data-expand-button]'
          )
        );
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-last] [data-expand-button]'
          )
        );
        await settle();

        // The above boundary fold hides the line-5 change.
        expect(
          calls.map(({ fold, lineCount }) => [fold.boundary, lineCount])
        ).toEqual([
          ['above', 3],
          ['below', 3],
        ]);
        expect(calls[0].fold.foldId).toBe('window:above');
        expect(calls[0].fold.containsChanges).toBe(true);
        expect(renderedLineNumbers(fileContainer)).toEqual(before);
      }
    );
  });

  test('onWindowExpand gets the default expansionLineCount (100) for a step click, and a falsy return reveals in place', async () => {
    const counts: number[] = [];
    await withFileDiff(
      {
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        onWindowExpand: (_fold, lineCount) => {
          counts.push(lineCount);
        },
      },
      async ({ fileContainer }) => {
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-last] [data-expand-button]'
          )
        );
        await settle();
        expect(counts).toEqual([100]);
        expect(renderedLineNumbers(fileContainer)).toContain(40);
      }
    );
  });

  test('an expansionLineCount below 1 counts as 1, for the hook and the reveal', async () => {
    const counts: number[] = [];
    await withFileDiff(
      {
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        expansionLineCount: 0,
        onWindowExpand: (_fold, lineCount) => {
          counts.push(lineCount);
        },
      },
      async ({ fileContainer }) => {
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-last] [data-expand-button]'
          )
        );
        await settle();
        expect(counts).toEqual([1]);
        expect(renderedLineNumbers(fileContainer)).toEqual(range(25, 36));
      }
    );
  });

  test('expand-all, shift-click and a label-text click on a boundary fold report Infinity, Infinity and expansionLineCount', async () => {
    const calls: Array<[string, number]> = [];
    await withFileDiff(
      {
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        expansionLineCount: 3,
        onWindowExpand: (fold, lineCount) => {
          calls.push([fold.boundary, lineCount]);
          return true;
        },
      },
      async ({ fileContainer }) => {
        // The above fold (1-24) is larger than one step: it offers expand-all.
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-first] [data-expand-all-button]'
          )
        );
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-last] [data-expand-button]'
          ),
          { shiftKey: true }
        );
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-first] [data-unmodified-lines]'
          )
        );
        await settle();
        expect(calls).toEqual([
          ['above', Number.POSITIVE_INFINITY],
          ['below', Number.POSITIVE_INFINITY],
          ['above', 3],
        ]);
      }
    );
  });

  test('a real click on an interior fold never calls onWindowExpand and reveals in place', async () => {
    const calls: unknown[] = [];
    await withFileDiff(
      {
        window: { start: 1, end: 40 },
        windowContextLines: 3,
        expansionLineCount: 2,
        // Even a hook that claims every click cannot block an interior fold.
        onWindowExpand: (fold) => {
          calls.push(fold);
          return true;
        },
      },
      async ({ fileContainer }) => {
        // Changes at 5 and 30: the run between them folds 9-26.
        const before = renderedLineNumbers(fileContainer);
        expect(before).not.toContain(9);
        const interior = queryAll(fileContainer, INTERIOR_FOLD_SELECTOR)[0];
        click(interior.querySelector('[data-expand-button]'));
        await settle();
        const after = renderedLineNumbers(fileContainer);
        expect(calls).toHaveLength(0);
        expect(after.length).toBeGreaterThan(before.length);
        // Shift-click opens the rest.
        click(
          queryAll(fileContainer, INTERIOR_FOLD_SELECTOR)[0]?.querySelector(
            '[data-expand-button]'
          ),
          { shiftKey: true }
        );
        await settle();
        expect(calls).toHaveLength(0);
        expect(renderedLineNumbers(fileContainer)).toEqual(range(1, 40));
      }
    );
  });

  test('a real click on the cut-at-edge fold (window:edge, boundary interior) never calls onWindowExpand', async () => {
    // Old 27-28 became new 28-29 and the window starts at 29: unified shows
    // -28 then +28 as a one-line window:edge fold before +29.
    const oldLines = numberedLines(60);
    const newLines = [...oldLines];
    newLines.splice(26, 2, 'new a', 'new b');
    newLines.splice(4, 0, 'inserted');
    const fileDiff = parseDiffFromFile(
      { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
      { name: 'f.txt', contents: newLines.join('\n') + '\n' }
    );
    const calls: unknown[] = [];
    await withFileDiff(
      {
        window: { start: 29, end: 45 },
        windowContextLines: 3,
        onWindowExpand: (fold) => {
          calls.push(fold);
          return true;
        },
      },
      async ({ instance, fileContainer }) => {
        // The only non-boundary separator is the one-line window:edge:0 fold.
        const edge = queryAll(fileContainer, INTERIOR_FOLD_SELECTOR);
        expect(edge).toHaveLength(1);
        click(edge[0].querySelector('[data-expand-button]'));
        await settle();
        expect(calls).toHaveLength(0);
        expect(queryAll(fileContainer, INTERIOR_FOLD_SELECTOR)).toHaveLength(0);
        // The click opened window:edge:0 whole, so it is no longer a fold.
        expect(instance.expandWindowFold('window:edge:0', 'both')).toBe(false);
      },
      { fileDiff }
    );
  });

  test('renderWindowSeparator returning undefined leaves that fold slot empty (no built-in fallback)', async () => {
    await withFileDiff(
      {
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        renderWindowSeparator: (fold) => {
          if (fold.boundary === 'above') {
            return undefined;
          }
          const el = document.createElement('button');
          el.setAttribute('data-custom-fold', fold.boundary);
          return el;
        },
      },
      ({ fileContainer }) => {
        // The hook owns the boundary folds: the above fold keeps its custom
        // slot, gets no built-in line-info separator, and nothing is slotted.
        const above = fileContainer.shadowRoot?.querySelector(
          '[data-content] > [data-separator][data-separator-first]'
        );
        expect(above?.getAttribute('data-separator')).toBe('custom');
        const slotName = above?.querySelector('slot')?.getAttribute('name');
        expect(slotName).toBeTruthy();
        expect(
          fileContainer.querySelector(`[slot="${slotName}"]`)
            ?.childElementCount ?? 0
        ).toBe(0);
        // Host elements are slotted as light-DOM children of the container.
        expect(
          fileContainer.querySelectorAll('[data-custom-fold]').length
        ).toBe(1);
      }
    );
  });

  test('custom fold separators re-render when a new diff changes a fold but not its size', async () => {
    // Split: a paired change is one row, so the above fold hides 24 rows
    // whether or not line 5 changed; only containsChanges differs.
    await withFileDiff(
      {
        diffStyle: 'split',
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        renderWindowSeparator: (fold) => {
          const el = document.createElement('span');
          el.setAttribute('data-fold-label', fold.boundary);
          el.textContent = `${fold.collapsedLines}:${fold.containsChanges}`;
          return el;
        },
      },
      async ({ instance, fileContainer }) => {
        const aboveLabel = (): string | null | undefined =>
          fileContainer.querySelector('[data-fold-label="above"]')?.textContent;
        expect(aboveLabel()).toBe('24:true');

        instance.render({ fileContainer, fileDiff: makeDiff([30]) });
        await settle();
        expect(aboveLabel()).toBe('24:false');
      },
      { fileDiff: makeDiff([5, 30]), wait: 'settle' }
    );
  });
});

describe('FileDiff deprecated hunkSeparators fn', () => {
  // Two changes far apart, so a non-windowed render has a real (expandable)
  // separator between them.
  const twoHunkDiff = () => makeDiff([3, 51], 60);

  test('without a window, slots stay in the gutter and are never wrapped in an expand-button region', async () => {
    // The host's element is the whole separator: an unwrapped slot in both
    // columns, on a wrapper that carries data-expand-index.
    await withFileDiff(
      {
        hunkSeparators: () => {
          const span = document.createElement('span');
          span.textContent = 'custom separator';
          return span;
        },
      },
      ({ fileContainer }) => {
        const slots = queryAll(fileContainer, 'slot');
        expect(slots.length).toBeGreaterThan(0);
        for (const slot of slots) {
          expect(slot.closest('[data-expand-button]')).toBeNull();
        }
        expect(
          slots.some((slot) => slot.closest('[data-gutter]') != null)
        ).toBe(true);
        for (const slot of slots) {
          expect(
            slot.closest('[data-separator]')?.getAttribute('data-expand-index')
          ).not.toBeNull();
        }
      },
      { fileDiff: twoHunkDiff() }
    );
  });

  test('windowed folds fall back to an expandable line-info separator and never call the fn', async () => {
    // The fn receives HunkData for real diff hunks; a windowed fold is not one.
    let fnCalls = 0;
    await withFileDiff(
      {
        window: { start: 20, end: 30 },
        hunkSeparators: () => {
          fnCalls++;
          return document.createElement('span');
        },
      },
      async ({ fileContainer }) => {
        const folds = queryAll(
          fileContainer,
          '[data-content] > [data-separator][data-expand-index]'
        );
        expect(folds.length).toBeGreaterThan(0);
        for (const fold of folds) {
          expect(fold.getAttribute('data-separator')).toBe('line-info');
        }
        const button = fileContainer.shadowRoot?.querySelector(
          '[data-separator-first] [data-expand-button]'
        );
        expect(button).not.toBeNull();
        expect(fnCalls).toBe(0);

        const lineCount = (): number =>
          queryAll(fileContainer, '[data-content] > [data-line]').length;
        const before = lineCount();
        click(button);
        await waitForRenderedCode(fileContainer);
        expect(lineCount()).toBeGreaterThan(before);
        expect(fnCalls).toBe(0);
      },
      { fileDiff: twoHunkDiff() }
    );
  });
});

describe('FileDiff windowed runs that touch a window edge', () => {
  test('a host widening the window step by step shows every line it adds, and nothing folds', async () => {
    const fileDiff = makeDiff([30], 60);
    await withFileDiff(
      { window: { start: 27, end: 33 }, windowContextLines: 3 },
      async ({ instance, fileContainer }) => {
        expect(renderedLineNumbers(fileContainer)).toEqual(range(27, 33));
        // As a boundary-fold click handler would, out to both file ends.
        for (const window of [
          { start: 15, end: 45 },
          { start: 3, end: 57 },
          { start: 1, end: 60 },
        ]) {
          instance.setOptions({ ...instance.options, window });
          instance.render({ fileContainer, fileDiff, forceRender: true });
          await settle();
          expect(renderedLineNumbers(fileContainer)).toEqual(
            range(window.start, window.end)
          );
          expect(queryAll(fileContainer, INTERIOR_FOLD_SELECTOR)).toHaveLength(
            0
          );
        }
      },
      { fileDiff }
    );
  });

  // New-file line numbers rendered as rows. Split view puts old line numbers
  // in the deletions column, so read the additions (or unified) column only.
  function renderedNewLines(container: HTMLElement): number[] {
    const set = new Set<number>();
    for (const node of queryAll(
      container,
      '[data-additions] [data-line], [data-unified] [data-line]:not([data-line-type="change-deletion"])'
    )) {
      set.add(Number.parseInt(node.getAttribute('data-line') ?? '', 10));
    }
    return [...set].sort((a, b) => a - b);
  }

  test.each(['unified', 'split'] as const)(
    '%s: a changed line just past the window edge does not fold the run that touches the edge',
    async (diffStyle) => {
      await withFileDiff(
        { diffStyle, window: { start: 1, end: 29 }, windowContextLines: 3 },
        ({ fileContainer }) => {
          // Line 30 is changed and outside the window; 1-29 all show and the
          // change's deletion half stays in the below fold.
          expect(renderedNewLines(fileContainer)).toEqual(range(1, 29));
          expect(
            queryAll(
              fileContainer,
              '[data-line-type="change-deletion"][data-line="30"]'
            ).length
          ).toBe(0);
        },
        { fileDiff: makeDiff([10, 30], 60), wait: 'settle' }
      );
    }
  );

  test('a long unchanged run between two changes inside the window still folds', async () => {
    await withFileDiff(
      { window: { start: 5, end: 55 }, windowContextLines: 3 },
      ({ fileContainer }) => {
        const lines = renderedNewLines(fileContainer);
        // Edges to the nearest change show in full ...
        expect(lines).toEqual(
          expect.arrayContaining([...range(5, 13), ...range(47, 55)])
        );
        // ... the run between the two changes keeps 3 lines each side.
        expect(lines).not.toContain(30);
        expect(queryAll(fileContainer, INTERIOR_FOLD_SELECTOR)).toHaveLength(1);
      },
      { fileDiff: makeDiff([10, 50], 60), wait: 'settle' }
    );
  });
});

describe('FileDiff windowed fold labels say when a fold hides changes', () => {
  function labels(container: HTMLElement, selector: string): string[] {
    return queryAll(container, `${selector} [data-unmodified-lines]`).map(
      (node) => node.textContent ?? ''
    );
  }

  test.each(['unified', 'split'] as const)(
    '%s: the above fold hides a change and does not claim its lines are unmodified',
    async (diffStyle) => {
      await withFileDiff(
        { diffStyle, window: { start: 25, end: 35 }, windowContextLines: 50 },
        ({ fileContainer }) => {
          const above = labels(fileContainer, '[data-separator-first]');
          expect(above.length).toBeGreaterThan(0);
          for (const text of above) {
            expect(text).not.toContain('unmodified');
            expect(text).toMatch(/^\d+ hidden lines \(includes changes\)$/);
          }
          const below = labels(fileContainer, '[data-separator-last]');
          expect(below.length).toBeGreaterThan(0);
          for (const text of below) {
            expect(text).toMatch(/^\d+ unmodified lines$/);
          }
        }
      );
    }
  );

  test.each([
    ['line-info-basic', 'split', 'modified'],
    ['simple', 'unified', 'modified'],
    ['metadata', 'unified', 'modified'],
    ['line-info', 'split', 'new'],
  ] as const)(
    "hunkSeparators '%s', %s, %s file: a one-row fold that hides a change reads '1 hidden line (includes changes)'",
    async (hunkSeparators, diffStyle, kind) => {
      const fileDiff =
        kind === 'new'
          ? parseDiffFromFile(
              { name: 'f.txt', contents: '' },
              { name: 'f.txt', contents: numberedLines(40).join('\n') + '\n' }
            )
          : makeDiff([1]);
      await withFileDiff(
        {
          diffStyle,
          hunkSeparators,
          window: { start: 2, end: 40 },
          windowContextLines: 50,
        },
        ({ fileContainer }) => {
          const above = labels(fileContainer, '[data-separator-first]');
          expect(above.length).toBeGreaterThan(0);
          // A modified file's split view hides one row (the paired change);
          // unified hides the deletion and the addition.
          const expected =
            diffStyle === 'unified' && kind === 'modified'
              ? '2 hidden lines (includes changes)'
              : '1 hidden line (includes changes)';
          for (const text of above) {
            expect(text).toBe(expected);
          }
        },
        { fileDiff }
      );
    }
  );

  test('interior folds and non-windowed hunk separators keep "unmodified lines"', async () => {
    await withFileDiff(
      { window: { start: 1, end: 40 }, windowContextLines: 3 },
      ({ fileContainer }) => {
        const interior = labels(
          fileContainer,
          '[data-separator]:not([data-separator-first]):not([data-separator-last])'
        );
        expect(interior.length).toBeGreaterThan(0);
        for (const text of interior) {
          expect(text).toMatch(/^\d+ unmodified lines?$/);
        }
      }
    );
    await withFileDiff({}, ({ fileContainer }) => {
      const hunkLabels = labels(fileContainer, '[data-separator]');
      expect(hunkLabels.length).toBeGreaterThan(0);
      for (const text of hunkLabels) {
        expect(text).toMatch(/^\d+ unmodified lines?$/);
      }
    });
  });
});

describe('FileDiff windowed no-newline marker placement', () => {
  // The deletion side's 60 lines end WITHOUT a trailing newline; the addition
  // side has 61 lines and ends with one. A window can sit far from the end
  // while the windowed row indices diverge from the full split geometry.
  function makeNoTrailingNewlineDiff() {
    const oldLines = numberedLines(59);
    oldLines.push('old-final');
    const newLines = [...oldLines];
    newLines[4] = 'line 5 CHANGED';
    newLines.push('new-final-extra');
    return parseDiffFromFile(
      { name: 'f.txt', contents: oldLines.join('\n') },
      { name: 'f.txt', contents: newLines.join('\n') + '\n' }
    );
  }

  test('split: a window far from EOF shows no marker', async () => {
    await withFileDiff(
      {
        diffStyle: 'split',
        window: { start: 1, end: 10 },
        windowContextLines: 50,
      },
      ({ fileContainer }) => {
        expect(queryAll(fileContainer, '[data-no-newline]')).toHaveLength(0);
      },
      { fileDiff: makeNoTrailingNewlineDiff() }
    );
  });

  test.each(['split', 'unified'] as const)(
    '%s: a window that includes the final line shows the marker exactly once, on the deletion side',
    async (diffStyle) => {
      await withFileDiff(
        { diffStyle, window: { start: 55, end: 61 }, windowContextLines: 50 },
        ({ fileContainer }) => {
          const markers = queryAll(fileContainer, '[data-no-newline]');
          expect(markers).toHaveLength(1);
          expect(markers[0].getAttribute('data-line-type')).toBe(
            'change-deletion'
          );
        },
        { fileDiff: makeNoTrailingNewlineDiff() }
      );
    }
  );
});

describe('FileDiff windowed rendering recovers from an empty resolved window', () => {
  // A host holding a stale window after the file shrank resolves to no rows;
  // the fold is the reader's only way back.
  test('a window entirely past the end of the file still renders one recoverable fold', async () => {
    await withFileDiff(
      { window: { start: 100, end: 200 }, windowContextLines: 50 },
      async ({ instance, fileContainer }) => {
        expect(
          fileContainer.shadowRoot?.querySelector('pre')
        ).not.toBeUndefined();
        expect(
          queryAll(fileContainer, '[data-expand-button]').length
        ).toBeGreaterThan(0);

        const expandIndex = firstExpandIndex(fileContainer);
        expect(Number.isNaN(expandIndex)).toBe(false);
        instance.expandHunk(expandIndex, 'down', 5);
        await settle();
        expect(renderedLineNumbers(fileContainer).length).toBeGreaterThan(0);
      },
      { fileDiff: makeDiff([5]), wait: 'settle' }
    );
  });

  test('a file-level annotation does not suppress the recovery fold of an empty window', async () => {
    // A file-level annotation (lineNumber 0) renders a row before any diff row.
    await withFileDiff(
      {
        window: { start: 100, end: 200 },
        windowContextLines: 50,
        renderAnnotation: () => document.createElement('div'),
      },
      ({ fileContainer }) => {
        expect(
          queryAll(fileContainer, '[data-line-annotation]').length
        ).toBeGreaterThan(0);
        expect(
          queryAll(fileContainer, '[data-expand-button]').length
        ).toBeGreaterThan(0);
      },
      {
        fileDiff: makeDiff([5]),
        lineAnnotations: [
          { side: 'additions', lineNumber: 0, metadata: 'file note' },
        ],
        wait: 'settle',
      }
    );
  });
});

describe('windowed FileDiff honours parseDiffOptions.disableLineMatching', () => {
  // A blank line inserted above an edited line: matching pairs old 5 with
  // new 6, positional pairing pairs it with new 5. A window starting at 6
  // cuts the change, so the removed line shows only when it pairs with 6.
  const CONTEXT = 'alpha\nbravo\ncharlie\ndelta\n';
  test.each([
    ['split', false, true],
    ['split', true, false],
    ['unified', false, true],
    ['unified', true, false],
  ] as const)(
    '%s, disableLineMatching=%p: removed line shown = %p',
    async (diffStyle, disableLineMatching, removedShown) => {
      const { cleanup } = installDom();
      const fileContainer = document.createElement('div');
      document.body.appendChild(fileContainer);
      const instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle,
        window: { start: 6, end: 10 },
        parseDiffOptions: { disableLineMatching },
      });
      try {
        instance.render({
          fileContainer,
          oldFile: { name: 'a.ts', contents: CONTEXT + 'x = 1\n' + CONTEXT },
          newFile: { name: 'a.ts', contents: CONTEXT + '\nx = 2\n' + CONTEXT },
        });
        await waitForRenderedCode(fileContainer);
        expect(
          queryAll(fileContainer, '[data-line-type="change-deletion"]').length >
            0
        ).toBe(removedShown);
        expect(renderedLineNumbers(fileContainer)).toContain(6);
      } finally {
        instance.cleanUp();
        cleanup();
      }
    }
  );
});

describe('hydrating a windowed FileDiff over prerendered HTML', () => {
  test('renders the window instead of adopting the full prerendered diff', async () => {
    const { cleanup } = installDom();
    const fileDiff = makeWindowedDiff();
    const fileContainer = document.createElement('div');
    document.body.appendChild(fileContainer);
    // The SSR preloaders cannot window, so this markup is the whole diff.
    const { prerenderedHTML } = await preloadFileDiff({
      fileDiff,
      options: { disableFileHeader: true, diffStyle: 'unified' },
    });
    const instance = new FileDiff<undefined>({
      disableFileHeader: true,
      diffStyle: 'unified',
      window: { start: 25, end: 35 },
    });
    try {
      instance.hydrate({ fileContainer, fileDiff, prerenderedHTML });
      await waitForRenderedCode(fileContainer);
      await settle();
      const shown = renderedLineNumbers(fileContainer);
      expect(shown).toContain(30);
      expect(shown).not.toContain(5);
      expect(
        fileContainer.shadowRoot?.querySelector('[data-separator-first]')
      ).not.toBeNull();
    } finally {
      instance.cleanUp();
      cleanup();
    }
  });
});

describe('FileDiff renderWindowSeparator host elements', () => {
  test('a new hook re-renders the host elements even when the folds are unchanged', async () => {
    const label = (text: string) => (fold: WindowFold) => {
      const el = document.createElement('span');
      el.setAttribute('data-host-label', `${fold.boundary}:${text}`);
      return el;
    };
    await withFileDiff(
      { window: { start: 25, end: 35 }, renderWindowSeparator: label('A') },
      async ({ instance, fileContainer }) => {
        const labels = () =>
          Array.from(fileContainer.querySelectorAll('[data-host-label]'))
            .map((el) => el.getAttribute('data-host-label'))
            .sort();
        expect(labels()).toEqual(['above:A', 'below:A']);
        instance.setOptions({
          ...instance.options,
          renderWindowSeparator: label('B'),
        });
        instance.rerender();
        await settle();
        expect(labels()).toEqual(['above:B', 'below:B']);
      }
    );
  });
});

describe('FileDiff.expandWindowFold opens a fold by its id', () => {
  test('reveals toward the window, re-renders, and does not call onWindowExpand', async () => {
    const calls: unknown[] = [];
    await withFileDiff(
      {
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        onWindowExpand: (fold) => {
          calls.push(fold);
          return true;
        },
      },
      async ({ instance, fileContainer }) => {
        expect(instance.expandWindowFold('window:above', 'down', 3)).toBe(true);
        await settle();
        expect(renderedLineNumbers(fileContainer)).toEqual(range(22, 35));
        expect(calls).toHaveLength(0);
      }
    );
  });

  test('lineCount defaults to expansionLineCount', async () => {
    await withFileDiff(
      {
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        expansionLineCount: 2,
      },
      async ({ instance, fileContainer }) => {
        expect(instance.expandWindowFold('window:below', 'up')).toBe(true);
        await settle();
        expect(renderedLineNumbers(fileContainer)).toEqual(range(25, 37));
      }
    );
  });

  test('an unknown or fully opened fold id is a no-op that returns false', async () => {
    await withFileDiff(
      { window: { start: 25, end: 35 }, windowContextLines: 50 },
      async ({ instance, fileContainer }) => {
        expect(instance.expandWindowFold('interior:7', 'both')).toBe(false);
        expect(
          instance.expandWindowFold(
            'window:below',
            'up',
            Number.POSITIVE_INFINITY
          )
        ).toBe(true);
        await settle();
        const opened = renderedLineNumbers(fileContainer);
        expect(opened).toEqual(range(25, 40));
        expect(instance.expandWindowFold('window:below', 'up')).toBe(false);
        await settle();
        expect(renderedLineNumbers(fileContainer)).toEqual(opened);
      }
    );
  });

  test('without a window it returns false', async () => {
    await withFileDiff({}, ({ instance }) => {
      expect(instance.expandWindowFold('window:above', 'down')).toBe(false);
    });
  });
});

describe('FileDiff.expandWindowFold rejects counts that open nothing', () => {
  test.each([0, -5, Number.NaN])(
    'lineCount %p returns false and leaves the fold as it was',
    async (count) => {
      await withFileDiff(
        { window: { start: 25, end: 35 }, windowContextLines: 50 },
        async ({ instance, fileContainer }) => {
          expect(instance.expandWindowFold('window:above', 'down', count)).toBe(
            false
          );
          expect(instance.expandWindowFold('window:above', 'down', 2)).toBe(
            true
          );
          await settle();
          expect(renderedLineNumbers(fileContainer)).toEqual(range(23, 35));
        }
      );
    }
  );

  test('returns false after cleanUp', async () => {
    await withFileDiff({ window: { start: 25, end: 35 } }, ({ instance }) => {
      instance.cleanUp();
      expect(instance.expandWindowFold('window:above', 'down')).toBe(false);
    });
  });
});
