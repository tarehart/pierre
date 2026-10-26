import { afterAll, describe, expect, test } from 'bun:test';

import {
  DiffHunksRenderer,
  disposeHighlighter,
  FileDiff,
  parseDiffFromFile,
} from '../src';
import { createEmptyReveal } from '../src/utils/computeWindowedDiffRows';
import { installDom, waitFor } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

describe('DiffHunksRenderer.setWindowState skips clearRenderCache when unchanged', () => {
  test('re-applying the identical window/reveal does not call clearRenderCache; a real change does', () => {
    // FileDiff.render calls syncWindowState -> setWindowState on every
    // render: an unconditional clearRenderCache() there would force a full
    // re-highlight even when the window never changed.
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

describe('windowed fold clicks keep a highlighted render cache', () => {
  test('expanding a fold reveals lines without discarding the highlighted result', async () => {
    // The highlighted result covers every line of the non-partial diff, so a
    // reveal only needs the rows re-assembled, as upstream expandHunk does.
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const old = Array.from(
        { length: 40 },
        (_, i) => `const v${i + 1} = ${i};`
      );
      const next = [...old];
      next[29] = 'const v30 = 300;';
      const fileContainer = document.createElement('div');
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        window: { start: 25, end: 35 },
        windowContextLines: 50,
      });
      instance.render({
        fileContainer,
        fileDiff: parseDiffFromFile(
          { name: 'f.ts', contents: old.join('\n') + '\n' },
          { name: 'f.ts', contents: next.join('\n') + '\n' }
        ),
      });
      // Reach the private render cache to tell a reveal from a re-tokenize.
      const renderer = (
        instance as unknown as {
          hunksRenderer: {
            renderCache?: { highlighted: boolean; result?: unknown };
            clearRenderCache(): void;
          };
        }
      ).hunksRenderer;
      await waitFor(
        () =>
          renderer.renderCache?.highlighted === true &&
          renderer.renderCache.result != null
      );
      const highlightedResult = renderer.renderCache?.result;
      let clearCount = 0;
      const originalClear = renderer.clearRenderCache.bind(renderer);
      renderer.clearRenderCache = () => {
        clearCount++;
        originalClear();
      };

      const lineCount = (): number =>
        fileContainer.shadowRoot?.querySelectorAll(
          '[data-content] > [data-line]'
        ).length ?? 0;
      const before = lineCount();
      const expandIndex = Number.parseInt(
        fileContainer.shadowRoot
          ?.querySelector('[data-separator-first][data-expand-index]')
          ?.getAttribute('data-expand-index') ?? '',
        10
      );
      instance.expandHunk(expandIndex, 'down', 5);
      await waitFor(() => lineCount() > before);

      expect(lineCount()).toBe(before + 5);
      expect(clearCount).toBe(0);
      expect(renderer.renderCache?.result).toBe(highlightedResult);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
