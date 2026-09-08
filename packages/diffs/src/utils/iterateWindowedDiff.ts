import type { FileDiffMetadata } from '../types';
import {
  computeWindowedDiffRows,
  type DiffWindow,
  type WindowedDiffResult,
  type WindowReveal,
} from './computeWindowedDiffRows';
import type {
  DiffLineCallback,
  DiffLineCallbackProps,
  DiffLineMetadata,
} from './iterateOverDiff';

/**
 * A fold to draw as a separator adjacent to a kept row. The renderer reads this
 * off the row and pushes the separator directly, so windowed separators do not
 * ride the `collapsedBefore`/`collapsedAfter` numeric channel (whose expand
 * index is derived from real hunk numbers that windowing does not have). It also
 * carries the fold's windowing metadata so the renderer can hand a `WindowFold`
 * to a host `renderWindowSeparator` hook.
 */
export interface WindowSeparatorSpec {
  /** Unique expand index, emitted as `data-expand-index` and used to route clicks. */
  expandIndex: number;
  /** Stable fold id this expand index maps back to. */
  foldId: string;
  /** Where this fold sits relative to the window. */
  boundary: 'above' | 'below' | 'interior';
  /** Rendered rows hidden behind this fold, shown as "N unmodified lines". */
  collapsedLines: number;
  /** Whether the hidden run still contains a real change (ground truth). */
  containsChanges: boolean;
  /** One-based new-file range `[start, end]` the fold hides, if contiguous. */
  newLineRange: [number, number] | undefined;
  canExpandUp: boolean;
  canExpandDown: boolean;
  /** Total hidden lines, for chunked-expansion affordance sizing. */
  rangeSize: number;
}

/**
 * Marker fields attached to a callback row carrying the windowed separators (if
 * any) that flank it. The `__window` prefix keeps them invisible to the base
 * render path. `DiffLineCallbackProps` is a union, so this is an intersection
 * rather than an `extends`.
 */
export interface WindowSeparatorMarkers {
  // Folds rendered before this row, in order. More than one occurs when reveals
  // remove every visible row between two folds (e.g. an above fold immediately
  // followed by an interior fold once the context between them is hidden).
  __windowSeparatorsBefore?: WindowSeparatorSpec[];
  __windowSeparatorsAfter?: WindowSeparatorSpec[];
}

export type WindowedDiffLineCallbackProps = DiffLineCallbackProps &
  WindowSeparatorMarkers;

export interface IterateWindowedDiffProps {
  diff: FileDiffMetadata;
  window: DiffWindow;
  diffStyle?: 'unified' | 'split';
  contextLines?: number;
  reveal?: WindowReveal;
  callback: DiffLineCallback;
  /**
   * Receives the computed windowed model plus the map from rendered
   * `expandIndex` to the fold's stable id, so an expansion click (which arrives
   * as an `expandIndex`) can be routed to `expandWindowSeparator(foldId)`. Also
   * receives the densified line-index lookup (see `WindowedLineIndexLookup`)
   * so callers that resolve a source line to a rendered row -- selection,
   * pointer targeting -- can use the same dense coordinates the renderer wrote
   * into the DOM instead of recomputing from the diff's original hunk geometry.
   */
  onModel?: (
    model: WindowedDiffResult,
    expandIndexToFoldId: Map<number, string>,
    lineIndexLookup: WindowedLineIndexLookup
  ) => void;
}

/**
 * Maps a rendered (new-file, one-based) line number and side to the densified
 * `[unifiedLineIndex, splitLineIndex]` pair the renderer actually wrote onto
 * that row's DOM elements. Built from the same redensified rows the callback
 * receives, so a lookup here always agrees with `data-line-index` in the DOM
 * -- unlike walking `fileDiff.hunks`, which only knows the diff's original,
 * non-windowed coordinates.
 */
export type WindowedLineIndexLookup = (
  lineNumber: number,
  side: 'deletions' | 'additions'
) => [number, number] | undefined;

/**
 * Drive the diff render callback from a windowed model instead of a raw
 * full-file walk. Emits only the kept (visible) rows; each fold is attached to
 * an adjacent kept row as a `WindowSeparatorSpec` the renderer draws directly.
 * Because the underlying diff is non-partial, those separators are natively
 * expandable with no hydration.
 *
 * Rendered-row positions (`unifiedLineIndex`/`splitLineIndex`) are re-densified
 * to a contiguous 0-based sequence so folded rows leave no gaps in the rendered
 * grid, while content indices (`lineIndex`) and gutter line numbers keep their
 * original full-file values so each row still resolves to the right source line.
 *
 * Works for both unified and split: the model flattens in the active style, and
 * densification advances the split axis one slot per emitted row while the
 * unified axis advances by the row's unified footprint (2 for a split paired
 * change), keeping both sides' data-line-index keys distinct.
 */
export function iterateWindowedDiff({
  diff,
  window,
  diffStyle = 'unified',
  contextLines,
  reveal,
  callback,
  onModel,
}: IterateWindowedDiffProps): void {
  const model = computeWindowedDiffRows({
    diff,
    window,
    diffStyle,
    contextLines,
    reveal,
  });

  const expandIndexToFoldId = new Map<number, string>();
  let nextExpandIndex = 0;

  // Build the visible-row stream with each fold attached as a spec on the row
  // before it (or after the last row, for a trailing fold).
  interface Pending {
    props: DiffLineCallbackProps;
    before: WindowSeparatorSpec[];
  }
  const pending: Pending[] = [];
  let pendingBefore: WindowSeparatorSpec[] = [];
  // Folds after the last kept row (there can be more than one when a reveal
  // hides the rows between them). Rendered as the trailing separators.
  let trailing: WindowSeparatorSpec[] = [];
  // Dense row positions. `splitLineIndex` advances one per emitted row (the
  // renderer positions split rows on it). `unifiedLineIndex` advances by the
  // row's unified footprint — 2 for a split paired change (which unified would
  // show as two rows), 1 otherwise — so the two sides of a paired change keep
  // distinct `${unifiedLineIndex},${splitLineIndex}` keys and their
  // data-line-index attributes never collide.
  let denseSplit = 0;
  let denseUnified = 0;
  // Densified `[unifiedLineIndex, splitLineIndex]` per rendered (lineNumber,
  // side), keyed by `lineIndexKey`. Populated as each row is redensified so a
  // lookup always matches the row's actual DOM attributes.
  const lineIndexByKey = new Map<string, [number, number]>();

  const makeSpec = (
    row: Extract<WindowedDiffResult['rows'][number], { kind: 'separator' }>
  ): WindowSeparatorSpec => {
    const expandIndex = nextExpandIndex++;
    expandIndexToFoldId.set(expandIndex, row.id);
    return {
      expandIndex,
      foldId: row.id,
      boundary: row.boundary,
      collapsedLines: row.collapsedLines,
      containsChanges: row.containsChanges,
      newLineRange: row.newLineRange,
      canExpandUp: row.canExpandUp,
      canExpandDown: row.canExpandDown,
      rangeSize: row.collapsedLines,
    };
  };

  for (const row of model.rows) {
    if (row.kind === 'separator') {
      const spec = makeSpec(row);
      // Accumulate; whether these lead the next kept row or trail the snippet
      // is decided when the next kept row arrives (or the stream ends).
      pendingBefore.push(spec);
      trailing.push(spec);
      continue;
    }
    // A paired split change carries both sides on one row; its two sides sit at
    // consecutive unified indexes. Every other row is a single unified slot.
    const isPairedChange =
      row.row.type === 'change' &&
      row.row.deletionLine != null &&
      row.row.additionLine != null;
    const densified = redensify(row.row, denseSplit, denseUnified);
    recordLineIndex(lineIndexByKey, densified.deletionLine, 'deletions');
    recordLineIndex(lineIndexByKey, densified.additionLine, 'additions');
    pending.push({
      props: densified,
      before: pendingBefore,
    });
    denseSplit += 1;
    denseUnified += isPairedChange ? 2 : 1;
    pendingBefore = [];
    // A kept row followed these folds, so they are not the trailing ones.
    trailing = [];
  }

  const lineIndexLookup: WindowedLineIndexLookup = (lineNumber, side) =>
    lineIndexByKey.get(lineIndexKey(lineNumber, side));

  onModel?.(model, expandIndexToFoldId, lineIndexLookup);

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    const isLast = i === pending.length - 1;
    // Zero the numeric collapse channel — windowed folds are carried by the
    // marker specs instead — then attach the flanking separators.
    const base: DiffLineCallbackProps = {
      ...entry.props,
      collapsedBefore: 0,
      collapsedAfter: 0,
    };
    const props: WindowedDiffLineCallbackProps = Object.assign(base, {
      __windowSeparatorsBefore:
        entry.before.length > 0 ? entry.before : undefined,
      __windowSeparatorsAfter:
        isLast && trailing.length > 0 ? trailing : undefined,
    });
    if (callback(props) === true) {
      return;
    }
  }

  // A window that collapses to folds with no visible row at all (e.g. an empty
  // selection) still needs its folds rendered. Emit nothing here; callers that
  // support a row-less render handle it, and the SSR/whole-file path shows an
  // empty diff. This matches the pre-existing empty-window behavior.
}

// Stable string key for the lineNumber/side lookup map. A plain tuple can't be
// a Map key by value, so join into a string.
function lineIndexKey(
  lineNumber: number,
  side: 'deletions' | 'additions'
): string {
  return `${lineNumber}:${side}`;
}

// Record a redensified line's dense indexes under its (lineNumber, side) key,
// if that side is present on this row.
function recordLineIndex(
  map: Map<string, [number, number]>,
  line: DiffLineMetadata | undefined,
  side: 'deletions' | 'additions'
): void {
  if (line == null) {
    return;
  }
  map.set(lineIndexKey(line.lineNumber, side), [
    line.unifiedLineIndex,
    line.splitLineIndex,
  ]);
}

// Rewrite a captured row's rendered-row positions to dense values while
// preserving its content index and gutter line number. Both sides share the
// row's dense split slot; the addition side of a paired change takes the next
// dense unified slot so the two sides keep distinct data-line-index keys.
function redensify(
  props: DiffLineCallbackProps,
  denseSplit: number,
  denseUnified: number
): DiffLineCallbackProps {
  const hasBothSides = props.deletionLine != null && props.additionLine != null;
  const additionUnified = hasBothSides ? denseUnified + 1 : denseUnified;
  return {
    ...props,
    deletionLine: densifyLine(props.deletionLine, denseSplit, denseUnified),
    additionLine: densifyLine(props.additionLine, denseSplit, additionUnified),
  } as DiffLineCallbackProps;
}

function densifyLine(
  line: DiffLineMetadata | undefined,
  denseSplit: number,
  denseUnified: number
): DiffLineMetadata | undefined {
  if (line == null) {
    return undefined;
  }
  return {
    ...line,
    unifiedLineIndex: denseUnified,
    splitLineIndex: denseSplit,
  };
}
