import type { FileDiffOptions } from '../components/FileDiff';
import {
  DiffHunksRenderer,
  type DiffHunksRendererOptions,
} from '../renderers/DiffHunksRenderer';
import type { DiffLineAnnotation, FileContents } from '../types';
import {
  createEmptyReveal,
  type DiffWindow,
  type WindowExpansionBounds,
  type WindowReveal,
} from '../utils/computeWindowedDiffRows';
import { parseDiffFromFile } from '../utils/parseDiffFromFile';
import { shouldUseTokenTransformer } from '../utils/shouldUseTokenTransformer';
import { preloadDiffHTML } from './preloadDiffs';

export interface RenderWindowedDiffOptions<
  LAnnotation = undefined,
  Caret = undefined,
> {
  /** Full old-file blob. */
  oldFile: FileContents;
  /** Full new-file blob. */
  newFile: FileContents;
  /** New-side line range to show expanded; everything else folds. */
  window: DiffWindow;
  /** Whether folds may expand past the window edge into the file. Default `'file'`. */
  expansionBounds?: WindowExpansionBounds;
  /** Reader-driven reveals (for SSR re-renders after expansion). */
  reveal?: WindowReveal;
  options?: FileDiffOptions<LAnnotation, Caret>;
  annotations?: DiffLineAnnotation<LAnnotation>[];
}

/**
 * Render a windowed diff snippet from two full file blobs. Pierre diffs the
 * blobs into a normal non-partial diff, then shows only `window`'s new-side
 * line range expanded — everything outside collapses to an expandable boundary
 * separator, long unchanged runs inside it collapse to interior separators, and
 * every separator expands natively because the underlying diff is complete.
 *
 * This is the "blobs + window in, everything handled" entry point: the caller
 * does not compute a windowed patch, detect out-of-window changes, or reconcile
 * anything on expand.
 */
export async function renderWindowedDiffHTML<
  LAnnotation = undefined,
  Caret = undefined,
>({
  oldFile,
  newFile,
  window,
  expansionBounds = 'file',
  reveal,
  options,
  annotations,
}: RenderWindowedDiffOptions<LAnnotation, Caret>): Promise<string> {
  const fileDiff = parseDiffFromFile(
    oldFile,
    newFile,
    options?.parseDiffOptions
  );
  const renderer = new DiffHunksRenderer<LAnnotation>(
    getWindowedHunksRendererOptions(options)
  );
  renderer.setWindowState({
    window,
    expansionBounds,
    reveal: reveal ?? createEmptyReveal(),
  });
  if (annotations != null && annotations.length > 0) {
    renderer.setLineAnnotations(annotations);
  }
  // Delegate the render+wrap to the shared preload path by handing it the
  // renderer we have already put into windowed mode.
  return preloadDiffHTML({
    fileDiff,
    options,
    annotations,
    renderer,
  });
}

function getWindowedHunksRendererOptions<LAnnotation, Caret>(
  options: FileDiffOptions<LAnnotation, Caret> | undefined
): DiffHunksRendererOptions {
  return {
    ...options,
    // Windowing supports both unified and split; default to unified when the
    // caller does not specify a style.
    diffStyle: options?.diffStyle ?? 'unified',
    useTokenTransformer: shouldUseTokenTransformer<'diff'>(options),
    headerRenderMode:
      options?.renderCustomHeader != null ? 'custom' : 'default',
    hunkSeparators:
      typeof options?.hunkSeparators === 'function'
        ? 'custom'
        : options?.hunkSeparators,
  };
}
