// Virtualized hosts size and range-render against the full file and route
// expand clicks through their own expandHunk, none of which knows windowed
// folds, so a `window` reaching them (a JS caller, or a React wrapper inside a
// Virtualizer) would render folds that never open. Their option types already
// exclude `window`; this catches untyped callers.
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
