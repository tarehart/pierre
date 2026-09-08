import { describe, expect, test } from 'bun:test';

import { getDiffHunksRendererOptions } from '../src/utils/getDiffHunksRendererOptions';

describe('getDiffHunksRendererOptions', () => {
  test('forwards windowContextLines onto the renderer option snapshot', () => {
    // getDiffHunksRendererOptions builds its return value with an explicit
    // property allowlist (not a spread) so prototype getters on CodeView item
    // options are not missed. windowContextLines must be in that allowlist, or
    // every FileDiff/CodeView windowed render silently falls back to
    // DEFAULT_WINDOW_CONTEXT_LINES regardless of what the caller configured.
    const result = getDiffHunksRendererOptions({
      window: { start: 10, end: 20 },
      windowContextLines: 8,
    });
    expect(result.windowContextLines).toBe(8);
  });

  test('windowContextLines is omitted (undefined) when the caller does not set it', () => {
    const result = getDiffHunksRendererOptions({});
    expect(result.windowContextLines).toBeUndefined();
  });
});
