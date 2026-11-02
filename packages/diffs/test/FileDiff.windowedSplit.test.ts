import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, parseDiffFromFile, type WindowFold } from '../src';
import {
  click,
  INTERIOR_FOLD_SELECTOR,
  makeDiff,
  numberedLines,
  queryAll,
  renderedLineNumbers,
  settle,
  withFileDiff,
} from './windowedHarness';

afterAll(async () => {
  await disposeHighlighter();
});

// Fixture (makeWindowedDiff): changes at lines 5 and 30 of a 40-line file.
describe('FileDiff split windowed boundary folds render as one full-width row', () => {
  test.each(['scroll', 'wrap'] as const)(
    "overflow '%s': the above and below folds are single rows outside the code columns, and a real click expands them",
    async (overflow) => {
      await withFileDiff(
        {
          diffStyle: 'split',
          overflow,
          window: { start: 25, end: 35 },
          windowContextLines: 50,
        },
        async ({ fileContainer }) => {
          const pre = fileContainer.shadowRoot?.querySelector('pre');
          const above = queryAll(fileContainer, '[data-separator-first]');
          const below = queryAll(fileContainer, '[data-separator-last]');
          expect(above).toHaveLength(1);
          expect(below).toHaveLength(1);
          for (const row of [above[0], below[0]]) {
            expect(row.closest('[data-code]')).toBeNull();
            expect(row.parentElement).toBe(pre ?? null);
            expect(row.getAttribute('data-separator')).toBe('line-info');
          }
          // The above row precedes both columns and the below row follows
          // them, so the below row sits under the columns' scrollbars.
          expect(pre?.firstElementChild).toBe(above[0]);
          expect(pre?.lastElementChild).toBe(below[0]);
          expect(
            Array.from(pre?.children ?? []).filter((child) =>
              child.hasAttribute('data-code')
            )
          ).toHaveLength(2);

          // Both columns still hold the same number of rows.
          const rowCounts = queryAll(fileContainer, '[data-code]').map(
            (column) => column.querySelectorAll('[data-line-index]').length
          );
          expect(rowCounts[0]).toBe(rowCounts[1]);

          // Only the window renders: the in-window change, not the folded one.
          expect(renderedLineNumbers(fileContainer)).toContain(30);
          expect(renderedLineNumbers(fileContainer)).not.toContain(5);

          // A real click on the above row's expander reveals lines toward the
          // window, through the InteractionManager click router.
          expect(renderedLineNumbers(fileContainer)).not.toContain(20);
          click(above[0].querySelector('[data-expand-button]'));
          await settle();
          expect(renderedLineNumbers(fileContainer)).toContain(20);

          // The below row expands in place too, and disappears once empty.
          expect(renderedLineNumbers(fileContainer)).not.toContain(40);
          click(
            fileContainer.shadowRoot?.querySelector(
              '[data-separator-last] [data-expand-button]'
            )
          );
          await settle();
          expect(renderedLineNumbers(fileContainer)).toContain(40);
          expect(queryAll(fileContainer, '[data-separator-last]')).toHaveLength(
            0
          );
        }
      );
    }
  );

  test('interior folds stay per column, inside the code columns', async () => {
    await withFileDiff(
      {
        diffStyle: 'split',
        window: { start: 1, end: 40 },
        windowContextLines: 3,
      },
      ({ fileContainer }) => {
        const interior = queryAll(fileContainer, INTERIOR_FOLD_SELECTOR);
        // One copy per column for each interior fold.
        expect(interior.length).toBeGreaterThan(0);
        expect(interior.length % 2).toBe(0);
        for (const element of interior) {
          expect(element.closest('[data-code]')).not.toBeNull();
        }
      }
    );
  });

  test('renderWindowSeparator is called once per boundary fold and never for interior folds; a click on the host element expands', async () => {
    const calls: WindowFold['boundary'][] = [];
    await withFileDiff(
      {
        diffStyle: 'split',
        window: { start: 3, end: 35 },
        windowContextLines: 3,
        renderWindowSeparator: (fold) => {
          calls.push(fold.boundary);
          const el = document.createElement('button');
          el.setAttribute('data-custom-fold', fold.boundary);
          el.textContent = `${fold.collapsedLines} hidden`;
          return el;
        },
      },
      async ({ fileContainer }) => {
        expect(calls.filter((b) => b === 'above')).toHaveLength(1);
        expect(calls.filter((b) => b === 'below')).toHaveLength(1);
        expect(calls.filter((b) => b === 'interior')).toHaveLength(0);
        // Interior folds use the built-in separator, with a working expander.
        const interior = queryAll(fileContainer, INTERIOR_FOLD_SELECTOR);
        expect(interior.length).toBeGreaterThan(0);
        for (const element of interior) {
          expect(element.getAttribute('data-separator')).toBe('line-info');
        }
        const beforeInterior = renderedLineNumbers(fileContainer).length;
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-gutter] > [data-separator][data-expand-index]:not([data-separator-first]):not([data-separator-last]) [data-expand-button]'
          )
        );
        await settle();
        expect(renderedLineNumbers(fileContainer).length).toBeGreaterThan(
          beforeInterior
        );

        // The above fold's slot lives in the full-width row, not in a column.
        const aboveRow = fileContainer.shadowRoot?.querySelector(
          'pre > [data-separator-first]'
        );
        expect(aboveRow?.getAttribute('data-separator')).toBe('custom');
        const slotName = aboveRow?.querySelector('slot')?.getAttribute('name');
        expect(slotName).toBeTruthy();
        const host = fileContainer.querySelector(
          `[slot="${slotName}"] [data-custom-fold="above"]`
        );
        expect(host).not.toBeNull();

        expect(renderedLineNumbers(fileContainer)).not.toContain(1);
        click(host);
        await settle();
        expect(renderedLineNumbers(fileContainer)).toContain(1);
        // The fully revealed above fold is gone, with its host element.
        expect(
          fileContainer.shadowRoot?.querySelector('[data-separator-first]')
        ).toBeNull();
        expect(
          fileContainer.querySelector('[data-custom-fold="above"]')
        ).toBeNull();
      }
    );
  });

  test('unified: renderWindowSeparator is never called for interior folds, also after a reveal', async () => {
    const calls: WindowFold['boundary'][] = [];
    await withFileDiff(
      {
        hunkSeparators: 'simple',
        window: { start: 3, end: 35 },
        windowContextLines: 3,
        renderWindowSeparator: (fold) => {
          calls.push(fold.boundary);
          return document.createElement('button');
        },
      },
      async ({ fileContainer }) => {
        const interior = () => queryAll(fileContainer, INTERIOR_FOLD_SELECTOR);
        expect(interior().length).toBeGreaterThan(0);
        expect(interior()[0].getAttribute('data-separator')).toBe('line-info');
        click(
          fileContainer.shadowRoot?.querySelector(
            '[data-separator-first] [data-expand-button]'
          )
        );
        await settle();
        expect(calls.filter((b) => b === 'interior')).toHaveLength(0);
        expect(interior()[0].getAttribute('data-separator')).toBe('line-info');
      }
    );
  });

  test("a 'both' click on the above fold keeps it the full-width top row", async () => {
    await withFileDiff(
      {
        diffStyle: 'split',
        window: { start: 30, end: 50 },
        windowContextLines: 3,
      },
      async ({ instance, fileContainer }) => {
        const topRow = () =>
          fileContainer.shadowRoot?.querySelector(
            'pre > [data-window-boundary="above"]'
          ) ?? null;
        expect(topRow()).not.toBeNull();
        const index = Number.parseInt(
          topRow()?.getAttribute('data-expand-index') ?? '',
          10
        );
        // A boundary fold opens only toward the window, so no row ever
        // renders above it and it stays one full-width row.
        instance.expandHunk(index, 'both', 8);
        await settle();
        expect(topRow()).not.toBeNull();
        expect(renderedLineNumbers(fileContainer)).not.toContain(1);
      },
      { fileDiff: makeDiff([5, 40], 60), wait: 'settle' }
    );
  });

  test('an empty window still renders its recovery fold as a full-width row', async () => {
    await withFileDiff(
      {
        diffStyle: 'split',
        window: { start: 100, end: 200 },
        windowContextLines: 50,
      },
      async ({ fileContainer }) => {
        const rows = queryAll(fileContainer, 'pre > [data-separator]');
        expect(rows).toHaveLength(1);
        expect(renderedLineNumbers(fileContainer)).toHaveLength(0);
        click(rows[0].querySelector('[data-expand-button]'));
        await settle();
        expect(renderedLineNumbers(fileContainer).length).toBeGreaterThan(0);
      },
      { wait: 'settle' }
    );
  });

  test('a new file in split (one column) keeps its boundary folds inside that column', async () => {
    await withFileDiff(
      {
        diffStyle: 'split',
        window: { start: 15, end: 20 },
        windowContextLines: 50,
      },
      ({ fileContainer }) => {
        expect(
          fileContainer.shadowRoot?.querySelector('[data-window-boundary]')
        ).toBeNull();
        const above = queryAll(fileContainer, '[data-separator-first]');
        expect(above.length).toBeGreaterThan(0);
        for (const copy of above) {
          expect(copy.closest('[data-code]')).not.toBeNull();
        }
      },
      {
        fileDiff: parseDiffFromFile(
          { name: 'f.txt', contents: '' },
          { name: 'f.txt', contents: numberedLines(40).join('\n') + '\n' }
        ),
      }
    );
  });

  test('a file-level annotation keeps the above fold inside the columns, after the annotation, as in unified', async () => {
    await withFileDiff(
      {
        diffStyle: 'split',
        window: { start: 25, end: 35 },
        windowContextLines: 50,
        renderAnnotation: () => {
          const el = document.createElement('div');
          el.textContent = 'file comment';
          return el;
        },
      },
      ({ fileContainer }) => {
        expect(
          fileContainer.shadowRoot?.querySelector(
            '[data-window-boundary="above"]'
          )
        ).toBeNull();
        const content = fileContainer.shadowRoot?.querySelector(
          '[data-additions] [data-content]'
        );
        const children = Array.from(content?.children ?? []);
        const annotationAt = children.findIndex((child) =>
          child.hasAttribute('data-line-annotation')
        );
        const foldAt = children.findIndex((child) =>
          child.hasAttribute('data-separator-first')
        );
        expect(annotationAt).toBeGreaterThanOrEqual(0);
        expect(foldAt).toBeGreaterThan(annotationAt);
        // The below fold has no annotation in its way and stays full width.
        expect(
          fileContainer.shadowRoot?.querySelector(
            'pre > [data-window-boundary="below"]'
          )
        ).not.toBeNull();
      },
      {
        lineAnnotations: [
          { side: 'additions', lineNumber: 0, metadata: 'file' },
        ],
      }
    );
  });

  test('unified boundary folds stay inside the code column', async () => {
    await withFileDiff(
      { window: { start: 25, end: 35 }, windowContextLines: 50 },
      ({ fileContainer }) => {
        for (const selector of [
          '[data-separator-first]',
          '[data-separator-last]',
        ]) {
          const copies = queryAll(fileContainer, selector);
          // Gutter and content copies, both inside the unified column.
          expect(copies).toHaveLength(2);
          for (const copy of copies) {
            expect(copy.closest('[data-code]')).not.toBeNull();
          }
        }
      }
    );
  });
});
