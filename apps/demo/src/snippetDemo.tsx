import {
  DIFFS_TAG_NAME,
  type FileDiffMetadata,
  parseDiffFromFile,
  SnippetFile,
  SnippetFileDiff,
  type SnippetFold,
} from '@pierre/diffs';
import {
  SnippetFile as ReactSnippetFile,
  SnippetFileDiff as ReactSnippetFileDiff,
} from '@pierre/diffs/react';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// Snippet demo: a range of a diff or file with folds that open in place,
// once with the built-in separators and once with host-drawn edge markup.

// Hides the built-in above/below separators; interior folds keep theirs.
const HIDE_BOUNDARY_CSS = '[data-snippet-boundary] { display: none; }';

function makeSource(changed: boolean): string {
  const lines: string[] = [];
  for (let i = 1; i <= 120; i++) {
    const edited = changed && (i === 12 || i === 48 || i === 61 || i === 95);
    lines.push(
      edited
        ? `export const value${i} = compute(${i}, 'changed');`
        : `export const value${i} = compute(${i});`
    );
  }
  return lines.join('\n') + '\n';
}

const OLD = { name: 'values.ts', contents: makeSource(false) };
const NEW = { name: 'values.ts', contents: makeSource(true) };
const DIFF: FileDiffMetadata = parseDiffFromFile(OLD, NEW);

function section(container: HTMLElement, title: string): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.dataset.snippetDemo = title;
  wrapper.style.cssText = 'margin-block:16px;font:13px system-ui,sans-serif';
  const heading = document.createElement('h3');
  heading.textContent = title;
  wrapper.append(heading);
  container.append(wrapper);
  return wrapper;
}

function logFold(log: HTMLElement, fold: SnippetFold, lineCount: number) {
  const entry = document.createElement('div');
  entry.textContent = `onSnippetExpand: ${fold.boundary}, ${fold.hiddenLines} hidden${fold.containsChanges ? ' (with changes)' : ''}, asks for ${lineCount}`;
  log.append(entry);
}

// A host-drawn bar outside the component that grows the snippet in place.
function hostBar(
  boundary: 'above' | 'below',
  expand: (boundary: 'above' | 'below', lineCount?: number) => boolean
): HTMLElement {
  const bar = document.createElement('div');
  bar.dataset.hostSnippetBar = boundary;
  bar.style.cssText =
    'display:flex;gap:8px;align-items:center;padding:4px 8px;border:1px dashed currentcolor;border-radius:6px';
  bar.append(`Host markup (${boundary})`);
  for (const [label, count] of [
    ['Show 20 more', 20],
    ['Show all', Infinity],
  ] as const) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => {
      if (!expand(boundary, count)) button.disabled = true;
    });
    bar.append(button);
  }
  return bar;
}

export interface SnippetDemo {
  cleanUp(): void;
}

export function renderSnippetDemo(
  container: HTMLElement,
  diffStyle: 'unified' | 'split'
): SnippetDemo {
  const cleanups: (() => void)[] = [];

  // 1. Built-in separators with a telemetry log (the callback returns
  //    nothing, so the built-in reveal still runs).
  const builtIn = section(container, 'SnippetFileDiff, lines 40-70');
  const log = document.createElement('div');
  log.dataset.snippetLog = '';
  const builtInDiff = new SnippetFileDiff({
    diffStyle,
    lineRange: { start: 40, end: 70 },
    expansionLineCount: 10,
    onSnippetExpand: (fold, lineCount) => logFold(log, fold, lineCount),
  });
  const builtInContainer = document.createElement(DIFFS_TAG_NAME);
  builtIn.append(builtInContainer, log);
  builtInDiff.render({ fileDiff: DIFF, fileContainer: builtInContainer });
  cleanups.push(() => builtInDiff.cleanUp());

  // 2. Host edge markup: built-in boundary separators hidden, host bars
  //    drive expandSnippet.
  const host = section(container, 'SnippetFileDiff with host edge markup');
  const hostDiff = new SnippetFileDiff({
    diffStyle,
    lineRange: { start: 40, end: 70 },
    unsafeCSS: HIDE_BOUNDARY_CSS,
  });
  const hostContainer = document.createElement(DIFFS_TAG_NAME);
  const expand = (boundary: 'above' | 'below', lineCount?: number) =>
    hostDiff.expandSnippet(boundary, lineCount);
  host.append(
    hostBar('above', expand),
    hostContainer,
    hostBar('below', expand)
  );
  hostDiff.render({ fileDiff: DIFF, fileContainer: hostContainer });
  cleanups.push(() => hostDiff.cleanUp());

  // 3. React: the same two patterns, one per component.
  const reactSection = section(
    container,
    'React SnippetFileDiff and SnippetFile'
  );
  const root = createRoot(
    reactSection.appendChild(document.createElement('div'))
  );
  root.render(<ReactSnippets diffStyle={diffStyle} />);
  cleanups.push(() => root.unmount());

  return {
    cleanUp() {
      for (const cleanUp of cleanups.splice(0)) cleanUp();
    },
  };
}

function ReactSnippets({ diffStyle }: { diffStyle: 'unified' | 'split' }) {
  const [log, setLog] = useState<string[]>([]);
  // The instance arrives through onPostRender; keep it for expandSnippet.
  const fileRef = useRef<SnippetFile | null>(null);
  return (
    <>
      <ReactSnippetFileDiff
        fileDiff={DIFF}
        options={{
          diffStyle,
          lineRange: { start: 90, end: 100 },
          onSnippetExpand: (fold, lineCount) =>
            setLog((entries) => [
              ...entries,
              `${fold.boundary}: ${fold.hiddenLines} hidden, asks for ${lineCount}`,
            ]),
        }}
      />
      <div data-snippet-log="react">
        {log.map((entry, index) => (
          <div key={index}>onSnippetExpand: {entry}</div>
        ))}
      </div>
      <button onClick={() => fileRef.current?.expandSnippet('above', 5)}>
        Host markup: 5 more lines above
      </button>
      <ReactSnippetFile
        file={NEW}
        options={{
          lineRange: { start: 10, end: 14 },
          unsafeCSS: HIDE_BOUNDARY_CSS,
          onPostRender: (_node, instance) => {
            fileRef.current = instance;
          },
        }}
      />
      <button onClick={() => fileRef.current?.expandSnippet('below', 5)}>
        Host markup: 5 more lines below
      </button>
    </>
  );
}
