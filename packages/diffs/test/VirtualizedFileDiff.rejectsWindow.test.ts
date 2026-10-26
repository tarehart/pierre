import { describe, expect, test } from 'bun:test';

import { VirtualizedFileDiff } from '../src/components/VirtualizedFileDiff';
import { Virtualizer } from '../src/components/Virtualizer';
import { parseDiffFromFile } from '../src/utils/parseDiffFromFile';
import { installDom } from './domHarness';

// VirtualizedFileDiff routes expand clicks through its own expandHunk, which
// does not know windowed folds. Its option type excludes `window`; untyped
// callers (plain JS, a React wrapper inside a Virtualizer) are stopped here.
describe('VirtualizedFileDiff window fence', () => {
  test('constructor rejects a window option', () => {
    const dom = installDom();
    try {
      const virtualizer = new Virtualizer();
      expect(
        () =>
          new VirtualizedFileDiff(
            { window: { start: 1, end: 3 } } as never,
            virtualizer
          )
      ).toThrow('VirtualizedFileDiff does not support the `window` option');
      virtualizer.cleanUp();
    } finally {
      dom.cleanup();
    }
  });

  test('setOptions rejects a window option; non-windowed options pass', () => {
    const dom = installDom();
    try {
      const virtualizer = new Virtualizer();
      const instance = new VirtualizedFileDiff({}, virtualizer);
      expect(() =>
        instance.setOptions({ window: { start: 1, end: 3 } } as never)
      ).toThrow('VirtualizedFileDiff does not support the `window` option');
      expect(() => instance.setOptions({ diffStyle: 'unified' })).not.toThrow();
      instance.cleanUp();
      virtualizer.cleanUp();
    } finally {
      dom.cleanup();
    }
  });
  test('render rejects a window that reached options without setOptions', () => {
    const dom = installDom();
    try {
      const virtualizer = new Virtualizer();
      const instance = new VirtualizedFileDiff({}, virtualizer);
      // A non-fresh object skips the excess-property check on the narrowed
      // options type.
      const widened = { ...instance.options, window: { start: 1, end: 3 } };
      instance.options = widened;
      const fileContainer = document.createElement('div');
      expect(() =>
        instance.render({
          fileContainer,
          fileDiff: parseDiffFromFile(
            { name: 'a.txt', contents: 'a\nb\n' },
            { name: 'a.txt', contents: 'a\nc\n' }
          ),
        })
      ).toThrow('VirtualizedFileDiff does not support the `window` option');
      instance.cleanUp();
      virtualizer.cleanUp();
    } finally {
      dom.cleanup();
    }
  });
});

// Type-level fence: the inherited `options` field must not accept `window`
// either, or a host could assign it directly and bypass the runtime guard.
export function assertOptionsFieldExcludesWindow(
  instance: VirtualizedFileDiff
): void {
  // @ts-expect-error `window` is not a VirtualizedFileDiff option.
  instance.options = { ...instance.options, window: { start: 1, end: 3 } };
}
