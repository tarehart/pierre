import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, FileDiff, parseDiffFromFile } from '../src';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

// 80 lines with changes at 5, 30 and 60; a window around the line-30 change
// folds 1-27 above and 33-80 below (the folds also hide the 5 and 60 changes).
function makeDiff() {
  const old = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
  const next = [...old];
  for (const line of [5, 30, 60]) {
    next[line - 1] = `line ${line} CHANGED`;
  }
  return parseDiffFromFile(
    { name: 'f.txt', contents: old.join('\n') + '\n' },
    { name: 'f.txt', contents: next.join('\n') + '\n' }
  );
}

async function settle(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (container.shadowRoot?.querySelector('[data-line]') != null) {
      return;
    }
  }
  throw new Error('Timed out waiting for FileDiff render');
}

function renderedAdditionLines(container: HTMLElement): number[] {
  const lines = new Set<number>();
  for (const row of Array.from(
    container.shadowRoot?.querySelectorAll('[data-content] > [data-line]') ?? []
  )) {
    if (row.getAttribute('data-line-type') !== 'change-deletion') {
      lines.add(Number(row.getAttribute('data-line')));
    }
  }
  return [...lines].sort((a, b) => a - b);
}

async function renderWindowed(
  diffStyle: 'unified' | 'split'
): Promise<{ instance: FileDiff<string>; fileContainer: HTMLElement }> {
  const fileContainer = document.createElement('div');
  const instance = new FileDiff<string>({
    disableFileHeader: true,
    diffStyle,
    window: { start: 28, end: 32 },
    expansionLineCount: 2,
  });
  instance.render({ fileContainer, fileDiff: makeDiff() });
  await settle(fileContainer);
  expect(renderedAdditionLines(fileContainer)).toEqual([28, 29, 30, 31, 32]);
  return { instance, fileContainer };
}

// Editor jump targets go through these three methods (editor.ts
// #revealLineIfCollapsed and the fold-skip helpers).
describe('FileDiff line visibility under a window', () => {
  test.each(['unified', 'split'] as const)(
    '%s: isLineRenderable and getNearestRenderableLine follow the folds',
    async (diffStyle) => {
      const { cleanup } = installDom();
      let instance: FileDiff<string> | undefined;
      try {
        ({ instance } = await renderWindowed(diffStyle));
        expect(instance.isLineRenderable(30)).toBe(true);
        expect(instance.isLineRenderable(15)).toBe(false);
        expect(instance.isLineRenderable(60)).toBe(false);
        expect(instance.getNearestRenderableLine(15, 'down')).toBe(28);
        expect(instance.getNearestRenderableLine(15, 'up')).toBeUndefined();
        expect(instance.getNearestRenderableLine(50, 'up')).toBe(32);
      } finally {
        instance?.cleanUp();
        cleanup();
      }
    }
  );

  test.each(['unified', 'split'] as const)(
    '%s: revealLine opens the fold that hides the line',
    async (diffStyle) => {
      const { cleanup } = installDom();
      let instance: FileDiff<string> | undefined;
      try {
        const rendered = await renderWindowed(diffStyle);
        instance = rendered.instance;
        const { fileContainer } = rendered;

        // A visible line needs no reveal.
        expect(instance.revealLine(30)).toBe(false);

        // Lines folded above (past the hidden line-5 change) and below the
        // window become visible.
        expect(instance.revealLine(4)).toBe(true);
        await settle(fileContainer);
        expect(renderedAdditionLines(fileContainer)).toContain(4);
        expect(instance.isLineRenderable(4)).toBe(true);

        expect(instance.revealLine(61)).toBe(true);
        await settle(fileContainer);
        expect(renderedAdditionLines(fileContainer)).toContain(61);
        expect(instance.isLineRenderable(61)).toBe(true);
      } finally {
        instance?.cleanUp();
        cleanup();
      }
    }
  );

  test('the line after a trailing newline stays reachable under a window', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      // Reveal everything below so the last line renders, then ask for the
      // line past it (the editor's empty document-end line).
      ({ instance } = await renderWindowed('unified'));
      expect(instance.revealLine(80)).toBe(true);
      expect(instance.isLineRenderable(81)).toBe(true);
      expect(instance.getNearestRenderableLine(81, 'down')).toBe(81);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('revealLine does not offer a programmatic reveal to onWindowExpand', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      let hookCalls = 0;
      instance = new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        window: { start: 28, end: 32 },
        expansionLineCount: 2,
        onWindowExpand: () => {
          hookCalls++;
          return true;
        },
      });
      instance.render({ fileContainer, fileDiff: makeDiff() });
      await settle(fileContainer);
      expect(instance.revealLine(15)).toBe(true);
      await settle(fileContainer);
      expect(hookCalls).toBe(0);
      expect(renderedAdditionLines(fileContainer)).toContain(15);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('a window moved by setOptions is not answered from the old folds', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      const options = {
        disableFileHeader: true,
        diffStyle: 'unified' as const,
        expansionLineCount: 2,
      };
      instance = new FileDiff<string>({
        ...options,
        window: { start: 28, end: 32 },
      });
      instance.render({ fileContainer, fileDiff: makeDiff() });
      await settle(fileContainer);

      // Before the next render the old folds no longer describe the DOM to
      // come; nothing may be revealed against them.
      instance.setOptions({ ...options, window: { start: 55, end: 62 } });
      expect(instance.revealLine(70)).toBe(false);
      instance.rerender();
      await settle(fileContainer);
      const lines = renderedAdditionLines(fileContainer);
      expect(lines).toContain(60);
      expect(lines).not.toContain(70);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('stepping down over the below fold does not land on the document-end line', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      ({ instance } = await renderWindowed('unified'));
      // 33-80 are folded below the window; 81 has no row to land on.
      expect(instance.getNearestRenderableLine(33, 'down')).toBeUndefined();
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });

  test('an expand index that is not a current fold records no whole-file expansion', async () => {
    const { cleanup } = installDom();
    let instance: FileDiff<string> | undefined;
    try {
      const fileContainer = document.createElement('div');
      const options = {
        disableFileHeader: true,
        diffStyle: 'unified' as const,
      };
      instance = new FileDiff<string>({
        ...options,
        window: { start: 28, end: 32 },
      });
      instance.render({ fileContainer, fileDiff: makeDiff() });
      await settle(fileContainer);
      // Between a window change and the next render no fold resolves.
      instance.setOptions({ ...options, window: { start: 55, end: 62 } });
      instance.expandHunk(0, 'down', 2);
      const renderer = (
        instance as unknown as {
          hunksRenderer: { getExpandedHunksMap(): Map<number, unknown> };
        }
      ).hunksRenderer;
      expect(renderer.getExpandedHunksMap().size).toBe(0);
    } finally {
      instance?.cleanUp();
      cleanup();
    }
  });
});
