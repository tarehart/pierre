import { DEFAULT_COLLAPSED_CONTEXT_THRESHOLD } from '../constants';
import type { FileDiffMetadata } from '../types';
import { type DiffLineCallbackProps, iterateOverDiff } from './iterateOverDiff';

/**
 * New-side line range of interest, one-based and inclusive on both ends.
 * `start`/`end` address lines in the *new* file (the side authors reason
 * about). A range that starts past the end of the file, or whose `end`
 * precedes its `start`, selects nothing and collapses the whole diff.
 */
export interface DiffWindow {
  start: number;
  end: number;
}

/**
 * Whether expanding a windowed boundary/interior separator may walk past the
 * window edge into the rest of the file (`'file'`) or stops at the window edge
 * (`'window'`). `'file'` is the default: the reader can keep pulling context
 * out of the collapsed regions, exactly like a normal collapsed diff.
 */
export type WindowExpansionBounds = 'file' | 'window';

/** Stable identity for the above/below boundary folds. */
export const WINDOW_ABOVE_ID = 'window:above';
export const WINDOW_BELOW_ID = 'window:below';

/** How many lines a reader has peeled off a fold's top and bottom edges. */
export interface FoldReveal {
  fromStart: number;
  fromEnd: number;
}

/**
 * Reader-driven reveals accumulated from separator clicks, keyed by fold id
 * (`WINDOW_ABOVE_ID`, `WINDOW_BELOW_ID`, or `interior:<ordinal>`, numbered in
 * document order over the reveal-free base layout so ids stay stable as folds
 * shrink). Every fold peels the same way as a normal collapsed region:
 * `fromStart` shows lines at the top edge, `fromEnd` at the bottom edge, and
 * revealed lines render as expanded context that is never re-folded.
 */
export type WindowReveal = Map<string, FoldReveal>;

export function createEmptyReveal(): WindowReveal {
  return new Map();
}

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
   * Long unchanged runs *inside* the window collapse when they exceed this many
   * lines. Runs at or below it stay expanded so a couple of context lines are
   * never hidden behind a separator. Defaults to
   * `DEFAULT_COLLAPSED_CONTEXT_THRESHOLD`.
   */
  collapsedContextThreshold?: number;
  /** Whether separators may expand past the window edge into the file. */
  expansionBounds?: WindowExpansionBounds;
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

/**
 * A collapsed run of rows folded behind a single separator. `boundary`
 * distinguishes the above/below-window folds (which the request lets authors
 * label with prose) from interior folds of long unchanged runs.
 */
export interface WindowedDiffSeparatorRow {
  kind: 'separator';
  /** Stable identity used to route expansion clicks back to this fold. */
  id: string;
  /** Where this fold sits relative to the window. */
  boundary: 'above' | 'below' | 'interior';
  /** Number of rendered rows hidden behind this separator (after reveals). */
  collapsedLines: number;
  /**
   * True when the collapsed run still contains at least one real change
   * (addition or deletion). Pierre knows this because it diffed the whole file,
   * so a boundary separator can honestly say "3 changes above" instead of
   * pretending everything hidden is unchanged. Interior folds are unchanged by
   * construction and are always false.
   */
  containsChanges: boolean;
  /** Whether the reader can expand upward out of this fold. */
  canExpandUp: boolean;
  /** Whether the reader can expand downward out of this fold. */
  canExpandDown: boolean;
  /**
   * One-based new-file line range `[start, end]` (inclusive) that this fold
   * still hides, when it maps to a contiguous new-side range. A fold made
   * entirely of pure deletions has no new-side extent and leaves this
   * `undefined`.
   */
  newLineRange: [number, number] | undefined;
}

export type WindowedDiffRow = WindowedDiffLineRow | WindowedDiffSeparatorRow;

export interface WindowedDiffResult {
  /** The display rows in order: kept lines interleaved with fold separators. */
  rows: WindowedDiffRow[];
  /** The window as applied after clamping to the file's line range. */
  appliedWindow: DiffWindow;
  /** Total rendered rows still hidden across every fold (after reveals). */
  totalCollapsed: number;
}

interface FlatRow {
  row: DiffLineCallbackProps;
  newLine: number | undefined;
  oldLine: number | undefined;
  isChange: boolean;
  inWindow: boolean;
  /** Reveal-free base visibility, set by `markBaseHidden`. */
  hidden: boolean;
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
  collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
  expansionBounds = 'file',
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
  const flat: FlatRow[] = [];
  iterateOverDiff({
    diff,
    diffStyle,
    expandedHunks: true,
    callback: (row) => {
      flat.push({
        row,
        newLine: row.additionLine?.lineNumber,
        oldLine: row.deletionLine?.lineNumber,
        isChange: row.type === 'change',
        inWindow: false,
        hidden: false,
      });
    },
  });

  const appliedWindow = clampWindow(window, flat);
  const empty = appliedWindow.end < appliedWindow.start;

  // 2. Mark in-window rows. A row with a new-side line is in-window when that
  //    line is within range. Pure deletions have no new line; they belong to
  //    the window iff an adjacent kept new-side line does, so they ride along
  //    with the change they are part of.
  if (!empty) {
    for (const entry of flat) {
      if (entry.newLine != null) {
        entry.inWindow =
          entry.newLine >= appliedWindow.start &&
          entry.newLine <= appliedWindow.end;
      }
    }
    attachPureDeletionsToWindow(flat);
  }

  // 3. Decide base visibility (reveal-free), then group maximal contiguous
  //    hidden runs into folds. Grouping the *maximal* run means two folds can
  //    never be adjacent — a fold that starts out of window and continues into
  //    a long in-window unchanged run is one separator, not two touching ones.
  //    Fold ids come from the base layout so they stay stable as the reader
  //    reveals lines (a fold that shrinks or fully opens keeps its id and never
  //    renumbers its neighbours), which is what lets expansion clicks route
  //    back to the right fold across re-renders.
  markBaseHidden(flat, empty, collapsedContextThreshold);
  const folds = enumerateFolds(flat);

  const rows: WindowedDiffRow[] = [];
  let totalCollapsed = 0;
  let index = 0;
  let foldCursor = 0;

  while (index < flat.length) {
    const entry = flat[index];
    if (!entry.hidden) {
      rows.push(toLineRow(entry));
      index += 1;
      continue;
    }
    const fold = folds[foldCursor];
    if (fold == null || fold.start !== index) {
      throw new Error('computeWindowedDiffRows: fold bookkeeping desync');
    }
    foldCursor += 1;
    index = fold.end;
    totalCollapsed += emitFold(flat.slice(fold.start, fold.end), {
      id: fold.id,
      boundary: fold.boundary,
      expansionBounds,
      reveal,
      out: rows,
    });
  }

  return { rows, appliedWindow, totalCollapsed };
}

interface BaseFold {
  id: string;
  boundary: 'above' | 'below' | 'interior';
  /** Inclusive start index into `flat`. */
  start: number;
  /** Exclusive end index into `flat`. */
  end: number;
}

/**
 * Set `hidden` on every flat row for the reveal-free base layout. A row is
 * hidden when it is out of window, or when it is an in-window unchanged line
 * inside a maximal in-window unchanged run longer than the threshold. Change
 * rows and short in-window unchanged runs stay visible.
 */
function markBaseHidden(
  flat: FlatRow[],
  empty: boolean,
  collapsedContextThreshold: number
): void {
  if (empty) {
    for (const entry of flat) {
      entry.hidden = true;
    }
    return;
  }
  let i = 0;
  while (i < flat.length) {
    const entry = flat[i];
    if (!entry.inWindow) {
      entry.hidden = true;
      i += 1;
      continue;
    }
    if (entry.isChange) {
      entry.hidden = false;
      i += 1;
      continue;
    }
    // A maximal run of in-window unchanged rows: fold it only if it exceeds the
    // threshold, so a couple of context lines are never hidden behind a fold.
    let j = i;
    while (j < flat.length && flat[j].inWindow && !flat[j].isChange) {
      j += 1;
    }
    const runLength = j - i;
    const hideRun = runLength > collapsedContextThreshold;
    for (let k = i; k < j; k++) {
      flat[k].hidden = hideRun;
    }
    i = j;
  }
}

/**
 * Cut the base-hidden rows into folds. A cut happens at every visible row and
 * also at each window edge, so the out-of-window boundary fold never merges
 * with an in-window interior fold even when no visible row sits between them —
 * the above/below fold stays a distinct, author-labelable region from the
 * interior context folds. A fold is classified by content: it is `above` when
 * its rows are entirely before the window, `below` when entirely after, and
 * `interior` otherwise. Ids are position-stable across reveals: the leading
 * out-of-window fold is `WINDOW_ABOVE_ID`, the trailing one `WINDOW_BELOW_ID`,
 * and interior folds are numbered in document order.
 */
function enumerateFolds(flat: FlatRow[]): BaseFold[] {
  const folds: BaseFold[] = [];
  // The first in-window row splits out-of-window folds into above vs below.
  // With no in-window rows at all (empty selection) every fold is "above".
  let firstInWindow = flat.length;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].inWindow) {
      firstInWindow = i;
      break;
    }
  }
  let interiorCount = 0;
  let index = 0;
  while (index < flat.length) {
    if (!flat[index].hidden) {
      index += 1;
      continue;
    }
    const start = index;
    // A run extends while rows stay hidden AND stay on the same side of the
    // window edge as the run's first row — crossing the edge starts a new fold
    // so the boundary fold never merges with an interior one.
    const startInWindow = flat[start].inWindow;
    while (
      index < flat.length &&
      flat[index].hidden &&
      flat[index].inWindow === startInWindow
    ) {
      index += 1;
    }
    const end = index;
    const boundary: 'above' | 'below' | 'interior' = startInWindow
      ? 'interior'
      : start < firstInWindow
        ? 'above'
        : 'below';
    const id =
      boundary === 'above'
        ? WINDOW_ABOVE_ID
        : boundary === 'below'
          ? WINDOW_BELOW_ID
          : `interior:${interiorCount++}`;
    folds.push({ id, boundary, start, end });
  }
  return folds;
}

/**
 * Clamp the requested window to the file's real new-line extent. An empty or
 * inverted range, or one that starts past the last line, yields an empty
 * (`end < start`) applied window.
 */
function clampWindow(window: DiffWindow, flat: FlatRow[]): DiffWindow {
  let maxNewLine = 0;
  for (const entry of flat) {
    if (entry.newLine != null && entry.newLine > maxNewLine) {
      maxNewLine = entry.newLine;
    }
  }
  const start = Math.max(1, Math.floor(window.start));
  const end = Math.min(maxNewLine, Math.floor(window.end));
  if (maxNewLine === 0 || end < start || start > maxNewLine) {
    return { start: 1, end: 0 };
  }
  return { start, end };
}

/**
 * Give each pure-deletion row the window membership of the nearest kept new-side
 * line it is adjacent to. Deletions render between the surrounding new lines, so
 * a deletion that sits directly against an in-window addition/context row is
 * itself in-window; one buried in an out-of-window region stays out.
 */
function attachPureDeletionsToWindow(flat: FlatRow[]): void {
  for (let i = 0; i < flat.length; i++) {
    const entry = flat[i];
    if (entry.newLine != null || entry.inWindow) {
      continue;
    }
    if (hasInWindowNeighbor(flat, i, -1) || hasInWindowNeighbor(flat, i, 1)) {
      entry.inWindow = true;
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

interface EmitFoldProps {
  id: string;
  boundary: 'above' | 'below' | 'interior';
  expansionBounds: WindowExpansionBounds;
  reveal: WindowReveal;
  out: WindowedDiffRow[];
}

/**
 * Emit one folded run, applying its reveal: show `fromStart` lines at the top
 * and `fromEnd` at the bottom as expanded context, folding whatever remains in
 * the middle behind a single expandable separator. Revealed lines are never
 * re-folded — this matches how a normal collapsed region peels open. Returns
 * the number of lines still hidden.
 */
function emitFold(
  run: FlatRow[],
  { id, boundary, expansionBounds, reveal, out }: EmitFoldProps
): number {
  const revealed = reveal.get(id);
  const fromStart = Math.min(Math.max(revealed?.fromStart ?? 0, 0), run.length);
  const fromEnd = Math.min(
    Math.max(revealed?.fromEnd ?? 0, 0),
    run.length - fromStart
  );
  const hiddenCount = run.length - fromStart - fromEnd;

  for (let i = 0; i < fromStart; i++) {
    out.push(toLineRow(run[i]));
  }
  if (hiddenCount > 0) {
    const hiddenRun = run.slice(fromStart, run.length - fromEnd);
    // With `expansionBounds: 'window'` a boundary fold only opens toward the
    // window edge (above → down, below → up). Interior folds and the `'file'`
    // mode open both ways.
    const canExpandUp =
      boundary === 'interior' ||
      boundary === 'below' ||
      expansionBounds === 'file';
    const canExpandDown =
      boundary === 'interior' ||
      boundary === 'above' ||
      expansionBounds === 'file';
    out.push({
      kind: 'separator',
      id,
      boundary,
      collapsedLines: hiddenCount,
      containsChanges: hiddenRun.some((entry) => entry.isChange),
      canExpandUp,
      canExpandDown,
      newLineRange: newLineRange(hiddenRun),
    });
  }
  for (let i = run.length - fromEnd; i < run.length; i++) {
    out.push(toLineRow(run[i]));
  }
  return hiddenCount;
}

function toLineRow(entry: FlatRow): WindowedDiffLineRow {
  return {
    kind: 'line',
    row: entry.row,
    newLine: entry.newLine,
    oldLine: entry.oldLine,
  };
}

/** The contiguous new-side extent of a run, or undefined if it has none. */
function newLineRange(run: FlatRow[]): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const entry of run) {
    if (entry.newLine == null) {
      continue;
    }
    if (entry.newLine < min) {
      min = entry.newLine;
    }
    if (entry.newLine > max) {
      max = entry.newLine;
    }
  }
  return max >= min ? [min, max] : undefined;
}
