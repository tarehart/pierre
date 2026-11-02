// Some viewers cannot render a `window`: the virtualized hosts size and
// range-render against the full file and route expand clicks through their
// own expandHunk, and UnresolvedFile rewrites the file on every resolve, so a
// fixed window would drift. Their option types exclude `window`; this catches
// untyped callers (plain JS, or a React wrapper passing it through).
export function assertNotWindowed(
  options: object | undefined,
  component: string
): void {
  if (options != null && (options as { window?: unknown }).window != null) {
    throw new Error(
      `${component} does not support the \`window\` option. Use FileDiff or File for windowed snippets.`
    );
  }
}

// A windowed snippet is read-only: the editor's reveals and caret moves follow
// the full file's geometry, which a window replaces with its own folds.
export function assertNotWindowedWhileEditing(
  window: unknown,
  editing: boolean,
  component: string
): void {
  if (window != null && editing) {
    throw new Error(
      `${component}: a windowed snippet (the \`window\` option) cannot be edited`
    );
  }
}
