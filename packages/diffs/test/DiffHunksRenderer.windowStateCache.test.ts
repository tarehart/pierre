import { afterAll, describe, expect, test } from 'bun:test';

import { DiffHunksRenderer, disposeHighlighter } from '../src';
import { createEmptyReveal } from '../src/utils/computeWindowedDiffRows';

afterAll(async () => {
  await disposeHighlighter();
});

describe('DiffHunksRenderer.setWindowState skips clearRenderCache when unchanged', () => {
  test('re-applying the identical window/reveal does not call clearRenderCache; a real change does', () => {
    // Regression test for review finding 9's suggested local win (and made
    // more urgent by the render-resync fix for finding 5, which now calls
    // syncWindowState -> setWindowState on every FileDiff.render call: an
    // unconditional clearRenderCache() there would force a full re-highlight
    // on every render even when the window never changed).
    const renderer = new DiffHunksRenderer({ diffStyle: 'unified' });
    let clearCount = 0;
    const originalClear = renderer.clearRenderCache.bind(renderer);
    renderer.clearRenderCache = () => {
      clearCount++;
      originalClear();
    };

    const reveal = createEmptyReveal();
    const windowState = { window: { start: 1, end: 10 }, reveal };

    // First call always clears (there was no prior window state).
    renderer.setWindowState(windowState);
    expect(clearCount).toBe(1);

    // Falsifier: re-applying the SAME window/reveal (same reveal reference,
    // matching how FileDiff/File keep a stable reveal Map across renders of
    // an unchanged window) must NOT clear again.
    renderer.setWindowState({ ...windowState });
    expect(clearCount).toBe(1);

    // A genuinely different window still clears -- a real change is not
    // silently ignored.
    renderer.setWindowState({ window: { start: 20, end: 30 }, reveal });
    expect(clearCount).toBe(2);

    // Leaving windowed mode (undefined) still clears.
    renderer.setWindowState(undefined);
    expect(clearCount).toBe(3);
  });
});
