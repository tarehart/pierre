// Windowed demo sections built with the React wrappers from
// @pierre/diffs/react. The other windowed sections use the vanilla classes.
import {
  type DiffsThemeNames,
  type DiffWindow,
  type FileContents,
  type FileDiff as FileDiffClass,
  type FileDiffMetadata,
  type ThemesType,
  VirtualizedFileDiff,
  type WindowFold,
} from '@pierre/diffs';
import {
  File,
  FileDiff,
  Virtualizer,
  type WindowedFileDiffOptions,
} from '@pierre/diffs/react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface WindowedReactProps {
  fileDiff: FileDiffMetadata;
  file: FileContents;
  diffWindow: DiffWindow;
  theme: DiffsThemeNames | ThemesType;
  themeType: 'light' | 'dark' | 'system';
  overflow: 'wrap' | 'scroll';
}

export interface WindowedReactSections {
  // Re-render with changed props (the page's theme and wrap toggles).
  update(props: Partial<WindowedReactProps>): void;
  unmount(): void;
}

// Mounts the React sections at the end of `wrapper`.
export function mountWindowedReactSections(
  wrapper: HTMLElement,
  initialProps: WindowedReactProps
): WindowedReactSections {
  const container = document.createElement('div');
  wrapper.appendChild(container);
  const root = createRoot(container);
  let props = initialProps;
  root.render(<Sections {...props} />);
  return {
    update(next) {
      props = { ...props, ...next };
      root.render(<Sections {...props} />);
    },
    unmount: () => root.unmount(),
  };
}

function Sections(props: WindowedReactProps) {
  return (
    <>
      <Section
        heading={`7. Windowed FileDiff — custom full-width boundary rows (split, lines ${props.diffWindow.start}-${props.diffWindow.end}) (React)`}
        note='Click the bar to open the fold the built-in way, or "Show 20 more" to call expandWindowFold(fold.foldId, ..., 20) on the instance from onPostRender.'
      >
        <FullWidthFoldsDiff {...props} />
      </Section>
      <Section heading="8. Windowed File — lines 200-260 (React)">
        <WidenableFile {...props} />
      </Section>
      <Section
        heading="9. Windowed FileDiff inside a Virtualizer (React)"
        note="With a window the wrapper builds a plain FileDiff; without one, a VirtualizedFileDiff. Toggling remounts it."
      >
        <VirtualizerToggle {...props} />
      </Section>
    </>
  );
}

function Section({
  heading,
  note,
  children,
}: {
  heading: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section data-react-section="">
      <h3
        style={{ font: 'bold 14px system-ui,sans-serif', margin: '16px 0 4px' }}
      >
        {heading}
      </h3>
      {note != null && (
        <p
          style={{
            font: '12px system-ui,sans-serif',
            margin: '0 0 8px',
            opacity: 0.7,
          }}
        >
          {note}
        </p>
      )}
      {children}
    </section>
  );
}

// Split, with a host-drawn bar in each full-width boundary row. The hook is
// a stable callback, so its elements are kept across re-renders.
function FullWidthFoldsDiff({
  fileDiff,
  diffWindow,
  theme,
  themeType,
  overflow,
}: WindowedReactProps) {
  const instanceRef = useRef<FileDiffClass<undefined> | null>(null);
  const renderWindowSeparator = useCallback(
    (fold: WindowFold) =>
      makeFullWidthSeparatorEl(fold, (count) =>
        instanceRef.current?.expandWindowFold(
          fold.foldId,
          fold.boundary === 'above' ? 'down' : 'up',
          count
        )
      ),
    []
  );
  const onPostRender = useCallback(
    (_node: HTMLElement, instance: FileDiffClass<undefined>) => {
      instanceRef.current = instance;
    },
    []
  );
  const options = useMemo<WindowedFileDiffOptions<undefined, undefined>>(
    () => ({
      theme,
      themeType,
      overflow,
      diffStyle: 'split',
      window: diffWindow,
      windowContextLines: 8,
      renderWindowSeparator,
      onPostRender,
    }),
    [
      theme,
      themeType,
      overflow,
      diffWindow,
      renderWindowSeparator,
      onPostRender,
    ]
  );
  return <FileDiff fileDiff={fileDiff} options={options} />;
}

// Boundary folds widen the window held in React state.
function WidenableFile({
  file,
  theme,
  themeType,
  overflow,
}: WindowedReactProps) {
  const [fileWindow, setFileWindow] = useState<DiffWindow>({
    start: 200,
    end: 260,
  });
  // Only the above/below folds call onWindowExpand. Widen by the lines one
  // step would open (Infinity from Expand all or a shift-click).
  const onWindowExpand = useCallback((fold: WindowFold, lineCount: number) => {
    // The component clamps the window to the file.
    setFileWindow((current) =>
      fold.boundary === 'above'
        ? { start: Math.max(1, current.start - lineCount), end: current.end }
        : { start: current.start, end: current.end + lineCount }
    );
    return true;
  }, []);
  return (
    <File
      file={file}
      options={{
        theme,
        themeType,
        overflow,
        window: fileWindow,
        onWindowExpand,
      }}
    />
  );
}

// Inside a Virtualizer, a window makes the wrapper build a plain FileDiff.
function VirtualizerToggle({
  fileDiff,
  diffWindow,
  theme,
  themeType,
  overflow,
}: WindowedReactProps) {
  const [windowed, setWindowed] = useState(true);
  const [kind, setKind] = useState('');
  const onPostRender = useCallback(
    (_node: HTMLElement, instance: unknown, phase: string) => {
      // The old instance reports 'unmount' when the toggle replaces it.
      if (phase === 'unmount') return;
      setKind(
        instance instanceof VirtualizedFileDiff
          ? 'VirtualizedFileDiff'
          : 'FileDiff'
      );
    },
    []
  );
  return (
    <>
      <label style={{ font: '12px system-ui,sans-serif' }}>
        <input
          type="checkbox"
          data-virtualizer-toggle=""
          checked={windowed}
          onChange={(event) => setWindowed(event.target.checked)}
        />{' '}
        window {diffWindow.start}-{diffWindow.end} (instance:{' '}
        <code data-instance-kind="">{kind}</code>)
      </label>
      <Virtualizer style={{ height: 360, overflow: 'auto' }}>
        <FileDiff
          fileDiff={fileDiff}
          options={{
            theme,
            themeType,
            overflow,
            diffStyle: 'unified',
            window: windowed ? diffWindow : undefined,
            windowContextLines: 8,
            onPostRender,
          }}
        />
      </Virtualizer>
    </>
  );
}

// A full-width custom boundary fold: hidden line count, the new-file range it
// hides, an "includes changes" marker, and a button that opens 20 lines
// through the fold-id API.
function makeFullWidthSeparatorEl(
  fold: WindowFold,
  showMore: (count: number) => void
): HTMLElement {
  const bar = document.createElement('div');
  bar.style.cssText =
    'display:flex;gap:12px;align-items:center;padding:4px 12px;cursor:pointer;' +
    'width:100%;box-sizing:border-box;' +
    'font:12px system-ui,sans-serif;color:var(--diffs-fg,currentcolor);' +
    'background:color-mix(in srgb,currentcolor 6%,transparent)';
  const range =
    fold.newLineRange != null
      ? `new lines ${fold.newLineRange[0]}-${fold.newLineRange[1]}`
      : 'deleted lines only';
  const label = document.createElement('span');
  label.textContent = `${fold.boundary === 'above' ? '▲' : '▼'} ${fold.collapsedLines} hidden lines · ${range}`;
  bar.appendChild(label);
  if (fold.containsChanges) {
    const marker = document.createElement('span');
    marker.textContent = 'includes changes';
    marker.style.cssText =
      'padding:0 6px;border-radius:4px;background:color-mix(in srgb,orange 30%,transparent)';
    bar.appendChild(marker);
  }
  const more = document.createElement('button');
  more.textContent = 'Show 20 more';
  more.style.marginLeft = 'auto';
  more.addEventListener('click', (event) => {
    // Keep this click from also opening the fold the built-in way.
    event.stopPropagation();
    showMore(20);
  });
  bar.appendChild(more);
  return bar;
}
