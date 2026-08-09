import { describe, expect, test } from 'bun:test';

import type { FileDiffMetadata } from '../src/types';
import {
  computeWindowedDiffRows,
  createEmptyReveal,
  WINDOW_ABOVE_ID,
  WINDOW_BELOW_ID,
  type WindowedDiffResult,
  type WindowedDiffSeparatorRow,
} from '../src/utils/computeWindowedDiffRows';
import { parseDiffFromFile } from '../src/utils/parseDiffFromFile';

// A 40-line file with a change on new-line 5 and new-line 30. The two changes
// sit far enough apart that a mid-file window can isolate one and fold the
// other, which is the whole point of windowed snippets.
function makeDiff(): FileDiffMetadata {
  const oldLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const newLines = [...oldLines];
  newLines[4] = 'line 5 CHANGED';
  newLines[29] = 'line 30 CHANGED';
  return parseDiffFromFile(
    { name: 'f.txt', contents: oldLines.join('\n') + '\n' },
    { name: 'f.txt', contents: newLines.join('\n') + '\n' }
  );
}

function separators(result: WindowedDiffResult): WindowedDiffSeparatorRow[] {
  return result.rows.filter(
    (row): row is WindowedDiffSeparatorRow => row.kind === 'separator'
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

describe('computeWindowedDiffRows', () => {
  test('keeps only in-window rows and folds the rest into boundary separators', () => {
    const diff = makeDiff();
    const result = computeWindowedDiffRows({
      diff,
      window: { start: 25, end: 35 },
      collapsedContextThreshold: 50,
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
    // Ground truth, not a heuristic: the above fold hides the line-5 change.
    expect(above?.containsChanges).toBe(true);
    expect(below?.containsChanges).toBe(false);
  });

  test('boundary separators carry stable ids and expand both ways by default', () => {
    const result = computeWindowedDiffRows({
      diff: makeDiff(),
      window: { start: 25, end: 35 },
      collapsedContextThreshold: 50,
    });
    const seps = separators(result);
    const above = seps.find((s) => s.id === WINDOW_ABOVE_ID);
    const below = seps.find((s) => s.id === WINDOW_BELOW_ID);
    expect(above?.canExpandDown).toBe(true);
    expect(above?.canExpandUp).toBe(true);
    expect(below?.canExpandUp).toBe(true);
    expect(below?.canExpandDown).toBe(true);
  });

  test("expansionBounds: 'window' clamps boundary folds to the window edge", () => {
    const result = computeWindowedDiffRows({
      diff: makeDiff(),
      window: { start: 25, end: 35 },
      collapsedContextThreshold: 50,
      expansionBounds: 'window',
    });
    const seps = separators(result);
    const above = seps.find((s) => s.id === WINDOW_ABOVE_ID);
    const below = seps.find((s) => s.id === WINDOW_BELOW_ID);
    // Above fold may only open toward the window (down); below only up.
    expect(above?.canExpandUp).toBe(false);
    expect(above?.canExpandDown).toBe(true);
    expect(below?.canExpandUp).toBe(true);
    expect(below?.canExpandDown).toBe(false);
  });

  test('long unchanged runs inside the window collapse into interior folds', () => {
    const result = computeWindowedDiffRows({
      diff: makeDiff(),
      window: { start: 25, end: 35 },
      // Default threshold (2) folds the 25-29 and 31-35 unchanged runs.
    });
    const interior = separators(result).filter(
      (s) => s.boundary === 'interior'
    );
    expect(interior.length).toBeGreaterThanOrEqual(1);
    for (const fold of interior) {
      expect(fold.containsChanges).toBe(false);
      expect(fold.canExpandUp).toBe(true);
      expect(fold.canExpandDown).toBe(true);
    }
  });

  test('a high threshold keeps in-window unchanged context expanded', () => {
    const result = computeWindowedDiffRows({
      diff: makeDiff(),
      window: { start: 25, end: 35 },
      collapsedContextThreshold: 50,
    });
    // Every in-window unchanged line renders; no interior fold.
    expect(separators(result).some((s) => s.boundary === 'interior')).toBe(
      false
    );
    expect(visibleNewLines(result)).toEqual([
      25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
    ]);
  });

  test('a whole-file window collapses nothing', () => {
    const result = computeWindowedDiffRows({
      diff: makeDiff(),
      window: { start: 1, end: 40 },
      collapsedContextThreshold: 50,
    });
    expect(separators(result)).toHaveLength(0);
    expect(result.totalCollapsed).toBe(0);
    expect(visibleNewLines(result)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1)
    );
  });

  test('a window at file start emits no above separator', () => {
    const result = computeWindowedDiffRows({
      diff: makeDiff(),
      window: { start: 1, end: 10 },
      collapsedContextThreshold: 50,
    });
    expect(separators(result).some((s) => s.boundary === 'above')).toBe(false);
    const below = separators(result).find((s) => s.boundary === 'below');
    // The line-30 change is below this window.
    expect(below?.containsChanges).toBe(true);
  });

  test('a window over only unchanged lines still reports changes truthfully', () => {
    const result = computeWindowedDiffRows({
      diff: makeDiff(),
      window: { start: 15, end: 20 },
      collapsedContextThreshold: 50,
    });
    const seps = separators(result);
    // Both changes are outside this window, one above and one below.
    expect(seps.find((s) => s.boundary === 'above')?.containsChanges).toBe(
      true
    );
    expect(seps.find((s) => s.boundary === 'below')?.containsChanges).toBe(
      true
    );
    expect(visibleNewLines(result)).toEqual([15, 16, 17, 18, 19, 20]);
  });

  test('an inverted or past-EOF window collapses the whole file', () => {
    const inverted = computeWindowedDiffRows({
      diff: makeDiff(),
      window: { start: 30, end: 10 },
    });
    expect(visibleNewLines(inverted)).toHaveLength(0);
    expect(separators(inverted)).toHaveLength(1);

    const pastEof = computeWindowedDiffRows({
      diff: makeDiff(),
      window: { start: 100, end: 120 },
    });
    expect(visibleNewLines(pastEof)).toHaveLength(0);
    expect(separators(pastEof)).toHaveLength(1);
  });

  test('revealing a boundary fold peels lines off its window-facing edge', () => {
    const diff = makeDiff();
    const reveal = createEmptyReveal();
    // Peel 3 lines off the bottom of the above fold (lines 22, 23, 24).
    reveal.set(WINDOW_ABOVE_ID, { fromStart: 0, fromEnd: 3 });
    const result = computeWindowedDiffRows({
      diff,
      window: { start: 25, end: 35 },
      collapsedContextThreshold: 50,
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
    const above = separators(result).find((s) => s.id === WINDOW_ABOVE_ID);
    expect(above?.collapsedLines).toBe(22);
    expect(above?.containsChanges).toBe(true);
  });

  test('revealing a fold fully removes its separator', () => {
    const diff = makeDiff();
    const reveal = createEmptyReveal();
    // The below fold hides 5 lines (36-40); reveal all of them.
    reveal.set(WINDOW_BELOW_ID, { fromStart: 100, fromEnd: 0 });
    const result = computeWindowedDiffRows({
      diff,
      window: { start: 25, end: 35 },
      collapsedContextThreshold: 50,
      reveal,
    });
    expect(separators(result).some((s) => s.id === WINDOW_BELOW_ID)).toBe(
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
      collapsedContextThreshold: 50,
    });
    // The pure deletion (old line 20) must be kept, rendered between its
    // surrounding new-side lines, not stranded in a fold.
    const hasDeletion = result.rows.some(
      (row) => row.kind === 'line' && row.newLine == null && row.oldLine === 20
    );
    expect(hasDeletion).toBe(true);
  });

  test('throws on a partial (patch-parsed) diff', () => {
    const diff = makeDiff();
    const partial: FileDiffMetadata = { ...diff, isPartial: true };
    expect(() =>
      computeWindowedDiffRows({ diff: partial, window: { start: 1, end: 5 } })
    ).toThrow(/non-partial/);
  });
});
