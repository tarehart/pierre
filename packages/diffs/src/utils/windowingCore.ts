import type { ExpansionDirections } from '../types';

/**
 * Shared pure utilities for the windowed-diff and windowed-file engines.
 * Both engines operate on a flat array of rows that share this minimal shape;
 * the concrete row types (diff vs file) extend it with their own payload.
 */

export interface WindowableFlatRow {
  /** 1-based new-file line number for this row, undefined for diff-only rows. */
  newLine: number | undefined;
  /** Whether the row is inside the active window. */
  inWindow: boolean;
  /** Whether the row is hidden behind a fold in the base (reveal-free) layout. */
  hidden: boolean;
  /**
   * Whether this row represents a real change (addition or deletion). Always
   * false for plain-file rows where every line is "unchanged".
   */
  isChange: boolean;
}

/** A folded run of consecutive hidden rows. */
interface BaseFold {
  id: string;
  boundary: 'above' | 'below' | 'interior';
  /** Inclusive start index into the flat array. */
  start: number;
  /** Exclusive end index into the flat array. */
  end: number;
}

/** Stable identity for the above/below boundary folds, shared by both windowing engines. */
export const WINDOW_ABOVE_ID = 'window:above';
export const WINDOW_BELOW_ID = 'window:below';

/**
 * Clamp the requested window to the file's real new-line extent.
 * Returns an empty range (`end < start`) when nothing maps inside.
 */
export function clampWindow(
  window: { start: number; end: number },
  flat: readonly WindowableFlatRow[]
): { start: number; end: number } {
  let maxNewLine = 0;
  for (const entry of flat) {
    if (entry.newLine != null && entry.newLine > maxNewLine) {
      maxNewLine = entry.newLine;
    }
  }
  const start = Math.max(1, Math.floor(window.start));
  const end = Math.min(maxNewLine, Math.floor(window.end));
  if (end < start) {
    return { start: 1, end: 0 };
  }
  return { start, end };
}

/**
 * Set `hidden` on every flat row for the reveal-free base layout.
 *
 * Out-of-window rows are hidden (the above/below boundary folds). A change
 * that crosses the window edge is cut there: its rows keep per-line
 * membership (see computeWindowedDiffRows), so in unified a fold can sit
 * inside such a change. Inside the window, change rows are always visible,
 * and only an unchanged run between two changes folds: it keeps
 * `contextLines` visible at each end and folds its middle into an interior
 * separator, like a conventional diff's `-U<n>` (it shows in full when its
 * length is `<= 2 * contextLines`). A run that touches the window's first or
 * last line never folds, so every line between a window edge and the nearest
 * change shows (and a plain file, which has no changes, never folds inside
 * the window). A deletion-only block at the very edge of the window does not
 * count as a change that bounds a run.
 */
function markBaseHidden(flat: WindowableFlatRow[], contextLines: number): void {
  let i = 0;
  while (i < flat.length) {
    const entry = flat[i];
    if (!entry.inWindow) {
      entry.hidden = true;
      i++;
      continue;
    }
    if (entry.isChange) {
      entry.hidden = false;
      i++;
      continue;
    }
    // Scan the maximal in-window unchanged run [i, j). Because the run is
    // maximal, the row before i (or at j) is either an in-window change or
    // lies outside the window (or past the file's start or end). Only a run
    // with an in-window change on both sides may fold its middle.
    let j = i;
    while (j < flat.length && flat[j].inWindow && !flat[j].isChange) j++;
    const betweenChanges = boundsRun(flat, i - 1, -1) && boundsRun(flat, j, 1);
    for (let k = i; k < j; k++) {
      const fromStart = k - i;
      const fromEnd = j - 1 - k;
      flat[k].hidden =
        betweenChanges && fromStart >= contextLines && fromEnd >= contextLines;
    }
    i = j;
  }
}

// True when the change block that starts at `from` (walking by `step`) bounds
// an unchanged run. The whole block counts, including rows outside the window:
// a change cut at the window edge still bounds the run beside it when any of
// its new lines is in the window. A block whose in-window rows are only
// removed lines (a pure deletion just past the last line) bounds the run only
// when the window continues beyond it.
function boundsRun(
  flat: readonly WindowableFlatRow[],
  from: number,
  step: -1 | 1
): boolean {
  let k = from;
  let anyInWindow = false;
  for (; k >= 0 && k < flat.length && flat[k].isChange; k += step) {
    const entry = flat[k];
    if (entry.inWindow && entry.newLine != null) {
      return true;
    }
    anyInWindow ||= entry.inWindow;
  }
  return anyInWindow && k >= 0 && k < flat.length && flat[k].inWindow;
}

/**
 * Group maximal contiguous hidden runs into `BaseFold` descriptors. A run is
 * cut at every visible row AND at the window boundary, so the above/below
 * boundary fold never merges with an in-window interior fold. Each side has at
 * most one boundary fold (the outermost); fold ids are unique and stable
 * across reveals.
 */
function enumerateFolds(flat: readonly WindowableFlatRow[]): BaseFold[] {
  const folds: BaseFold[] = [];
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
      index++;
      continue;
    }
    const start = index;
    const startInWindow = flat[start].inWindow;
    while (
      index < flat.length &&
      flat[index].hidden &&
      flat[index].inWindow === startInWindow
    )
      index++;
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
  // An out-of-window fold that sits between two in-window rows is the part
  // of a change cut at the window edge (unified lists a modification's
  // removed lines before its new lines); it is an interior fold with its own
  // `window:edge` id.
  let lastInWindow = -1;
  for (let i = flat.length - 1; i >= firstInWindow; i--) {
    if (flat[i].inWindow) {
      lastInWindow = i;
      break;
    }
  }
  let edgeCount = 0;
  for (const fold of folds) {
    if (
      fold.boundary !== 'interior' &&
      fold.start > firstInWindow &&
      fold.end <= lastInWindow
    ) {
      fold.boundary = 'interior';
      fold.id = `window:edge:${edgeCount++}`;
    }
  }
  return folds;
}

/** The contiguous new-side extent of a run, or undefined if it has none. */
function newLineRange(
  run: readonly WindowableFlatRow[]
): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const entry of run) {
    if (entry.newLine == null) continue;
    if (entry.newLine < min) min = entry.newLine;
    if (entry.newLine > max) max = entry.newLine;
  }
  return max >= min ? [min, max] : undefined;
}

/**
 * New-side line range of interest, one-based and inclusive on both ends.
 * `start`/`end` address lines in the *new* file (the side authors reason
 * about). A range that starts past the end of the file, or whose `end`
 * precedes its `start`, selects nothing and collapses the whole diff.
 *
 * Shared by both windowing engines: a windowed file has no "new" side of its
 * own, but reuses this same range shape to select the line range of interest.
 */
export interface DiffWindow {
  start: number;
  end: number;
}

/** How many lines a reader has peeled off a fold's top and bottom edges. */
export interface FoldReveal {
  fromStart: number;
  fromEnd: number;
}

/**
 * Reader-driven reveals accumulated from separator clicks, keyed by fold id
 * (an engine's above/below boundary ids, `interior:<ordinal>`, or
 * `window:edge:<ordinal>` for the part of a change cut at the
 * window edge; ordinals run in document order over the reveal-free base
 * layout so ids stay stable as folds shrink). Every fold peels the same way as a normal collapsed region:
 * `fromStart` shows lines at the top edge, `fromEnd` at the bottom edge, and
 * revealed lines render as expanded context that is never re-folded.
 */
export type WindowReveal = Map<string, FoldReveal>;

export function createEmptyReveal(): WindowReveal {
  return new Map();
}

/**
 * The public, render-agnostic view of a folded run of hidden rows, shared by
 * both windowing engines' host-facing hooks (`renderWindowSeparator`,
 * `onWindowExpand`, both boundary-only). The host decides how to draw a
 * boundary fold and what its expander click does. Only relevant when content
 * is rendered with a `window`.
 */
export interface WindowFold {
  /** Stable fold id, also the routing key for reveals. */
  foldId: string;
  /**
   * Where the fold sits relative to the window. Only `above`/`below` boundary
   * folds can reach a neighbouring snippet (nothing is shown beyond them), so
   * only they reach `onWindowExpand` and `renderWindowSeparator`. `interior`
   * folds sit between shown rows and always expand in place: inside the
   * window, or the part of a change cut at the window edge
   * (`window:edge:<n>`), which hides changes.
   */
  boundary: 'above' | 'below' | 'interior';
  /** Rendered rows currently hidden behind the fold. */
  collapsedLines: number;
  /** True when the hidden run still contains a real change (ground truth). */
  containsChanges: boolean;
  /** One-based new-file range `[start, end]` the fold hides, if contiguous. */
  newLineRange: [number, number] | undefined;
}

/** A fold in an engine's display model: rows it hides, after reveals. */
export interface WindowSeparatorRow extends WindowFold {
  kind: 'separator';
}

/** The host-facing `WindowFold` of a separator row. */
export function toWindowFold({
  kind: _kind,
  ...fold
}: WindowSeparatorRow): WindowFold {
  return fold;
}

/**
 * Shared tail of both windowing engines. Given flat rows whose `inWindow` is
 * already set, decide the base layout (markBaseHidden), group hidden runs
 * into folds (enumerateFolds), then peel each fold by its reveal: `fromStart`
 * rows at its top and `fromEnd` at its bottom render as expanded context,
 * never re-folded, and whatever remains is one separator. `toLine` maps a
 * shown flat row to the engine's line row.
 */
export function layoutWindowRows<Row extends WindowableFlatRow, Line>(
  flat: Row[],
  contextLines: number,
  reveal: WindowReveal,
  toLine: (row: Row) => Line
): (Line | WindowSeparatorRow)[] {
  markBaseHidden(flat, contextLines);
  const out: (Line | WindowSeparatorRow)[] = [];
  let index = 0;
  for (const fold of enumerateFolds(flat)) {
    for (; index < fold.start; index++) out.push(toLine(flat[index]));
    const run = flat.slice(fold.start, fold.end);
    const revealed = reveal.get(fold.id);
    const fromStart = clamp(revealed?.fromStart ?? 0, run.length);
    const fromEnd = clamp(revealed?.fromEnd ?? 0, run.length - fromStart);
    const hiddenRun = run.slice(fromStart, run.length - fromEnd);
    for (const row of run.slice(0, fromStart)) out.push(toLine(row));
    if (hiddenRun.length > 0) {
      out.push({
        kind: 'separator',
        foldId: fold.id,
        boundary: fold.boundary,
        collapsedLines: hiddenRun.length,
        containsChanges: hiddenRun.some((row) => row.isChange),
        newLineRange: newLineRange(hiddenRun),
      });
    }
    for (const row of run.slice(run.length - fromEnd)) out.push(toLine(row));
    index = fold.end;
  }
  for (; index < flat.length; index++) out.push(toLine(flat[index]));
  return out;
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

/**
 * Grow a fold's reveal by `lineCount` lines after an expander click. A
 * boundary fold only opens toward the window (the above fold from its bottom
 * edge, the below fold from its top edge), whatever direction the click
 * reports, so it never shows lines detached from the window; an interior fold
 * peels the way the click says (`both` peels both edges).
 */
export function growWindowReveal(
  reveal: WindowReveal,
  fold: WindowFold,
  direction: ExpansionDirections,
  lineCount: number
): void {
  const region = reveal.get(fold.foldId) ?? { fromStart: 0, fromEnd: 0 };
  const towardStart =
    fold.boundary === 'interior'
      ? direction !== 'down'
      : fold.boundary === 'below';
  const towardEnd =
    fold.boundary === 'interior'
      ? direction !== 'up'
      : fold.boundary === 'above';
  if (towardStart) region.fromStart += lineCount;
  if (towardEnd) region.fromEnd += lineCount;
  reveal.set(fold.foldId, region);
}

/**
 * Whether two folds would render the same separator. A fold can change (e.g.
 * `containsChanges` under a new diff) while its slot stays the same, so a
 * host's separator element is rebuilt when this is false.
 */
export function areWindowFoldsEqual(
  a: WindowFold | undefined,
  b: WindowFold | undefined
): boolean {
  if (a == null || b == null) {
    return a === b;
  }
  return (
    a.foldId === b.foldId &&
    a.boundary === b.boundary &&
    a.collapsedLines === b.collapsedLines &&
    a.containsChanges === b.containsChanges &&
    a.newLineRange?.[0] === b.newLineRange?.[0] &&
    a.newLineRange?.[1] === b.newLineRange?.[1]
  );
}
