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
export interface BaseFold {
  id: string;
  boundary: 'above' | 'below' | 'interior';
  /** Inclusive start index into the flat array. */
  start: number;
  /** Exclusive end index into the flat array. */
  end: number;
}

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
  if (maxNewLine === 0 || end < start || start > maxNewLine) {
    return { start: 1, end: 0 };
  }
  return { start, end };
}

/**
 * Set `hidden` on every flat row for the reveal-free base layout.
 *
 * Out-of-window rows are always hidden (the above/below boundary folds). Inside
 * the window, an unchanged run keeps `contextLines` visible at each end and
 * folds only its middle into an interior separator — mirroring a conventional
 * diff's `-U<n>` context. Change rows are always visible.
 *
 * Only a change anchors context; the window edge does not. A run touching the
 * window edge keeps `contextLines` on its change-facing side only (if any) and
 * shows nothing extra on its window-edge side, because that side was already
 * fully inside the requested range — folding part of it would hide lines the
 * caller explicitly asked to see. A run bounded by changes on both sides shows
 * in full when its length is `<= 2 * contextLines` (the two margins meet); a
 * run bounded by the window edge on both sides (the window contains no
 * changes at all) never folds, since neither side has a change to hug. Pass a
 * non-finite value (e.g. `Infinity`) to disable interior folding entirely and
 * keep every in-window line — the plain-file engine relies on this.
 */
export function markBaseHidden(
  flat: WindowableFlatRow[],
  empty: boolean,
  contextLines: number
): void {
  if (empty) {
    for (const entry of flat) entry.hidden = true;
    return;
  }
  const neverFold = !Number.isFinite(contextLines);
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
    // Scan the maximal in-window unchanged run [i, j). Figure out whether each
    // edge is bounded by a real change (which anchors contextLines of visible
    // context) or by the window edge itself (which anchors nothing extra: the
    // range up to that edge was already requested in full).
    let j = i;
    while (j < flat.length && flat[j].inWindow && !flat[j].isChange) j++;
    const startsAtChange =
      i > 0 && flat[i - 1].inWindow && flat[i - 1].isChange;
    const endsAtChange =
      j < flat.length && flat[j].inWindow && flat[j].isChange;
    // A run with no change on either side (the window contains no changes at
    // all) has nothing to anchor a fold against — the whole range was
    // requested explicitly, so show it in full rather than hiding a middle
    // chunk that borders no change.
    const noAnchor = !startsAtChange && !endsAtChange;
    for (let k = i; k < j; k++) {
      const fromStart = k - i;
      const fromEnd = j - 1 - k;
      const visible =
        neverFold ||
        noAnchor ||
        (startsAtChange && fromStart < contextLines) ||
        (endsAtChange && fromEnd < contextLines);
      flat[k].hidden = !visible;
    }
    i = j;
  }
}

/**
 * Group maximal contiguous hidden runs into `BaseFold` descriptors. A run is
 * cut at every visible row AND at the window boundary, so the above/below
 * boundary fold never merges with an in-window interior fold. Fold ids are
 * stable across reveals.
 */
export function enumerateFolds(
  flat: readonly WindowableFlatRow[],
  aboveId: string,
  belowId: string
): BaseFold[] {
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
        ? aboveId
        : boundary === 'below'
          ? belowId
          : `interior:${interiorCount++}`;
    folds.push({ id, boundary, start, end });
  }
  return folds;
}

/** The contiguous new-side extent of a run, or undefined if it has none. */
export function newLineRange(
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
