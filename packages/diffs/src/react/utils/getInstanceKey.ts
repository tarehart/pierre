// Key for a React wrapper's container element. Inside a Virtualizer a
// windowed instance is a plain (not virtualized) one, since a virtualized
// instance cannot fold, so toggling `window` there must re-create the
// instance: the key changes and React remounts the container. Outside a
// Virtualizer the key never changes.
export function getInstanceKey(
  inVirtualizer: boolean,
  window: unknown
): string {
  return inVirtualizer && window != null ? 'windowed' : 'default';
}
