import type { ExpansionDirections, FileDiffMetadata } from '../types';
import { type DiffLineCallbackProps, iterateOverDiff } from './iterateOverDiff';

/**
 * A one-based, inclusive line range. For a diff it addresses new-file lines
 * (old-file lines for a deleted file, which has no new side).
 *
 * Experimental: this API may change in a minor release.
 * @experimental
 */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * A folded run of lines at the edge of a snippet, as handed to
 * `onSnippetExpand`. Counts are source lines: an unchanged line counts once,
 * a removed and an added line count separately, so unified and split agree.
 *
 * Experimental: this API may change in a minor release.
 * @experimental
 */
export interface SnippetFold {
  /** Which side of the snippet's line range the fold sits on. */
  boundary: 'above' | 'below';
  /** Source lines currently hidden behind the fold. */
  hiddenLines: number;
  /** True when the hidden lines include an addition or deletion. */
  containsChanges: boolean;
  /**
   * The lines the fold hides, numbered like the snippet's `lineRange`, or
   * undefined when it hides only removed lines of a changed file.
   */
  lineRange: LineRange | undefined;
}

// Unchanged lines kept on each side of a change inside the range when
// `contextLines` is not set, like `git diff -U3`.
export const DEFAULT_SNIPPET_CONTEXT_LINES = 3;

/**
 * The smallest piece a fold can hide or reveal: one row, or a whole
 * modification (a run of change rows with both removed and added lines),
 * because unified and split order a modification's lines differently and
 * revealing part of one would leave the two styles out of step.
 */
export interface SnippetUnit {
  /** Index of the unit's first row in the row list it was built from. */
  rowStart: number;
  /** Exclusive end row index. */
  rowEnd: number;
  /** Source lines the unit stands for (the same in unified and split). */
  lines: number;
  isChange: boolean;
  /** Smallest and largest range-numbered line in the unit, if it has any. */
  firstLine: number | undefined;
  lastLine: number | undefined;
  /** Whether the unit belongs to the requested range. */
  inRange: boolean;
}

/** How many source lines a reader has opened at a fold's top and bottom. */
export interface SnippetReveal {
  fromStart: number;
  fromEnd: number;
}

/** Reveals keyed by fold id (`above`, `below`, `interior:<n>`). */
export type SnippetReveals = Map<string, SnippetReveal>;

/** A fold in a computed layout, with the bookkeeping renderers need. */
export interface SnippetLayoutFold {
  /** Stable across reveals: `above`, `below`, or `interior:<n>`. */
  id: string;
  boundary: 'above' | 'below' | 'interior';
  hiddenLines: number;
  containsChanges: boolean;
  lineRange: LineRange | undefined;
  /** Hidden units, as a [start, end) index range into the unit list. */
  unitStart: number;
  unitEnd: number;
  /**
   * Source lines already open at the fold's top and bottom. A reveal opens
   * whole units, so this can exceed what was asked for; growing a reveal
   * starts from here.
   */
  openedStart: number;
  openedEnd: number;
}

export type SnippetLayoutItem =
  | { kind: 'rows'; rowStart: number; rowEnd: number }
  | { kind: 'fold'; fold: SnippetLayoutFold };

export interface SnippetLayout {
  units: SnippetUnit[];
  items: SnippetLayoutItem[];
  /** The folds in document order; an item's fold is the same object. */
  folds: SnippetLayoutFold[];
}

interface LayoutSnippetProps {
  units: SnippetUnit[];
  contextLines: number;
  /** Unchanged runs whose middle would hide this many lines or fewer show. */
  collapsedContextThreshold: number;
  reveals: SnippetReveals;
}

/**
 * Lays out a snippet over `units`: the units outside the range fold into an
 * `above` and a `below` fold; inside the range, an unchanged run between two
 * changes keeps `contextLines` at each end and folds its middle. Each fold is
 * then opened by its reveal, never re-folding what a reader opened.
 */
export function layoutSnippet({
  units,
  contextLines,
  collapsedContextThreshold,
  reveals,
}: LayoutSnippetProps): SnippetLayout {
  let first = units.findIndex((unit) => unit.inRange);
  let last = units.findLastIndex((unit) => unit.inRange);
  if (first < 0) {
    // Nothing is numbered like the range (an empty new side): show it all.
    first = 0;
    last = units.length - 1;
  }

  const baseFolds: Omit<
    SnippetLayoutFold,
    keyof FoldSummary | 'openedStart' | 'openedEnd'
  >[] = [];
  if (first > 0) {
    baseFolds.push({
      id: 'above',
      boundary: 'above',
      unitStart: 0,
      unitEnd: first,
    });
  }
  let interior = 0;
  let index = first;
  while (index <= last) {
    if (units[index].isChange) {
      index++;
      continue;
    }
    let end = index;
    while (end <= last && !units[end].isChange) end++;
    const betweenChanges = index > first && end <= last;
    const foldStart = index + contextLines;
    const foldEnd = end - contextLines;
    if (betweenChanges && foldEnd - foldStart > collapsedContextThreshold) {
      baseFolds.push({
        id: `interior:${interior++}`,
        boundary: 'interior',
        unitStart: foldStart,
        unitEnd: foldEnd,
      });
    }
    index = end;
  }
  if (last < units.length - 1) {
    baseFolds.push({
      id: 'below',
      boundary: 'below',
      unitStart: last + 1,
      unitEnd: units.length,
    });
  }

  const items: SnippetLayoutItem[] = [];
  const folds: SnippetLayoutFold[] = [];
  let unitCursor = 0;
  const pushUnits = (end: number) => {
    if (end > unitCursor) {
      items.push({
        kind: 'rows',
        rowStart: units[unitCursor].rowStart,
        rowEnd: units[end - 1].rowEnd,
      });
    }
    unitCursor = Math.max(unitCursor, end);
  };
  for (const base of baseFolds) {
    const reveal = reveals.get(base.id);
    const hiddenStart = peel(
      units,
      base.unitStart,
      base.unitEnd,
      reveal?.fromStart ?? 0,
      1
    );
    const hiddenEnd = peel(
      units,
      hiddenStart,
      base.unitEnd,
      reveal?.fromEnd ?? 0,
      -1
    );
    pushUnits(base.unitStart);
    if (hiddenEnd > hiddenStart) {
      pushUnits(hiddenStart);
      const fold: SnippetLayoutFold = {
        ...base,
        ...summarize(units, hiddenStart, hiddenEnd),
        unitStart: hiddenStart,
        unitEnd: hiddenEnd,
        openedStart: countLines(units, base.unitStart, hiddenStart),
        openedEnd: countLines(units, hiddenEnd, base.unitEnd),
      };
      items.push({ kind: 'fold', fold });
      folds.push(fold);
      unitCursor = hiddenEnd;
    }
    pushUnits(base.unitEnd);
  }
  pushUnits(units.length);
  return { units, items, folds };
}

type FoldSummary = Pick<
  SnippetLayoutFold,
  'hiddenLines' | 'containsChanges' | 'lineRange'
>;

function summarize(
  units: SnippetUnit[],
  start: number,
  end: number
): FoldSummary {
  let hiddenLines = 0;
  let containsChanges = false;
  let min: number | undefined;
  let max: number | undefined;
  for (let i = start; i < end; i++) {
    const unit = units[i];
    hiddenLines += unit.lines;
    containsChanges ||= unit.isChange;
    if (unit.firstLine != null) {
      min = Math.min(min ?? unit.firstLine, unit.firstLine);
    }
    if (unit.lastLine != null) {
      max = Math.max(max ?? unit.lastLine, unit.lastLine);
    }
  }
  return {
    hiddenLines,
    containsChanges,
    lineRange:
      min != null && max != null ? { start: min, end: max } : undefined,
  };
}

// Opens whole units from one end of [start, end) until at least `lines`
// source lines are open. Returns the new start (step 1) or end (step -1) of
// what stays hidden.
function peel(
  units: SnippetUnit[],
  start: number,
  end: number,
  lines: number,
  step: 1 | -1
): number {
  let opened = 0;
  if (step === 1) {
    let i = start;
    while (i < end && opened < lines) opened += units[i++].lines;
    return i;
  }
  let i = end;
  while (i > start && opened < lines) opened += units[--i].lines;
  return i;
}

/**
 * Grows a fold's reveal by `lines` source lines. A boundary fold opens toward
 * the range only (the above fold from its bottom, the below fold from its
 * top) whatever the click direction; an interior fold opens the way the
 * click says, like any collapsed context.
 */
export function growSnippetReveal(
  reveals: SnippetReveals,
  fold: SnippetLayoutFold,
  direction: ExpansionDirections,
  lines: number
): void {
  // Start from what is open, or from what was already asked for when a
  // render has not caught up with an earlier call yet.
  const current = reveals.get(fold.id);
  const reveal = {
    fromStart: Math.max(fold.openedStart, current?.fromStart ?? 0),
    fromEnd: Math.max(fold.openedEnd, current?.fromEnd ?? 0),
  };
  const fromStart =
    fold.boundary === 'interior'
      ? direction !== 'down'
      : fold.boundary === 'below';
  const fromEnd =
    fold.boundary === 'interior'
      ? direction !== 'up'
      : fold.boundary === 'above';
  if (fromStart) reveal.fromStart += lines;
  if (fromEnd) reveal.fromEnd += lines;
  reveals.set(fold.id, reveal);
}

/**
 * Opens the fold that hides `line` (numbered like the range) just far enough
 * to show it, from the fold's nearer edge. Returns false when no fold hides
 * that line.
 */
export function revealSnippetLine(
  layout: SnippetLayout,
  reveals: SnippetReveals,
  line: number
): boolean {
  for (const fold of layout.folds) {
    for (let i = fold.unitStart; i < fold.unitEnd; i++) {
      const unit = layout.units[i];
      if (
        unit.firstLine == null ||
        unit.lastLine == null ||
        line < unit.firstLine ||
        line > unit.lastLine
      ) {
        continue;
      }
      const fromStart = countLines(layout.units, fold.unitStart, i + 1);
      const fromEnd = countLines(layout.units, i, fold.unitEnd);
      const useStart =
        fold.boundary === 'below' ||
        (fold.boundary === 'interior' && fromStart <= fromEnd);
      growSnippetReveal(
        reveals,
        fold,
        useStart ? 'up' : 'down',
        useStart ? fromStart : fromEnd
      );
      return true;
    }
  }
  return false;
}

function countLines(units: SnippetUnit[], start: number, end: number): number {
  let lines = 0;
  for (let i = start; i < end; i++) lines += units[i].lines;
  return lines;
}

/** The host-facing copy of a boundary fold. */
export function toSnippetFold(fold: SnippetLayoutFold): SnippetFold {
  if (fold.boundary === 'interior') {
    throw new Error('toSnippetFold: interior folds are not host-facing');
  }
  return {
    boundary: fold.boundary,
    hiddenLines: fold.hiddenLines,
    containsChanges: fold.containsChanges,
    lineRange: fold.lineRange != null ? { ...fold.lineRange } : undefined,
  };
}

/**
 * Checks a host-supplied range synchronously so a bad value fails where it is
 * passed, not later inside a render.
 */
export function assertLineRange(owner: string, range: unknown): LineRange {
  const value = range as Partial<LineRange> | undefined;
  if (
    value == null ||
    !Number.isInteger(value.start) ||
    !Number.isInteger(value.end) ||
    value.start! < 1 ||
    value.end! < value.start!
  ) {
    throw new RangeError(
      `${owner}: lineRange must be { start, end } with whole numbers and 1 <= start <= end`
    );
  }
  return { start: value.start!, end: value.end! };
}

/** Checks an optional whole-number option (contextLines, expansionLineCount). */
export function assertLineCount(
  owner: string,
  name: string,
  value: number | undefined,
  min: number
): void {
  if (
    value != null &&
    (Number.isNaN(value) ||
      value < min ||
      (Number.isFinite(value) && !Number.isInteger(value)))
  ) {
    throw new RangeError(
      `${owner}: ${name} must be a whole number of at least ${min}, or Infinity`
    );
  }
}

/** Units for a plain file: one per line, in range by line number. */
export function getFileSnippetUnits(
  lineCount: number,
  requested: LineRange
): SnippetUnit[] {
  const range = clampLineRange(requested, lineCount);
  const units: SnippetUnit[] = [];
  for (let i = 0; i < lineCount; i++) {
    const line = i + 1;
    units.push({
      rowStart: i,
      rowEnd: i + 1,
      lines: 1,
      isChange: false,
      firstLine: line,
      lastLine: line,
      inRange: line >= range.start && line <= range.end,
    });
  }
  return units;
}

/** Every row of a fully expanded diff, in render order for `diffStyle`. */
export function getSnippetDiffRows(
  diff: FileDiffMetadata,
  diffStyle: 'unified' | 'split'
): DiffLineCallbackProps[] {
  const rows: DiffLineCallbackProps[] = [];
  iterateOverDiff({
    diff,
    diffStyle,
    expandedHunks: true,
    callback: (row) => {
      rows.push({ ...row, collapsedBefore: 0, collapsedAfter: 0 });
    },
  });
  return rows;
}

/**
 * Groups diff rows into units and marks which belong to `range`. Lines are
 * numbered on the new side, or the old side for a deleted file. A
 * modification is one unit, in range when any of its added lines is. A pure
 * deletion inside a changed file has no new line; it is in range when it
 * sits inside the range or touches one of its edges.
 */
export function getDiffSnippetUnits(
  diff: FileDiffMetadata,
  rows: DiffLineCallbackProps[],
  requested: LineRange
): SnippetUnit[] {
  const useOldSide = diff.type === 'deleted';
  let maxLine = 0;
  for (const row of rows) {
    const line = useOldSide
      ? row.deletionLine?.lineNumber
      : row.additionLine?.lineNumber;
    if (line != null && line > maxLine) maxLine = line;
  }
  const range = clampLineRange(requested, maxLine);
  const units: SnippetUnit[] = [];
  // New line number of the last row seen with one, for placing deletions.
  let lastNewLine = 0;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type !== 'change') {
      const line = useOldSide
        ? row.deletionLine.lineNumber
        : row.additionLine.lineNumber;
      lastNewLine = row.additionLine.lineNumber;
      units.push(lineUnit(i, line, false, range));
      i++;
      continue;
    }
    let end = i;
    let hasDeletion = false;
    let hasAddition = false;
    while (end < rows.length && rows[end].type === 'change') {
      hasDeletion ||= rows[end].deletionLine != null;
      hasAddition ||= rows[end].additionLine != null;
      end++;
    }
    if (hasDeletion && hasAddition && !useOldSide) {
      let lines = 0;
      let firstLine: number | undefined;
      let lastLine: number | undefined;
      for (let k = i; k < end; k++) {
        const { additionLine, deletionLine } = rows[k];
        lines +=
          (additionLine != null ? 1 : 0) + (deletionLine != null ? 1 : 0);
        if (additionLine != null) {
          firstLine ??= additionLine.lineNumber;
          lastLine = additionLine.lineNumber;
        }
      }
      units.push({
        rowStart: i,
        rowEnd: end,
        lines,
        isChange: true,
        firstLine,
        lastLine,
        inRange:
          firstLine != null &&
          lastLine != null &&
          lastLine >= range.start &&
          firstLine <= range.end,
      });
      lastNewLine = lastLine ?? lastNewLine;
    } else {
      for (let k = i; k < end; k++) {
        const { additionLine, deletionLine } = rows[k];
        if (useOldSide) {
          units.push(lineUnit(k, deletionLine!.lineNumber, true, range));
        } else if (additionLine != null) {
          units.push(lineUnit(k, additionLine.lineNumber, true, range));
          lastNewLine = additionLine.lineNumber;
        } else {
          units.push({
            rowStart: k,
            rowEnd: k + 1,
            lines: 1,
            isChange: true,
            firstLine: undefined,
            lastLine: undefined,
            // Between new lines lastNewLine and lastNewLine + 1.
            inRange: lastNewLine >= range.start - 1 && lastNewLine <= range.end,
          });
        }
      }
    }
    i = end;
  }
  return units;
}

// A range past the end of the content addresses its last line, so a snippet
// always shows something when there is something to show.
function clampLineRange(range: LineRange, maxLine: number): LineRange {
  const start = Math.min(range.start, Math.max(maxLine, 1));
  return { start, end: Math.max(Math.min(range.end, maxLine), start) };
}

function lineUnit(
  row: number,
  line: number,
  isChange: boolean,
  range: LineRange
): SnippetUnit {
  return {
    rowStart: row,
    rowEnd: row + 1,
    lines: 1,
    isChange,
    firstLine: line,
    lastLine: line,
    inRange: line >= range.start && line <= range.end,
  };
}

/**
 * Checks snippet diff options synchronously (construction, setOptions, SSR
 * preload) so a bad value fails where it is passed, not inside a render.
 */
export function assertSnippetDiffOptions(
  owner: string,
  options:
    | {
        lineRange?: unknown;
        contextLines?: number;
        expansionLineCount?: number;
        hunkSeparators?: unknown;
        expandUnchanged?: boolean;
      }
    | undefined
): void {
  assertLineRange(owner, options?.lineRange);
  assertLineCount(owner, 'contextLines', options?.contextLines, 0);
  assertLineCount(owner, 'expansionLineCount', options?.expansionLineCount, 1);
  const separators = options?.hunkSeparators;
  if (
    separators != null &&
    separators !== 'line-info' &&
    separators !== 'line-info-basic'
  ) {
    throw new Error(
      `${owner}: hunkSeparators must be 'line-info' or 'line-info-basic' (snippet folds are always expandable); got ${typeof separators === 'string' ? `'${separators}'` : `a ${typeof separators}`}`
    );
  }
  if (options?.expandUnchanged === true) {
    throw new Error(
      `${owner}: expandUnchanged is not supported; widen lineRange to show more`
    );
  }
}

/** Rejects a partial (patch-only) diff before any render work starts. */
export function assertCompleteDiff(
  owner: string,
  fileDiff: FileDiffMetadata | undefined
): void {
  if (fileDiff?.isPartial === true) {
    throw new Error(
      `${owner}: a partial diff (parsed from a patch) cannot be shown as a snippet; pass a diff of both full files, e.g. parseDiffFromFile(oldFile, newFile)`
    );
  }
}

/** Checks snippet file options synchronously (construction, setOptions, SSR). */
export function assertSnippetFileOptions(
  owner: string,
  options: { lineRange?: unknown; expansionLineCount?: number } | undefined
): void {
  assertLineRange(owner, options?.lineRange);
  assertLineCount(owner, 'expansionLineCount', options?.expansionLineCount, 1);
}
