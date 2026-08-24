import { describe, expect, test } from 'bun:test';
import { toHtml } from 'hast-util-to-html';

import { createSeparator } from '../src/utils/createSeparator';

function html(node: ReturnType<typeof createSeparator>): string {
  return toHtml(node);
}

describe('createSeparator custom slot expandability', () => {
  test('a custom windowed separator is clickable: the slot is wrapped in an expand-button region', () => {
    // A host `renderWindowSeparator` fold renders as a `custom` slot. The host
    // owns the visuals, but Pierre must still route the click, so the wrapper
    // has to carry the expand affordance the InteractionManager looks for.
    const out = html(
      createSeparator({
        type: 'custom',
        slotName: 'window-file-sep-3',
        expandIndex: 3,
        isFirstHunk: true, // above-window boundary fold
        isLastHunk: false,
      })
    );
    expect(out).toContain('data-expand-button');
    expect(out).toContain('data-expand-index="3"');
    expect(out).toContain('name="window-file-sep-3"');
    // Above-window fold peels toward the window (downward).
    expect(out).toContain('data-expand-down');
    expect(out).not.toContain('data-expand-up');
    expect(out).not.toContain('data-expand-both');
  });

  test('below-window custom fold expands upward', () => {
    const out = html(
      createSeparator({
        type: 'custom',
        slotName: 'sep-below',
        expandIndex: 9,
        isFirstHunk: false,
        isLastHunk: true,
      })
    );
    expect(out).toContain('data-expand-button');
    expect(out).toContain('data-expand-up');
    expect(out).not.toContain('data-expand-down');
    expect(out).not.toContain('data-expand-both');
  });

  test('interior custom fold expands both directions', () => {
    const out = html(
      createSeparator({
        type: 'custom',
        slotName: 'sep-interior',
        expandIndex: 5,
        isFirstHunk: false,
        isLastHunk: false,
      })
    );
    expect(out).toContain('data-expand-button');
    expect(out).toContain('data-expand-both');
    expect(out).not.toContain('data-expand-up');
    expect(out).not.toContain('data-expand-down');
  });

  test('a custom slot with no expandIndex stays a bare, non-expandable slot', () => {
    const out = html(
      createSeparator({
        type: 'custom',
        slotName: 'plain',
        isFirstHunk: false,
        isLastHunk: false,
      })
    );
    expect(out).toContain('name="plain"');
    expect(out).not.toContain('data-expand-button');
  });
});
