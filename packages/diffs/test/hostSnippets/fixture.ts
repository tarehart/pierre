// Shared fixture for the host-side snippet probes: a TypeScript file with a
// change before the window (3 lines inserted after old line 10), a change in
// the window (old 35 / new 38, inside a block comment that opens on old line
// 20) and a change after it (old 60-61 deleted). The window is new 33-43
// (old 30-40), so both hidden edges contain changes and the two sides of the
// tail differ in length (old 40 lines, new 38).
import {
  type FileContents,
  FileDiff,
  type FileDiffMetadata,
  hydratePartialDiff,
  parseDiffFromFile,
} from '../../src';

export function makeOld(): string[] {
  const out: string[] = [];
  for (let n = 1; n <= 80; n++) {
    if (n === 20) out.push('/*');
    else if (n > 20 && n < 45) out.push(` * comment line ${n}`);
    else if (n === 45) out.push(' */');
    else if (n === 60 || n === 61) out.push(`const del${n} = ${n};`);
    else out.push(`const a${n} = ${n};`);
  }
  return out;
}

export function makeNew(
  old: string[],
  opts: { tail?: boolean } = {}
): string[] {
  const out: string[] = [];
  old.forEach((line, i) => {
    const n = i + 1;
    if (n === 35) out.push(' * comment CHANGED 35');
    else if ((n === 60 || n === 61) && opts.tail !== false) return;
    else out.push(line);
    if (n === 10)
      out.push('const ins1 = 1;', 'const ins2 = 2;', 'const ins3 = 3;');
  });
  return out;
}

export const toFile = (lines: string[], name = 'x.ts'): FileContents => ({
  name,
  contents: `${lines.join('\n')}\n`,
});

export interface Window {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/**
 * What a host can build today from public API only: diff the window's slices,
 * shift the hunk to the real line numbers as a partial diff, then hydrate it
 * with the whole files (hydratePartialDiff recomputes every derived field).
 */
export function hostWindowDiff(
  oldLines: string[],
  newLines: string[],
  w: Window
): FileDiffMetadata {
  const oldSlice = oldLines.slice(w.oldStart - 1, w.oldEnd);
  const newSlice = newLines.slice(w.newStart - 1, w.newEnd);
  const sub = parseDiffFromFile(toFile(oldSlice), toFile(newSlice), {
    context: 1_000_000,
  } as never);
  const hunk = sub.hunks[0];
  if (hunk == null) throw new Error('fixture: window has no change');
  const partial: FileDiffMetadata = {
    ...sub,
    isPartial: true,
    cacheKey: undefined,
    hunks: [
      {
        ...hunk,
        additionStart: hunk.additionStart + w.newStart - 1,
        deletionStart: hunk.deletionStart + w.oldStart - 1,
      },
    ],
  };
  return hydratePartialDiff('clone', partial, {
    oldFile: toFile(oldLines),
    newFile: toFile(newLines),
  });
}

export interface Row {
  type: string;
  line: number;
  alt: number | undefined;
  text: string;
  html: string;
}

export function rows(container: HTMLElement, column = '[data-content]'): Row[] {
  const content = container.shadowRoot?.querySelector(column);
  if (content == null) return [];
  return Array.from(content.querySelectorAll(':scope > [data-line]'), (el) => ({
    type: el.getAttribute('data-line-type') ?? '',
    line: Number(el.getAttribute('data-line')),
    alt: el.hasAttribute('data-alt-line')
      ? Number(el.getAttribute('data-alt-line'))
      : undefined,
    text: el.textContent ?? '',
    html: el.innerHTML,
  }));
}

export function separators(container: HTMLElement): string[] {
  const content = container.shadowRoot?.querySelector('[data-content]');
  if (content == null) return [];
  return Array.from(
    content.querySelectorAll(':scope > [data-separator]'),
    (el) => el.textContent ?? ''
  );
}

export async function settle(container: HTMLElement): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (container.shadowRoot?.querySelector('[data-line] span[style]') != null)
      break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 50));
}

export function mount(
  fileDiff: FileDiffMetadata,
  diffStyle: 'unified' | 'split',
  extra: Record<string, unknown> = {}
): { container: HTMLElement; instance: FileDiff<string> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const instance = new FileDiff<string>({
    diffStyle,
    disableFileHeader: true,
    disableErrorHandling: true,
    ...extra,
  });
  instance.render({ fileContainer: container, fileDiff });
  return { container, instance };
}

/**
 * A window with declared edges: `before` unchanged lines above it and `after`
 * below it that the view may open; nothing past them is part of the view.
 * Public fields only: collapsedBefore, the split/unified starts and totals,
 * and (with the library change) collapsedAfter.
 */
export function hostEdgedWindowDiff(
  oldLines: string[],
  newLines: string[],
  w: Window,
  before: number,
  after: number
): FileDiffMetadata {
  const diff = hostWindowDiff(oldLines, newLines, w);
  const hunk = diff.hunks[0];
  hunk.collapsedBefore = before;
  hunk.splitLineStart = before;
  hunk.unifiedLineStart = before;
  diff.splitLineCount = before + hunk.splitLineCount + after;
  diff.unifiedLineCount = before + hunk.unifiedLineCount + after;
  (diff as FileDiffMetadata & { collapsedAfter?: number }).collapsedAfter =
    after;
  return diff;
}

export function captureErrors(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a[0] instanceof Error ? a[0].message : String(a[0]));
  };
  return { errors, restore: () => (console.error = original) };
}
