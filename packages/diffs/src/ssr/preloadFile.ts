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
   * identical. Internal — not part of the public preloadFile surface.
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
