/**
 * Whether `FileDiff` should wire an `onHunkExpand` handler into its
 * `InteractionManager`. A windowed fold always renders an
 * expander, whatever `hunkSeparators` is, so a window always needs the
 * handler; otherwise only the separator modes with an expand button do (a
 * custom function, `'line-info'` (the default) and `'line-info-basic'`).
 */
export function shouldWireHunkExpandHandler(
  hunkSeparators: unknown,
  window: unknown
): boolean {
  if (window != null) {
    return true;
  }
  return (
    typeof hunkSeparators === 'function' ||
    (hunkSeparators ?? 'line-info') === 'line-info' ||
    hunkSeparators === 'line-info-basic'
  );
}
