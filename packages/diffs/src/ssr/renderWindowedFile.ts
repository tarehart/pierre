import type { FileOptions } from '../components/File';
import {
  FileRenderer,
  type FileWindowRenderState,
} from '../renderers/FileRenderer';
import type { FileContents, LineAnnotation } from '../types';
import { shouldUseTokenTransformer } from '../utils/shouldUseTokenTransformer';
import type { DiffWindow, WindowReveal } from '../utils/windowingCore';
import { createEmptyReveal } from '../utils/windowingCore';
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
    // A host-owned separator has no server-side render step for its own
    // element (that only exists client-side), but the renderer still needs to
    // know to leave an empty custom slot rather than the built-in line-info
    // separator, or the client's post-hydration fill would land inside markup
    // with a different shape and height than what the host actually renders.
    hasSeparatorRenderer: options?.renderWindowSeparator != null,
  };
  renderer.setWindowState(windowState);
  if (annotations != null && annotations.length > 0) {
    renderer.setLineAnnotations(annotations);
  }
  // annotations already applied above via setLineAnnotations on the renderer
  // this function constructs; preloadFileHTML only applies its own
  // `annotations` param when it builds the renderer itself (no `renderer`
  // passed in), so it is not passed again here to avoid implying it does
  // something when a renderer is provided.
  return preloadFileHTML({ file, options, renderer });
}
