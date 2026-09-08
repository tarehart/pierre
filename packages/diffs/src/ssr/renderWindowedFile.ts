import type { FileOptions } from '../components/File';
import {
  FileRenderer,
  type FileWindowRenderState,
} from '../renderers/FileRenderer';
import type { FileContents, LineAnnotation } from '../types';
import type {
  DiffWindow,
  WindowReveal,
} from '../utils/computeWindowedDiffRows';
import { createEmptyReveal } from '../utils/computeWindowedDiffRows';
import { shouldUseTokenTransformer } from '../utils/shouldUseTokenTransformer';
import { preloadFileHTML } from './preloadFile';

export interface RenderWindowedFileOptions<
  LAnnotation = undefined,
  Caret = undefined,
> {
  /** Full file contents. */
  file: FileContents;
  /** 1-based inclusive line range to show; everything outside folds. */
  window: DiffWindow;
  /** Reader-driven reveals (for SSR re-renders after expansion). */
  reveal?: WindowReveal;
  options?: FileOptions<LAnnotation, Caret>;
  annotations?: LineAnnotation<LAnnotation>[];
}

/**
 * Render a windowed view of a plain file to hydratable HTML.
 *
 * Suitable for SSR / prerendering: only the lines inside `window` are emitted;
 * everything outside collapses to expandable boundary separators. Pass the
 * result as `prerenderedHTML` to `File.hydrate()`.
 *
 * Delegates the render+wrap tail to the same path `preloadFile` uses (CSS,
 * theme styles, header AST, and the `data-dehydrated` marker `File.hydrate()`
 * needs), handing it a renderer already put into windowed mode, rather than
 * duplicating that wrapper here. It awaits the highlighter the way every
 * sibling preload function does (`preloadFile`, `preloadDiffHTML`,
 * `renderWindowedDiffHTML`): a cold process has no highlighter loaded yet, and
 * reading FileRenderer's synchronous `renderFile` result would race that.
 */
export async function renderWindowedFileHTML<
  LAnnotation = undefined,
  Caret = undefined,
>({
  file,
  window,
  reveal = createEmptyReveal(),
  options,
  annotations,
}: RenderWindowedFileOptions<LAnnotation, Caret>): Promise<string> {
  const renderer = new FileRenderer<LAnnotation>({
    ...options,
    useTokenTransformer: shouldUseTokenTransformer(options),
    headerRenderMode:
      options?.renderCustomHeader != null ? 'custom' : 'default',
  });
  const windowState: FileWindowRenderState = {
    window,
    reveal,
    // NOTE: hardcoded false here (not derived from options.renderWindowSeparator)
    // is a separate, known gap tracked out of scope for this fix (see
    // DECISIONS.md) -- SSR custom windowed-separator wiring is a distinct
    // defect from the two (empty cold-process output, missing hydration
    // wrapper) this function addresses.
    hasSeparatorRenderer: false,
  };
  renderer.setWindowState(windowState);
  if (annotations != null && annotations.length > 0) {
    renderer.setLineAnnotations(annotations);
  }
  return preloadFileHTML({ file, options, annotations, renderer });
}
