import { afterAll, describe, expect, test } from 'bun:test';
import { createTwoFilesPatch } from 'diff';

import {
  disposeHighlighter,
  parseDiffFromFile,
  parsePatchFiles,
  SnippetFileDiff,
  type SnippetFold,
} from '../src';
import { Editor } from '../src/editor/editor';
import { installDom } from './domHarness';
import {
  boundaryLabel,
  click,
  foldLabels,
  makeDiff,
  numberedLines,
  queryAll,
  renderedLines,
  withSnippetDiff,
} from './snippetHarness';

afterAll(async () => {
  await disposeHighlighter();
});

describe('SnippetFileDiff', () => {
  test('shows only the range, with boundary and interior folds', async () => {
    await withSnippetDiff(
      { lineRange: { start: 1, end: 35 } },
      ({ container }) => {
        expect(renderedLines(container, 'additions')).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 27, 28, 29, 30, 31, 32, 33, 34, 35,
        ]);
        expect(foldLabels(container)).toEqual([
          '18 unmodified lines',
          '5 unmodified lines',
        ]);
        expect(
          queryAll(container, '[data-snippet-boundary="below"]').length
        ).toBe(2);
      }
    );
  });

  test('a click on a boundary fold calls onSnippetExpand, then opens in place', async () => {
    const calls: [SnippetFold, number][] = [];
    await withSnippetDiff(
      {
        lineRange: { start: 25, end: 35 },
        expansionLineCount: 10,
        onSnippetExpand: (fold, lineCount) => {
          calls.push([fold, lineCount]);
        },
      },
      ({ container }) => {
        click(boundaryLabel(container, 'above'));
        expect(calls).toEqual([
          [
            {
              boundary: 'above',
              hiddenLines: 25,
              containsChanges: true,
              lineRange: { start: 1, end: 24 },
            },
            10,
          ],
        ]);
        expect(renderedLines(container, 'additions')).toEqual([
          15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
          32, 33, 34, 35,
        ]);
        expect(foldLabels(container)[0]).toBe('15 hidden lines, with changes');
        // Shift-click asks for the whole fold.
        click(boundaryLabel(container, 'above'), { shiftKey: true });
        expect(calls[1][1]).toBe(Infinity);
        expect(renderedLines(container, 'additions')[0]).toBe(1);
      }
    );
  });

  test('onSnippetExpand returning true keeps the fold closed', async () => {
    await withSnippetDiff({ onSnippetExpand: () => true }, ({ container }) => {
      click(boundaryLabel(container, 'below'));
      expect(renderedLines(container).at(-1)).toBe(35);
      expect(foldLabels(container).at(-1)).toBe('5 unmodified lines');
    });
  });

  test('interior folds open in place without the callback', async () => {
    let called = false;
    await withSnippetDiff(
      {
        lineRange: { start: 1, end: 40 },
        expansionLineCount: 5,
        onSnippetExpand: () => {
          called = true;
        },
      },
      ({ container }) => {
        const label = queryAll(
          container,
          '[data-gutter] [data-separator]:not([data-snippet-boundary]) [data-unmodified-lines]'
        )[0];
        click(label);
        expect(called).toBe(false);
        // 'both' opens 5 at each edge of the 18-line fold.
        expect(foldLabels(container)).toEqual(['8 unmodified lines']);
      }
    );
  });

  test('expandSnippet reveals past a change and nothing re-folds', async () => {
    await withSnippetDiff({}, ({ instance, container }) => {
      expect(instance.expandSnippet('above', 22)).toBe(true);
      // The change at line 5 (and its removed line) is now open; line 6-8
      // and 9-24 stay open too: no interior fold appears.
      expect(instance.expandSnippet('above', 4)).toBe(true);
      expect(renderedLines(container, 'additions')).toEqual(
        Array.from({ length: 35 }, (_, i) => i + 1)
      );
      expect(foldLabels(container)).toEqual(['5 unmodified lines']);
      expect(instance.expandSnippet('above')).toBe(false);
      expect(instance.expandSnippet('below', Infinity)).toBe(true);
      expect(foldLabels(container)).toEqual([]);
      expect(() => instance.expandSnippet('below', 0)).toThrow(RangeError);
    });
  });

  test('unified and split hide the same lines after an expansion', async () => {
    // A four-line modification above the range: split pairs it into four
    // rows, unified draws eight.
    const fileDiff = makeDiff([3, 4, 5, 6, 30]);
    const counts: string[][] = [];
    for (const diffStyle of ['unified', 'split'] as const) {
      await withSnippetDiff(
        { diffStyle, lineRange: { start: 10, end: 20 } },
        ({ instance, container }) => {
          instance.expandSnippet('above', 8);
          counts.push(foldLabels(container));
        },
        fileDiff
      );
    }
    expect(counts[0]).toEqual([
      '2 unmodified lines',
      '21 hidden lines, with changes',
    ]);
    expect(counts[1]).toEqual(counts[0]);
  });

  test('revealLine opens the fold that hides the line', async () => {
    await withSnippetDiff({}, ({ instance, container }) => {
      expect(instance.revealLine(10)).toBe(true);
      expect(renderedLines(container, 'additions')[0]).toBe(10);
      expect(instance.revealLine(10)).toBe(false);
      expect(instance.revealLine(38)).toBe(true);
      expect(renderedLines(container).at(-1)).toBe(38);
    });
  });

  test('line-info-basic folds keep their style and stay clickable', async () => {
    await withSnippetDiff(
      { hunkSeparators: 'line-info-basic', expansionLineCount: 2 },
      ({ container }) => {
        expect(
          queryAll(container, '[data-separator="line-info-basic"]').length
        ).toBe(4);
        click(boundaryLabel(container, 'below'));
        expect(renderedLines(container).at(-1)).toBe(37);
      }
    );
  });

  test('a new lineRange is a fresh layout; the same range keeps reveals', async () => {
    await withSnippetDiff({}, ({ instance, container }) => {
      instance.expandSnippet('below', 2);
      instance.setOptions({
        ...instance.options,
        lineRange: { start: 25, end: 35 },
      });
      instance.render();
      expect(renderedLines(container).at(-1)).toBe(37);
      instance.setOptions({
        ...instance.options,
        lineRange: { start: 2, end: 3 },
      });
      instance.render();
      expect(renderedLines(container, 'additions')).toEqual([2, 3]);
    });
  });

  test('reveals survive an equal diff object and back-to-back calls', async () => {
    await withSnippetDiff({}, ({ instance, container }) => {
      // Two calls before any render catches up both count.
      instance.expandSnippet('below', 2);
      instance.expandSnippet('below', 2);
      expect(renderedLines(container).at(-1)).toBe(39);
      // A host re-parsing the same files keeps the reader's reveals.
      instance.render({ fileDiff: makeDiff([5, 30]) });
      expect(renderedLines(container).at(-1)).toBe(39);
      // Different contents are a fresh layout.
      instance.render({ fileDiff: makeDiff([5, 31]) });
      expect(renderedLines(container).at(-1)).toBe(35);
      expect(instance.expandSnippet('below', Infinity)).toBe(true);
      expect(instance.expandSnippet('below')).toBe(false);
    });
  });

  test('a diff re-parsed with other options renders its own rows', async () => {
    const old = {
      name: 'f.txt',
      contents: numberedLines(40).join('\n') + '\n',
    };
    const next = {
      ...old,
      contents: old.contents.replace('line 30\n', 'line 30  \n'),
    };
    await withSnippetDiff(
      {},
      ({ instance, container }) => {
        const changes = () =>
          queryAll(
            container,
            '[data-content] [data-line-type="change-addition"]'
          ).length;
        expect(changes()).toBe(1);
        instance.render({
          fileDiff: parseDiffFromFile(old, next, { ignoreWhitespace: true }),
        });
        expect(changes()).toBe(0);
      },
      parseDiffFromFile(old, next)
    );
  });

  test('changing collapsedContextThreshold is a fresh layout', async () => {
    await withSnippetDiff(
      { lineRange: { start: 1, end: 40 }, expansionLineCount: 2 },
      ({ instance, container }) => {
        click(
          queryAll(
            container,
            '[data-gutter] [data-separator]:not([data-snippet-boundary]) [data-unmodified-lines]'
          )[0]
        );
        expect(foldLabels(container)).toEqual(['14 unmodified lines']);
        instance.setOptions({
          ...instance.options,
          collapsedContextThreshold: 6,
        });
        instance.render();
        expect(foldLabels(container)).toEqual(['18 unmodified lines']);
      }
    );
  });

  test('renderable-line queries answer from the snippet layout', async () => {
    await withSnippetDiff({}, async ({ instance }) => {
      expect(instance.isLineRenderable(25)).toBe(true);
      expect(instance.isLineRenderable(5)).toBe(false);
      expect(instance.getNearestRenderableLine(10, 'down')).toBe(25);
      expect(instance.getNearestRenderableLine(38, 'up')).toBe(35);
      const error = await instance
        .prepareForEditing()
        .catch((caught: unknown) => caught);
      expect(String(error)).toContain('read-only');
    });
  });

  test('a collapsed snippet renders no rows', async () => {
    await withSnippetDiff({ collapsed: true }, ({ container }) => {
      expect(renderedLines(container)).toEqual([]);
    });
  });

  test('rejects bad input synchronously with a clear error', () => {
    const { cleanup } = installDom();
    try {
      expect(
        () => new SnippetFileDiff({ lineRange: { start: 5, end: 2 } })
      ).toThrow('lineRange must be');
      expect(
        () =>
          new SnippetFileDiff({
            lineRange: { start: 1, end: 2 },
            hunkSeparators: 'simple' as never,
          })
      ).toThrow("hunkSeparators must be 'line-info' or 'line-info-basic'");
      expect(
        () =>
          new SnippetFileDiff({
            lineRange: { start: 1, end: 2 },
            expandUnchanged: true,
          } as never)
      ).toThrow('expandUnchanged is not supported');

      const old = numberedLines(20).join('\n') + '\n';
      const patch = createTwoFilesPatch(
        'f.txt',
        'f.txt',
        old,
        old.replace('line 9\n', 'nine\n')
      );
      const partial = parsePatchFiles(patch)[0].files[0];
      const instance = new SnippetFileDiff({ lineRange: { start: 1, end: 5 } });
      expect(() =>
        instance.render({
          fileContainer: document.createElement('div'),
          fileDiff: partial,
        })
      ).toThrow(
        'a partial diff (parsed from a patch) cannot be shown as a snippet'
      );
      instance.cleanUp();
    } finally {
      cleanup();
    }
  });

  test('hunk expansion and editing are refused', async () => {
    await withSnippetDiff({}, ({ instance }) => {
      expect(() => instance.expandHunk(0, 'up')).toThrow('use expandSnippet');
      expect(() => new Editor('file-diff').edit(instance as never)).toThrow(
        'read-only'
      );
    });
  });
});
