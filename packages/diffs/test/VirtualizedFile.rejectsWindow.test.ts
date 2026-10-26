import { describe, expect, test } from 'bun:test';

import { VirtualizedFile } from '../src/components/VirtualizedFile';
import { Virtualizer } from '../src/components/Virtualizer';
import { installDom } from './domHarness';

// VirtualizedFile sizes and range-renders against the full file, which the
// windowed row set does not follow. Its option type excludes `window`; untyped
// callers (plain JS, a React wrapper inside a Virtualizer) are stopped here.
describe('VirtualizedFile window fence', () => {
  test('constructor rejects a window option', () => {
    const dom = installDom();
    try {
      const virtualizer = new Virtualizer();
      expect(
        () =>
          new VirtualizedFile(
            { window: { start: 1, end: 3 } } as never,
            virtualizer
          )
      ).toThrow('VirtualizedFile does not support the `window` option');
      virtualizer.cleanUp();
    } finally {
      dom.cleanup();
    }
  });

  test('setOptions rejects a window option; non-windowed options pass', () => {
    const dom = installDom();
    try {
      const virtualizer = new Virtualizer();
      const instance = new VirtualizedFile({}, virtualizer);
      expect(() =>
        instance.setOptions({ window: { start: 1, end: 3 } } as never)
      ).toThrow('VirtualizedFile does not support the `window` option');
      expect(() =>
        instance.setOptions({ disableFileHeader: true })
      ).not.toThrow();
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
      const instance = new VirtualizedFile({}, virtualizer);
      // A non-fresh object skips the excess-property check on the narrowed
      // options type.
      const widened = { ...instance.options, window: { start: 1, end: 3 } };
      instance.options = widened;
      const fileContainer = document.createElement('div');
      expect(() =>
        instance.render({
          fileContainer,
          file: { name: 'a.txt', contents: 'a\nb\n' },
        })
      ).toThrow('VirtualizedFile does not support the `window` option');
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
  instance: VirtualizedFile
): void {
  // @ts-expect-error `window` is not a VirtualizedFile option.
  instance.options = { ...instance.options, window: { start: 1, end: 3 } };
}
