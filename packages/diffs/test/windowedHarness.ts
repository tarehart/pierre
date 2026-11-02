import {
  File,
  FileDiff,
  type FileDiffOptions,
  type FileDiffWindowOptions,
  type FileOptions,
  type FileWindowOptions,
  parseDiffFromFile,
} from '../src';
import type {
  DiffLineAnnotation,
  FileContents,
  FileDiffMetadata,
} from '../src/types';
import { installDom } from './domHarness';

// Shared fixtures and helpers for the windowed-rendering tests.

export function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export function numberedLines(length: number): string[] {
  return Array.from({ length }, (_, i) => `line ${i + 1}`);
}

// A `length`-line file (default 40) whose listed one-based lines are modified.
export function makeDiff(
  changedLines: number[],
  length = 40
): FileDiffMetadata {
  const old = numberedLines(length);
  const next = [...old];
  for (const line of changedLines) {
    next[line - 1] = `line ${line} CHANGED`;
  }
  return parseDiffFromFile(
    { name: 'f.txt', contents: old.join('\n') + '\n' },
    { name: 'f.txt', contents: next.join('\n') + '\n' }
  );
}

// The standard fixture: changes at lines 5 and 30 of a 40-line file. A 25-35
// window leaves an above fold that hides the line-5 change and a below fold
// (36-40) that hides none.
export function makeWindowedDiff(): FileDiffMetadata {
  return makeDiff([5, 30]);
}

// 60 lines with one merge conflict at lines 30-34.
export function makeUnresolvedFile(): FileContents {
  const lines = numberedLines(29);
  lines.push(
    '<<<<<<< HEAD',
    'const value = 1;',
    '=======',
    'const value = 2;',
    '>>>>>>> feature'
  );
  for (let i = 35; i <= 60; i++) {
    lines.push(`line ${i}`);
  }
  return { name: 'conflict.ts', contents: lines.join('\n') + '\n' };
}

export async function waitForRenderedCode(
  container: HTMLElement
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (container.shadowRoot?.querySelector('code') != null) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for render');
}

export async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Distinct one-based line numbers currently rendered as rows, read from
// `attribute` (`data-line` for diffs, `data-column-number` for File).
export function renderedLineNumbers(
  container: HTMLElement,
  attribute = 'data-line'
): number[] {
  const set = new Set<number>();
  for (const node of Array.from(
    container.shadowRoot?.querySelectorAll(`[${attribute}]`) ?? []
  )) {
    const value = Number.parseInt(node.getAttribute(attribute) ?? '', 10);
    if (!Number.isNaN(value) && value > 0) {
      set.add(value);
    }
  }
  return [...set].sort((a, b) => a - b);
}

// A real click, the path a reader's click takes through InteractionManager.
export function click(
  element: Element | null | undefined,
  { shiftKey = false }: { shiftKey?: boolean } = {}
): void {
  if (element == null) {
    throw new Error('click: no element');
  }
  element.dispatchEvent(
    new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      shiftKey,
    })
  );
}

export function queryAll(container: HTMLElement, selector: string): Element[] {
  return Array.from(container.shadowRoot?.querySelectorAll(selector) ?? []);
}

// Interior fold separators in the content column(s).
export const INTERIOR_FOLD_SELECTOR =
  '[data-content] > [data-separator][data-expand-index]:not([data-separator-first]):not([data-separator-last])';

interface Mounted<T> {
  instance: T;
  fileContainer: HTMLElement;
}

// Installs a DOM, mounts one component, runs `body`, then tears both down.
async function withMounted<T extends { cleanUp(): void }>(
  mount: (fileContainer: HTMLElement) => T,
  body: (mounted: Mounted<T>) => Promise<void> | void
): Promise<void> {
  const { cleanup } = installDom();
  let instance: T | undefined;
  try {
    const fileContainer = document.createElement('div');
    instance = mount(fileContainer);
    await body({ instance, fileContainer });
  } finally {
    instance?.cleanUp();
    cleanup();
  }
}

interface FileDiffMountOptions {
  fileDiff?: FileDiffMetadata;
  lineAnnotations?: DiffLineAnnotation<string>[];
  // `settle` for renders that may produce no `code` element.
  wait?: 'code' | 'settle';
}

// Renders a FileDiff (unified, line-info, no header unless overridden) of
// `fileDiff` (default: makeWindowedDiff()) and waits for it before `body`.
export async function withFileDiff(
  options: FileDiffOptions<string, undefined> & FileDiffWindowOptions,
  body: (mounted: Mounted<FileDiff<string>>) => Promise<void> | void,
  {
    fileDiff = makeWindowedDiff(),
    lineAnnotations,
    wait = 'code',
  }: FileDiffMountOptions = {}
): Promise<void> {
  await withMounted(
    () =>
      new FileDiff<string>({
        disableFileHeader: true,
        diffStyle: 'unified',
        hunkSeparators: 'line-info',
        ...options,
      }),
    async (mounted) => {
      mounted.instance.render({
        fileContainer: mounted.fileContainer,
        fileDiff,
        lineAnnotations,
      });
      await (wait === 'code'
        ? waitForRenderedCode(mounted.fileContainer)
        : settle());
      await body(mounted);
    }
  );
}

export const FIFTY_LINES: string = numberedLines(50).join('\n');

// Renders a File (no header) of FIFTY_LINES and waits for it before `body`.
export async function withFile(
  options: FileOptions<undefined, undefined> & FileWindowOptions,
  body: (mounted: Mounted<File>) => Promise<void> | void
): Promise<void> {
  await withMounted(
    () => new File({ disableFileHeader: true, ...options }),
    async (mounted) => {
      mounted.instance.render({
        fileContainer: mounted.fileContainer,
        file: { name: 'f.txt', contents: FIFTY_LINES },
      });
      await waitForRenderedCode(mounted.fileContainer);
      await body(mounted);
    }
  );
}
