import {
  type BaseFold,
  clampWindow,
  createEmptyReveal,
  type DiffWindow,
  enumerateFolds,
  markBaseHidden,
  newLineRange,
  WINDOW_ABOVE_ID,
  WINDOW_BELOW_ID,
  type WindowableFlatRow,
  type WindowFold,
  type WindowReveal,
} from './windowingCore';

export interface ComputeWindowedFileRowsProps {
  /** Full file contents, split on `\n`. */
  lines: readonly string[];
  window: DiffWindow;
  /** Reader-driven reveals accumulated from separator clicks. */
  reveal?: WindowReveal;
}

export interface WindowedFileLineRow {
  kind: 'line';
  /** 1-based absolute line number. */
  lineNumber: number;
  /** Raw text of the line (no trailing newline). */
  text: string;
}

export interface WindowedFileSeparatorRow {
  kind: 'separator';
  /** Stable fold id used to route expansion clicks. */
  id: string;
  boundary: 'above' | 'below' | 'interior';
  /** Rendered rows still hidden behind this separator (after reveals). */
  collapsedLines: number;
  /** Always false for plain files — every line is unchanged. */
  containsChanges: false;
  canExpandUp: boolean;
  canExpandDown: boolean;
  newLineRange: [number, number] | undefined;
}

export type WindowedFileRow = WindowedFileLineRow | WindowedFileSeparatorRow;

export interface WindowedFileResult {
  rows: WindowedFileRow[];
  appliedWindow: DiffWindow;
  totalCollapsed: number;
}

interface FileFlatRow extends WindowableFlatRow {
  lineNumber: number;
  text: string;
}

/**
 * Turn a plain file (array of lines) into a windowed display model: lines
 * inside `window` are kept; everything outside collapses to an above/below
 * boundary separator; long unchanged runs inside the window collapse to
 * interior separators. Every separator is backed by real lines, so the caller
 * can render it as natively expandable — there is no partial content to
 * reconcile.
 */
export function computeWindowedFileRows({
  lines,
  window,
  reveal = createEmptyReveal(),
}: ComputeWindowedFileRowsProps): WindowedFileResult {
  // Build the flat row list. Plain files have no additions/deletions — every
  // row is an unchanged context line, so `isChange` is always false.
  const flat: FileFlatRow[] = lines.map((text, i) => ({
    lineNumber: i + 1,
    text,
    newLine: i + 1,
    inWindow: false,
    hidden: false,
    isChange: false,
  }));

  const appliedWindow = clampWindow(window, flat);
  const empty = appliedWindow.end < appliedWindow.start;

  // Mark in-window rows.
  if (!empty) {
    for (const entry of flat) {
      entry.inWindow =
        entry.lineNumber >= appliedWindow.start &&
        entry.lineNumber <= appliedWindow.end;
    }
  }

  // File windows always render all in-window lines — interior folds are
  // meaningless for a plain code snippet. Pass Infinity so markBaseHidden
  // never hides any in-window unchanged run.
  markBaseHidden(flat, empty, Infinity);
  const folds = enumerateFolds(flat, WINDOW_ABOVE_ID, WINDOW_BELOW_ID);

  const rows: WindowedFileRow[] = [];
  let totalCollapsed = 0;
  let index = 0;
  let foldCursor = 0;

  while (index < flat.length) {
    const entry = flat[index];
    if (!entry.hidden) {
      rows.push({
        kind: 'line',
        lineNumber: entry.lineNumber,
        text: entry.text,
      });
      index++;
      continue;
    }
    const fold = folds[foldCursor];
    if (fold == null || fold.start !== index) {
      throw new Error('computeWindowedFileRows: fold bookkeeping desync');
    }
    foldCursor++;
    index = fold.end;
    totalCollapsed += emitFileFold(
      flat.slice(fold.start, fold.end),
      fold,
      reveal,
      rows
    );
  }

  return { rows, appliedWindow, totalCollapsed };
}

function emitFileFold(
  run: FileFlatRow[],
  fold: BaseFold,
  reveal: WindowReveal,
  out: WindowedFileRow[]
): number {
  const revealed = reveal.get(fold.id);
  const fromStart = Math.min(Math.max(revealed?.fromStart ?? 0, 0), run.length);
  const fromEnd = Math.min(
    Math.max(revealed?.fromEnd ?? 0, 0),
    run.length - fromStart
  );
  const hiddenCount = run.length - fromStart - fromEnd;

  for (let i = 0; i < fromStart; i++) {
    out.push({
      kind: 'line',
      lineNumber: run[i].lineNumber,
      text: run[i].text,
    });
  }
  if (hiddenCount > 0) {
    const hiddenRun = run.slice(fromStart, run.length - fromEnd);
    out.push({
      kind: 'separator',
      id: fold.id,
      boundary: fold.boundary,
      collapsedLines: hiddenCount,
      containsChanges: false,
      canExpandUp: true,
      canExpandDown: true,
      newLineRange: newLineRange(hiddenRun),
    });
  }
  for (let i = run.length - fromEnd; i < run.length; i++) {
    out.push({
      kind: 'line',
      lineNumber: run[i].lineNumber,
      text: run[i].text,
    });
  }
  return hiddenCount;
}

/**
 * Convert a `WindowedFileSeparatorRow` to the public `WindowFold` shape that
 * host hooks (`onWindowExpand`, `renderWindowSeparator`) receive.
 */
export function fileSeparatorToFold(sep: WindowedFileSeparatorRow): WindowFold {
  return {
    foldId: sep.id,
    boundary: sep.boundary,
    collapsedLines: sep.collapsedLines,
    containsChanges: sep.containsChanges,
    newLineRange: sep.newLineRange,
    expandable: { up: sep.canExpandUp, down: sep.canExpandDown },
  };
}
