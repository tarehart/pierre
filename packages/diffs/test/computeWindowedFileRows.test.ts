import { describe, expect, test } from 'bun:test';

import {
  createEmptyReveal,
  WINDOW_ABOVE_ID,
  WINDOW_BELOW_ID,
} from '../src/utils/computeWindowedDiffRows';
import {
  computeWindowedFileRows,
  type WindowedFileLineRow,
  type WindowedFileSeparatorRow,
} from '../src/utils/computeWindowedFileRows';

const FIFTY_LINES = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);

function lineNumbers(
  result: ReturnType<typeof computeWindowedFileRows>
): number[] {
  return result.rows
    .filter((r): r is WindowedFileLineRow => r.kind === 'line')
    .map((r) => r.lineNumber);
}

function separators(
  result: ReturnType<typeof computeWindowedFileRows>
): WindowedFileSeparatorRow[] {
  return result.rows.filter(
    (r): r is WindowedFileSeparatorRow => r.kind === 'separator'
  );
}

describe('computeWindowedFileRows', () => {
  test('shows only lines in the window with boundary separators', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 20, end: 30 },
    });

    const lines = lineNumbers(result);
    expect(lines).toContain(20);
    expect(lines).toContain(25);
    expect(lines).toContain(30);
    expect(lines).not.toContain(19);
    expect(lines).not.toContain(31);

    const seps = separators(result);
    const ids = seps.map((s) => s.id);
    expect(ids).toContain(WINDOW_ABOVE_ID);
    expect(ids).toContain(WINDOW_BELOW_ID);
  });

  test('boundary separators have containsChanges: false', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 10, end: 20 },
    });
    for (const sep of separators(result)) {
      expect(sep.containsChanges).toBe(false);
    }
  });

  test('collapsedLines on above fold equals lines before window', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 10, end: 20 },
    });
    const above = separators(result).find((s) => s.id === WINDOW_ABOVE_ID);
    expect(above).toBeDefined();
    expect(above!.collapsedLines).toBe(9); // lines 1-9
  });

  test('collapsedLines on below fold equals lines after window', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 10, end: 20 },
    });
    const below = separators(result).find((s) => s.id === WINDOW_BELOW_ID);
    expect(below).toBeDefined();
    expect(below!.collapsedLines).toBe(30); // lines 21-50
  });

  test('no separator when window covers the whole file', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 1, end: 50 },
    });
    expect(separators(result)).toHaveLength(0);
    expect(lineNumbers(result)).toHaveLength(50);
  });

  test('never produces interior folds — all in-window lines are always rendered', () => {
    // For plain files every line is unchanged context, but interior folds are
    // meaningless for a code snippet: you asked for a window and you get it all.
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 1, end: 50 },
    });
    const interior = separators(result).filter(
      (s) => s.boundary === 'interior'
    );
    expect(interior).toHaveLength(0);
    expect(lineNumbers(result)).toHaveLength(50);
  });

  test('reveal peels lines off the above fold', () => {
    const reveal = createEmptyReveal();
    reveal.set(WINDOW_ABOVE_ID, { fromStart: 0, fromEnd: 3 });
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 10, end: 15 },
      reveal,
    });
    // Lines 7, 8, 9 should now be visible (3 from end of above fold).
    const lines = lineNumbers(result);
    expect(lines).toContain(7);
    expect(lines).toContain(8);
    expect(lines).toContain(9);
    expect(lines).toContain(10); // window start
  });

  test('newLineRange on separators is correct', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 20, end: 30 },
    });
    const above = separators(result).find((s) => s.id === WINDOW_ABOVE_ID)!;
    expect(above.newLineRange).toEqual([1, 19]);
    const below = separators(result).find((s) => s.id === WINDOW_BELOW_ID)!;
    expect(below.newLineRange).toEqual([31, 50]);
  });

  test('empty window produces all-above fold', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 200, end: 300 }, // past end of file
    });
    expect(lineNumbers(result)).toHaveLength(0);
    expect(result.totalCollapsed).toBe(50);
  });

  test('single-line window', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 25, end: 25 },
    });
    expect(lineNumbers(result)).toEqual([25]);
    const seps = separators(result);
    expect(seps.map((s) => s.id)).toContain(WINDOW_ABOVE_ID);
    expect(seps.map((s) => s.id)).toContain(WINDOW_BELOW_ID);
  });

  test('appliedWindow is clamped to file extent', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: -5, end: 200 },
    });
    expect(result.appliedWindow).toEqual({ start: 1, end: 50 });
    expect(separators(result)).toHaveLength(0);
  });
});
