import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter } from '../src';
import { UnresolvedFile } from '../src/components/UnresolvedFile';
import { DEFAULT_THEMES } from '../src/constants';
import type { FileContents } from '../src/types';
import type { DiffWindow } from '../src/utils/windowingCore';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

// 60 lines with one merge conflict at lines 30-34.
function makeUnresolvedFile(): FileContents {
  const lines: string[] = [];
  for (let i = 1; i <= 29; i++) {
    lines.push(`line ${i}`);
  }
  lines.push('<<<<<<< HEAD');
  lines.push('const value = 1;');
  lines.push('=======');
  lines.push('const value = 2;');
  lines.push('>>>>>>> feature');
  for (let i = 35; i <= 60; i++) {
    lines.push(`line ${i}`);
  }
  return { name: 'conflict.ts', contents: lines.join('\n') + '\n' };
}

async function waitForRenderedCode(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (container.shadowRoot?.querySelector('code') != null) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for UnresolvedFile render');
}

// Each injected conflict row (action bar, start/separator/end marker) paired
// with the code row it is anchored to: the next code row for rows injected
// before a line, the previous one for the end marker.
function conflictRowAnchors(container: HTMLElement): string[] {
  const content = container.shadowRoot?.querySelector('[data-content]');
  const children = Array.from(content?.children ?? []);
  const describeLine = (el: Element | undefined): string =>
    el == null
      ? 'none'
      : `${el.getAttribute('data-line')}:${el.textContent?.trim()}`;
  const anchors: string[] = [];
  children.forEach((child, index) => {
    const isActions = child.hasAttribute('data-merge-conflict-actions');
    const isMarker = child.hasAttribute('data-merge-conflict-marker-row');
    if (!isActions && !isMarker) {
      return;
    }
    const kind = isActions
      ? 'actions'
      : `marker-${child.getAttribute('data-merge-conflict')}`;
    const step = kind === 'marker-marker-end' ? -1 : 1;
    let cursor = index + step;
    while (
      children[cursor] != null &&
      !children[cursor].hasAttribute('data-line')
    ) {
      cursor += step;
    }
    anchors.push(`${kind}@${describeLine(children[cursor])}`);
  });
  return anchors;
}

async function renderAnchors(window?: DiffWindow): Promise<string[]> {
  const { cleanup } = installDom();
  let instance: UnresolvedFile | undefined;
  try {
    const fileContainer = document.createElement('div');
    instance = new UnresolvedFile({
      theme: DEFAULT_THEMES,
      disableFileHeader: true,
      window,
      windowContextLines: 50,
    });
    instance.render({ file: makeUnresolvedFile(), fileContainer });
    await waitForRenderedCode(fileContainer);
    return conflictRowAnchors(fileContainer);
  } finally {
    instance?.cleanUp();
    cleanup();
  }
}

describe('UnresolvedFile windowed conflict rows', () => {
  test('conflict action and marker rows anchor to the same code rows as the non-windowed render', async () => {
    const expected = await renderAnchors(undefined);
    // Sanity: the non-windowed render places an action bar and markers.
    expect(expected.length).toBeGreaterThanOrEqual(3);

    expect(await renderAnchors({ start: 20, end: 45 })).toEqual(expected);
  });
});
