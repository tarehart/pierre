// A sample of what a host does with `collapsedAfter`: cut a whole diff down
// to a window of lines, render it, and widen it on a click. The sweep renders
// many such windows and checks that none throws and every row matches the
// same row of the whole diff (text, line numbers, tokens).
import { afterAll, describe, expect, test } from 'bun:test';

import {
  disposeHighlighter,
  type FileDiffMetadata,
  type Hunk,
  parseDiffFromFile,
} from '../../src';
import { installDom } from '../domHarness';
import {
  captureErrors,
  makeNew,
  makeOld,
  mount,
  rows,
  settle,
  toFile,
} from './fixture';

afterAll(async () => {
  await disposeHighlighter();
});

interface Run {
  // Zero-based first line on each side and line counts on each side.
  del: number;
  add: number;
  dels: number;
  adds: number;
  change: boolean;
}

/**
 * The host's slicer, in short: the new lines `start`-`end` (one-based) of
 * `full` as one hunk, with nothing declared above or below it. A change the
 * window touches is kept whole, so the window may grow to include it.
 */
function windowOf(
  full: FileDiffMetadata,
  start: number,
  end: number
): FileDiffMetadata {
  // 1. The whole diff as runs of unchanged lines and change blocks.
  const runs: Run[] = [];
  let del = 0;
  let add = 0;
  const unchanged = (count: number) => {
    if (count <= 0) return;
    runs.push({ del, add, dels: count, adds: count, change: false });
    del += count;
    add += count;
  };
  for (const hunk of full.hunks) {
    for (const block of hunk.hunkContent) {
      unchanged(block.additionLineIndex - add);
      if (block.type === 'context') {
        unchanged(block.lines);
      } else {
        runs.push({
          del,
          add,
          dels: block.deletions,
          adds: block.additions,
          change: true,
        });
        del += block.deletions;
        add += block.additions;
      }
    }
  }
  unchanged(full.additionLines.length - add);

  // 2. The runs the window meets: unchanged runs cut to it, changes whole,
  // a pure deletion only when new lines of the window sit on both sides.
  const from = start - 1;
  const to = end;
  const picked: Run[] = [];
  for (const run of runs) {
    if (run.adds === 0) {
      if (run.add > from && run.add < to) picked.push(run);
    } else if (run.add < to && run.add + run.adds > from) {
      if (run.change) {
        picked.push(run);
      } else {
        const lo = Math.max(run.add, from);
        const hi = Math.min(run.add + run.adds, to);
        const offset = lo - run.add;
        picked.push({
          del: run.del + offset,
          add: lo,
          dels: hi - lo,
          adds: hi - lo,
          change: false,
        });
      }
    }
  }

  // 3. One hunk over the picked runs, at their real line numbers.
  const first = picked[0];
  const last = picked[picked.length - 1];
  const hunk: Hunk = {
    collapsedBefore: 0, // nothing above the window is part of the view
    additionStart: first.add + 1,
    additionCount: last.add + last.adds - first.add,
    additionLines: 0,
    additionLineIndex: first.add,
    deletionStart: first.del + 1,
    deletionCount: last.del + last.dels - first.del,
    deletionLines: 0,
    deletionLineIndex: first.del,
    hunkContent: [],
    splitLineStart: 0,
    splitLineCount: 0,
    unifiedLineStart: 0,
    unifiedLineCount: 0,
    noEOFCRDeletions: false,
    noEOFCRAdditions: false,
  };
  for (const run of picked) {
    if (run.change) {
      hunk.hunkContent.push({
        type: 'change',
        deletions: run.dels,
        additions: run.adds,
        deletionLineIndex: run.del,
        additionLineIndex: run.add,
      });
      hunk.deletionLines += run.dels;
      hunk.additionLines += run.adds;
      hunk.splitLineCount += Math.max(run.dels, run.adds);
      hunk.unifiedLineCount += run.dels + run.adds;
    } else {
      hunk.hunkContent.push({
        type: 'context',
        lines: run.adds,
        deletionLineIndex: run.del,
        additionLineIndex: run.add,
      });
      hunk.splitLineCount += run.adds;
      hunk.unifiedLineCount += run.adds;
    }
  }
  return {
    ...full,
    hunks: [hunk],
    splitLineCount: hunk.splitLineCount,
    unifiedLineCount: hunk.unifiedLineCount,
    collapsedAfter: 0, // nothing below the window is part of the view
    cacheKey: undefined, // each window renders different rows
  };
}

const key = (r: { type: string; line: number; alt?: number }) =>
  `${r.type.replace('-expanded', '')}:${r.line}:${r.alt ?? ''}`;

describe('host window sweep', () => {
  for (const diffStyle of ['unified', 'split'] as const) {
    test(`${diffStyle}: windows over a diff with changes above, inside and below`, async () => {
      const { cleanup } = installDom();
      const { errors, restore } = captureErrors();
      try {
        const old = makeOld();
        const full = parseDiffFromFile(toFile(old), toFile(makeNew(old)));
        const last = full.additionLines.length;
        const whole = mount(full, diffStyle, { expandUnchanged: true });
        await settle(whole.container);
        const column =
          diffStyle === 'unified'
            ? '[data-unified] [data-content]'
            : '[data-additions] [data-content]';
        const want = new Map(
          rows(whole.container, column).map((r) => [key(r), r])
        );

        const windows: [number, number][] = [
          [1, last],
          [1, 1],
          [last, last],
        ];
        for (const size of [1, 5, 20]) {
          for (let start = 1; start + size - 1 <= last; start += 6) {
            windows.push([start, start + size - 1]);
          }
        }
        for (const [start, end] of windows) {
          const { container, instance } = mount(
            windowOf(full, start, end),
            diffStyle
          );
          await settle(container);
          const got = rows(container, column);
          expect(got.length).toBeGreaterThan(0);
          for (const r of got) {
            const w = want.get(key(r));
            expect(
              `${start}-${end} ${key(r)} ${w == null ? 'missing' : w.html === r.html ? 'same' : 'differs'}`
            ).toBe(`${start}-${end} ${key(r)} same`);
          }
          instance.cleanUp();
          container.remove();
        }

        // A reveal: widen the window on the same instance, as a click would.
        const { container, instance } = mount(
          windowOf(full, 33, 43),
          diffStyle
        );
        await settle(container);
        instance.render({
          fileContainer: container,
          fileDiff: windowOf(full, 13, 63),
        });
        await settle(container);
        const lines = rows(container, column)
          .filter((r) => !r.type.includes('deletion'))
          .map((r) => r.line);
        // Line 13 is the last of three inserted lines (new 11-13), which the
        // slicer keeps whole, so the window opens to 11.
        expect([lines[0], lines.at(-1)]).toEqual([11, 63]);

        expect(errors).toEqual([]);
      } finally {
        restore();
        cleanup();
      }
    }, 120000);
  }
});
