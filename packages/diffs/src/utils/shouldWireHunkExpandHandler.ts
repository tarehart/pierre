/**
 * Whether `FileDiff` (and `UnresolvedFile`) should wire an `onHunkExpand`
 * handler into their `InteractionManager` for a given options combination.
 *
 * A windowed fold (`window != null`) always needs its expander to be
 * clickable, regardless of `hunkSeparators` mode: the renderer emits the
 * fold's separator + expand button whenever windowing is active (see
 * `DiffHunksRenderer`/`iterateWindowedDiff`), independent of the separator
 * mode chosen for the rest of the diff. Without this exception, a windowed
 * fold rendered under `hunkSeparators: 'simple'` or `'metadata'` looks fully
 * interactive but a click does nothing: `InteractionManager.handlePointerClick`
 * finds no `onHunkExpand` handler and returns before ever calling
 * `expandHunk`.
 *
 * Outside windowing, only the separator modes that actually render a
 * clickable hunk-expand affordance need the handler: a custom function, the
 * default `'line-info'`, or `'line-info-basic'`. `'simple'` and `'metadata'`
 * render collapsed-context separators with no expand button in the
 * non-windowed case, so wiring the handler there would be dead weight, not a
 * correctness issue -- this predicate still excludes them when `window` is
 * absent.
 *
 * `hunkSeparators` is typed loosely (matching either FileDiffOptions'
 * exact union or the plain HunkSeparators string enum) so this shared helper
 * has no dependency on either type -- every check below is a plain runtime
 * comparison.
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
