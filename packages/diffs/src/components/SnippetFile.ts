import { DEFAULT_THEMES } from '../constants';
import type { Editor } from '../editor/editor';
import { pluckInteractionOptions } from '../managers/InteractionManager';
import type { FileRenderer } from '../renderers/FileRenderer';
import { SnippetFileRenderer } from '../renderers/SnippetFileRenderer';
import type {
  ExpansionDirections,
  LineAnnotation,
  PostRenderPhase,
} from '../types';
import {
  assertLineCount,
  assertSnippetFileOptions,
  type LineRange,
  type SnippetFold,
  toSnippetFold,
} from '../utils/snippetLayout';
import type { WorkerPoolManager } from '../worker';
import { File, type FileOptions } from './File';

/**
 * Experimental: this API may change in a minor release.
 * @experimental
 */
export interface SnippetFileOptions<LAnnotation> extends Omit<
  FileOptions<LAnnotation, undefined>,
  'onPostRender' | 'onEditChange' | 'onEditComplete'
> {
  /**
   * The lines to show. File-level annotations (line 0) render only while
   * line 1 is shown.
   */
  lineRange: LineRange;
  /** Lines one click on a fold opens. Default 100, as in FileDiff. */
  expansionLineCount?: number;
  /**
   * Called when a reader clicks the fold above or below `lineRange`, before
   * it opens. Return true to handle the click yourself and keep it closed.
   *
   * Experimental: this API may change in a minor release.
   * @experimental
   */
  onSnippetExpand?(fold: SnippetFold, lineCount: number): boolean | void;
  onPostRender?(
    node: HTMLElement,
    instance: SnippetFile<LAnnotation>,
    phase: PostRenderPhase
  ): unknown;
}

let instanceId = -1;

/**
 * A read-only File that shows only `lineRange`, with folds above and below
 * that open in place.
 *
 * Experimental: this API may change in a minor release.
 * @experimental
 */
export class SnippetFile<LAnnotation = undefined> extends File<
  LAnnotation,
  undefined
> {
  override readonly __id: string = `snippet-file:${++instanceId}`;
  declare public options: SnippetFileOptions<LAnnotation>;

  constructor(
    options: SnippetFileOptions<LAnnotation>,
    workerManager?: WorkerPoolManager | undefined,
    requestOwnerRender?: () => void
  ) {
    assertSnippetFileOptions('SnippetFile', options);
    super(
      { theme: DEFAULT_THEMES, ...options },
      workerManager,
      requestOwnerRender
    );
    this.snippetRenderer.setSnippet(options);
    this.syncInteractionOptions();
  }

  private get snippetRenderer(): SnippetFileRenderer<LAnnotation> {
    return this.fileRenderer as SnippetFileRenderer<LAnnotation>;
  }

  override setOptions(
    options: SnippetFileOptions<LAnnotation> | undefined
  ): void {
    if (options == null) return;
    assertSnippetFileOptions('SnippetFile', options);
    const { lineRange } = this.options;
    if (
      lineRange.start !== options.lineRange.start ||
      lineRange.end !== options.lineRange.end
    ) {
      this.forceRenderOverride = true;
    }
    this.snippetRenderer.setSnippet(options);
    super.setOptions(options);
  }

  /**
   * Opens the fold above or below the line range by `lineCount` lines
   * (default `expansionLineCount`; Infinity opens it all), in place. Does not
   * call `onSnippetExpand`. Returns false when there is no fold on that side.
   *
   * Experimental: this API may change in a minor release.
   * @experimental
   */
  public expandSnippet(
    boundary: 'above' | 'below',
    lineCount?: number
  ): boolean {
    assertLineCount('SnippetFile.expandSnippet', 'lineCount', lineCount, 1);
    const file = this.getRenderedFile() ?? this.getInputFile();
    const fold =
      file != null
        ? this.snippetRenderer.getBoundaryFold(file, boundary)
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
   * Opens the fold that hides `lineNumber` just far enough to show it.
   * Returns false when the line is already shown or does not exist.
   *
   * Experimental: this API may change in a minor release.
   * @experimental
   */
  public revealLine(lineNumber: number): boolean {
    const file = this.getRenderedFile();
    if (file == null || !this.snippetRenderer.revealLine(file, lineNumber)) {
      return false;
    }
    this.rerender();
    return true;
  }

  /** Snippets are read-only: an editor never attaches. */
  override __attachEditor(
    _editor: Editor<'file', LAnnotation, undefined>
  ): () => void {
    throw new Error('SnippetFile: snippets are read-only and cannot be edited');
  }

  protected override createFileRenderer(
    options: FileOptions<LAnnotation, undefined>,
    annotationSlotName: (annotation: LineAnnotation<LAnnotation>) => string,
    onRenderUpdate: () => unknown,
    workerManager: WorkerPoolManager | undefined
  ): FileRenderer<LAnnotation> {
    return new SnippetFileRenderer<LAnnotation>(
      options,
      annotationSlotName,
      onRenderUpdate,
      workerManager
    );
  }

  protected override syncInteractionOptions(): void {
    // The base constructor builds its interaction options before this
    // class's fields exist; the constructor syncs again afterwards.
    if (this.handleFoldClick == null) return;
    this.interactionManager.setOptions(
      pluckInteractionOptions(this.options, this.handleFoldClick)
    );
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
      this.options.onSnippetExpand?.(toSnippetFold(fold), lineCount) === true
    ) {
      return;
    }
    this.snippetRenderer.revealFold(fold, direction, lineCount);
    this.rerender();
  };
}
