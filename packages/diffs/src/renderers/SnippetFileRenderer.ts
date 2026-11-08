import type { ElementContent } from 'hast';

import { DEFAULT_RENDER_RANGE } from '../constants';
import type { ExpansionDirections, FileContents, RenderRange } from '../types';
import { areFileTargetsEqual } from '../utils/areFileTargetsEqual';
import { createSeparator } from '../utils/createSeparator';
import { DEFAULT_EXPANSION_LINE_COUNT } from '../utils/expansionLineCount';
import {
  getFileSnippetUnits,
  growSnippetReveal,
  layoutSnippet,
  type LineRange,
  revealSnippetLine,
  type SnippetLayout,
  type SnippetLayoutFold,
  type SnippetReveals,
} from '../utils/snippetLayout';
import { FileRenderer, type FileRenderResult } from './FileRenderer';
import { getSnippetFoldLabel } from './SnippetDiffHunksRenderer';

export interface FileSnippetState {
  lineRange: LineRange;
  expansionLineCount?: number;
}

/**
 * Draws a file as a snippet. A file snippet has no interior folds, so what it
 * shows is always one run of lines: it renders that run through the base
 * render range (the same path virtualization uses, so highlighting is done
 * once per file) and adds the above/below fold separators around it.
 * Internal to SnippetFile and the snippet SSR preload.
 */
export class SnippetFileRenderer<
  LAnnotation = undefined,
> extends FileRenderer<LAnnotation> {
  private snippet: FileSnippetState = { lineRange: { start: 1, end: 1 } };
  private reveals: SnippetReveals = new Map();
  private revealsFile: FileContents | undefined;
  private layout: SnippetLayout | undefined;

  /** Set the range and step; a new range forgets reader reveals. */
  public setSnippet(snippet: FileSnippetState): void {
    const { lineRange } = this.snippet;
    if (
      lineRange.start !== snippet.lineRange.start ||
      lineRange.end !== snippet.lineRange.end
    ) {
      this.reveals = new Map();
    }
    this.snippet = snippet;
  }

  public getExpansionLineCount(): number {
    return this.snippet.expansionLineCount ?? DEFAULT_EXPANSION_LINE_COUNT;
  }

  // Hydrated markup was laid out by the server; lay out the same file here
  // so its fold indexes resolve before the first client render.
  override hydrate(file: FileContents): void {
    super.hydrate(file);
    this.computeLayout(file);
  }

  public getFoldAt(index: number): SnippetLayoutFold | undefined {
    return this.layout?.folds[index];
  }

  // Laid out now so calls made before the next render see earlier reveals.
  public getBoundaryFold(
    file: FileContents,
    boundary: 'above' | 'below'
  ): SnippetLayoutFold | undefined {
    const { layout } = this;
    const fold = this.computeLayout(file).folds.find(
      (candidate) => candidate.boundary === boundary
    );
    // Clicks address the rendered layout; keep it until the next render.
    this.layout = layout ?? this.layout;
    return fold;
  }

  public revealFold(
    fold: SnippetLayoutFold,
    direction: ExpansionDirections,
    lines: number
  ): void {
    growSnippetReveal(this.reveals, fold, direction, lines);
  }

  public revealLine(file: FileContents, line: number): boolean {
    // Clicks address the rendered layout; keep it until the next render.
    const { layout } = this;
    const revealed = revealSnippetLine(
      this.computeLayout(file),
      this.reveals,
      line
    );
    this.layout = layout ?? this.layout;
    return revealed;
  }

  override renderFile(
    file: FileContents | undefined = this.fileCache,
    renderRange: RenderRange = DEFAULT_RENDER_RANGE
  ): FileRenderResult | undefined {
    if (file == null || renderRange.totalLines === 0) {
      return super.renderFile(file, renderRange);
    }
    const layout = this.computeLayout(file);
    const result = super.renderFile(file, getVisibleRange(layout));
    return result != null ? this.addFoldRows(result, layout) : undefined;
  }

  override async asyncRender(
    file: FileContents,
    renderRange: RenderRange = DEFAULT_RENDER_RANGE
  ): Promise<FileRenderResult> {
    if (renderRange.totalLines === 0) {
      return super.asyncRender(file, renderRange);
    }
    const layout = this.computeLayout(file);
    return this.addFoldRows(
      await super.asyncRender(file, getVisibleRange(layout)),
      layout
    );
  }

  private computeLayout(file: FileContents): SnippetLayout {
    // A file with different contents is a fresh layout; an equal file passed
    // as a new object keeps the reader's reveals.
    if (!areFileTargetsEqual(this.revealsFile, file)) {
      this.reveals = new Map();
    }
    this.revealsFile = file;
    this.layout = layoutSnippet({
      units: getFileSnippetUnits(
        this.getLineCount(file),
        this.snippet.lineRange
      ),
      contextLines: 0,
      collapsedContextThreshold: 0,
      reveals: this.reveals,
    });
    return this.layout;
  }

  private addFoldRows(
    result: FileRenderResult,
    layout: SnippetLayout
  ): FileRenderResult {
    const gutterAST = [...result.gutterAST];
    const contentAST = [...result.contentAST];
    const expansionLineCount = this.getExpansionLineCount();
    layout.folds.forEach((fold, index) => {
      const create = (): ElementContent => {
        const element = createSeparator({
          type: 'line-info',
          content: getSnippetFoldLabel(fold.hiddenLines, false),
          expandIndex: index,
          chunked: fold.hiddenLines > expansionLineCount,
          isFirstHunk: fold.boundary === 'above',
          isLastHunk: fold.boundary === 'below',
        });
        element.properties['data-snippet-boundary'] = fold.boundary;
        return element;
      };
      if (fold.boundary === 'above') {
        gutterAST.unshift(create());
        contentAST.unshift(create());
      } else {
        gutterAST.push(create());
        contentAST.push(create());
      }
    });
    return {
      ...result,
      gutterAST,
      contentAST,
      rowCount: result.rowCount + layout.folds.length,
    };
  }
}

// The one run of lines a file snippet shows, as a render range.
function getVisibleRange(layout: SnippetLayout): RenderRange {
  const rows = layout.items.filter((item) => item.kind === 'rows');
  const startingLine = rows[0]?.rowStart ?? 0;
  const endLine = rows.at(-1)?.rowEnd ?? 0;
  return {
    startingLine,
    totalLines: endLine - startingLine,
    bufferBefore: 0,
    bufferAfter: 0,
  };
}
