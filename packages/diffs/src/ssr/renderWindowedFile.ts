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
 * Render a windowed view of a plain file synchronously.
 *
 * Suitable for SSR / prerendering: only the lines inside `window` are emitted;
 * everything outside collapses to expandable boundary separators. Pass the
 * result as `prerenderedHTML` to `File.hydrate()`.
 */
export function renderWindowedFileHTML<
  LAnnotation = undefined,
  Caret = undefined,
>({
  file,
  window,
  reveal = createEmptyReveal(),
  options = {},
  annotations,
}: RenderWindowedFileOptions<LAnnotation, Caret>): string {
  const renderer = new FileRenderer<LAnnotation>(options);
  if (annotations != null) {
    renderer.setLineAnnotations(annotations);
  }
  const windowState: FileWindowRenderState = {
    window,
    reveal,
    hasSeparatorRenderer: false,
  };
  renderer.setWindowState(windowState);
  const fileResult = renderer.renderFile(file, undefined);
  if (fileResult == null) {
    return '';
  }
  return renderer.renderFullHTML(fileResult);
}
