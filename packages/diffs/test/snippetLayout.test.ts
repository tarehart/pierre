import { describe, expect, test } from 'bun:test';

import { parseDiffFromFile } from '../src';
import {
  getDiffSnippetUnits,
  getFileSnippetUnits,
  getSnippetDiffRows,
  growSnippetReveal,
  layoutSnippet,
  type LineRange,
  revealSnippetLine,
  type SnippetLayout,
  type SnippetReveals,
} from '../src/utils/snippetLayout';
import { makeDiff, numberedLines } from './snippetHarness';

function diffLayout(
  diff = makeDiff([5, 30]),
  range: LineRange = { start: 25, end: 35 },
  {
    diffStyle = 'unified',
    contextLines = 3,
    reveals = new Map(),
  }: {
    diffStyle?: 'unified' | 'split';
    contextLines?: number;
    reveals?: SnippetReveals;
  } = {}
): SnippetLayout {
  const rows = getSnippetDiffRows(diff, diffStyle);
  return layoutSnippet({
    units: getDiffSnippetUnits(diff, rows, range),
    contextLines,
    collapsedContextThreshold: 1,
    reveals,
  });
}

const summary = (layout: SnippetLayout) =>
  layout.folds.map((fold) => [fold.id, fold.hiddenLines, fold.containsChanges]);

describe('layoutSnippet', () => {
  test('folds what lies outside the range into above/below folds', () => {
    // Lines 1-24 plus the removed line 5 above, 36-40 below.
    expect(summary(diffLayout())).toEqual([
      ['above', 25, true],
      ['below', 5, false],
    ]);
  });

  test('folds a long unchanged run between changes to contextLines', () => {
    const layout = diffLayout(makeDiff([5, 30]), { start: 1, end: 40 });
    expect(summary(layout)).toEqual([['interior:0', 18, false]]);
    expect(layout.folds[0].lineRange).toEqual({ start: 9, end: 26 });
    // A run at a range edge never folds, and contextLines: 0 folds it all.
    expect(
      summary(
        diffLayout(
          makeDiff([5, 30]),
          { start: 1, end: 40 },
          { contextLines: 0 }
        )
      )
    ).toEqual([['interior:0', 24, false]]);
  });

  test('unified and split agree on every fold, before and after reveals', () => {
    // A four-line modification right above the range: split draws it as four
    // paired rows, unified as eight rows.
    const diff = makeDiff([3, 4, 5, 6, 30]);
    const range = { start: 10, end: 20 };
    for (const lines of [0, 1, 3, 4, 8, 11, 12]) {
      const counts = (['unified', 'split'] as const).map((diffStyle) => {
        const reveals: SnippetReveals = new Map();
        const base = diffLayout(diff, range, { diffStyle, reveals });
        if (lines > 0) {
          growSnippetReveal(reveals, base.folds[0], 'down', lines);
        }
        return summary(diffLayout(diff, range, { diffStyle, reveals }));
      });
      expect(counts[0]).toEqual(counts[1]);
    }
  });

  test('a modification opens whole, and a reveal never re-folds', () => {
    const diff = makeDiff([3, 4, 5, 6]);
    const reveals: SnippetReveals = new Map();
    const range = { start: 10, end: 20 };
    const base = diffLayout(diff, range, { reveals });
    expect(base.folds[0].hiddenLines).toBe(13);
    // 4 lines: 9, 8, 7 and then the whole 8-line modification.
    growSnippetReveal(reveals, base.folds[0], 'down', 4);
    const opened = diffLayout(diff, range, { reveals });
    expect(opened.folds[0]).toMatchObject({ hiddenLines: 2, openedEnd: 11 });
    // Growing again starts from what is open (11), not what was asked (4).
    growSnippetReveal(reveals, opened.folds[0], 'down', 1);
    expect(diffLayout(diff, range, { reveals }).folds[0].hiddenLines).toBe(1);
  });

  test('a range that cuts a modification shows all of it', () => {
    const layout = diffLayout(makeDiff([10, 11, 12]), { start: 11, end: 20 });
    expect(layout.folds[0]).toMatchObject({
      boundary: 'above',
      hiddenLines: 9,
      containsChanges: false,
    });
  });

  test('a pure deletion touching the range edge belongs to it', () => {
    const old = numberedLines(30);
    const next = old.filter((_, i) => i !== 9); // remove line 10
    const diff = parseDiffFromFile(
      { name: 'f.txt', contents: old.join('\n') + '\n' },
      { name: 'f.txt', contents: next.join('\n') + '\n' }
    );
    // The deletion sits between new lines 9 and 10.
    expect(diffLayout(diff, { start: 10, end: 20 }).folds[0].hiddenLines).toBe(
      9
    );
    expect(diffLayout(diff, { start: 1, end: 9 }).folds[0]).toMatchObject({
      boundary: 'below',
      hiddenLines: 20,
      containsChanges: false,
    });
  });

  test('a new file folds by new lines and a deleted file by old lines', () => {
    const lines = numberedLines(20).join('\n') + '\n';
    const added = parseDiffFromFile(
      { name: 'f.txt', contents: '' },
      { name: 'f.txt', contents: lines }
    );
    expect(summary(diffLayout(added, { start: 5, end: 10 }))).toEqual([
      ['above', 4, true],
      ['below', 10, true],
    ]);
    const removed = parseDiffFromFile(
      { name: 'f.txt', contents: lines },
      { name: 'f.txt', contents: '' }
    );
    const layout = diffLayout(removed, { start: 5, end: 10 });
    expect(summary(layout)).toEqual([
      ['above', 4, true],
      ['below', 10, true],
    ]);
    expect(layout.folds[0].lineRange).toEqual({ start: 1, end: 4 });
  });

  test('a range past the end addresses the last line', () => {
    expect(summary(diffLayout(makeDiff([5]), { start: 90, end: 99 }))).toEqual([
      ['above', 40, true],
    ]);
  });

  test('revealSnippetLine opens the fold hiding a line from its nearer edge', () => {
    const reveals: SnippetReveals = new Map();
    const diff = makeDiff([5, 30]);
    const range = { start: 25, end: 35 };
    expect(
      revealSnippetLine(diffLayout(diff, range, { reveals }), reveals, 20)
    ).toBe(true);
    // Lines 20-24 are open; the change at 5 stays folded.
    expect(diffLayout(diff, range, { reveals }).folds[0]).toMatchObject({
      hiddenLines: 20,
      lineRange: { start: 1, end: 19 },
    });
    expect(
      revealSnippetLine(diffLayout(diff, range, { reveals }), reveals, 30)
    ).toBe(false);
  });
});

describe('file snippets', () => {
  test('a file has only boundary folds', () => {
    const layout = layoutSnippet({
      units: getFileSnippetUnits(50, { start: 20, end: 25 }),
      contextLines: 0,
      collapsedContextThreshold: 0,
      reveals: new Map(),
    });
    expect(summary(layout)).toEqual([
      ['above', 19, false],
      ['below', 25, false],
    ]);
  });
});
