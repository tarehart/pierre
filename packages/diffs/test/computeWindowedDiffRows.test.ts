import { describe, expect, test } from 'bun:test';

import type { FileDiffMetadata } from '../src/types';
import {
  computeWindowedDiffRows,
  type WindowedDiffResult,
} from '../src/utils/computeWindowedDiffRows';
import { iterateOverDiff } from '../src/utils/iterateOverDiff';
import { parseDiffFromFile } from '../src/utils/parseDiffFromFile';
import {
  createEmptyReveal,
  WINDOW_ABOVE_ID,
  WINDOW_BELOW_ID,
  type WindowSeparatorRow,
} from '../src/utils/windowingCore';

// Changes at lines 5 and 30 of a 40-line file (the same fixture as
// windowedHarness.makeWindowedDiff; kept local so the engine tests stand
// alone).
function makeWindowedDiff(): FileDiffMetadata {
  const old = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const next = [...old];
  next[4] = 'line 5 CHANGED';
  next[29] = 'line 30 CHANGED';
  return parseDiffFromFile(
    { name: 'f.txt', contents: old.join('\n') + '\n' },
    { name: 'f.txt', contents: next.join('\n') + '\n' }
  );
}

function separators(result: WindowedDiffResult): WindowSeparatorRow[] {
  return result.rows.filter(
    (row): row is WindowSeparatorRow => row.kind === 'separator'
  );
}

function visibleNewLines(result: WindowedDiffResult): number[] {
  const lines = new Set<number>();
  for (const row of result.rows) {
    if (row.kind === 'line' && row.newLine != null) {
      lines.add(row.newLine);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

// Fixture (makeWindowedDiff): changes at lines 5 and 30 of a 40-line file, far
// enough apart that a mid-file window can isolate one and fold the other.
describe('computeWindowedDiffRows', () => {
  test('keeps only in-window rows and folds the rest into boundary separators', () => {
    const diff = makeWindowedDiff();
    const result = computeWindowedDiffRows({
      diff,
      window: { start: 25, end: 35 },
      contextLines: 50,
    });

    // The line-30 change is inside the window and is kept as a paired row.
    expect(visibleNewLines(result)).toContain(30);
    // The line-5 change is above the window and must not render as a line.
    expect(visibleNewLines(result)).not.toContain(5);

    const seps = separators(result);
    const above = seps.find((s) => s.boundary === 'above');
    const below = seps.find((s) => s.boundary === 'below');
    expect(above).toBeDefined();
    expect(below).toBeDefined();
    // The above fold hides the line-5 change.
    expect(above?.containsChanges).toBe(true);
    expect(below?.containsChanges).toBe(false);
  });

  test('boundary separators carry stable ids that survive a reveal', () => {
    const run = (reveal = createEmptyReveal()) =>
      separators(
        computeWindowedDiffRows({
          diff: makeWindowedDiff(),
          window: { start: 25, end: 35 },
          contextLines: 50,
          reveal,
        })
      ).map((s) => [s.foldId, s.boundary]);
    expect(run()).toEqual([
      [WINDOW_ABOVE_ID, 'above'],
      [WINDOW_BELOW_ID, 'below'],
    ]);
    const reveal = createEmptyReveal();
    reveal.set(WINDOW_ABOVE_ID, { fromStart: 0, fromEnd: 3 });
    expect(run(reveal)).toEqual(run());
  });

  test('long unchanged runs inside the window collapse into interior folds', () => {
    const result = computeWindowedDiffRows({
      diff: makeWindowedDiff(),
      window: { start: 3, end: 35 },
      // With 1 context line, the 24-line run between the changes at 5 and 30
      // keeps one line at each end and folds its middle into an interior
      // separator. (Runs that touch a window edge never fold.)
      contextLines: 1,
    });
    const interior = separators(result).filter(
      (s) => s.boundary === 'interior'
    );
    expect(interior).toHaveLength(1);
    expect(interior[0].newLineRange).toEqual([7, 28]);
    expect(interior[0].containsChanges).toBe(false);
    // The runs touching the window edges (3-4 and 31-35) stay visible.
    expect(visibleNewLines(result)).toEqual([
      3, 4, 5, 6, 29, 30, 31, 32, 33, 34, 35,
    ]);
  });

  test('a high threshold keeps the run between two changes expanded', () => {
    // Both changes (5 and 30) are inside the window, so the 24-line run
    // between them could fold; 50 context lines cover it.
    const result = computeWindowedDiffRows({
      diff: makeWindowedDiff(),
      window: { start: 3, end: 35 },
      contextLines: 50,
    });
    expect(separators(result).some((s) => s.boundary === 'interior')).toBe(
      false
    );
    expect(visibleNewLines(result)).toEqual(
      Array.from({ length: 33 }, (_, i) => 3 + i)
    );
  });

  test.each(['unified', 'split'] as const)(
    '%s: a pure deletion inside the window bounds a run like any change',
    (diffStyle) => {
      const oldLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      const newLines = [...oldLines];
      newLines[9] = 'line 10 CHANGED';
      newLines.splice(49, 1); // delete old line 50
      const result = computeWindowedDiffRows({
        diff: parseDiffFromFile(
          { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
          { name: 'f.txt', contents: newLines.join('\n') + '\n' }
        ),
        window: { start: 1, end: 99 },
        diffStyle,
        contextLines: 3,
      });
      expect(
        separators(result).filter((s) => s.boundary === 'interior')
      ).toHaveLength(1);
      expect(visibleNewLines(result)).not.toContain(30);
    }
  );

  test('split: the extra deletion rows of a modification stay with their addition', () => {
    // Old lines 30-31 are replaced by new line 30. In split rows the second
    // deletion (old 31) is its own row after the paired 30 row. With the
    // window at 31-50, +30 is in the above fold, so old 31 must be too.
    const oldLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines.splice(29, 2, 'line 30 and 31 MERGED');
    const result = computeWindowedDiffRows({
      diff: parseDiffFromFile(
        { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
        { name: 'f.txt', contents: newLines.join('\n') + '\n' }
      ),
      window: { start: 31, end: 50 },
      diffStyle: 'split',
      contextLines: 3,
    });
    expect(
      result.rows.some((row) => row.kind === 'line' && row.newLine == null)
    ).toBe(false);
  });

  test('split: a shrinking modification inside the window yields unique folds in order', () => {
    // Old 28-33 become new 28-31: in split rows the extra deletions (old 32,
    // 33) follow the paired rows and must join the window with the paired
    // row before them, not with the first one.
    const oldLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines.splice(27, 6, 'n28', 'n29', 'n30', 'n31');
    const diff = parseDiffFromFile(
      { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
      { name: 'f.txt', contents: newLines.join('\n') + '\n' }
    );
    for (const window of [
      { start: 30, end: 40 },
      { start: 20, end: 29 },
    ]) {
      const result = computeWindowedDiffRows({
        diff,
        window,
        diffStyle: 'split',
        contextLines: 3,
      });
      const folds = separators(result);
      expect(new Set(folds.map((f) => f.foldId)).size).toBe(folds.length);
      const boundaries = folds.map((f) => f.boundary);
      expect(
        boundaries.filter((b) => b === 'above').length
      ).toBeLessThanOrEqual(1);
      expect(
        boundaries.filter((b) => b === 'below').length
      ).toBeLessThanOrEqual(1);
      if (boundaries.includes('below')) {
        expect(boundaries[boundaries.length - 1]).toBe('below');
      }
    }
  });

  test('a pure deletion just past the window end does not fold the run that reaches the edge', () => {
    const oldLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[11] = 'line 12 CHANGED';
    newLines.splice(30, 1); // delete old line 31
    const result = computeWindowedDiffRows({
      diff: parseDiffFromFile(
        { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
        { name: 'f.txt', contents: newLines.join('\n') + '\n' }
      ),
      window: { start: 10, end: 30 },
      contextLines: 3,
    });
    expect(visibleNewLines(result)).toEqual(
      Array.from({ length: 21 }, (_, i) => 10 + i)
    );
  });

  // Shown new-side and removed lines of one render, for comparing styles.
  function shownLines(
    diff: FileDiffMetadata,
    window: { start: number; end: number },
    diffStyle: 'unified' | 'split',
    contextLines: number
  ) {
    const newSide = new Set<number>();
    const removed = new Set<number>();
    for (const row of computeWindowedDiffRows({
      diff,
      window,
      diffStyle,
      contextLines,
    }).rows) {
      if (row.kind !== 'line') continue;
      if (row.newLine != null) newSide.add(row.newLine);
      if (row.row.type === 'change' && row.oldLine != null) {
        removed.add(row.oldLine);
      }
    }
    return {
      newSide: [...newSide].sort((a, b) => a - b),
      removed: [...removed].sort((a, b) => a - b),
    };
  }

  // Cut at the edge: a modification that crosses the
  // window edge shows only its new lines inside the window, each removed line
  // following the new line it pairs with (the i-th removed line with the i-th
  // new line), the same in split and unified. With an insertion at line 5,
  // the replaced old lines `at+1 .. at+removed` become new `at+2 ..`.
  test.each([
    {
      name: 'two-line replacement',
      start: 29,
      end: 45,
      splice: [26, 2, 2],
      deleted: [28],
    },
    {
      name: 'two-line replacement',
      start: 10,
      end: 28,
      splice: [26, 2, 2],
      deleted: [27],
    },
    {
      name: '40-line rewrite',
      start: 85,
      end: 100,
      splice: [50, 40, 40],
      deleted: [84, 85, 86, 87, 88, 89, 90],
    },
    {
      name: '40-line rewrite',
      start: 40,
      end: 55,
      splice: [50, 40, 40],
      deleted: [51, 52, 53, 54],
    },
    // Old 28-30 become new 29: old 28 pairs with new 29, and the unpaired
    // old 29-30 follow the block's last new line (new 29).
    {
      name: '3-into-1 replacement',
      start: 29,
      end: 45,
      splice: [27, 3, 1],
      deleted: [28, 29, 30],
    },
    {
      name: '3-into-1 replacement',
      start: 10,
      end: 28,
      splice: [27, 3, 1],
      deleted: [],
    },
  ])(
    'a $name crossing window $start-$end is cut at the edge, the same in both styles',
    ({ start, end, splice, deleted }) => {
      const oldLines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
      const newLines = [...oldLines];
      const [at, removed, added] = splice;
      newLines.splice(
        at,
        removed,
        ...Array.from({ length: added }, (_, i) => `new ${i}`)
      );
      newLines.splice(4, 0, 'inserted');
      const diff = parseDiffFromFile(
        { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
        { name: 'f.txt', contents: newLines.join('\n') + '\n' }
      );
      for (const diffStyle of ['unified', 'split'] as const) {
        const result = shownLines(diff, { start, end }, diffStyle, 3);
        expect(result.newSide).toEqual(
          Array.from({ length: end - start + 1 }, (_, i) => start + i)
        );
        expect(result.removed).toEqual([...deleted]);
      }
    }
  );

  test('unified: the part of a cut change outside the window is a fold labelled as hiding changes', () => {
    // Old 27-28 became new 28-29; the window starts at 29. Unified lists the
    // removed lines first: -27 (pairs with +28, outside) is hidden, -28
    // (pairs with +29) shows, then +28 is a one-line fold before +29.
    const oldLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines.splice(26, 2, 'new a', 'new b');
    newLines.splice(4, 0, 'inserted');
    const result = computeWindowedDiffRows({
      diff: parseDiffFromFile(
        { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
        { name: 'f.txt', contents: newLines.join('\n') + '\n' }
      ),
      window: { start: 29, end: 45 },
      diffStyle: 'unified',
      contextLines: 3,
    });
    const at = result.rows.findIndex(
      (row) => row.kind === 'line' && row.oldLine === 28
    );
    const fold = result.rows[at + 1];
    const next = result.rows[at + 2];
    expect(fold.kind).toBe('separator');
    if (fold.kind === 'separator') {
      expect(fold.collapsedLines).toBe(1);
      expect(fold.containsChanges).toBe(true);
      expect(fold.boundary).toBe('interior');
      expect(fold.foldId).toBe('window:edge:0');
      expect(fold.newLineRange).toEqual([28, 28]);
    }
    expect(next.kind === 'line' ? next.newLine : undefined).toBe(29);
    // The above fold holds everything before, including -27.
    expect(result.rows[0].kind).toBe('separator');
    expect(
      result.rows.some((row) => row.kind === 'line' && row.oldLine === 27)
    ).toBe(false);
  });

  test.each([0, 1])(
    'contextLines %p: a change cut at the bottom edge bounds the run above it in both styles',
    (contextLines) => {
      const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      const newLines = [...oldLines];
      newLines[4] = 'line 5 CHANGED';
      newLines.splice(11, 3, 'n12', 'n13', 'n14');
      const diff = parseDiffFromFile(
        { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
        { name: 'f.txt', contents: newLines.join('\n') + '\n' }
      );
      const window = { start: 3, end: 12 };
      const unified = shownLines(diff, window, 'unified', contextLines);
      expect(unified).toEqual(shownLines(diff, window, 'split', contextLines));
      // The run between the changes at 5 and 12 folds its middle.
      expect(unified.newSide).not.toContain(8);
    }
  );

  test.each([
    { start: 21, end: 30 },
    { start: 10, end: 20 },
  ])(
    'a realigned change pairs the same lines in both styles at window %p',
    (window) => {
      const oldLines = Array.from({ length: 40 }, (_, i) =>
        i === 19 ? 'const value = compute(alpha, beta);' : `line ${i + 1}`
      );
      const newLines = [...oldLines];
      newLines.splice(19, 1, '', 'const value = compute(alpha, beta, gamma);');
      const diff = parseDiffFromFile(
        { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
        { name: 'f.txt', contents: newLines.join('\n') + '\n' }
      );
      expect(shownLines(diff, window, 'unified', 3)).toEqual(
        shownLines(diff, window, 'split', 3)
      );
    }
  );

  test('unified: the deletion half of a line changed just past the window stays out of it', () => {
    // Line 30 is modified; the window ends at 29. In unified rows the deletion
    // half has no new-side line; it belongs with its addition (out of the
    // window), so it neither renders in the window nor bounds the 6-29 run,
    // which touches the window edge and shows in full.
    const result = computeWindowedDiffRows({
      diff: makeWindowedDiff(),
      window: { start: 6, end: 29 },
      diffStyle: 'unified',
      contextLines: 3,
    });
    expect(visibleNewLines(result)).toEqual(
      Array.from({ length: 24 }, (_, i) => 6 + i)
    );
    expect(
      result.rows.some((row) => row.kind === 'line' && row.newLine == null)
    ).toBe(false);
    const below = separators(result).find((s) => s.boundary === 'below');
    expect(below?.containsChanges).toBe(true);
  });

  test('interior context: keeps contextLines around each change, folds only the middle', () => {
    // Whole-file window, but the diff view still hugs each change (new-lines 5
    // and 30) with 3 context lines and folds only the long unchanged middle —
    // the conventional git -U3 look.
    const result = computeWindowedDiffRows({
      diff: makeWindowedDiff(),
      window: { start: 1, end: 40 },
      contextLines: 3,
    });
    const visible = visibleNewLines(result);
    // 3 context lines hug each change on both sides.
    for (const n of [2, 3, 4, 5, 6, 7, 8, 27, 28, 29, 30, 31, 32, 33]) {
      expect(visible).toContain(n);
    }
    // The long unchanged middle between the two changes is folded away.
    for (const n of [12, 15, 20]) {
      expect(visible).not.toContain(n);
    }
    // At least one interior separator carries the folded middle.
    expect(separators(result).some((s) => s.boundary === 'interior')).toBe(
      true
    );
  });

  test('a window with no change at all never folds', () => {
    // 200-line file, single change at new-line 5, window deep in the unchanged
    // tail (100-160). Both edges of the run are the window boundary, not a
    // change, so the requested range renders in full.
    const oldLines200 = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const newLines200 = [...oldLines200];
    newLines200[4] = 'line 5 CHANGED';
    const diff200 = parseDiffFromFile(
      { name: 'f.txt', contents: oldLines200.join('\n') + '\n' },
      { name: 'f.txt', contents: newLines200.join('\n') + '\n' }
    );
    const result = computeWindowedDiffRows({
      diff: diff200,
      window: { start: 100, end: 160 },
      contextLines: 3,
    });
    expect(visibleNewLines(result)).toEqual(
      Array.from({ length: 61 }, (_, i) => 100 + i)
    );
    expect(separators(result).some((s) => s.boundary === 'interior')).toBe(
      false
    );
  });

  test('a run bounded by a change on one side and the window edge on the other never folds', () => {
    // 200-line file, single change at new-line 100, window straddling it
    // (90-110) with contextLines 3. The runs [90,99] and [101,110] each touch
    // a window edge, so they show in full: every line the window asks for,
    // up to the change, stays visible, and widening the window can never
    // fold lines that were already shown.
    const oldLines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[99] = 'line 100 CHANGED';
    const diff = parseDiffFromFile(
      { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
      { name: 'f.txt', contents: newLines.join('\n') + '\n' }
    );
    const result = computeWindowedDiffRows({
      diff,
      window: { start: 90, end: 110 },
      contextLines: 3,
    });
    expect(visibleNewLines(result)).toEqual(
      Array.from({ length: 21 }, (_, i) => 90 + i)
    );
    expect(separators(result).some((s) => s.boundary === 'interior')).toBe(
      false
    );
  });

  test('an unchanged gap no larger than 2*contextLines stays fully expanded', () => {
    // Window around a single change with only a few unchanged lines on each
    // side: the context margins cover the whole run, so nothing folds.
    const result = computeWindowedDiffRows({
      diff: makeWindowedDiff(),
      window: { start: 2, end: 8 },
      contextLines: 3,
    });
    expect(separators(result).some((s) => s.boundary === 'interior')).toBe(
      false
    );
    expect(visibleNewLines(result)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  test('a whole-file window collapses nothing', () => {
    const result = computeWindowedDiffRows({
      diff: makeWindowedDiff(),
      window: { start: 1, end: 40 },
      contextLines: 50,
    });
    expect(separators(result)).toHaveLength(0);
    expect(visibleNewLines(result)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1)
    );
  });

  // At file start there is no above fold; over only unchanged lines both
  // folds still report the changes they hide (lines 5 and 30).
  test.each([
    { start: 1, end: 10, above: undefined },
    { start: 15, end: 20, above: true },
  ])(
    'window $start-$end: boundary folds report the changes they hide',
    ({ start, end, above }) => {
      const result = computeWindowedDiffRows({
        diff: makeWindowedDiff(),
        window: { start, end },
        contextLines: 50,
      });
      const seps = separators(result);
      const aboveFold = seps.find((s) => s.boundary === 'above');
      if (above === undefined) {
        expect(aboveFold).toBeUndefined();
      } else {
        expect(aboveFold?.containsChanges).toBe(above);
      }
      expect(seps.find((s) => s.boundary === 'below')?.containsChanges).toBe(
        true
      );
      expect(visibleNewLines(result)).toEqual(
        Array.from({ length: end - start + 1 }, (_, i) => start + i)
      );
    }
  );

  test('an inverted or past-EOF window collapses the whole file', () => {
    const inverted = computeWindowedDiffRows({
      diff: makeWindowedDiff(),
      window: { start: 30, end: 10 },
    });
    expect(visibleNewLines(inverted)).toHaveLength(0);
    expect(separators(inverted)).toHaveLength(1);

    const pastEof = computeWindowedDiffRows({
      diff: makeWindowedDiff(),
      window: { start: 100, end: 120 },
    });
    expect(visibleNewLines(pastEof)).toHaveLength(0);
    expect(separators(pastEof)).toHaveLength(1);
  });

  test('revealing a boundary fold peels lines off its window-facing edge', () => {
    const diff = makeWindowedDiff();
    const reveal = createEmptyReveal();
    // Peel 3 lines off the bottom of the above fold (lines 22, 23, 24).
    reveal.set(WINDOW_ABOVE_ID, { fromStart: 0, fromEnd: 3 });
    const result = computeWindowedDiffRows({
      diff,
      window: { start: 25, end: 35 },
      contextLines: 50,
      reveal,
    });
    const visible = visibleNewLines(result);
    expect(visible).toContain(22);
    expect(visible).toContain(23);
    expect(visible).toContain(24);
    expect(visible).not.toContain(21);
    // The above fold hid 25 rendered rows (context lines 1-24 plus the pure
    // deletion row of the line-5 change); revealing 3 leaves 22, still
    // including the change.
    const above = separators(result).find((s) => s.foldId === WINDOW_ABOVE_ID);
    expect(above?.collapsedLines).toBe(22);
    expect(above?.containsChanges).toBe(true);
  });

  test('revealing a fold fully removes its separator', () => {
    const diff = makeWindowedDiff();
    const reveal = createEmptyReveal();
    // The below fold hides 5 lines (36-40); reveal all of them.
    reveal.set(WINDOW_BELOW_ID, { fromStart: 100, fromEnd: 0 });
    const result = computeWindowedDiffRows({
      diff,
      window: { start: 25, end: 35 },
      contextLines: 50,
      reveal,
    });
    expect(separators(result).some((s) => s.foldId === WINDOW_BELOW_ID)).toBe(
      false
    );
    expect(visibleNewLines(result)).toContain(40);
  });

  test('pure deletions adjacent to the window ride along with it', () => {
    // Delete old line 20; window straddles the deletion point.
    const oldLines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`);
    const newLines = oldLines.filter((_, i) => i !== 19);
    const diff = parseDiffFromFile(
      { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
      { name: 'f.txt', contents: newLines.join('\n') + '\n' }
    );
    const result = computeWindowedDiffRows({
      diff,
      window: { start: 15, end: 25 },
      contextLines: 50,
    });
    // The pure deletion (old line 20) must be kept, rendered between its
    // surrounding new-side lines, not stranded in a fold.
    const hasDeletion = result.rows.some(
      (row) => row.kind === 'line' && row.newLine == null && row.oldLine === 20
    );
    expect(hasDeletion).toBe(true);
  });

  test('throws on a partial (patch-parsed) diff', () => {
    const diff = makeWindowedDiff();
    const partial: FileDiffMetadata = { ...diff, isPartial: true };
    expect(() =>
      computeWindowedDiffRows({ diff: partial, window: { start: 1, end: 5 } })
    ).toThrow(/non-partial/);
  });

  test('split style keeps a paired change as a single row', () => {
    const diff = makeWindowedDiff();
    const split = computeWindowedDiffRows({
      diff,
      diffStyle: 'split',
      window: { start: 25, end: 35 },
      contextLines: 50,
    });
    // The line-30 change renders once in split (both sides on one row) versus
    // twice in unified.
    const splitChangeRows = split.rows.filter(
      (row) => row.kind === 'line' && row.row.type === 'change'
    );
    expect(splitChangeRows).toHaveLength(1);

    const unified = computeWindowedDiffRows({
      diff,
      diffStyle: 'unified',
      window: { start: 25, end: 35 },
      contextLines: 50,
    });
    const unifiedChangeRows = unified.rows.filter(
      (row) => row.kind === 'line' && row.row.type === 'change'
    );
    expect(unifiedChangeRows).toHaveLength(2);

    // Same window folds either way: the line-5 change is above, line-30 kept.
    expect(visibleNewLines(split)).toContain(30);
    expect(visibleNewLines(split)).not.toContain(5);
    expect(
      separators(split).find((s) => s.boundary === 'above')?.containsChanges
    ).toBe(true);
  });
});

// A blank line inserted above an edited line. With similarity matching the
// edited line pairs with its old text (old 5 | new 6); with
// `disableLineMatching` the block pairs positionally (old 5 | new 5, the
// blank line). Removed lines are paired from the parsed diff's own split
// rows, so windowing follows whichever mode parsed the diff.
describe('windowed rows follow disableLineMatching', () => {
  const CONTEXT = 'alpha\nbravo\ncharlie\ndelta\n';
  const parse = (disableLineMatching: boolean) =>
    parseDiffFromFile(
      { name: 'a.ts', contents: CONTEXT + 'x = 1\n' + CONTEXT },
      { name: 'a.ts', contents: CONTEXT + '\nx = 2\n' + CONTEXT },
      { disableLineMatching }
    );
  type Pair = [number | undefined, number | undefined];

  test('the two modes pair the removed line differently', () => {
    const splitPairs = (disableLineMatching: boolean) => {
      const pairs: Pair[] = [];
      iterateOverDiff({
        diff: parse(disableLineMatching),
        diffStyle: 'split',
        expandedHunks: true,
        callback: (row) => {
          if (row.type === 'change') {
            pairs.push([
              row.deletionLine?.lineNumber,
              row.additionLine?.lineNumber,
            ]);
          }
        },
      });
      return pairs;
    };
    expect(splitPairs(false)).toEqual([
      [undefined, 5],
      [5, 6],
    ]);
    expect(splitPairs(true)).toEqual([
      [5, 5],
      [undefined, 6],
    ]);
  });

  test.each(['split', 'unified'] as const)(
    '%s: a cut change shows the removed line only when its partner is in the window',
    (diffStyle) => {
      const shownChanges = (disableLineMatching: boolean) =>
        computeWindowedDiffRows({
          diff: parse(disableLineMatching),
          // Starts at the edited line, cutting the change block.
          window: { start: 6, end: 10 },
          diffStyle,
        }).rows.flatMap((row): Pair[] =>
          row.kind === 'line' && row.row.type === 'change'
            ? [[row.oldLine, row.newLine]]
            : []
        );
      // Matching on: old 5 pairs with new 6, inside the window.
      expect(shownChanges(false)).toEqual(
        diffStyle === 'split'
          ? [[5, 6]]
          : [
              [5, undefined],
              [undefined, 6],
            ]
      );
      // Matching off: old 5 pairs with new 5, outside the window.
      expect(shownChanges(true)).toEqual([[undefined, 6]]);
    }
  );
});
