import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, type SnippetFold } from '../src';
import { Editor } from '../src/editor/editor';
import {
  boundaryLabel,
  click,
  foldLabels,
  queryAll,
  withSnippetFile,
} from './snippetHarness';

afterAll(async () => {
  await disposeHighlighter();
});

function fileLines(container: HTMLElement): number[] {
  return queryAll(container, '[data-gutter] [data-column-number]').map((node) =>
    Number(node.getAttribute('data-column-number'))
  );
}

describe('SnippetFile', () => {
  test('shows the range between two boundary folds', async () => {
    await withSnippetFile({}, ({ container }) => {
      expect(fileLines(container)).toEqual([20, 21, 22, 23, 24, 25]);
      expect(foldLabels(container)).toEqual([
        '19 unmodified lines',
        '25 unmodified lines',
      ]);
    });
  });

  test('a fold click uses the FileDiff default step and calls onSnippetExpand', async () => {
    const calls: [SnippetFold, number][] = [];
    await withSnippetFile(
      {
        onSnippetExpand: (fold, lineCount) =>
          void calls.push([fold, lineCount]),
      },
      ({ container }) => {
        click(boundaryLabel(container, 'below'));
        expect(calls[0]).toEqual([
          {
            boundary: 'below',
            hiddenLines: 25,
            containsChanges: false,
            lineRange: { start: 26, end: 50 },
          },
          100,
        ]);
        expect(fileLines(container).at(-1)).toBe(50);
        expect(foldLabels(container)).toEqual(['19 unmodified lines']);
      }
    );
  });

  test('onSnippetExpand returning true keeps the fold closed', async () => {
    await withSnippetFile({ onSnippetExpand: () => true }, ({ container }) => {
      click(boundaryLabel(container, 'above'));
      expect(fileLines(container)[0]).toBe(20);
    });
  });

  test('expandSnippet and revealLine open in place', async () => {
    await withSnippetFile({}, ({ instance, container }) => {
      expect(instance.expandSnippet('above', 4)).toBe(true);
      expect(fileLines(container)[0]).toBe(16);
      expect(instance.revealLine(30)).toBe(true);
      expect(fileLines(container).at(-1)).toBe(30);
      expect(instance.revealLine(22)).toBe(false);
      expect(instance.expandSnippet('above', Infinity)).toBe(true);
      expect(instance.expandSnippet('above')).toBe(false);
      expect(foldLabels(container)).toEqual(['20 unmodified lines']);
    });
  });

  test('is read-only', async () => {
    await withSnippetFile({}, ({ instance }) => {
      expect(() => new Editor('file').edit(instance as never)).toThrow(
        'read-only'
      );
    });
  });
});
