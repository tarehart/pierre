import type { FileOptions } from '../components/File';
import { FileRenderer } from '../renderers/FileRenderer';
import type { FileContents, LineAnnotation } from '../types';
import {
  createStyleElement,
  createThemeStyleElement,
} from '../utils/createStyleElement';
import { wrapThemeCSS } from '../utils/cssWrappers';
import { shouldUseTokenTransformer } from '../utils/shouldUseTokenTransformer';
import { renderHTML } from './renderHTML';

export type PreloadFileOptions<LAnnotation, Caret> = {
  file: FileContents;
  options?: FileOptions<LAnnotation, Caret>;
  annotations?: LineAnnotation<LAnnotation>[];
  /**
   * A pre-configured renderer to render with instead of constructing one from
   * `options`. Used by `renderWindowedFileHTML`, which must set the renderer's
   * window state before rendering; the wrap/serialize path is otherwise
   * identical. Part of the public `preloadFile` surface (re-exported from
   * `ssr/index.ts`) for any caller that similarly needs to pre-configure a
   * renderer before this function wraps and serializes its output. When
   * supplying one, call `setLineAnnotations` on it directly instead of
   * passing `annotations` here -- see `preloadFileHTML`'s docs for why.
   */
  renderer?: FileRenderer<LAnnotation>;
};

export interface PreloadedFileResult<LAnnotation, Caret> {
  file: FileContents;
  options?: FileOptions<LAnnotation, Caret>;
  annotations?: LineAnnotation<LAnnotation>[];
  prerenderedHTML: string;
}

/**
 * Render a file to hydratable HTML: highlighted markup wrapped with its CSS,
 * theme styles, and the `data-dehydrated` marker `File.hydrate()` looks for.
 * Shared by `preloadFile` (constructs its own renderer from `options`) and
 * `renderWindowedFileHTML` (hands in a renderer already in windowed mode), so
 * both entry points produce hydratable output through one code path instead
 * of each maintaining their own copy of the wrapper.
 *
 * `annotations` is only applied here when no `renderer` is provided: a
 * caller that hands in its own renderer (currently only
 * `renderWindowedFileHTML`) is expected to have already called
 * `setLineAnnotations` on it, since annotations must be set before the
 * renderer's window state for the windowed path to interleave them
 * correctly. Passing `annotations` alongside a `renderer` here would be
 * silently inert, so callers should omit it in that case.
 */
export async function preloadFileHTML<LAnnotation, Caret>({
  file,
  options,
  annotations,
  renderer: providedRenderer,
}: PreloadFileOptions<LAnnotation, Caret>): Promise<string> {
  const fileRenderer =
    providedRenderer ??
    new FileRenderer<LAnnotation>({
      ...options,
      // Match the client's option snapshot: token callbacks imply the
      // transformer, so server markup hydrates into identical client renders.
      useTokenTransformer: shouldUseTokenTransformer(options),
      headerRenderMode:
        options?.renderCustomHeader != null ? 'custom' : 'default',
    });

  if (
    providedRenderer == null &&
    annotations != null &&
    annotations.length > 0
  ) {
    fileRenderer.setLineAnnotations(annotations);
  }

  // asyncRender awaits the highlighter (initializing it if needed) instead of
  // reading FileRenderer.renderFile's synchronous, possibly-still-pending
  // result: on a cold process renderFile returns undefined until a background
  // asyncHighlight resolves, which asyncRender is what actually drives.
  const fileResult = await fileRenderer.asyncRender(file);
  const children = [createStyleElement(fileResult.css, true)];

  children.push(
    createThemeStyleElement(
      wrapThemeCSS(
        fileResult.themeStyles,
        fileResult.baseThemeType ?? options?.themeType ?? 'system'
      )
    )
  );

  if (options?.unsafeCSS != null) {
    children.push(createStyleElement(options.unsafeCSS));
  }

  if (fileResult.headerAST != null) {
    children.push(fileResult.headerAST);
  }
  const code = fileRenderer.renderFullAST(fileResult);
  code.properties['data-dehydrated'] = '';
  children.push(code);

  return renderHTML(children);
}

export async function preloadFile<LAnnotation = undefined, Caret = undefined>({
  file,
  options,
  annotations,
}: PreloadFileOptions<LAnnotation, Caret>): Promise<
  PreloadedFileResult<LAnnotation, Caret>
> {
  return {
    file,
    options,
    annotations,
    prerenderedHTML: await preloadFileHTML({ file, options, annotations }),
  };
}
