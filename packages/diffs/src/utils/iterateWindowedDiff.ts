import type { FileDiffMetadata } from '../types';
import {
  computeWindowedDiffRows,
  type DiffWindow,
  type WindowedDiffResult,
  type WindowExpansionBounds,
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
 * index is derived from real hunk numbers that windowing does not have).
 */
export interface WindowSeparatorSpec {
  /** Unique expand index, emitted as `data-expand-index` and used to route clicks. */
  expandIndex: number;
  /** Stable fold id this expand index maps back to. */
  foldId: string;
  /** Rendered rows hidden behind this fold, shown as "N unmodified lines". */
  collapsedLines: number;
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
  collapsedContextThreshold?: number;
  expansionBounds?: WindowExpansionBounds;
  reveal?: WindowReveal;
  callback: DiffLineCallback;
  /**
   * Receives the computed windowed model plus the map from rendered
   * `expandIndex` to the fold's stable id, so an expansion click (which arrives
   * as an `expandIndex`) can be routed to `expandWindowSeparator(foldId)`.
   */
  onModel?: (
    model: WindowedDiffResult,
    expandIndexToFoldId: Map<number, string>
  ) => void;
}

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
 * Unified diff style only. Split windowing would flatten in split row space;
 * the inline narrative snippets this targets are unified.
 */
export function iterateWindowedDiff({
  diff,
  window,
  collapsedContextThreshold,
  expansionBounds,
  reveal,
  callback,
  onModel,
}: IterateWindowedDiffProps): void {
  const model = computeWindowedDiffRows({
    diff,
    window,
    collapsedContextThreshold,
    expansionBounds,
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
  let denseIndex = 0;

  const makeSpec = (
    row: Extract<WindowedDiffResult['rows'][number], { kind: 'separator' }>
  ): WindowSeparatorSpec => {
    const expandIndex = nextExpandIndex++;
    expandIndexToFoldId.set(expandIndex, row.id);
    return {
      expandIndex,
      foldId: row.id,
      collapsedLines: row.collapsedLines,
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
    pending.push({
      props: redensify(row.row, denseIndex),
      before: pendingBefore,
    });
    denseIndex += 1;
    pendingBefore = [];
    // A kept row followed these folds, so they are not the trailing ones.
    trailing = [];
  }

  onModel?.(model, expandIndexToFoldId);

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

// Rewrite a captured row's rendered-row positions to a dense value while
// preserving its content index and gutter line number.
function redensify(
  props: DiffLineCallbackProps,
  denseIndex: number
): DiffLineCallbackProps {
  return {
    ...props,
    deletionLine: densifyLine(props.deletionLine, denseIndex),
    additionLine: densifyLine(props.additionLine, denseIndex),
  } as DiffLineCallbackProps;
}

function densifyLine(
  line: DiffLineMetadata | undefined,
  denseIndex: number
): DiffLineMetadata | undefined {
  if (line == null) {
    return undefined;
  }
  return {
    ...line,
    unifiedLineIndex: denseIndex,
    splitLineIndex: denseIndex,
  };
}
