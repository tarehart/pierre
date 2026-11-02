import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, File, FileDiff } from '../src';
import { Editor } from '../src/editor/editor';
import { installDom } from './domHarness';
import {
  makeDiff,
  numberedLines,
  queryAll,
  range,
  renderedLineNumbers,
  settle,
  withFileDiff,
} from './windowedHarness';

afterAll(async () => {
  await disposeHighlighter();
});

// A windowed snippet is read-only: the editor relies on hunk geometry for
// reveals and caret moves, which a window replaces with its own folds.
describe('a windowed FileDiff cannot be edited', () => {
  // One change, at line 20 of a 40-line file.
  const makeEditDiff = () => makeDiff([20]);

  test('attaching an editor to a windowed FileDiff throws', () => {
    const { cleanup } = installDom();
    const instance = new FileDiff<undefined>({
      disableFileHeader: true,
      window: { start: 15, end: 25 },
    });
    try {
      instance.render({
        fileDiff: makeEditDiff(),
        fileContainer: document.createElement('div'),
      });
      expect(() => new Editor('file-diff').edit(instance)).toThrow(/window/);
    } finally {
      instance.cleanUp();
      cleanup();
    }
  });

  test('setting a window while an editor is attached throws', () => {
    const { cleanup } = installDom();
    const instance = new FileDiff<undefined>({ disableFileHeader: true });
    const editor = new Editor('file-diff');
    try {
      instance.render({
        fileDiff: makeEditDiff(),
        fileContainer: document.createElement('div'),
      });
      editor.edit(instance);
      expect(() =>
        instance.setOptions({
          ...instance.options,
          window: { start: 15, end: 25 },
        })
      ).toThrow(/window/);
    } finally {
      editor.cleanUp();
      instance.cleanUp();
      cleanup();
    }
  });

  test('setting a window by assigning options while an editor is attached throws on render', () => {
    const { cleanup } = installDom();
    const instance = new FileDiff<undefined>({ disableFileHeader: true });
    const editor = new Editor('file-diff');
    const fileContainer = document.createElement('div');
    try {
      instance.render({ fileDiff: makeEditDiff(), fileContainer });
      editor.edit(instance);
      instance.options = {
        ...instance.options,
        window: { start: 15, end: 25 },
      };
      expect(() =>
        instance.render({
          fileDiff: makeEditDiff(),
          fileContainer,
          forceRender: true,
        })
      ).toThrow(/window/);
    } finally {
      editor.cleanUp();
      instance.cleanUp();
      cleanup();
    }
  });

  test('a windowed File cannot be edited either', () => {
    const { cleanup } = installDom();
    const file = {
      name: 'f.txt',
      contents: numberedLines(40).join('\n') + '\n',
    };
    const windowed = new File<undefined>({ window: { start: 15, end: 25 } });
    const plain = new File<undefined>({});
    const editor = new Editor('file');
    try {
      windowed.render({ file, fileContainer: document.createElement('div') });
      expect(() => new Editor('file').edit(windowed)).toThrow(/window/);
      plain.render({ file, fileContainer: document.createElement('div') });
      editor.edit(plain);
      expect(() =>
        plain.setOptions({ ...plain.options, window: { start: 15, end: 25 } })
      ).toThrow(/window/);
    } finally {
      editor.cleanUp();
      windowed.cleanUp();
      plain.cleanUp();
      cleanup();
    }
  });

  test('revealLine on a windowed FileDiff does nothing and offers no fold to onWindowExpand', async () => {
    const calls: string[] = [];
    await withFileDiff(
      {
        window: { start: 15, end: 25 },
        onWindowExpand: (fold) => {
          calls.push(fold.boundary);
          return true;
        },
      },
      ({ instance }) => {
        expect(instance.revealLine(5)).toBe(false);
        expect(calls).toEqual([]);
      },
      { fileDiff: makeEditDiff(), wait: 'settle' }
    );
  });

  test('an expand index that is not a current fold does not expand the whole-file diff', async () => {
    const options = {
      disableFileHeader: true,
      diffStyle: 'unified' as const,
      hunkSeparators: 'line-info' as const,
    };
    const fileDiff = makeEditDiff();
    await withFileDiff(
      { ...options, window: { start: 15, end: 25 } },
      async ({ instance, fileContainer }) => {
        // Between a window change and the next render no fold resolves.
        instance.setOptions({ ...options, window: { start: 30, end: 38 } });
        instance.expandHunk(0, 'down', 2);
        instance.render({ fileContainer, fileDiff, forceRender: true });
        await settle();
        expect(renderedLineNumbers(fileContainer)).toEqual(range(30, 38));

        // Without the window, hunk 0 shows only its default 3 context lines
        // around the line-20 change: the stray index expanded nothing.
        instance.setOptions(options);
        instance.render({ fileContainer, fileDiff, forceRender: true });
        await settle();
        expect(renderedLineNumbers(fileContainer)).toEqual(range(16, 24));
      },
      { fileDiff, wait: 'settle' }
    );
  });
});

// Rendered windowed rows carry dense indexes; getLineIndex and selection must
// resolve into the same space. Fixture: changes at lines 5 and 30.
describe('FileDiff windowed line indexes and selection', () => {
  const windowed = {
    window: { start: 25, end: 35 },
    windowContextLines: 50,
  };

  async function selectedLines(container: HTMLElement): Promise<string[]> {
    await settle(20);
    return queryAll(
      container,
      '[data-content] > [data-line][data-selected-line]'
    ).map((row) => row.getAttribute('data-line') ?? '');
  }

  test('getLineIndex for a folded line returns an index between its rendered neighbours', async () => {
    await withFileDiff(windowed, ({ instance }) => {
      // Line 5 sits in the above fold; line 25 is the first rendered row.
      const folded = instance.getLineIndex(5, 'additions');
      const first = instance.getLineIndex(25, 'additions');
      expect(folded).toBeDefined();
      expect(folded![0]).toBeLessThan(first![0]);
      expect(Number.isInteger(folded![0])).toBe(false);
    });
  });

  test('getLineIndex(inWindowLine) matches the rendered gutter row data-line-index, so selector-based lookups succeed', async () => {
    // InteractionManager.targetForSelectionPoint builds
    // `[data-column-number="N"][data-line-index="u,s"]` from getLineIndex.
    await withFileDiff(windowed, ({ instance, fileContainer }) => {
      const computed = instance.getLineIndex(30, 'additions');
      expect(computed).not.toBeUndefined();
      const [unifiedIndex, splitIndex] = computed!;
      expect(
        queryAll(
          fileContainer,
          `[data-column-number="30"][data-line-index="${unifiedIndex},${splitIndex}"]`
        ).length
      ).toBeGreaterThan(0);
    });
  });

  test('the selection-anchored gutter utility places on an in-window selection', async () => {
    await withFileDiff(
      {
        ...windowed,
        enableGutterUtility: true,
        renderGutterUtility: () => document.createElement('button'),
      },
      async ({ instance, fileContainer }) => {
        instance.setSelectedLines({ start: 30, end: 30 });
        await settle(20);
        expect(
          fileContainer.shadowRoot?.querySelector('[data-gutter-utility-slot]')
        ).not.toBeNull();
      }
    );
  });

  test('unified: every rendered row gets a distinct data-line-index, so selecting a context line highlights one row', async () => {
    // A context row is one unified row with both a deletion and an addition
    // side; both sides share one dense unified slot.
    await withFileDiff(windowed, async ({ instance, fileContainer }) => {
      // Line 29 is context directly above the line-30 change's deletion row.
      instance.setSelectedLines({ start: 29, end: 29 });
      expect(await selectedLines(fileContainer)).toEqual(['29']);

      const contentRows = queryAll(
        fileContainer,
        '[data-content] > [data-line][data-line-index]'
      );
      expect(contentRows.length).toBeGreaterThan(0);
      const unifiedIndexes = contentRows.map((row) =>
        Number.parseInt(
          row.getAttribute('data-line-index')!.split(',')[0] ?? '',
          10
        )
      );
      expect(new Set(unifiedIndexes).size).toBe(unifiedIndexes.length);
      // Dense and contiguous: 0..n-1 in DOM order.
      expect(unifiedIndexes).toEqual(unifiedIndexes.map((_, i) => i));
    });
  });

  test('selecting folded lines highlights only the visible rows inside the range', async () => {
    // A folded line has no rendered row: its index must not alias a visible
    // row's, and a range reaching into a fold still covers the visible rows.
    await withFileDiff(windowed, async ({ instance, fileContainer }) => {
      // Line 5 is a change folded away above the window.
      instance.setSelectedLines({ start: 5, end: 5 });
      expect(await selectedLines(fileContainer)).toEqual([]);

      // 20 is folded above the window, 27 is visible.
      instance.setSelectedLines({ start: 20, end: 27 });
      expect(await selectedLines(fileContainer)).toEqual(['25', '26', '27']);

      // 33 is visible, 38 is folded below the window.
      instance.setSelectedLines({ start: 33, end: 38 });
      expect(await selectedLines(fileContainer)).toEqual(['33', '34', '35']);
    });
  });
});
