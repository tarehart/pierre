import { DEFAULT_WINDOW_CONTEXT_LINES } from '../constants';
import type { FileDiffMetadata } from '../types';
import { type DiffLineCallbackProps, iterateOverDiff } from './iterateOverDiff';
import {
  clampWindow,
  createEmptyReveal,
  type DiffWindow,
  layoutWindowRows,
  type WindowableFlatRow,
  type WindowReveal,
  type WindowSeparatorRow,
} from './windowingCore';

export interface ComputeWindowedDiffRowsProps {
  diff: FileDiffMetadata;
  window: DiffWindow;
  /**
   * Row space to flatten into. `'unified'` (default) emits a paired change as
   * two rows (deletion then addition); `'split'` emits it as one row carrying
   * both sides. Windowing is otherwise identical: the folds are the same
   * new-line ranges, just cut over a different row stream.
   */
  diffStyle?: 'unified' | 'split';
  /**
   * Unchanged context lines kept on each side of a change *inside* the window,
   * like a conventional diff's `-U<n>`. An unchanged run between two changes
   * shows in full when its length is `<= 2 * contextLines`; a longer run keeps
   * `contextLines` at each edge and folds only the middle into an interior
   * separator. A run that touches a window edge never folds (see
   * markBaseHidden). Defaults to `DEFAULT_WINDOW_CONTEXT_LINES`.
   */
  contextLines?: number;
  /** Reader-driven reveals accumulated from separator clicks. */
  reveal?: WindowReveal;
}

/** A single new-file diff line kept for display, with its provenance. */
export interface WindowedDiffLineRow {
  kind: 'line';
  row: DiffLineCallbackProps;
  /**
   * One-based new-file line number for this row, or `undefined` for a pure
   * deletion row (which has no new-side line). Used to place the row relative
   * to the window.
   */
  newLine: number | undefined;
  /** One-based old-file line number, or `undefined` for a pure addition. */
  oldLine: number | undefined;
}

export type WindowedDiffRow = WindowedDiffLineRow | WindowSeparatorRow;

export interface WindowedDiffResult {
  /** The display rows in order: kept lines interleaved with fold separators. */
  rows: WindowedDiffRow[];
}

interface FlatRow extends WindowableFlatRow {
  row: DiffLineCallbackProps;
  oldLine: number | undefined;
  /**
   * Removed rows of a modification only: the new line this removed line
   * pairs with (see getModificationPairs).
   */
  pairNewLine?: number;
}

/**
 * Turn a full non-partial diff into a windowed display model: rows inside
 * `window` are kept; everything outside collapses to an above/below boundary
 * separator; long unchanged runs inside the window collapse to interior
 * separators. Every separator is backed by real diff rows, so the caller can
 * render it as natively expandable — there is no partial patch to reconcile.
 *
 * This is a pure transform over the row stream `iterateOverDiff` already
 * produces for a fully expanded diff, so it inherits that function's line
 * bookkeeping instead of recomputing hunk geometry.
 */
export function computeWindowedDiffRows({
  diff,
  window,
  diffStyle = 'unified',
  contextLines = DEFAULT_WINDOW_CONTEXT_LINES,
  reveal = createEmptyReveal(),
}: ComputeWindowedDiffRowsProps): WindowedDiffResult {
  if (diff.isPartial) {
    throw new Error(
      'computeWindowedDiffRows: windowing requires a non-partial diff ' +
        '(both file blobs). A partial patch-parsed diff cannot be windowed ' +
        'because it does not know what lies outside its hunks.'
    );
  }

  // 1. Flatten the fully-expanded diff into a flat, in-order row list. With
  //    `expandedHunks: true` the iterator emits every line of the file exactly
  //    once, in order, with correct line numbers on each side. In split style a
  //    paired change is one row (both sides); in unified it is two rows.
  const newForOld = getModificationPairs(diff);
  const flat: FlatRow[] = [];
  iterateOverDiff({
    diff,
    diffStyle,
    expandedHunks: true,
    callback: (row) => {
      const newLine = row.additionLine?.lineNumber;
      const oldLine = row.deletionLine?.lineNumber;
      const isChange = row.type === 'change';
      const pairNewLine =
        isChange && newLine == null && oldLine != null
          ? newForOld.get(oldLine)
          : undefined;
      flat.push({
        row,
        newLine,
        oldLine,
        isChange,
        inWindow: false,
        hidden: false,
        pairNewLine,
      });
    },
  });

  const appliedWindow = clampWindow(window, flat);

  // 2. Mark in-window rows. A row with a new-side line is in-window when that
  //    line is within range, so a change crossing the window edge is cut
  //    there. A removed line joins the window with the new line it pairs with,
  //    and a pure deletion rides along with an adjacent in-window line (see
  //    settleChangeBlockMembership). An empty window leaves every row out.
  for (const entry of flat) {
    if (entry.newLine != null) {
      entry.inWindow =
        entry.newLine >= appliedWindow.start &&
        entry.newLine <= appliedWindow.end;
    }
  }
  settleChangeBlockMembership(flat, appliedWindow);

  // 3. Fold and peel by reveals (layoutWindowRows). Fold ids come from the
  //    reveal-free base layout, so they stay stable as the reader reveals
  //    lines, which is what lets expansion clicks route back to the right fold
  //    across re-renders.
  return {
    rows: layoutWindowRows(flat, contextLines, reveal, (entry) => ({
      kind: 'line' as const,
      row: entry.row,
      newLine: entry.newLine,
      oldLine: entry.oldLine,
    })),
  };
}

/**
 * The pairing of removed and new lines inside modifications, taken from the
 * split row model so both styles agree: a split paired row pairs its two
 * lines; an extra removed row pairs with the nearest paired row before it in
 * its change block (else the first one after it, else the nearest new-side
 * row in the block). A block with no new-side row is a pure deletion and has
 * no pairs.
 */
function getModificationPairs(diff: FileDiffMetadata): Map<number, number> {
  const rows: { oldLine?: number; newLine?: number; isChange: boolean }[] = [];
  iterateOverDiff({
    diff,
    diffStyle: 'split',
    expandedHunks: true,
    callback: (row) => {
      rows.push({
        oldLine: row.deletionLine?.lineNumber,
        newLine: row.additionLine?.lineNumber,
        isChange: row.type === 'change',
      });
    },
  });
  const newForOld = new Map<number, number>();
  let i = 0;
  while (i < rows.length) {
    if (!rows[i].isChange) {
      i++;
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end].isChange) end++;
    const paired: number[] = [];
    const newSide: number[] = [];
    for (let k = i; k < end; k++) {
      if (rows[k].newLine != null) {
        newSide.push(k);
        if (rows[k].oldLine != null) paired.push(k);
      }
    }
    for (let k = i; k < end; k++) {
      const { oldLine, newLine } = rows[k];
      if (oldLine == null) continue;
      if (newLine != null) {
        newForOld.set(oldLine, newLine);
        continue;
      }
      const partner =
        paired.findLast((p) => p < k) ??
        paired.find((p) => p > k) ??
        newSide.findLast((p) => p < k) ??
        newSide.find((p) => p > k);
      if (partner != null) {
        newForOld.set(oldLine, rows[partner].newLine!);
      }
    }
    i = end;
  }
  return newForOld;
}

/**
 * Settle window membership of removed lines. New-side rows keep per-line
 * membership, so a change that crosses the window edge is cut there. A
 * removed line in a modification joins the window with the new line it pairs
 * with (see getModificationPairs), the same in both styles. A pure deletion
 * takes the membership of the new-side lines it sits against: in the window
 * when either neighbour is.
 */
function settleChangeBlockMembership(
  flat: FlatRow[],
  window: DiffWindow
): void {
  for (let k = 0; k < flat.length; k++) {
    const entry = flat[k];
    if (!entry.isChange || entry.newLine != null) {
      continue;
    }
    if (entry.pairNewLine != null) {
      // The partner's own membership is exactly this range check.
      entry.inWindow =
        entry.pairNewLine >= window.start && entry.pairNewLine <= window.end;
    } else {
      entry.inWindow =
        hasInWindowNeighbor(flat, k, -1) || hasInWindowNeighbor(flat, k, 1);
    }
  }
}

function hasInWindowNeighbor(
  flat: FlatRow[],
  from: number,
  step: -1 | 1
): boolean {
  for (let i = from + step; i >= 0 && i < flat.length; i += step) {
    const entry = flat[i];
    if (entry.newLine == null) {
      continue;
    }
    return entry.inWindow;
  }
  return false;
}
