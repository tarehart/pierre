import type { Element as HASTElement } from 'hast';

import type { ExpansionDirections, FileDiffMetadata } from '../types';
import { areDiffTargetsEqual } from '../utils/areDiffTargetsEqual';
import { createSeparator } from '../utils/createSeparator';
import type {
  DiffLineCallbackProps,
  IterateOverDiffProps,
} from '../utils/iterateOverDiff';
import {
  DEFAULT_SNIPPET_CONTEXT_LINES,
  getDiffSnippetUnits,
  getSnippetDiffRows,
  growSnippetReveal,
  layoutSnippet,
  type LineRange,
  revealSnippetLine,
  type SnippetLayout,
  type SnippetLayoutFold,
  type SnippetReveals,
  type SnippetUnit,
} from '../utils/snippetLayout';
import {
  DiffHunksRenderer,
  type DiffHunksRendererOptions,
  type InjectedRow,
  type RenderedLineContext,
  type SplitInjectedRowPlacement,
  type UnifiedInjectedRowPlacement,
} from './DiffHunksRenderer';

export interface SnippetDiffHunksRendererOptions extends DiffHunksRendererOptions {
  lineRange: LineRange;
  contextLines?: number;
}

interface FoldsAtRow {
  before: SnippetLayoutFold[];
  after: SnippetLayoutFold[];
}

/**
 * Draws a diff as a snippet: only the rows of a line range and what a reader
 * opened, with fold separators for the rest. It replaces the row walk and
 * places its separators through the injected-row hooks, so the base render
 * pipeline (highlighting, line markup, annotations) is reused unchanged.
 * Internal to SnippetFileDiff and the snippet SSR preload.
 */
export class SnippetDiffHunksRenderer<
  LAnnotation = undefined,
> extends DiffHunksRenderer<LAnnotation> {
  declare public options: SnippetDiffHunksRendererOptions;

  // Reader reveals, keyed by fold id. Cleared for a fresh layout: new
  // layout options (resetReveals) or a diff with different content
  // (computeLayout). An equal diff passed as a new object keeps them.
  private reveals: SnippetReveals = new Map();
  private revealsDiff: FileDiffMetadata | undefined;
  // Fully expanded rows and their units for the last diff, style and range,
  // reused across reveals so a click does not re-walk the whole diff.
  private rowCache:
    | {
        diff: FileDiffMetadata;
        diffStyle: 'unified' | 'split';
        rows: DiffLineCallbackProps[];
        lineRange?: LineRange;
        units?: SnippetUnit[];
      }
    | undefined;
  // The layout the latest render drew; click indexes address its folds.
  private layout: SnippetLayout | undefined;
  // Separators to place around the row the base walk is drawing now.
  private foldsAtRow: FoldsAtRow | undefined;

  /** Forget reader reveals so the next render lays the snippet out afresh. */
  public resetReveals(): void {
    this.reveals = new Map();
  }

  /** The expansion step when `expansionLineCount` is not set. */
  public getExpansionLineCount(): number {
    return this.getOptionsWithDefaults().expansionLineCount;
  }

  // Hydrated markup was laid out by the server; lay out the same diff here
  // so its fold indexes resolve before the first client render.
  override hydrate(diff: FileDiffMetadata | undefined): void {
    super.hydrate(diff);
    if (diff != null) {
      this.layout = this.computeLayout(
        diff,
        this.getOptionsWithDefaults().diffStyle
      );
    }
  }

  /** The fold whose separator carries `data-expand-index={index}`. */
  public getFoldAt(index: number): SnippetLayoutFold | undefined {
    return this.layout?.folds[index];
  }

  /**
   * The boundary fold on `boundary` under the current reveals (laid out now,
   * so calls made before the next render see earlier calls' reveals).
   */
  public getBoundaryFold(
    diff: FileDiffMetadata,
    boundary: 'above' | 'below'
  ): SnippetLayoutFold | undefined {
    return this.computeLayout(
      diff,
      this.getOptionsWithDefaults().diffStyle
    ).folds.find((fold) => fold.boundary === boundary);
  }

  /** Whether a range-numbered line is shown under the current reveals. */
  public isLineShown(diff: FileDiffMetadata, line: number): boolean {
    return getShownLines(
      this.computeLayout(diff, this.getOptionsWithDefaults().diffStyle)
    ).has(line);
  }

  /** The nearest shown line at or beyond `line` in `direction`. */
  public getNearestShownLine(
    diff: FileDiffMetadata,
    line: number,
    direction: 'up' | 'down'
  ): number | undefined {
    const shown = [
      ...getShownLines(
        this.computeLayout(diff, this.getOptionsWithDefaults().diffStyle)
      ),
    ].sort((a, b) => a - b);
    return direction === 'down'
      ? shown.find((candidate) => candidate >= line)
      : shown.findLast((candidate) => candidate <= line);
  }

  /** Grow a fold's reveal; the caller re-renders. */
  public revealFold(
    fold: SnippetLayoutFold,
    direction: ExpansionDirections,
    lines: number
  ): void {
    growSnippetReveal(this.reveals, fold, direction, lines);
  }

  /** Open the fold hiding `line`, if any; the caller re-renders. */
  public revealLine(diff: FileDiffMetadata, line: number): boolean {
    return revealSnippetLine(
      this.computeLayout(diff, this.getOptionsWithDefaults().diffStyle),
      this.reveals,
      line
    );
  }

  protected override iterateDiff({
    diff,
    callback,
    totalLines,
  }: IterateOverDiffProps): void {
    // A collapsed component asks for no rows at all.
    if (totalLines === 0) return;
    const { diffStyle } = this.getOptionsWithDefaults();
    const layout = this.computeLayout(diff, diffStyle);
    this.layout = layout;
    const rows = this.getRows(diff, diffStyle);
    const visibleRows: number[] = [];
    const before = new Map<number, SnippetLayoutFold[]>();
    let pending: SnippetLayoutFold[] = [];
    for (const item of layout.items) {
      if (item.kind === 'fold') {
        pending.push(item.fold);
        continue;
      }
      for (let row = item.rowStart; row < item.rowEnd; row++) {
        if (pending.length > 0) {
          before.set(row, pending);
          pending = [];
        }
        visibleRows.push(row);
      }
    }
    const lastRow = visibleRows.at(-1);
    try {
      for (const row of visibleRows) {
        this.foldsAtRow = {
          before: before.get(row) ?? [],
          after: row === lastRow ? pending : [],
        };
        if (callback(rows[row]) === true) {
          return;
        }
      }
    } finally {
      this.foldsAtRow = undefined;
    }
  }

  protected override getUnifiedInjectedRowsForLine = (
    _context: RenderedLineContext
  ): UnifiedInjectedRowPlacement | undefined => {
    const folds = this.foldsAtRow;
    if (folds == null) return undefined;
    return {
      before: folds.before.map((fold) => this.createFoldRow(fold)),
      after: folds.after.map((fold) => this.createFoldRow(fold)),
    };
  };

  protected override getSplitInjectedRowsForLine = (
    _context: RenderedLineContext
  ): SplitInjectedRowPlacement | undefined => {
    const folds = this.foldsAtRow;
    if (folds == null) return undefined;
    const toRow = (fold: SnippetLayoutFold) => ({
      deletion: this.createFoldRow(fold),
      addition: this.createFoldRow(fold),
    });
    return { before: folds.before.map(toRow), after: folds.after.map(toRow) };
  };

  private createFoldRow(fold: SnippetLayoutFold): InjectedRow {
    const { hunkSeparators, expansionLineCount } =
      this.getOptionsWithDefaults();
    const index = this.layout?.folds.indexOf(fold) ?? -1;
    const create = (): HASTElement => {
      const element = createSeparator({
        type:
          hunkSeparators === 'line-info-basic'
            ? 'line-info-basic'
            : 'line-info',
        content: getSnippetFoldLabel(fold.hiddenLines, fold.containsChanges),
        expandIndex: index,
        chunked: fold.hiddenLines > expansionLineCount,
        isFirstHunk: fold.boundary === 'above',
        isLastHunk: fold.boundary === 'below',
      });
      if (fold.boundary !== 'interior') {
        element.properties['data-snippet-boundary'] = fold.boundary;
      }
      return element;
    };
    return { gutter: create(), content: create() };
  }

  private getRows(
    diff: FileDiffMetadata,
    diffStyle: 'unified' | 'split'
  ): DiffLineCallbackProps[] {
    const cache = this.rowCache;
    // Rows are reused only for the same diff target: equal lines parsed with
    // other options (ignoreWhitespace) can classify changes differently.
    if (
      cache != null &&
      cache.diffStyle === diffStyle &&
      areDiffTargetsEqual(cache.diff, diff)
    ) {
      return cache.rows;
    }
    const rows = getSnippetDiffRows(diff, diffStyle);
    this.rowCache = { diff, diffStyle, rows };
    return rows;
  }

  private getUnits(
    diff: FileDiffMetadata,
    diffStyle: 'unified' | 'split'
  ): SnippetUnit[] {
    const rows = this.getRows(diff, diffStyle);
    const cache = this.rowCache!;
    const { lineRange } = this.options;
    if (
      cache.units == null ||
      cache.lineRange?.start !== lineRange.start ||
      cache.lineRange.end !== lineRange.end
    ) {
      cache.units = getDiffSnippetUnits(diff, rows, lineRange);
      cache.lineRange = { ...lineRange };
    }
    return cache.units;
  }

  private computeLayout(
    diff: FileDiffMetadata,
    diffStyle: 'unified' | 'split'
  ): SnippetLayout {
    const { contextLines = DEFAULT_SNIPPET_CONTEXT_LINES } = this.options;
    if (!isSameDiffContent(this.revealsDiff, diff)) {
      this.reveals = new Map();
    }
    this.revealsDiff = diff;
    return layoutSnippet({
      units: this.getUnits(diff, diffStyle),
      contextLines,
      collapsedContextThreshold:
        this.getOptionsWithDefaults().collapsedContextThreshold,
      reveals: this.reveals,
    });
  }
}

// Whether reader reveals carry over to `next`: the same target (identity or
// cacheKey), or equal lines and hunks passed as a new object (a host
// re-parsing on every render).
function isSameDiffContent(
  previous: FileDiffMetadata | undefined,
  next: FileDiffMetadata
): boolean {
  if (previous == null) return false;
  if (areDiffTargetsEqual(previous, next)) return true;
  return (
    previous.type === next.type &&
    previous.name === next.name &&
    previous.hunks.length === next.hunks.length &&
    previous.hunks.every((hunk, i) => {
      const other = next.hunks[i];
      return (
        hunk.additionStart === other.additionStart &&
        hunk.additionCount === other.additionCount &&
        hunk.deletionStart === other.deletionStart &&
        hunk.deletionCount === other.deletionCount
      );
    }) &&
    areLinesEqual(previous.additionLines, next.additionLines) &&
    areLinesEqual(previous.deletionLines, next.deletionLines)
  );
}

function areLinesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

// Range-numbered lines a layout shows.
function getShownLines(layout: SnippetLayout): Set<number> {
  const hidden = new Set<SnippetUnit>();
  for (const fold of layout.folds) {
    for (let i = fold.unitStart; i < fold.unitEnd; i++) {
      hidden.add(layout.units[i]);
    }
  }
  const shown = new Set<number>();
  for (const unit of layout.units) {
    if (hidden.has(unit) || unit.firstLine == null || unit.lastLine == null) {
      continue;
    }
    for (let line = unit.firstLine; line <= unit.lastLine; line++) {
      shown.add(line);
    }
  }
  return shown;
}

const EN_PLURAL_RULES = new Intl.PluralRules('en-US');

/** The separator label for a fold hiding `lines` source lines. */
export function getSnippetFoldLabel(
  lines: number,
  containsChanges: boolean
): string {
  const noun = EN_PLURAL_RULES.select(lines) === 'one' ? 'line' : 'lines';
  return containsChanges
    ? `${lines} hidden ${noun}, with changes`
    : `${lines} unmodified ${noun}`;
}
