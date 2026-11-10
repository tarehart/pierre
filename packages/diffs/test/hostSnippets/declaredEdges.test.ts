// The contract a host-built window needs from FileDiffMetadata: the view
// begins `collapsedBefore` lines above the first hunk and ends
// `collapsedAfter` lines below the last, whatever the files hold beyond.
import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, parseDiffFromFile } from '../../src';
import { installDom } from '../domHarness';
import {
  captureErrors,
  hostEdgedWindowDiff,
  makeNew,
  makeOld,
  mount,
  rows,
  separators,
  settle,
  toFile,
} from './fixture';

afterAll(async () => {
  await disposeHighlighter();
});

// New 33-43 (old 30-40). Above: old 11-29 / new 14-32 are unchanged (19
// lines), then the insertion. Below: old 41-59 / new 44-62 (19 lines), then
// the deletion of old 60-61.
const W = { oldStart: 30, oldEnd: 40, newStart: 33, newEnd: 43 };
const STYLES = ['unified', 'split'] as const;
const column = (style: (typeof STYLES)[number]) =>
  style === 'unified'
    ? '[data-unified] [data-content]'
    : '[data-additions] [data-content]';
const norm = (t: string) => t.replace('-expanded', '');

function checkRows(
  container: HTMLElement,
  style: (typeof STYLES)[number],
  old: string[],
  neu: string[],
  whole: HTMLElement
): number[] {
  const got = rows(container, column(style)).filter(
    (r) => !r.type.includes('deletion')
  );
  const want = rows(whole, column(style));
  for (const r of got) {
    expect(r.text).toBe(neu[r.line - 1]);
    if (r.type.startsWith('context'))
      expect(old[(r.alt ?? 0) - 1]).toBe(neu[r.line - 1]);
    const w = want.find(
      (x) => x.line === r.line && norm(x.type) === norm(r.type)
    );
    expect(r.html).toBe(w?.html ?? 'missing');
  }
  return got.map((r) => r.line);
}

describe('declared edges', () => {
  for (const style of STYLES) {
    test(`E1 ${style}: no edges shows exactly the window, highlighted as in the whole file`, async () => {
      const { cleanup } = installDom();
      const { errors, restore } = captureErrors();
      try {
        const old = makeOld();
        const neu = makeNew(old);
        const whole = mount(
          parseDiffFromFile(toFile(old), toFile(neu)),
          style,
          { expandUnchanged: true }
        );
        const { container } = mount(
          hostEdgedWindowDiff(old, neu, W, 0, 0),
          style
        );
        await settle(whole.container);
        await settle(container);
        expect(errors).toEqual([]);
        expect(separators(container)).toEqual([]);
        expect(checkRows(container, style, old, neu, whole.container)).toEqual([
          33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43,
        ]);
      } finally {
        restore();
        cleanup();
      }
    });

    test(`E2 ${style}: declared edges open in place, only over the unchanged lines`, async () => {
      const { cleanup } = installDom();
      const { errors, restore } = captureErrors();
      try {
        const old = makeOld();
        const neu = makeNew(old);
        const whole = mount(
          parseDiffFromFile(toFile(old), toFile(neu)),
          style,
          { expandUnchanged: true }
        );
        const { container, instance } = mount(
          hostEdgedWindowDiff(old, neu, W, 19, 19),
          style
        );
        await settle(whole.container);
        await settle(container);
        expect(errors).toEqual([]);
        expect(
          separators(container).map((s) => s.match(/\d+ unmodified lines/)?.[0])
        ).toEqual(['19 unmodified lines', '19 unmodified lines']);
        // 'down' opens a gap from its bottom (next to the hunk below it), 'up'
        // from its top (next to the hunk above it).
        instance.expandHunk(0, 'down', 5);
        instance.expandHunk(1, 'up', 4);
        await settle(container);
        expect(errors).toEqual([]);
        const shown = checkRows(container, style, old, neu, whole.container);
        expect(shown[0]).toBe(28);
        expect(shown.at(-1)).toBe(47);
        instance.expandHunk(0, 'down', 1000);
        instance.expandHunk(1, 'up', 1000);
        await settle(container);
        const all = checkRows(container, style, old, neu, whole.container);
        expect([all[0], all.at(-1)]).toEqual([14, 62]);
        expect(separators(container)).toEqual([]);
      } finally {
        restore();
        cleanup();
      }
    });
  }

  test('E3 a deleted file: a window over its old lines', async () => {
    const { cleanup } = installDom();
    const { errors, restore } = captureErrors();
    try {
      const old = makeOld();
      const full = parseDiffFromFile(toFile(old), null);
      const whole = mount(full, 'unified');
      // Old lines 30-40 as one deletion block, nothing above or below.
      const hunk = full.hunks[0];
      const custom = {
        ...full,
        cacheKey: undefined,
        splitLineCount: 11,
        unifiedLineCount: 11,
        collapsedAfter: 0,
        hunks: [
          {
            ...hunk,
            deletionStart: 30,
            deletionCount: 11,
            deletionLines: 11,
            deletionLineIndex: 29,
            splitLineCount: 11,
            unifiedLineCount: 11,
            hunkContent: [
              {
                type: 'change' as const,
                deletions: 11,
                additions: 0,
                deletionLineIndex: 29,
                additionLineIndex: 0,
              },
            ],
          },
        ],
      };
      const { container } = mount(custom, 'unified');
      await settle(whole.container);
      await settle(container);
      expect(errors).toEqual([]);
      const got = rows(container);
      const want = rows(whole.container);
      expect(got.map((r) => r.line)).toEqual([
        30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
      ]);
      for (const r of got) {
        expect(r.text).toBe(old[r.line - 1]);
        expect(r.html).toBe(
          want.find((x) => x.line === r.line)?.html ?? 'missing'
        );
      }
    } finally {
      restore();
      cleanup();
    }
  });
});
