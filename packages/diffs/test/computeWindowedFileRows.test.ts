import { describe, expect, test } from 'bun:test';

import {
  computeWindowedFileRows,
  type WindowedFileLineRow,
} from '../src/utils/computeWindowedFileRows';
import {
  createEmptyReveal,
  WINDOW_ABOVE_ID,
  WINDOW_BELOW_ID,
  type WindowSeparatorRow,
} from '../src/utils/windowingCore';

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
): WindowSeparatorRow[] {
  return result.rows.filter(
    (r): r is WindowSeparatorRow => r.kind === 'separator'
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
    const ids = seps.map((s) => s.foldId);
    expect(ids).toContain(WINDOW_ABOVE_ID);
    expect(ids).toContain(WINDOW_BELOW_ID);
  });

  test('boundary folds hide only unchanged lines and report their size and range', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 10, end: 20 },
    });
    for (const sep of separators(result)) {
      expect(sep.containsChanges).toBe(false);
    }
    const above = separators(result).find((s) => s.foldId === WINDOW_ABOVE_ID);
    const below = separators(result).find((s) => s.foldId === WINDOW_BELOW_ID);
    expect(above).toBeDefined();
    expect(below).toBeDefined();
    expect(above!.collapsedLines).toBe(9);
    expect(above!.newLineRange).toEqual([1, 9]);
    expect(below!.collapsedLines).toBe(30);
    expect(below!.newLineRange).toEqual([21, 50]);
  });

  test('no separator when window covers the whole file', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 1, end: 50 },
    });
    expect(separators(result)).toHaveLength(0);
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

  test('empty window produces all-above fold', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 200, end: 300 }, // past end of file
    });
    expect(lineNumbers(result)).toHaveLength(0);
    expect(separators(result).map((s) => s.collapsedLines)).toEqual([50]);
  });

  test('single-line window', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: 25, end: 25 },
    });
    expect(lineNumbers(result)).toEqual([25]);
    const seps = separators(result);
    expect(seps.map((s) => s.foldId)).toContain(WINDOW_ABOVE_ID);
    expect(seps.map((s) => s.foldId)).toContain(WINDOW_BELOW_ID);
  });

  test('a window past both ends is clamped to the file', () => {
    const result = computeWindowedFileRows({
      lines: FIFTY_LINES,
      window: { start: -5, end: 200 },
    });
    expect(lineNumbers(result)).toHaveLength(50);
    expect(separators(result)).toHaveLength(0);
  });
});
