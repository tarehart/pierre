import {
  clampWindow,
  createEmptyReveal,
  type DiffWindow,
  layoutWindowRows,
  type WindowableFlatRow,
  type WindowReveal,
  type WindowSeparatorRow,
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

export type WindowedFileRow = WindowedFileLineRow | WindowSeparatorRow;

export interface WindowedFileResult {
  rows: WindowedFileRow[];
}

interface FileFlatRow extends WindowableFlatRow {
  lineNumber: number;
  text: string;
}

/**
 * Turn a plain file (array of lines) into a windowed display model: lines
 * inside `window` are kept; everything outside collapses to an above/below
 * boundary separator. There are no interior folds: a plain file has no
 * changes, so no in-window run is bounded by one (see markBaseHidden). Every
 * separator is backed by real lines, so the caller can render it as natively
 * expandable — there is no partial content to reconcile.
 */
export function computeWindowedFileRows({
  lines,
  window,
  reveal = createEmptyReveal(),
}: ComputeWindowedFileRowsProps): WindowedFileResult {
  const flat: FileFlatRow[] = lines.map((text, i) => ({
    lineNumber: i + 1,
    text,
    newLine: i + 1,
    inWindow: false,
    hidden: false,
    isChange: false,
  }));
  const { start, end } = clampWindow(window, flat);
  for (const entry of flat) {
    entry.inWindow = entry.lineNumber >= start && entry.lineNumber <= end;
  }
  return {
    rows: layoutWindowRows(flat, 0, reveal, ({ lineNumber, text }) => ({
      kind: 'line' as const,
      lineNumber,
      text,
    })),
  };
}
