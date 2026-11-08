import { DEFAULT_THEMES } from '../constants';
import type { Editor } from '../editor/editor';
import { pluckInteractionOptions } from '../managers/InteractionManager';
import {
  SnippetDiffHunksRenderer,
  type SnippetDiffHunksRendererOptions,
} from '../renderers/SnippetDiffHunksRenderer';
import type { ExpansionDirections, PostRenderPhase } from '../types';
import { getDiffHunksRendererOptions } from '../utils/getDiffHunksRendererOptions';
import {
  assertCompleteDiff,
  assertLineCount,
  assertSnippetDiffOptions,
  type LineRange,
  type SnippetFold,
  toSnippetFold,
} from '../utils/snippetLayout';
import type { WorkerPoolManager } from '../worker';
import {
  FileDiff,
  type FileDiffHydrationProps,
  type FileDiffOptions,
  type FileDiffRenderProps,
} from './FileDiff';

/**
 * Experimental: this API may change in a minor release.
 * @experimental
 */
export interface SnippetFileDiffOptions<LAnnotation> extends Omit<
  FileDiffOptions<LAnnotation, undefined>,
  | 'hunkSeparators'
  | 'expandUnchanged'
  | 'loadDiffFiles'
  | 'onPostRender'
  | 'onEditChange'
  | 'onEditComplete'
> {
  /** The new-file lines to show (old-file lines for a deleted file). */
  lineRange: LineRange;
  /**
   * Unchanged lines kept on each side of a change inside `lineRange`; a
   * longer unchanged run between two changes folds its middle. Default 3.
   */
  contextLines?: number;
  /** Fold separator style. Default `'line-info'`. */
  hunkSeparators?: 'line-info' | 'line-info-basic';
  /**
   * Called when a reader clicks the fold above or below `lineRange`, before
   * it opens. `lineCount` is the source lines the click asks for
   * (`expansionLineCount`, or Infinity for expand-all). Return true to handle
   * the click yourself and keep the fold closed.
   *
   * Experimental: this API may change in a minor release.
   * @experimental
   */
  onSnippetExpand?(fold: SnippetFold, lineCount: number): boolean | void;
  onPostRender?(
    node: HTMLElement,
    instance: SnippetFileDiff<LAnnotation>,
    phase: PostRenderPhase
  ): unknown;
}

let instanceId = -1;

/**
 * A read-only FileDiff that shows only `lineRange` of a complete diff. Folds
 * above and below the range open in place; long unchanged runs between
 * changes inside it fold to `contextLines`. Partial (patch-only) diffs are
 * rejected because a snippet needs the lines outside its hunks.
 *
 * Experimental: this API may change in a minor release.
 * @experimental
 */
export class SnippetFileDiff<LAnnotation = undefined> extends FileDiff<
  LAnnotation,
  undefined
> {
  override readonly __id: string = `snippet-file-diff:${++instanceId}`;
  declare public options: SnippetFileDiffOptions<LAnnotation>;

  constructor(
    options: SnippetFileDiffOptions<LAnnotation>,
    workerManager?: WorkerPoolManager | undefined,
    requestOwnerRender?: () => void
  ) {
    assertSnippetDiffOptions('SnippetFileDiff', options);
    super(
      { theme: DEFAULT_THEMES, ...options },
      workerManager,
      requestOwnerRender
    );
    this.syncInteractionOptions();
  }

  private get snippetRenderer(): SnippetDiffHunksRenderer<LAnnotation> {
    return this.hunksRenderer as SnippetDiffHunksRenderer<LAnnotation>;
  }

  override setOptions(
    options: SnippetFileDiffOptions<LAnnotation> | undefined
  ): void {
    if (options == null) return;
    assertSnippetDiffOptions('SnippetFileDiff', options);
    const previous = this.options;
    if (
      previous.lineRange.start !== options.lineRange.start ||
      previous.lineRange.end !== options.lineRange.end ||
      previous.contextLines !== options.contextLines ||
      previous.collapsedContextThreshold !== options.collapsedContextThreshold
    ) {
      this.snippetRenderer.resetReveals();
      this.forceRenderOverride = true;
    }
    super.setOptions(options);
  }

  override render(props: FileDiffRenderProps<LAnnotation> = {}): boolean {
    assertCompleteDiff('SnippetFileDiff', props.fileDiff);
    return super.render(props);
  }

  override hydrate(props: FileDiffHydrationProps<LAnnotation>): void {
    assertCompleteDiff('SnippetFileDiff', props.fileDiff);
    super.hydrate(props);
  }

  /**
   * Opens the fold above or below the line range by `lineCount` source lines
   * (default `expansionLineCount`; Infinity opens it all), in place: nothing
   * re-folds and `lineRange` does not change. Does not call
   * `onSnippetExpand`. Returns false when there is no fold on that side.
   *
   * Experimental: this API may change in a minor release.
   * @experimental
   */
  public expandSnippet(
    boundary: 'above' | 'below',
    lineCount?: number
  ): boolean {
    assertLineCount('SnippetFileDiff.expandSnippet', 'lineCount', lineCount, 1);
    const fileDiff = this.getRenderedDiff() ?? this.fileDiff;
    const fold =
      fileDiff != null
        ? this.snippetRenderer.getBoundaryFold(fileDiff, boundary)
        : undefined;
    if (fold == null) return false;
    this.snippetRenderer.revealFold(
      fold,
      'both',
      lineCount ?? this.snippetRenderer.getExpansionLineCount()
    );
    this.rerender();
    return true;
  }

  /**
   * Opens the fold that hides a new-file line (an old-file line for a
   * deleted file) just far enough to show it. Returns false when the line is
   * already shown or does not exist.
   *
   * Experimental: this API may change in a minor release.
   * @experimental
   */
  override revealLine(lineNumber: number): boolean {
    const fileDiff = this.getRenderedDiff();
    if (
      fileDiff == null ||
      !this.snippetRenderer.revealLine(fileDiff, lineNumber)
    ) {
      return false;
    }
    this.rerender();
    return true;
  }

  /** Whether a new-file line is shown (not hidden behind a fold). */
  override isLineRenderable(lineNumber: number): boolean {
    const fileDiff = this.getRenderedDiff();
    return (
      fileDiff == null || this.snippetRenderer.isLineShown(fileDiff, lineNumber)
    );
  }

  /** The nearest shown new-file line at or beyond `lineNumber`. */
  override getNearestRenderableLine(
    lineNumber: number,
    direction: 'up' | 'down'
  ): number | undefined {
    const fileDiff = this.getRenderedDiff();
    return fileDiff == null
      ? lineNumber
      : this.snippetRenderer.getNearestShownLine(
          fileDiff,
          lineNumber,
          direction
        );
  }

  /**
   * Hunk indexes do not address a snippet's folds, so this throws; use
   * `expandSnippet` or `revealLine`.
   */
  override expandHunk = (
    _hunkIndex: number,
    _direction: ExpansionDirections,
    _expansionLineCountOverride?: number
  ): void => {
    throw new Error(
      'SnippetFileDiff.expandHunk: a snippet has no hunk expansion; use expandSnippet(boundary, lineCount) or revealLine(line)'
    );
  };

  /** Snippets are read-only: there is nothing to prepare for editing. */
  override prepareForEditing(): Promise<void> {
    return Promise.reject(
      new Error('SnippetFileDiff: snippets are read-only and cannot be edited')
    );
  }

  /** Snippets are read-only: an editor never attaches. */
  override __attachEditor(
    _editor: Editor<'file-diff', LAnnotation, undefined>
  ): () => void {
    throw new Error(
      'SnippetFileDiff: snippets are read-only and cannot be edited'
    );
  }

  protected override syncInteractionOptions(): void {
    // The base constructor syncs before this class's fields exist.
    if (this.handleFoldClick == null) return;
    this.interactionManager.setOptions(
      pluckInteractionOptions(
        this.options as FileDiffOptions<LAnnotation, undefined>,
        this.handleFoldClick,
        this.getLineIndex
      )
    );
  }

  protected override createHunksRenderer(
    options: FileDiffOptions<LAnnotation, undefined>
  ): SnippetDiffHunksRenderer<LAnnotation> {
    return new SnippetDiffHunksRenderer<LAnnotation>(
      this.getHunksRendererOptions(options),
      this.getAnnotationSlotName,
      this.handleHighlightRender,
      this.workerManager
    );
  }

  protected override getHunksRendererOptions(
    options: FileDiffOptions<LAnnotation, undefined>
  ): SnippetDiffHunksRendererOptions {
    const { lineRange, contextLines } =
      options as unknown as SnippetFileDiffOptions<LAnnotation>;
    return { ...getDiffHunksRendererOptions(options), lineRange, contextLines };
  }

  // A click on a fold separator: `index` is the fold's `data-expand-index`.
  private handleFoldClick = (
    index: number,
    direction: ExpansionDirections,
    lineCountOverride?: number
  ): void => {
    const fold = this.snippetRenderer.getFoldAt(index);
    if (fold == null) return;
    const lineCount =
      lineCountOverride ?? this.snippetRenderer.getExpansionLineCount();
    if (
      fold.boundary !== 'interior' &&
      this.options.onSnippetExpand?.(toSnippetFold(fold), lineCount) === true
    ) {
      return;
    }
    this.snippetRenderer.revealFold(fold, direction, lineCount);
    this.rerender();
  };
}
