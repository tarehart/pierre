import { afterAll, describe, expect, test } from 'bun:test';
import { createTwoFilesPatch } from 'diff';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import {
  disposeHighlighter,
  parsePatchFiles,
  SnippetFile,
  SnippetFileDiff,
} from '../src';
import { SnippetFileDiff as ReactSnippetFileDiff } from '../src/react/SnippetFileDiff';
import { Virtualizer } from '../src/react/Virtualizer';
import { preloadSnippetFile, preloadSnippetFileDiff } from '../src/ssr';
import { installDom, wait, waitFor } from './domHarness';
import {
  boundaryLabel,
  click,
  FIFTY_LINES,
  foldLabels,
  makeDiff,
  numberedLines,
  renderedLines,
} from './snippetHarness';

afterAll(async () => {
  await disposeHighlighter();
});

describe('snippet SSR', () => {
  test('hydrating a preloaded SnippetFileDiff keeps the server markup', async () => {
    const options = {
      diffStyle: 'unified' as const,
      disableFileHeader: true,
      lineRange: { start: 25, end: 35 },
    };
    const fileDiff = makeDiff([5, 30]);
    const { prerenderedHTML } = await preloadSnippetFileDiff({
      fileDiff,
      options,
    });
    expect(prerenderedHTML).toContain('data-snippet-boundary="above"');
    const { cleanup } = installDom();
    const instance = new SnippetFileDiff(options);
    try {
      const container = document.createElement('div');
      document.body.append(container);
      instance.hydrate({ fileContainer: container, fileDiff, prerenderedHTML });
      const pre = container.shadowRoot?.querySelector('pre');
      expect(pre).not.toBeNull();
      const before = pre?.innerHTML;
      await wait(50);
      expect(container.shadowRoot?.querySelector('pre')).toBe(pre);
      expect(pre?.innerHTML).toBe(before);
      // The hydrated folds are live.
      click(boundaryLabel(container, 'below'));
      expect(renderedLines(container).at(-1)).toBe(40);
    } finally {
      instance.cleanUp();
      cleanup();
    }
  });

  test('hydrating a preloaded SnippetFile keeps the server markup', async () => {
    const options = {
      disableFileHeader: true,
      lineRange: { start: 20, end: 25 },
    };
    const { prerenderedHTML } = await preloadSnippetFile({
      file: FIFTY_LINES,
      options,
    });
    const { cleanup } = installDom();
    const instance = new SnippetFile(options);
    try {
      const container = document.createElement('div');
      instance.hydrate({
        fileContainer: container,
        file: FIFTY_LINES,
        prerenderedHTML,
      });
      const pre = container.shadowRoot?.querySelector('pre');
      await wait(50);
      expect(container.shadowRoot?.querySelector('pre')).toBe(pre);
      expect(foldLabels(container)).toEqual([
        '19 unmodified lines',
        '25 unmodified lines',
      ]);
    } finally {
      instance.cleanUp();
      cleanup();
    }
  });

  test('preloadSnippetFileDiff rejects a partial diff before rendering', async () => {
    const old = numberedLines(20).join('\n') + '\n';
    const patch = createTwoFilesPatch(
      'f.txt',
      'f.txt',
      old,
      old.replace('line 9\n', 'nine\n')
    );
    const partial = parsePatchFiles(patch)[0].files[0];
    const error = await preloadSnippetFileDiff({
      fileDiff: partial,
      options: { lineRange: { start: 1, end: 3 } },
    }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('a partial diff');
  });
});

describe('React snippets', () => {
  function mount(element: ReactNode) {
    const handle = installDom();
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    return {
      container,
      async render(next: ReactNode) {
        await act(async () => {
          root.render(next);
          await wait(0);
        });
      },
      async cleanUp() {
        await act(async () => {
          root.unmount();
          await wait(0);
        });
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
        handle.cleanup();
      },
      root,
      element,
    };
  }

  test('SnippetFileDiff renders and hands its instance to onPostRender', async () => {
    let instance: SnippetFileDiff | undefined;
    const fileDiff = makeDiff([5, 30]);
    const element = (lineRange: { start: number; end: number }) =>
      createElement(ReactSnippetFileDiff<undefined>, {
        fileDiff,
        options: {
          diffStyle: 'unified',
          disableFileHeader: true,
          lineRange,
          onPostRender: (_node, next) => {
            instance = next;
          },
        },
      });
    const mounted = mount(null);
    try {
      await mounted.render(element({ start: 25, end: 35 }));
      const host = mounted.container.querySelector(
        'diffs-container'
      ) as HTMLElement;
      await waitFor(() => host.shadowRoot?.querySelector('code') != null);
      expect(instance).toBeInstanceOf(SnippetFileDiff);
      await act(async () => {
        instance!.expandSnippet('below', 2);
        await wait(0);
      });
      // A re-render with an equal (new object) range keeps the reveal.
      await mounted.render(element({ start: 25, end: 35 }));
      expect(renderedLines(host).at(-1)).toBe(37);
      // A different range is a fresh layout.
      await mounted.render(element({ start: 30, end: 31 }));
      expect(renderedLines(host, 'additions')).toEqual([30, 31]);
    } finally {
      await mounted.cleanUp();
    }
  });

  test('throws inside a Virtualizer instead of swapping classes', async () => {
    const mounted = mount(null);
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      const root = createRoot(document.createElement('div'));
      try {
        await act(async () => {
          root.render(
            createElement(
              Virtualizer,
              null,
              createElement(ReactSnippetFileDiff<undefined>, {
                fileDiff: makeDiff([5]),
                options: { lineRange: { start: 1, end: 3 } },
              })
            )
          );
          await wait(0);
        });
      } catch (error) {
        errors.push(error);
      }
      expect(String(errors[0])).toContain(
        'SnippetFileDiff: snippets cannot render inside a <Virtualizer>'
      );
      await act(async () => {
        root.unmount();
        await wait(0);
      });
    } finally {
      console.error = originalError;
      await mounted.cleanUp();
    }
  });
});
