import { describe, expect, test } from 'bun:test';

import { UnresolvedFile } from '../src/components/UnresolvedFile';
import { VirtualizedFile } from '../src/components/VirtualizedFile';
import { VirtualizedFileDiff } from '../src/components/VirtualizedFileDiff';
import { Virtualizer } from '../src/components/Virtualizer';
import { parseDiffFromFile } from '../src/utils/parseDiffFromFile';
import { installDom } from './domHarness';

// VirtualizedFile sizes and range-renders against the full file, and
// VirtualizedFileDiff routes expand clicks through its own expandHunk; neither
// follows the windowed row set. Their option types exclude `window`; untyped
// callers (plain JS, a React wrapper inside a Virtualizer) are stopped here.
interface FenceCase {
  name: string;
  create(
    options: object,
    virtualizer: Virtualizer
  ): {
    options: object;
    setOptions(options: object): void;
    render(props: { fileContainer: HTMLElement }): unknown;
    cleanUp(): void;
  };
  validOptions: object;
  renderInput: object;
}

const cases: FenceCase[] = [
  {
    name: 'VirtualizedFile',
    create: (options, virtualizer) =>
      new VirtualizedFile(options, virtualizer) as never,
    validOptions: { disableFileHeader: true },
    renderInput: { file: { name: 'a.txt', contents: 'a\nb\n' } },
  },
  {
    name: 'VirtualizedFileDiff',
    create: (options, virtualizer) =>
      new VirtualizedFileDiff(options, virtualizer),
    validOptions: { diffStyle: 'unified' },
    renderInput: {
      fileDiff: parseDiffFromFile(
        { name: 'a.txt', contents: 'a\nb\n' },
        { name: 'a.txt', contents: 'a\nc\n' }
      ),
    },
  },
];

describe.each(cases)('$name window fence', (fence) => {
  const message = `${fence.name} does not support the \`window\` option`;

  test('constructor rejects a window option', () => {
    const dom = installDom();
    try {
      const virtualizer = new Virtualizer();
      expect(() =>
        fence.create({ window: { start: 1, end: 3 } }, virtualizer)
      ).toThrow(message);
      virtualizer.cleanUp();
    } finally {
      dom.cleanup();
    }
  });

  test('setOptions rejects a window option; non-windowed options pass', () => {
    const dom = installDom();
    try {
      const virtualizer = new Virtualizer();
      const instance = fence.create({}, virtualizer);
      expect(() =>
        instance.setOptions({ window: { start: 1, end: 3 } })
      ).toThrow(message);
      expect(() => instance.setOptions(fence.validOptions)).not.toThrow();
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
      const instance = fence.create({}, virtualizer);
      instance.options = { ...instance.options, window: { start: 1, end: 3 } };
      const fileContainer = document.createElement('div');
      expect(() =>
        instance.render({ fileContainer, ...fence.renderInput })
      ).toThrow(message);
      instance.cleanUp();
      virtualizer.cleanUp();
    } finally {
      dom.cleanup();
    }
  });
});

// Type-level fences: the inherited `options` field must not accept `window`
// either, or a host could assign it directly and bypass the runtime guard.
export function assertFileOptionsFieldExcludesWindow(
  instance: VirtualizedFile
): void {
  // @ts-expect-error `window` is not a VirtualizedFile option.
  instance.options = { ...instance.options, window: { start: 1, end: 3 } };
}

export function assertFileDiffOptionsFieldExcludesWindow(
  instance: VirtualizedFileDiff
): void {
  // @ts-expect-error `window` is not a VirtualizedFileDiff option.
  instance.options = { ...instance.options, window: { start: 1, end: 3 } };
}

// UnresolvedFile rejects windowing too: resolving a conflict rewrites the
// file, so a fixed window drifts, and conflicts outside it still need
// resolving.
describe('UnresolvedFile window fence', () => {
  const message = 'UnresolvedFile does not support the `window` option';
  const file = {
    name: 'c.ts',
    contents: 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\nd\n',
  };
  const window = { start: 1, end: 3 };

  test('constructor, setOptions, render and hydrate reject a window', () => {
    const dom = installDom();
    try {
      expect(() => new UnresolvedFile({ window } as never)).toThrow(message);
      const instance = new UnresolvedFile();
      expect(() => instance.setOptions({ window } as never)).toThrow(message);
      expect(() =>
        instance.setOptions({ disableFileHeader: true })
      ).not.toThrow();
      instance.options = { ...instance.options, window } as never;
      const fileContainer = document.createElement('div');
      expect(() => instance.render({ fileContainer, file })).toThrow(message);
      const hydrating = new UnresolvedFile();
      hydrating.options = { ...hydrating.options, window } as never;
      expect(() =>
        hydrating.hydrate({
          fileContainer: document.createElement('div'),
          file,
        })
      ).toThrow(message);
      instance.cleanUp();
      hydrating.cleanUp();
    } finally {
      dom.cleanup();
    }
  });

  test('expandWindowFold, inherited from FileDiff, returns false', () => {
    const dom = installDom();
    try {
      const instance = new UnresolvedFile({ disableFileHeader: true });
      instance.render({ fileContainer: document.createElement('div'), file });
      expect(instance.expandWindowFold('window:above', 'down')).toBe(false);
      instance.cleanUp();
    } finally {
      dom.cleanup();
    }
  });
});

export function assertUnresolvedFileOptionsExcludeWindow(): void {
  // @ts-expect-error `window` is not an UnresolvedFile option.
  new UnresolvedFile({ window: { start: 1, end: 3 } });
}
