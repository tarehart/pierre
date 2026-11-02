import { afterAll, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { File as FileClass } from '../src/components/File';
import { FileDiff as FileDiffClass } from '../src/components/FileDiff';
import { VirtualizedFile } from '../src/components/VirtualizedFile';
import { VirtualizedFileDiff } from '../src/components/VirtualizedFileDiff';
import { Editor } from '../src/editor/editor';
import { disposeHighlighter } from '../src/highlighter/shared_highlighter';
import { EditProvider } from '../src/react/EditContext';
import { File } from '../src/react/File';
import { FileDiff } from '../src/react/FileDiff';
import { MultiFileDiff } from '../src/react/MultiFileDiff';
import { UnresolvedFile } from '../src/react/UnresolvedFile';
import { Virtualizer } from '../src/react/Virtualizer';
import { areOptionsEqual } from '../src/utils/areOptionsEqual';
import type { WindowFold } from '../src/utils/windowingCore';
import { installDom, wait, waitFor } from './domHarness';
import {
  FIFTY_LINES,
  INTERIOR_FOLD_SELECTOR,
  makeUnresolvedFile,
  makeWindowedDiff,
  numberedLines,
  queryAll,
  renderedLineNumbers,
} from './windowedHarness';

afterAll(async () => {
  await disposeHighlighter();
});

// Changes at lines 5 and 30 of 40; a 25-35 window hides the line-5 change.
const WINDOW = { start: 25, end: 35 };

interface Mounted {
  container: HTMLElement;
  host(): HTMLElement;
  render(element: ReactElement): Promise<void>;
  errors: unknown[];
}

async function withRoot(body: (mounted: Mounted) => Promise<void>) {
  const { cleanup } = installDom();
  const hadAct = Reflect.has(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  const previousAct = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const errors: unknown[] = [];
  const root: Root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
  });
  const mounted: Mounted = {
    container,
    errors,
    host: () => {
      const host = container.querySelector('diffs-container');
      if (!(host instanceof HTMLElement)) {
        throw new Error('no diffs-container rendered');
      }
      return host;
    },
    render: async (element) => {
      await act(async () => {
        root.render(element);
        await wait(20);
      });
    },
  };
  try {
    await body(mounted);
  } finally {
    await act(async () => {
      root.unmount();
      await wait(0);
    });
    if (hadAct) {
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
    } else {
      Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
    container.remove();
    cleanup();
  }
}

async function lines(mounted: Mounted, attribute?: string) {
  await waitFor(
    () =>
      mounted.container
        .querySelector('diffs-container')
        ?.shadowRoot?.querySelector('[data-line]') != null
  );
  return renderedLineNumbers(mounted.host(), attribute);
}

function click(element: Element | undefined) {
  if (element == null) throw new Error('click: no element');
  element.dispatchEvent(
    new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    })
  );
}

function aboveFoldButton(mounted: Mounted): Element | undefined {
  return queryAll(
    mounted.host(),
    '[data-separator-first] [data-expand-button]'
  )[0];
}

describe('React FileDiff accepts the windowed options', () => {
  test('window renders only the window and folds the rest', async () => {
    await withRoot(async (mounted) => {
      await mounted.render(
        createElement(FileDiff<undefined>, {
          fileDiff: makeWindowedDiff(),
          options: { window: WINDOW, disableFileHeader: true },
        })
      );
      const shown = await lines(mounted);
      expect(shown).toContain(30);
      expect(shown).not.toContain(5);
      expect(aboveFoldButton(mounted)).toBeDefined();
    });
  });

  test('window and windowContextLines prop changes re-render', async () => {
    await withRoot(async (mounted) => {
      const fileDiff = makeWindowedDiff();
      const element = (window: { start: number; end: number }, ctx: number) =>
        createElement(FileDiff<undefined>, {
          fileDiff,
          options: {
            window,
            windowContextLines: ctx,
            diffStyle: 'unified',
            disableFileHeader: true,
          },
        });
      await mounted.render(element(WINDOW, 3));
      expect(await lines(mounted)).not.toContain(5);
      await mounted.render(element({ start: 1, end: 10 }, 3));
      expect(await lines(mounted)).toContain(5);
      expect(await lines(mounted)).not.toContain(30);
      // A whole-file window: the run between the changes folds at 3 lines of
      // context and shows in full at 50.
      await mounted.render(element({ start: 1, end: 40 }, 3));
      expect(queryAll(mounted.host(), INTERIOR_FOLD_SELECTOR)).toHaveLength(1);
      await mounted.render(element({ start: 1, end: 40 }, 50));
      expect(queryAll(mounted.host(), INTERIOR_FOLD_SELECTOR)).toHaveLength(0);
    });
  });

  test('onWindowExpand receives the fold and lineCount and can claim the click', async () => {
    await withRoot(async (mounted) => {
      const folds: WindowFold[] = [];
      const counts: number[] = [];
      await mounted.render(
        createElement(FileDiff<undefined>, {
          fileDiff: makeWindowedDiff(),
          options: {
            window: WINDOW,
            disableFileHeader: true,
            onWindowExpand: (fold, lineCount) => {
              folds.push(fold);
              counts.push(lineCount);
              return true;
            },
          },
        })
      );
      const before = await lines(mounted);
      await act(async () => {
        click(aboveFoldButton(mounted));
        await wait(20);
      });
      expect(folds.map((fold) => fold.boundary)).toEqual(['above']);
      expect(counts).toEqual([100]);
      expect(await lines(mounted)).toEqual(before);
    });
  });

  test('an interior fold click skips onWindowExpand and reveals in place', async () => {
    await withRoot(async (mounted) => {
      const folds: WindowFold[] = [];
      await mounted.render(
        createElement(FileDiff<undefined>, {
          fileDiff: makeWindowedDiff(),
          options: {
            window: { start: 1, end: 40 },
            windowContextLines: 3,
            disableFileHeader: true,
            onWindowExpand: (fold) => {
              folds.push(fold);
              return true;
            },
          },
        })
      );
      expect(await lines(mounted)).not.toContain(15);
      await act(async () => {
        click(
          queryAll(
            mounted.host(),
            '[data-separator][data-expand-index]:not([data-separator-first]):not([data-separator-last]) [data-expand-button]'
          )[0]
        );
        await wait(20);
      });
      expect(folds).toHaveLength(0);
      expect(await lines(mounted)).toContain(15);
    });
  });

  test('renderWindowSeparator fills the boundary fold slots', async () => {
    await withRoot(async (mounted) => {
      await mounted.render(
        createElement(FileDiff<undefined>, {
          fileDiff: makeWindowedDiff(),
          options: {
            window: WINDOW,
            disableFileHeader: true,
            renderWindowSeparator: (fold) => {
              const el = document.createElement('span');
              el.setAttribute('data-host-sep', fold.boundary);
              return el;
            },
          },
        })
      );
      await lines(mounted);
      const boundaries = Array.from(
        mounted.host().querySelectorAll('[data-host-sep]')
      ).map((el) => el.getAttribute('data-host-sep'));
      expect(boundaries.sort()).toEqual(['above', 'below']);
    });
  });

  test('MultiFileDiff takes the same options', async () => {
    await withRoot(async (mounted) => {
      const old = numberedLines(40);
      const next = [...old];
      next[4] = 'line 5 CHANGED';
      next[29] = 'line 30 CHANGED';
      await mounted.render(
        createElement(MultiFileDiff<undefined>, {
          oldFile: { name: 'f.txt', contents: old.join('\n') + '\n' },
          newFile: { name: 'f.txt', contents: next.join('\n') + '\n' },
          options: { window: WINDOW, disableFileHeader: true },
        })
      );
      const shown = await lines(mounted);
      expect(shown).toContain(30);
      expect(shown).not.toContain(5);
    });
  });

  test('inside a Virtualizer a windowed FileDiff is a plain FileDiff, and toggling window swaps the instance', async () => {
    await withRoot(async (mounted) => {
      const instances: unknown[] = [];
      const fileDiff = makeWindowedDiff();
      const element = (windowed: boolean) =>
        createElement(
          Virtualizer,
          null,
          createElement(FileDiff<undefined>, {
            fileDiff,
            options: {
              window: windowed ? WINDOW : undefined,
              disableFileHeader: true,
              onPostRender: (_node: HTMLElement, instance: unknown) => {
                instances.push(instance);
              },
            },
          })
        );
      await mounted.render(element(true));
      expect(await lines(mounted)).not.toContain(5);
      expect(instances.at(-1)).toBeInstanceOf(FileDiffClass);
      expect(instances.at(-1)).not.toBeInstanceOf(VirtualizedFileDiff);

      await mounted.render(element(false));
      await waitFor(() => instances.at(-1) instanceof VirtualizedFileDiff);
      expect(await lines(mounted)).toContain(5);

      await mounted.render(element(true));
      await waitFor(() => !(instances.at(-1) instanceof VirtualizedFileDiff));
      expect(await lines(mounted)).not.toContain(5);
      expect(
        mounted.container.querySelectorAll('diffs-container')
      ).toHaveLength(1);
      expect(mounted.errors).toEqual([]);
    });
  });

  test('window with edit fails with the windowed read-only error', async () => {
    await withRoot(async (mounted) => {
      let thrown: unknown;
      try {
        await mounted.render(
          createElement(
            EditProvider,
            {
              createEditor: (type, options) =>
                new Editor(type, options) as never,
            },
            createElement(FileDiff<undefined>, {
              fileDiff: makeWindowedDiff(),
              edit: true,
              options: { window: WINDOW, disableFileHeader: true },
            })
          )
        );
      } catch (error) {
        thrown = error;
      }
      const error = thrown ?? mounted.errors[0];
      expect(String(error)).toContain('windowed snippet');
      expect(String(error)).toContain('cannot be edited');
    });
  });
});

describe('React File accepts the windowed options', () => {
  const file = { name: 'f.txt', contents: FIFTY_LINES };

  test('window, expansionLineCount and onWindowExpand', async () => {
    await withRoot(async (mounted) => {
      const folds: WindowFold[] = [];
      const counts: number[] = [];
      await mounted.render(
        createElement(File<undefined>, {
          file,
          options: {
            window: { start: 20, end: 30 },
            expansionLineCount: 3,
            disableFileHeader: true,
            onWindowExpand: (fold, lineCount) => {
              folds.push(fold);
              counts.push(lineCount);
            },
          },
        })
      );
      const shown = await lines(mounted, 'data-column-number');
      expect(shown[0]).toBe(20);
      await act(async () => {
        click(aboveFoldButton(mounted));
        await wait(20);
      });
      expect(folds.map((fold) => fold.boundary)).toEqual(['above']);
      expect(counts).toEqual([3]);
      expect((await lines(mounted, 'data-column-number'))[0]).toBe(17);
    });
  });

  test('inside a Virtualizer a windowed File is a plain File, and toggling window swaps the instance', async () => {
    await withRoot(async (mounted) => {
      const instances: unknown[] = [];
      const element = (windowed: boolean) =>
        createElement(
          Virtualizer,
          null,
          createElement(File<undefined>, {
            file,
            options: {
              window: windowed ? { start: 20, end: 30 } : undefined,
              disableFileHeader: true,
              onPostRender: (_node: HTMLElement, instance: unknown) => {
                instances.push(instance);
              },
            },
          })
        );
      await mounted.render(element(true));
      expect((await lines(mounted, 'data-column-number'))[0]).toBe(20);
      expect(instances.at(-1)).toBeInstanceOf(FileClass);
      expect(instances.at(-1)).not.toBeInstanceOf(VirtualizedFile);
      await mounted.render(element(false));
      await waitFor(() => instances.at(-1) instanceof VirtualizedFile);
      await mounted.render(element(true));
      await waitFor(() => !(instances.at(-1) instanceof VirtualizedFile));
      expect((await lines(mounted, 'data-column-number'))[0]).toBe(20);
      expect(mounted.errors).toEqual([]);
    });
  });
});

describe('React UnresolvedFile rejects a window', () => {
  test('an untyped window fails with the UnresolvedFile error', async () => {
    await withRoot(async (mounted) => {
      let thrown: unknown;
      try {
        await mounted.render(
          createElement(UnresolvedFile<undefined>, {
            file: makeUnresolvedFile(),
            options: { window: WINDOW, disableFileHeader: true } as never,
          })
        );
      } catch (error) {
        thrown = error;
      }
      // React may report the failed mount together with follow-on errors.
      const messages = (error: unknown): string[] =>
        error instanceof AggregateError
          ? error.errors.flatMap(messages)
          : [String(error)];
      expect(messages(thrown ?? mounted.errors[0]).join('\n')).toContain(
        'UnresolvedFile does not support the `window` option'
      );
    });
  });
});

describe('React wrappers can leave editing for a window in one render', () => {
  const editProvider = (child: ReactElement) =>
    createElement(
      EditProvider,
      { createEditor: (type, options) => new Editor(type, options) as never },
      child
    );

  test('FileDiff: edit off and window on together', async () => {
    await withRoot(async (mounted) => {
      const fileDiff = makeWindowedDiff();
      await mounted.render(
        editProvider(
          createElement(FileDiff<undefined>, {
            fileDiff,
            edit: true,
            options: { disableFileHeader: true },
          })
        )
      );
      await mounted.render(
        editProvider(
          createElement(FileDiff<undefined>, {
            fileDiff,
            edit: false,
            options: { window: WINDOW, disableFileHeader: true },
          })
        )
      );
      expect(await lines(mounted)).not.toContain(5);
      expect(mounted.errors).toEqual([]);
    });
  });

  test('File: edit off and window on together', async () => {
    await withRoot(async (mounted) => {
      const file = { name: 'f.txt', contents: FIFTY_LINES };
      await mounted.render(
        editProvider(
          createElement(File<undefined>, {
            file,
            edit: true,
            options: { disableFileHeader: true },
          })
        )
      );
      await mounted.render(
        editProvider(
          createElement(File<undefined>, {
            file,
            edit: false,
            options: {
              window: { start: 20, end: 30 },
              disableFileHeader: true,
            },
          })
        )
      );
      expect((await lines(mounted, 'data-column-number'))[0]).toBe(20);
      expect(mounted.errors).toEqual([]);
    });
  });
});

describe('option comparison for the React wrappers', () => {
  test('compares window by value, so an inline range object is no change', () => {
    expect(
      areOptionsEqual(
        { window: { start: 1, end: 9 } },
        { window: { start: 1, end: 9 } }
      )
    ).toBe(true);
    expect(
      areOptionsEqual(
        { window: { start: 1, end: 9 } },
        { window: { start: 1, end: 10 } }
      )
    ).toBe(false);
    expect(areOptionsEqual({ window: { start: 1, end: 9 } }, {})).toBe(false);
  });
});

describe('a React host reaches expandWindowFold through onPostRender', () => {
  test('the instance from onPostRender opens a fold by id', async () => {
    await withRoot(async (mounted) => {
      let instance: FileDiffClass<undefined> | undefined;
      await mounted.render(
        createElement(FileDiff<undefined>, {
          fileDiff: makeWindowedDiff(),
          options: {
            window: WINDOW,
            windowContextLines: 50,
            diffStyle: 'unified',
            disableFileHeader: true,
            onPostRender: (_node, rendered) => {
              instance = rendered;
            },
          },
        })
      );
      expect(await lines(mounted)).not.toContain(24);
      await act(async () => {
        expect(instance?.expandWindowFold('window:above', 'down', 3)).toBe(
          true
        );
        await wait(20);
      });
      expect(await lines(mounted)).toContain(22);
    });
  });
});
