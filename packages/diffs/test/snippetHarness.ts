import {
  parseDiffFromFile,
  SnippetFile,
  SnippetFileDiff,
  type SnippetFileDiffOptions,
  type SnippetFileOptions,
} from '../src';
import type { FileContents, FileDiffMetadata } from '../src/types';
import { installDom, waitFor } from './domHarness';

// Shared fixtures and helpers for the snippet tests.

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

export function queryAll(container: HTMLElement, selector: string): Element[] {
  return Array.from(container.shadowRoot?.querySelectorAll(selector) ?? []);
}

// Distinct one-based line numbers rendered as rows on one side.
export function renderedLines(
  container: HTMLElement,
  side: 'additions' | 'deletions' | 'any' = 'any'
): number[] {
  const set = new Set<number>();
  for (const node of queryAll(container, '[data-content] [data-line]')) {
    const type = node.getAttribute('data-line-type') ?? '';
    if (side === 'additions' && type === 'change-deletion') continue;
    if (side === 'deletions' && type === 'change-addition') continue;
    set.add(Number(node.getAttribute('data-line')));
  }
  return [...set].sort((a, b) => a - b);
}

// The fold labels in document order, read from the first rendered column.
export function foldLabels(container: HTMLElement): string[] {
  const code = queryAll(container, '[data-code]')[0];
  return Array.from(
    code?.querySelectorAll('[data-content] [data-unmodified-lines]') ?? []
  ).map((node) => node.textContent ?? '');
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

// The clickable label of the boundary fold, in the first column.
export function boundaryLabel(
  container: HTMLElement,
  boundary: 'above' | 'below'
): Element | undefined {
  return queryAll(
    container,
    `[data-gutter] [data-snippet-boundary="${boundary}"] [data-unmodified-lines]`
  )[0];
}

interface Mounted<T> {
  instance: T;
  container: HTMLElement;
}

async function withMounted<T extends { cleanUp(): void }>(
  mount: () => T,
  render: (mounted: Mounted<T>) => void,
  body: (mounted: Mounted<T>) => Promise<void> | void
): Promise<void> {
  const { cleanup } = installDom();
  let instance: T | undefined;
  try {
    const container = document.createElement('div');
    document.body.append(container);
    instance = mount();
    const mounted = { instance, container };
    render(mounted);
    await waitFor(() => container.shadowRoot?.querySelector('code') != null);
    await body(mounted);
  } finally {
    instance?.cleanUp();
    cleanup();
  }
}

export async function withSnippetDiff(
  options: Partial<SnippetFileDiffOptions<undefined>>,
  body: (mounted: Mounted<SnippetFileDiff>) => Promise<void> | void,
  fileDiff: FileDiffMetadata = makeDiff([5, 30])
): Promise<void> {
  await withMounted(
    () =>
      new SnippetFileDiff({
        disableFileHeader: true,
        diffStyle: 'unified',
        lineRange: { start: 25, end: 35 },
        ...options,
      }),
    ({ instance, container }) =>
      instance.render({ fileContainer: container, fileDiff }),
    body
  );
}

export const FIFTY_LINES: FileContents = {
  name: 'f.txt',
  contents: numberedLines(50).join('\n'),
};

export async function withSnippetFile(
  options: Partial<SnippetFileOptions<undefined>>,
  body: (mounted: Mounted<SnippetFile>) => Promise<void> | void
): Promise<void> {
  await withMounted(
    () =>
      new SnippetFile({
        disableFileHeader: true,
        lineRange: { start: 20, end: 25 },
        ...options,
      }),
    ({ instance, container }) =>
      instance.render({ fileContainer: container, file: FIFTY_LINES }),
    body
  );
}
