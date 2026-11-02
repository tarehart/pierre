import {
  DEFAULT_THEMES,
  DIFFS_TAG_NAME,
  type DiffsThemeNames,
  type DiffWindow,
  File,
  type FileContents,
  FileDiff,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type FileDiffOptions,
  type FileOptions,
  FileStream,
  type FileStreamOptions,
  isHighlighterNull,
  parseDiffFromFile,
  type ParsedPatch,
  parsePatchFiles,
  preloadHighlighter,
  type SupportedLanguages,
  type ThemesType,
  UnresolvedFile,
  VirtualizedFile,
  VirtualizedFileDiff,
  Virtualizer,
  type WindowFold,
} from '@pierre/diffs';
import { Editor } from '@pierre/diffs/edit';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
import {
  IconCiFailedOctagonFill,
  IconCiWarningFill,
  IconInfoFill,
} from '@pierre/icons';
import { createTwoFilesPatch } from 'diff';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  cleanupCodeView,
  renderDemoCodeView,
  setCodeViewDiffStyle,
  setCodeViewOverflow,
  setCodeViewThemeType,
} from './codeViewDemo';
import {
  FAKE_DIFF_LINE_ANNOTATIONS,
  FAKE_LINE_ANNOTATIONS,
  FILE_CONFLICT,
  FILE_NEW,
  FILE_OLD,
  type LineCommentMetadata,
} from './mocks/';
import './style.css';
import mdContent from './mocks/example_md.txt?raw';
import tsContent from './mocks/example_ts.txt?raw';
import { createFakeContentStream } from './utils/createFakeContentStream';
import { createHeaderFilenameSuffixBadge } from './utils/createHeaderFilenameSuffixBadge';
import { createHighlighterCleanup } from './utils/createHighlighterCleanup';
import { createWorkerAPI } from './utils/createWorkerAPI';
import {
  renderAnnotation,
  renderDiffAnnotation,
} from './utils/renderAnnotation';
import {
  mountWindowedReactSections,
  type WindowedReactSections,
} from './windowedReact';

// FAKE_DIFF_LINE_ANNOTATIONS.length = 0;
// FAKE_LINE_ANNOTATIONS.length = 0;
const DEMO_THEME: DiffsThemeNames | ThemesType = DEFAULT_THEMES;
const WORKER_POOL = true;
const VIRTUALIZE = true;
const CRAZY_FILE = false;
const LARGE_CONFLICT_FILE = false;
const RENDER_FILENAME_SUFFIX = false;
const CODE_VIEW_TYPE: 'old-new-full' | 'old-new-hydration' | 'patch-file' =
  'old-new-full';

// Pre-render the @pierre/icons SVG markup once so it can be embedded into the
// `message.html` strings the editor injects for markers. The icons default to
// `fill: currentcolor`, so each one inherits the surrounding text color.
const MARKER_INFO_ICON = renderToStaticMarkup(
  createElement(IconInfoFill, { size: 16 })
);
const MARKER_WARNING_ICON = renderToStaticMarkup(
  createElement(IconCiWarningFill, { size: 16 })
);
const MARKER_ERROR_ICON = renderToStaticMarkup(
  createElement(IconCiFailedOctagonFill, { size: 16 })
);

// Builds the HTML for a marker overlay: a leading icon and message with an
// indented description. The popover is severity-colored (see editor.css), so
// the icon and text inherit white instead of painting their own color, which
// would vanish against the fill.
function markerMessage(opts: {
  icon: string;
  message: string;
  description: string;
}): string {
  const iconCol = `<span style="display:inline-flex;flex:none;margin-top:2px">${opts.icon}</span>`;
  const textCol = `<div style="display:flex;flex-direction:column;gap:2px">${opts.message}<div style="opacity:0.8">${opts.description}</div></div>`;
  return `<div style="display:flex;align-items:flex-start;gap:8px">${iconCol}${textCol}</div>`;
}

const FileStreamCodeConfigs: FileStreamCodeConfigsItem[] = [
  {
    content: tsContent,
    letterByLetter: false,
    options: {
      lang: 'tsx',
      theme: DEMO_THEME,
      ...createHighlighterCleanup(),
    },
  },
  {
    content: mdContent,
    letterByLetter: true,
    options: {
      lang: 'markdown',
      theme: DEMO_THEME,
      ...createHighlighterCleanup(),
    },
  },
];

const diffInstances: (
  | FileDiff<LineCommentMetadata>
  | VirtualizedFileDiff<LineCommentMetadata>
)[] = [];
const fileInstances: File<LineCommentMetadata>[] = [];
const streamingInstances: FileStream[] = [];
const conflictInstances: UnresolvedFile<LineCommentMetadata>[] = [];
// React roots the windowed demo mounts.
const reactSections: WindowedReactSections[] = [];

interface FileStreamCodeConfigsItem {
  content: string;
  letterByLetter: boolean;
  options: FileStreamOptions;
}

interface HydratableRenderOptions {
  loadDiffFiles?: FileDiffContentsLoader;
}

interface CodeViewRenderData extends HydratableRenderOptions {
  parsedPatches: ParsedPatch[];
}

function cleanupInstances(container: HTMLElement) {
  for (const instances of [
    diffInstances,
    fileInstances,
    streamingInstances,
    conflictInstances,
  ]) {
    for (const instance of instances) {
      instance.cleanUp();
    }
    instances.length = 0;
  }
  for (const section of reactSections.splice(0)) {
    section.unmount();
  }
  cleanupCodeView(container);
  container.textContent = '';
  delete container.dataset.diff;
  editShortcutCallback = undefined;
}

let editShortcutCallback: (() => boolean | void) | undefined;
document.addEventListener('keydown', (event) => {
  if (event.key === 'e') {
    if (editShortcutCallback?.() === false) {
      event.preventDefault();
    }
  }
});

let loadingPatch: Promise<string> | undefined;
async function loadPatchContent() {
  loadingPatch =
    loadingPatch ??
    new Promise((resolve) => {
      void import('./mocks/diff.patch?raw').then(({ default: content }) =>
        resolve(content)
      );
    });
  return loadingPatch;
}

let loadingLargeConflict: Promise<FileContents> | undefined;
async function loadLargeConflictFile(): Promise<FileContents> {
  loadingLargeConflict =
    loadingLargeConflict ??
    new Promise((resolve) => {
      void import('./mocks/fileConflictLarge.txt?raw').then(
        ({ default: contents }) =>
          resolve({
            name: 'fileConflictLarge.ts',
            contents,
            cacheKey: 'file-conflict-large',
          })
      );
    });
  return loadingLargeConflict;
}

// Create worker API - helper handles worker creation automatically!
const poolManager: WorkerPoolManager | undefined = WORKER_POOL
  ? (() => {
      const manager = createWorkerAPI({
        theme: DEMO_THEME,
        langs: ['typescript', 'tsx'],
        useTokenTransformer: true,
      });
      void manager.initialize().then(() => {
        console.log('WorkerPoolManager initialized, with:', manager.getStats());
      });

      // @ts-expect-error bcuz
      window.__POOL = manager;
      return manager;
    })()
  : undefined;

const virtualizer: Virtualizer | undefined = (() =>
  VIRTUALIZE ? new Virtualizer() : undefined)();

function startStreaming() {
  const container = document.getElementById('wrapper');
  if (container == null) return;
  cleanupInstances(container);
  for (const { content, letterByLetter, options } of FileStreamCodeConfigs) {
    const instance = new FileStream(options);
    void instance.setup(
      createFakeContentStream(content, letterByLetter),
      container
    );
    streamingInstances.push(instance);
  }
}

let parsedPatches: ParsedPatch[] | undefined;

function createCodeViewFiles(): {
  oldFile: FileContents;
  newFile: FileContents;
} {
  return {
    oldFile: {
      name: 'file_old.ts',
      contents: FILE_OLD,
      cacheKey: 'code-view-file-old',
    },
    newFile: {
      name: 'file_new.ts',
      contents: FILE_NEW,
      cacheKey: 'code-view-file-new',
    },
  };
}

function createCodeViewNoTrailingExpansionFiles(): {
  oldFile: FileContents;
  newFile: FileContents;
} {
  const oldFile: FileContents = {
    name: 'no_trailing_expansion.ts',
    contents: [
      'const keepOne = "same";\n',
      'const keepTwo = "same";\n',
      'const keepThree = "same";\n',
      'const keepFour = "same";\n',
      'export const noTrailingExpansion = "old";\n',
    ].join(''),
    cacheKey: 'code-view-no-trailing-expansion-old',
  };
  const newFile: FileContents = {
    name: oldFile.name,
    contents: [
      'const keepOne = "same";\n',
      'const keepTwo = "same";\n',
      'const keepThree = "same";\n',
      'const keepFour = "same";\n',
      'export const noTrailingExpansion = "new";\n',
    ].join(''),
    cacheKey: 'code-view-no-trailing-expansion-new',
  };
  return { oldFile, newFile };
}

function createCodeViewFullPatches(
  oldFile: FileContents,
  newFile: FileContents
): ParsedPatch[] {
  return [{ files: [parseDiffFromFile(oldFile, newFile)] }];
}

function createCodeViewPartialPatches(
  oldFile: FileContents,
  newFile: FileContents
): ParsedPatch[] {
  return parsePatchFiles(
    createTwoFilesPatch(
      oldFile.name,
      newFile.name,
      oldFile.contents,
      newFile.contents,
      oldFile.header,
      newFile.header
    ),
    { cacheKeyPrefix: 'code-view-partial' }
  );
}

function createCodeViewNoTrailingExpansionPartialPatches(
  oldFile: FileContents,
  newFile: FileContents
): ParsedPatch[] {
  return parsePatchFiles(
    createTwoFilesPatch(
      oldFile.name,
      newFile.name,
      oldFile.contents,
      newFile.contents,
      oldFile.header,
      newFile.header,
      { context: 0 }
    ),
    { cacheKeyPrefix: 'code-view-no-trailing-expansion-partial' }
  );
}

async function loadCodeViewPatches(): Promise<CodeViewRenderData> {
  switch (CODE_VIEW_TYPE) {
    case 'old-new-full': {
      const { oldFile, newFile } = createCodeViewFiles();
      return { parsedPatches: createCodeViewFullPatches(oldFile, newFile) };
    }
    case 'old-new-hydration': {
      const { oldFile, newFile } = createCodeViewFiles();
      const noTrailingExpansionFiles = createCodeViewNoTrailingExpansionFiles();
      return {
        parsedPatches: [
          ...createCodeViewNoTrailingExpansionPartialPatches(
            noTrailingExpansionFiles.oldFile,
            noTrailingExpansionFiles.newFile
          ),
          ...createCodeViewPartialPatches(oldFile, newFile),
        ],
        loadDiffFiles(fileDiff) {
          console.log(
            'CodeView partial hydration demo loading full files',
            fileDiff
          );
          if (fileDiff.name === noTrailingExpansionFiles.newFile.name) {
            return Promise.resolve(noTrailingExpansionFiles);
          }
          return Promise.resolve({ oldFile, newFile });
        },
      };
    }
    case 'patch-file':
      return {
        parsedPatches: (parsedPatches ??= parsePatchFiles(
          await loadPatchContent(),
          { cacheKeyPrefix: 'parsed-patch' }
        )),
      };
  }
}

function handlePreloadCodeViewDiff() {
  if (CODE_VIEW_TYPE === 'patch-file') {
    void handlePreloadDiff();
  }
}

async function handlePreloadDiff() {
  if (parsedPatches != null) return;
  const content = await loadPatchContent();
  parsedPatches = parsePatchFiles(content, { cacheKeyPrefix: 'parsed-patch' });
  console.log('preloaded diff', parsedPatches);
}

function renderDiff(parsedPatches: ParsedPatch[], manager?: WorkerPoolManager) {
  console.log('renderDiff: rendering patches:', parsedPatches);
  const wrapper = document.getElementById('wrapper');
  if (wrapper == null) return;
  window.scrollTo({ top: 0 });
  cleanupInstances(wrapper);
  wrapper.dataset.diff = '';

  const unified = getUnified();
  const wrap = getWrapped();
  let patchIndex = 0;
  const themeType = getThemeType();

  virtualizer?.setup(globalThis.document);
  for (const parsedPatch of parsedPatches) {
    if (parsedPatch.patchMetadata != null) {
      wrapper.appendChild(createFileMetadata(parsedPatch.patchMetadata));
    }
    const patchAnnotations = FAKE_DIFF_LINE_ANNOTATIONS[patchIndex] ?? [];
    let hunkIndex = 0;
    for (const fileDiff of parsedPatch.files) {
      const editor = new Editor<'file-diff', LineCommentMetadata>('file-diff', {
        onAttach: (editor) => {
          editor.setSelections([
            {
              start: {
                line: 3,
                character: 1000, // will be normalized to the end of the line(< 1000 chars)
              },
              end: {
                line: 3,
                character: 1000, // will be normalized to the end of the line(< 1000 chars)
              },
              direction: 'none',
            },
          ]);
        },
        __debug: true,
      });
      const fileAnnotations = patchAnnotations[hunkIndex];
      let isEditing = false;
      const options: FileDiffOptions<LineCommentMetadata, undefined> = {
        theme: DEMO_THEME,
        themeType,
        diffStyle: unified ? 'unified' : 'split',
        overflow: wrap ? 'wrap' : 'scroll',
        renderAnnotation: renderDiffAnnotation,
        ...(RENDER_FILENAME_SUFFIX
          ? {
              renderHeaderFilenameSuffix() {
                return createHeaderFilenameSuffixBadge('Diff slot');
              },
            }
          : null),
        renderHeaderMetadata() {
          const collapseToggle = createToggle(
            'Collapse',
            instance?.options.collapsed ?? false,
            (checked) => {
              instance?.setOptions({
                ...instance.options,
                collapsed: checked,
              });
              if (!VIRTUALIZE) {
                void instance.rerender();
              }
            }
          );
          const editableToggle = createToggle(
            'Editable',
            isEditing,
            (checked) => {
              isEditing = checked;
              if (isEditing) {
                editor.edit(instance);
              } else {
                editor.cleanUp();
              }
            }
          );
          editShortcutCallback = (): boolean | void => {
            if (!isEditing) {
              editableToggle.querySelector('input')?.click();
              return false;
            }
          };
          const div = document.createElement('div');
          div.style.display = 'flex';
          div.style.gap = '8px';
          div.append(collapseToggle);
          if (!fileDiff.isPartial) {
            div.append(editableToggle);
          }
          return div;
        },
        lineHoverHighlight: 'both',
        expansionLineCount: 10,
        // expandUnchanged: true,

        // Hover Decoration Snippets
        enableGutterUtility: true,
        // onGutterUtilityClick(event) {
        //   console.log('onGutterUtilityClick', event);
        // },
        // renderGutterUtility(getHoveredLine) {
        //   const el = document.createElement('div');
        //   el.style.width = '20px';
        //   el.style.height = '20px';
        //   el.style.backgroundColor = 'blue';
        //   el.style.borderRadius = '2px';
        //   el.style.marginRight = '-10px';
        //   el.style.textAlign = 'center';
        //   el.style.color = 'white';
        //   el.innerText = '+';
        //   el.addEventListener('click', (event) => {
        //     event.stopPropagation();
        //     console.log('ZZZZ - clicked', getHoveredLine());
        //   });
        //   el.addEventListener('pointerdown', (event) => {
        //     event.stopPropagation();
        //   });
        //   return el;
        // },

        // Custom Hunk Separators Tests with expansion properties
        // expansionLineCount: 10,
        // hunkSeparators(hunkData, instance) {
        //   const fragment = document.createDocumentFragment();
        //   const numCol = document.createElement('div');
        //   numCol.textContent = `${hunkData.lines}`;
        //   numCol.style.position = 'sticky';
        //   numCol.style.left = '0';
        //   numCol.style.backgroundColor = 'blue';
        //   numCol.style.zIndex = '2';
        //   numCol.style.color = 'white';
        //   fragment.appendChild(numCol);
        //   const contentCol = document.createElement('div');
        //   contentCol.textContent = 'unmodified lines';
        //   contentCol.style.position = 'sticky';
        //   contentCol.style.width = 'var(--diffs-column-content-width)';
        //   contentCol.style.left = 'var(--diffs-column-number-width)';
        //   contentCol.style.backgroundColor = 'blue';
        //   contentCol.style.color = 'white';
        //   fragment.appendChild(contentCol);
        //   const { expandable } = hunkData;
        //   if (expandable != null) {
        //     if (expandable.up && expandable.down && !expandable.chunked) {
        //       const button = document.createElement('button');
        //       button.innerText = 'both';
        //       button.addEventListener('click', () => {
        //         instance.expandHunk(hunkData.hunkIndex, 'both');
        //       });
        //       contentCol.appendChild(button);
        //     } else {
        //       if (expandable.up) {
        //         const button = document.createElement('button');
        //         button.innerText = '^';
        //         button.addEventListener('click', () => {
        //           instance.expandHunk(hunkData.hunkIndex, 'up');
        //         });
        //         contentCol.appendChild(button);
        //       }
        //       if (expandable.down) {
        //         const button = document.createElement('button');
        //         button.innerText = 'v';
        //         button.addEventListener('click', () => {
        //           instance.expandHunk(hunkData.hunkIndex, 'down');
        //         });
        //         contentCol.appendChild(button);
        //       }
        //     }
        //   }
        //   return fragment;
        // },
        // hunkSeparators(hunkData) {
        //   const wrapper = document.createElement('div');
        //   wrapper.style.gridColumn = 'span 2';
        //   const contentCol = document.createElement('div');
        //   contentCol.textContent = `${hunkData.lines} unmodified lines`;
        //   contentCol.style.position = 'sticky';
        //   contentCol.style.width = 'var(--diffs-column-width)';
        //   contentCol.style.left = '0';
        //   wrapper.appendChild(contentCol);
        //   return wrapper;
        // },
        // hunkSeparators(hunkData) {
        //   const wrapper = document.createElement('div');
        //   wrapper.style.gridColumn = '2 / 3';
        //   wrapper.textContent = `${hunkData.lines} unmodified lines`;
        //   wrapper.style.position = 'sticky';
        //   wrapper.style.width = 'var(--diffs-column-content-width)';
        //   wrapper.style.left = 'var(--diffs-column-number-width)';
        //   return wrapper;
        // },

        // Line selection stuff
        enableLineSelection: true,
        // onLineClick(props) {
        //   console.log('onLineClick', props);
        // },
        // onLineNumberClick(props) {
        //   console.info('onLineNumberClick', props);
        // },
        // onLineSelected(props) {
        //   console.log('onLineSelected', props);
        // },
        // onLineSelectionStart(props) {
        //   console.log('onLineSelectionStart', props);
        // },
        // onLineSelectionChange(props) {
        //   console.log('onLineSelectionChange', props);
        // },
        // onLineSelectionEnd(props) {
        //   console.log('onLineSelectionEnd', props);
        // },
        // Super noisy, but for debuggin
        // onLineEnter(props) {
        //   console.log('onLineEnter', props);
        // },
        // onLineLeave(props) {
        //   console.log('onLineLeave', props);
        // },
        // __debugMouseEvents: 'click',

        // Token Testing Helpers
        // onTokenEnter(props) {
        //   console.log(
        //     'enter',
        //     props.tokenText,
        //     props.lineNumber,
        //     props.lineCharStart
        //   );
        //   props.tokenElement.style.backgroundColor = 'light-dark(black, white)';
        //   props.tokenElement.style.color = 'light-dark(white, black)';
        //   props.tokenElement.style.borderRadius = '2px';
        // },
        // onTokenLeave(props) {
        //   console.log(
        //     'leave',
        //     props.tokenText,
        //     props.lineNumber,
        //     props.lineCharStart
        //   );
        //   props.tokenElement.style.backgroundColor = '';
        //   props.tokenElement.style.color = '';
        //   props.tokenElement.style.borderRadius = '';
        // },
      };
      const instance:
        | FileDiff<LineCommentMetadata>
        | VirtualizedFileDiff<LineCommentMetadata> = (() => {
        if (virtualizer != null) {
          return new VirtualizedFileDiff<LineCommentMetadata>(
            options,
            virtualizer,
            undefined,
            manager
          );
        } else {
          return new FileDiff<LineCommentMetadata>(options, manager);
        }
      })();

      const fileContainer = document.createElement(DIFFS_TAG_NAME);
      wrapper.appendChild(fileContainer);
      // This is weird...
      instance.render({
        fileDiff,
        lineAnnotations: fileAnnotations,
        fileContainer,
      });
      diffInstances.push(instance);
      hunkIndex++;
    }
    patchIndex++;
  }
  // window.scrollTo({ top: 70747 });
}

function renderCodeView(
  parsedPatches: ParsedPatch[],
  { loadDiffFiles }: HydratableRenderOptions = {}
) {
  const wrapper = document.getElementById('wrapper');
  if (wrapper == null) return;
  window.scrollTo({ top: 0 });
  cleanupInstances(wrapper);
  renderDemoCodeView(wrapper, parsedPatches, {
    theme: DEMO_THEME,
    themeType: getThemeType(),
    diffStyle: getUnified() ? 'unified' : 'split',
    overflow: getWrapped() ? 'wrap' : 'scroll',
    loadDiffFiles,
    workerManager: poolManager,
  });
}

function createFileMetadata(patchMetadata: string) {
  const metadata = document.createElement('div');
  metadata.dataset.commitMetadata = '';
  metadata.innerText = patchMetadata.replace(/\n+$/, '');
  return metadata;
}

const workerInstances: Promise<unknown>[] = [];
// FIXME(amadeus): Don't export this, lawl
export function workerRenderDiff(parsedPatches: ParsedPatch[]) {
  workerInstances.length = 0;

  console.log('Worker Render: Starting to async render patch');
  for (const parsedPatch of parsedPatches) {
    for (const fileDiff of parsedPatch.files) {
      const start = Date.now();
      poolManager?.highlightDiffAST(
        {
          __id: 'hack',
          onHighlightSuccess(_diff, { code }) {
            console.log(
              'Worker Render: rendered file:',
              fileDiff.name,
              'lines:',
              code.additionLines.length + code.deletionLines.length,
              'time:',
              Date.now() - start
            );
          },
          onHighlightError(error: unknown) {
            console.error(error);
          },
        },
        fileDiff
      );
    }
  }
}

function handlePreload() {
  if (isHighlighterNull() !== true) return;
  const langs: SupportedLanguages[] = [];
  const themes: DiffsThemeNames[] = [];
  for (const item of FileStreamCodeConfigs) {
    if (item.options.lang != null) {
      langs.push(item.options.lang);
    }
    if (item.options.theme == null) {
      continue;
    } else if (typeof item.options.theme === 'string') {
      themes.push(item.options.theme);
    } else {
      themes.push(item.options.theme.dark);
      themes.push(item.options.theme.light);
    }
  }
  // Match the pool even during initialization; two types cannot coexist.
  void preloadHighlighter({
    langs,
    themes,
    preferredHighlighter: poolManager?.getPreferredHighlighter(),
  });
}

document.getElementById('toggle-theme')?.addEventListener('click', toggleTheme);

const streamCode = document.getElementById('stream-code');
if (streamCode != null) {
  streamCode.addEventListener('click', startStreaming);
  streamCode.addEventListener('pointerenter', handlePreload);
}

const loadDiff = document.getElementById('load-diff');
if (loadDiff != null) {
  function handleClick() {
    void (async () => {
      parsedPatches ??= parsePatchFiles(await loadPatchContent(), {
        cacheKeyPrefix: 'parsed-patch',
      });
      renderDiff(parsedPatches, poolManager);
      // window.scrollTo({ top: 99999999999 });
    })();
  }

  // void poolManager.initialize().then(() => handleClick());
  loadDiff.addEventListener('click', handleClick);
  loadDiff.addEventListener('pointerenter', () => void handlePreloadDiff());
}

const renderCodeViewButton = document.getElementById('render-code-view');
if (renderCodeViewButton != null) {
  renderCodeViewButton.addEventListener('click', () => {
    void (async () => {
      const { parsedPatches, loadDiffFiles } = await loadCodeViewPatches();
      renderCodeView(parsedPatches, { loadDiffFiles });
    })();
  });
  renderCodeViewButton.addEventListener(
    'pointerenter',
    handlePreloadCodeViewDiff
  );
}

const wrapCheckbox = document.getElementById('wrap-lines');
function getWrapped(): boolean {
  return wrapCheckbox instanceof HTMLInputElement
    ? wrapCheckbox.checked
    : false;
}
if (wrapCheckbox != null) {
  wrapCheckbox.addEventListener('change', ({ currentTarget }) => {
    if (!(currentTarget instanceof HTMLInputElement)) {
      return;
    }
    const { checked } = currentTarget;
    for (const instance of diffInstances) {
      instance.setOptions({
        ...instance.options,
        overflow: checked ? 'wrap' : 'scroll',
      });
      if (!VIRTUALIZE) {
        void instance.rerender();
      }
    }
    for (const instance of fileInstances) {
      instance.setOptions({
        ...instance.options,
        overflow: checked ? 'wrap' : 'scroll',
      });
      void instance.rerender();
    }
    for (const section of reactSections) {
      section.update({ overflow: checked ? 'wrap' : 'scroll' });
    }
    setCodeViewOverflow(checked ? 'wrap' : 'scroll');
  });
}

const unifiedCheckbox = document.getElementById('unified');
function getUnified(): boolean {
  return unifiedCheckbox instanceof HTMLInputElement
    ? unifiedCheckbox.checked
    : false;
}
if (unifiedCheckbox instanceof HTMLInputElement) {
  unifiedCheckbox.addEventListener('change', () => {
    const checked = unifiedCheckbox.checked;
    for (const instance of diffInstances) {
      instance.setOptions({
        ...instance.options,
        diffStyle: checked ? 'unified' : 'split',
      });
      if (!VIRTUALIZE) {
        void instance.rerender();
      }
    }
    setCodeViewDiffStyle(checked ? 'unified' : 'split');
  });
}

let lastWrapper: HTMLElement | undefined;
const diff2Files = document.getElementById('diff-files');
if (diff2Files != null) {
  diff2Files.addEventListener('click', () => {
    if (lastWrapper != null) {
      lastWrapper.remove();
    }
    lastWrapper = document.createElement('div');

    const fileOldContainer = document.createElement('div');
    fileOldContainer.className = 'file';
    lastWrapper.className = 'files-input';
    const fileOldName = document.createElement('input');
    fileOldName.type = 'text';
    fileOldName.value = 'file_old.ts';
    fileOldName.spellcheck = false;
    const fileOldContents = document.createElement('textarea');
    fileOldContents.value = FILE_OLD;
    fileOldContents.spellcheck = false;
    fileOldContainer.appendChild(fileOldName);
    fileOldContainer.appendChild(fileOldContents);
    lastWrapper.appendChild(fileOldContainer);

    const fileNewContainer = document.createElement('div');
    fileNewContainer.className = 'file';
    lastWrapper.className = 'files-input';
    const fileNewName = document.createElement('input');
    fileNewName.type = 'text';
    fileNewName.value = 'file_new.ts';
    fileNewName.spellcheck = false;
    const fileNewContents = document.createElement('textarea');
    fileNewContents.value = FILE_NEW;
    fileNewContents.spellcheck = false;
    fileNewContainer.appendChild(fileNewName);
    fileNewContainer.appendChild(fileNewContents);
    lastWrapper.appendChild(fileNewContainer);

    const bottomWrapper = document.createElement('div');
    bottomWrapper.className = 'buttons';
    const render = document.createElement('button');
    render.innerText = 'Render Diff';
    render.addEventListener('click', () => {
      const oldFile: FileContents = {
        name: fileOldName.value,
        contents: fileOldContents.value,
        cacheKey: `old-${fileOldContents.value}`,
      };
      const newFile = {
        name: fileNewName.value,
        contents: fileNewContents.value,
        cacheKey: `new-${fileNewContents.value}`,
      };

      lastWrapper?.remove();
      const parsed = parseDiffFromFile(oldFile, newFile);
      console.log('ZZZZZ - parsed', parsed);
      renderDiff([{ files: [parsed] }], poolManager);
    });
    bottomWrapper.appendChild(render);

    const cancel = document.createElement('button');
    cancel.innerText = 'Cancel';
    bottomWrapper.appendChild(cancel);

    cancel.addEventListener('click', () => {
      lastWrapper?.remove();
    });

    lastWrapper.append(bottomWrapper);

    document.body.appendChild(lastWrapper);
  });
}

function toggleTheme() {
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
  const pageTheme =
    (document.documentElement.dataset.themeType ?? systemTheme) === 'dark'
      ? 'dark'
      : 'light';
  const nextTheme = pageTheme === 'dark' ? 'light' : 'dark';

  document.documentElement.dataset.themeType = nextTheme;

  for (const instances of [
    diffInstances,
    fileInstances,
    streamingInstances,
    conflictInstances,
  ]) {
    for (const instance of instances) {
      instance.setThemeType(nextTheme);
    }
  }
  for (const section of reactSections) {
    section.update({ themeType: nextTheme });
  }
  setCodeViewThemeType(nextTheme);
}

const fileExample: FileContents | Promise<FileContents> = (() => {
  if (CRAZY_FILE) {
    return new Promise<FileContents>((resolve) => {
      void import('../../../pnpm-lock.yaml?raw').then(({ default: contents }) =>
        resolve({
          name: 'pnpm-lock.yaml',
          contents,
          cacheKey: 'diff',
        })
      );
    });
  }
  return {
    name: 'main.tsx',
    contents: FILE_NEW,
    cacheKey: 'file',
  };
})();

const fileConflict: FileContents = {
  name: 'file.ts',
  contents: FILE_CONFLICT,
};

const renderFileButton = document.getElementById('render-file');
if (renderFileButton != null) {
  // oxlint-disable-next-line typescript/no-misused-promises
  renderFileButton.addEventListener('click', async () => {
    const file = await fileExample;
    const wrapper = document.getElementById('wrapper');
    if (wrapper == null) return;
    cleanupInstances(wrapper);

    virtualizer?.setup(globalThis.document);
    const wrap = getWrapped();
    const editor = new Editor<'file', LineCommentMetadata>('file', {
      enabledSelectionAction: true,
      renderSelectionAction: (ctx) => {
        const div = document.createElement('div');
        const button = document.createElement('button');
        button.innerText = `Comment the selection`;
        button.addEventListener('click', () => {
          const lines = ctx.getSelectionText().split('\n');
          const comment = lines
            .map((line) => (line.startsWith('//') ? line : `// ${line}`))
            .join('\n');
          ctx.replaceSelectionText(comment);
          ctx.close();
        });
        div.appendChild(button);
        return div;
      },
      onChange: ({ file, lineAnnotations }) => {
        console.log('change', file, lineAnnotations);
      },
      onAttach: (editor) => {
        const { selections } = editor.getViewState();
        if (selections === undefined || selections.length === 0) {
          editor.setSelections([
            {
              start: {
                line: 0,
                character: 1000, // will be normalized to the end of the line(< 1000 chars)
              },
              end: {
                line: 0,
                character: 1000, // will be normalized to the end of the line(< 1000 chars)
              },
              direction: 'none',
            },
          ]);
          editor.setMarkers([
            {
              start: {
                line: 1,
                character: 2,
              },
              end: {
                line: 1,
                character: 1000, // will be normalized to the end of the line(< 1000 chars)
              },
              severity: 'info',
              message: {
                html: markerMessage({
                  icon: MARKER_INFO_ICON,
                  message: '<code>CodeOptionsMultipleThemes</code>',
                  description: 'Code options of multiple themes.',
                }),
              },
            },
            {
              start: {
                line: 2,
                character: 2,
              },
              end: {
                line: 2,
                character: 1000, // will be normalized to the end of the line(< 1000 chars)
              },
              severity: 'warning',
              message: {
                html: markerMessage({
                  icon: MARKER_WARNING_ICON,
                  message: '<code>CodeToHastOptions</code>',
                  description: 'Code to Hast Options is deprecated.',
                }),
              },
            },
            {
              start: {
                line: 3,
                character: 2,
              },
              end: {
                line: 3,
                character: 1000, // will be normalized to the end of the line(< 1000 chars)
              },
              severity: 'error',
              message: {
                html: markerMessage({
                  icon: MARKER_ERROR_ICON,
                  message: '<code>DecorationItem</code>',
                  description: 'Type not defined.',
                }),
              },
            },
          ]);
        }
      },
      __debug: true,
    });
    Object.assign(window, { editor });
    const fileContainer = document.createElement(DIFFS_TAG_NAME);
    wrapper.appendChild(fileContainer);
    let isEditing = false;
    const options: FileOptions<LineCommentMetadata, undefined> = {
      overflow: wrap ? 'wrap' : 'scroll',
      theme: DEMO_THEME,
      themeType: getThemeType(),
      renderAnnotation,
      ...(RENDER_FILENAME_SUFFIX
        ? {
            renderHeaderFilenameSuffix() {
              return createHeaderFilenameSuffixBadge('File slot');
            },
          }
        : null),
      renderHeaderMetadata() {
        const collapsedToggle = createToggle(
          'Collapse',
          instance?.options.collapsed ?? false,
          (checked) => {
            instance?.setOptions({
              ...instance.options,
              collapsed: checked,
            });
            if (!VIRTUALIZE) {
              void instance.rerender();
            }
          }
        );
        const editableToggle = createToggle(
          'Editable',
          isEditing,
          (checked) => {
            isEditing = checked;
            if (isEditing) {
              editor.edit(instance);
            } else {
              editor.cleanUp();
            }
          }
        );
        editShortcutCallback = (): boolean | void => {
          if (!isEditing) {
            editableToggle.querySelector('input')?.click();
            return false;
          }
        };
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.gap = '8px';
        div.append(collapsedToggle, editableToggle);
        return div;
      },

      // Line selection stuff
      enableLineSelection: true,
      // onLineClick(props) {
      //   console.log('onLineClick', props);
      // },
      // onLineNumberClick(props) {
      //   console.info('onLineNumberClick', props);
      // },
      // onLineSelected(props) {
      //   console.log('onLineSelected', props);
      // },
      // onLineSelectionStart(props) {
      //   console.log('onLineSelectionStart', props);
      // },
      // onLineSelectionChange(props) {
      //   console.log('onLineSelectionChange', props);
      // },
      // onLineSelectionEnd(props) {
      //   console.log('onLineSelectionEnd', props);
      // },
      // Super noisy, but for debuggin
      // onLineEnter(props) {
      //   console.log('onLineEnter', props);
      // },
      // onLineLeave(props) {
      //   console.log('onLineLeave', props);
      // },

      // Hover Decoration Snippets
      enableGutterUtility: true,
      // onGutterUtilityClick(event) {
      //   console.log('onGutterUtilityClick', event);
      // },
      // renderGutterUtility(getHoveredLine) {
      //   const el = document.createElement('div');
      //   el.style.width = '20px';
      //   el.style.height = '20px';
      //   el.style.backgroundColor = 'blue';
      //   el.style.borderRadius = '2px';
      //   el.style.marginRight = '-10px';
      //   el.style.textAlign = 'center';
      //   el.style.color = 'white';
      //   el.innerText = '+';
      //   el.addEventListener('click', (event) => {
      //     event.stopPropagation();
      //     console.log('ZZZZ - clicked', getHoveredLine());
      //   });
      //   el.addEventListener('mousedown', (event) => {
      //     event.stopPropagation();
      //   });
      //   return el;
      // },

      // Token Testing Helpers
      // onTokenEnter(props) {
      //   console.log(
      //     'enter',
      //     props.tokenText,
      //     props.lineNumber,
      //     props.lineCharStart
      //   );
      //   props.tokenElement.style.backgroundColor = 'light-dark(black, white)';
      //   props.tokenElement.style.color = 'light-dark(white, black)';
      //   props.tokenElement.style.borderRadius = '2px';
      // },
      // onTokenLeave(props) {
      //   console.log(
      //     'leave',
      //     props.tokenText,
      //     props.lineNumber,
      //     props.lineCharStart
      //   );
      //   props.tokenElement.style.backgroundColor = '';
      //   props.tokenElement.style.color = '';
      //   props.tokenElement.style.borderRadius = '';
      // },
    };

    const instance:
      | File<LineCommentMetadata>
      | VirtualizedFile<LineCommentMetadata> = (() => {
      if (virtualizer != null) {
        return new VirtualizedFile<LineCommentMetadata>(
          options,
          virtualizer,
          undefined,
          poolManager
        );
      } else {
        return new File<LineCommentMetadata>(options, poolManager);
      }
    })();
    instance.render({
      file,
      lineAnnotations: FAKE_LINE_ANNOTATIONS,
      fileContainer,
    });
    fileInstances.push(instance);
  });
}

const renderFileConflictButton = document.getElementById('render-conflict');
if (renderFileConflictButton != null) {
  // oxlint-disable-next-line typescript/no-misused-promises
  renderFileConflictButton.addEventListener('click', async () => {
    const wrapper = document.getElementById('wrapper');
    if (wrapper == null) {
      return;
    }
    cleanupInstances(wrapper);
    const wrap = getWrapped();
    const fileContainer = document.createElement(DIFFS_TAG_NAME);
    wrapper.appendChild(fileContainer);
    const instance = new UnresolvedFile<LineCommentMetadata>(
      {
        theme: DEMO_THEME,
        themeType: getThemeType(),
        overflow: wrap ? 'wrap' : 'scroll',
        renderAnnotation,
        ...(RENDER_FILENAME_SUFFIX
          ? {
              renderHeaderFilenameSuffix() {
                return createHeaderFilenameSuffixBadge('Conflict slot');
              },
            }
          : null),
        enableLineSelection: true,
        enableGutterUtility: true,
        maxContextLines: 4,

        // Token Testing Helpers
        // onTokenEnter(props) {
        //   console.log(
        //     'enter',
        //     props.tokenText,
        //     props.lineNumber,
        //     props.lineCharStart
        //   );
        //   props.tokenElement.style.backgroundColor = 'light-dark(black, white)';
        //   props.tokenElement.style.color = 'light-dark(white, black)';
        //   props.tokenElement.style.borderRadius = '2px';
        // },
        // onTokenLeave(props) {
        //   console.log(
        //     'leave',
        //     props.tokenText,
        //     props.lineNumber,
        //     props.lineCharStart
        //   );
        //   props.tokenElement.style.backgroundColor = '';
        //   props.tokenElement.style.color = '';
        //   props.tokenElement.style.borderRadius = '';
        // },
      },
      poolManager
    );
    const file = LARGE_CONFLICT_FILE
      ? await loadLargeConflictFile()
      : fileConflict;
    instance.render({
      file,
      // lineAnnotations: FAKE_DIFF_LINE_ANNOTATIONS[0][0],
      fileContainer,
    });
    conflictInstances.push(instance);
  });
}

const workerRenderButton = document.getElementById('worker-load-diff');
workerRenderButton?.addEventListener('click', () => {
  void (async () => {
    const patches = parsePatchFiles(await loadPatchContent(), {
      cacheKeyPrefix: 'parsed-patch',
    });
    workerRenderDiff(patches);
  })();
});

function getThemeType() {
  const parentThemeSetting = document.documentElement.dataset.themeType;
  return parentThemeSetting === 'dark'
    ? 'dark'
    : parentThemeSetting === 'light'
      ? 'light'
      : 'system';
}

const cleanButton = document.getElementById('clean');
cleanButton?.addEventListener('click', () => {
  const container = document.getElementById('wrapper');
  if (container == null) {
    return;
  }
  cleanupInstances(container);
});

const lagRadarCheckbox = document.getElementById('lag-radar');
const radar = document.getElementById('radar');
if (lagRadarCheckbox != null && radar != null) {
  const { default: lagRadar } =
    // @ts-expect-error dynamic import
    await import('https://mobz.github.io/lag-radar/lag-radar.js');
  let dispose: (() => void) | undefined;
  lagRadarCheckbox.addEventListener('change', () => {
    if (
      lagRadarCheckbox instanceof HTMLInputElement &&
      lagRadarCheckbox.checked
    ) {
      dispose = lagRadar({
        parent: radar,
        size: 100,
        frames: 60,
      });
      radar.style.display = 'block';
    } else {
      dispose?.();
      dispose = undefined;
      radar.style.display = 'none';
    }
  });
}

// ---------------------------------------------------------------------------
// Windowed Demo: the `window` option on FileDiff and File.
// ---------------------------------------------------------------------------

// Custom label for a windowed boundary fold (renderWindowSeparator). The
// library calls it only for the above/below folds; interior folds always use
// the built-in separator.
function makeSeparatorEl(fold: WindowFold): HTMLElement {
  const btn = document.createElement('button');
  const count = fold.collapsedLines;
  const noun = count === 1 ? 'line' : 'lines';
  const label = `${fold.boundary === 'above' ? '▲' : '▼'} ${count} hidden ${noun}${fold.containsChanges ? ' (includes changes)' : ''}`;
  btn.textContent = label;
  btn.style.cssText =
    'all:unset;cursor:pointer;font:var(--diffs-font-size,13px)/1 var(--diffs-font-family,monospace);' +
    'color:var(--diffs-fg,currentcolor);opacity:0.6;padding:2px 8px;' +
    'text-decoration:underline dotted;';
  return btn;
}

function makeHeading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = text;
  h.style.cssText =
    'font:bold 14px system-ui,sans-serif;margin:16px 0 4px;color:var(--diffs-fg,currentcolor)';
  return h;
}

function makeNote(text: string): HTMLElement {
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText =
    'font:12px system-ui,sans-serif;margin:0 0 8px;color:var(--diffs-fg,currentcolor);opacity:0.7';
  return p;
}

// The window widened by `lineCount` lines at the edge of a boundary fold
// (`Infinity`, from an expand-all or shift-click, reaches the file edge).
function widenWindowForBoundary(
  current: DiffWindow,
  boundary: 'above' | 'below',
  lineCount: number,
  lastLine: number
): DiffWindow {
  return boundary === 'above'
    ? { start: Math.max(1, current.start - lineCount), end: current.end }
    : {
        start: current.start,
        end: Math.min(lastLine, current.end + lineCount),
      };
}

interface WindowedFileDiffConfig {
  heading: string;
  note?: string;
  diffStyle: 'unified' | 'split';
  window: DiffWindow;
  windowContextLines: number;
  customSeparator?: boolean;
  // Host-owned expansion of the above/below folds; `widen` re-renders with a
  // new window. Without it, every fold reveals lines in place.
  onWindowExpand?: (
    fold: WindowFold,
    lineCount: number,
    current: DiffWindow,
    widen: (next: DiffWindow) => void
  ) => boolean | void;
}

// Builds, renders and registers one windowed FileDiff; returns its container.
function buildWindowedFileDiff(
  wrapper: HTMLElement,
  fileDiff: FileDiffMetadata,
  config: WindowedFileDiffConfig
): HTMLElement {
  wrapper.appendChild(makeHeading(config.heading));
  if (config.note != null) {
    wrapper.appendChild(makeNote(config.note));
  }
  let windowState: DiffWindow = { ...config.window };
  const container = document.createElement(DIFFS_TAG_NAME);
  wrapper.appendChild(container);
  const widen = (next: DiffWindow) => {
    windowState = next;
    instance.setOptions({ ...instance.options, window: windowState });
    instance.render({ fileDiff, fileContainer: container, forceRender: true });
  };
  const { onWindowExpand } = config;
  const instance: FileDiff<LineCommentMetadata> =
    new FileDiff<LineCommentMetadata>({
      theme: DEMO_THEME,
      themeType: getThemeType(),
      diffStyle: config.diffStyle,
      overflow: getWrapped() ? 'wrap' : 'scroll',
      enableLineSelection: true,
      window: windowState,
      windowContextLines: config.windowContextLines,
      onWindowExpand:
        onWindowExpand != null
          ? (fold, lineCount) =>
              onWindowExpand(fold, lineCount, windowState, widen)
          : undefined,
      renderWindowSeparator:
        config.customSeparator === true ? makeSeparatorEl : undefined,
    });
  instance.render({ fileDiff, fileContainer: container });
  diffInstances.push(instance);
  return container;
}

function renderWindowedDemo() {
  const wrapper = document.getElementById('wrapper');
  if (wrapper == null) return;
  cleanupInstances(wrapper);

  const oldFile: FileContents = {
    name: 'highlighter.ts',
    contents: FILE_OLD,
    cacheKey: 'windowed-demo-old',
  };
  const newFile: FileContents = {
    name: 'highlighter.ts',
    contents: FILE_NEW,
    cacheKey: 'windowed-demo-new',
  };
  const fileDiff = parseDiffFromFile(oldFile, newFile);
  // One view shows every fold kind: the above fold hides real changes (lines
  // 1-545 are full of edits), the 64-line unchanged run between the change
  // blocks near lines 554 and 635 folds into an interior separator at 8
  // context lines, and the below fold (671-711) hides no change.
  const diffWindow: DiffWindow = { start: 546, end: 670 };
  const diffRange = `${diffWindow.start}-${diffWindow.end}`;

  // 1. Built-in separators (split); clicking a fold reveals lines in place.
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading: `Windowed FileDiff — built-in separators (split, lines ${diffRange})`,
    diffStyle: 'split',
    window: diffWindow,
    windowContextLines: 8,
  });

  // 2. renderWindowSeparator draws the above/below folds; the interior fold
  // keeps the built-in separator.
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading: `Windowed FileDiff — custom boundary separators (unified, lines ${diffRange})`,
    diffStyle: 'unified',
    window: diffWindow,
    windowContextLines: 8,
    customSeparator: true,
  });

  // 3. Host-owned widening of the boundary folds. The note below the
  // instance reports each onWindowExpand call and what the widen added.
  const expandNote = makeNote(
    'Click the above or below fold: onWindowExpand gets the fold and the lines one step would open (Infinity for Expand all or a shift-click), and widens the window by that much. The interior fold never calls it and opens in place.'
  );
  const expandContainer = buildWindowedFileDiff(wrapper, fileDiff, {
    heading: 'Windowed FileDiff — onWindowExpand widens the boundary folds',
    diffStyle: 'unified',
    window: diffWindow,
    windowContextLines: 8,
    customSeparator: true,
    onWindowExpand: (fold, lineCount, current, widen) => {
      // Never true (interior folds do not call the hook); narrows the type.
      if (fold.boundary === 'interior') return undefined;
      const hidden =
        fold.newLineRange != null
          ? `new lines ${fold.newLineRange[0]}-${fold.newLineRange[1]}`
          : 'deleted lines only';
      const summary = `Last onWindowExpand call: ${fold.boundary} fold (hid ${hidden}), lineCount=${lineCount}.`;
      const widened = widenWindowForBoundary(
        current,
        fold.boundary,
        lineCount,
        fileDiff.additionLines.length
      );
      const [addedStart, addedEnd] =
        fold.boundary === 'above'
          ? [widened.start, current.start - 1]
          : [current.end + 1, widened.end];
      expandNote.textContent =
        addedEnd >= addedStart
          ? `${summary} Window widened to ${widened.start}-${widened.end}, adding new lines ${addedStart}-${addedEnd}.`
          : `${summary} The window already reaches that end of the file.`;
      widen(widened);
      return true;
    },
  });
  expandContainer.insertAdjacentElement('afterend', expandNote);

  // 4. The same window with a 3-line budget: the run between the two changes
  // keeps only 3 lines at each end.
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading: `Windowed FileDiff — windowContextLines: 3 (split, lines ${diffRange})`,
    diffStyle: 'split',
    window: diffWindow,
    windowContextLines: 3,
  });

  // 5. A change cut at the window edge. Old lines 296-297 were replaced by
  // new lines 370-371; the window starts at 371. Split shows the one row
  // old 297 | new 371; unified lists removed lines first, so it shows -297, a
  // one-line fold hiding +370, then +371.
  const cutWindow: DiffWindow = { start: 371, end: 385 };
  for (const diffStyle of ['split', 'unified'] as const) {
    buildWindowedFileDiff(wrapper, fileDiff, {
      heading: `Windowed FileDiff — a change cut at the window edge (${diffStyle}, lines ${cutWindow.start}-${cutWindow.end})`,
      note: 'Old 296-297 became new 370-371; only new 371 is in the window, so only it and the line it replaced (old 297) show.',
      diffStyle,
      window: cutWindow,
      windowContextLines: 3,
    });
  }

  // 7-9 use the React wrappers (windowedReact.tsx); the page toggles reach
  // them through update().
  reactSections.push(
    mountWindowedReactSections(wrapper, {
      fileDiff,
      file: newFile,
      diffWindow,
      theme: DEMO_THEME,
      themeType: getThemeType(),
      overflow: getWrapped() ? 'wrap' : 'scroll',
    })
  );
}

const renderWindowedButton = document.getElementById('render-windowed');
renderWindowedButton?.addEventListener('click', renderWindowedDemo);

function createToggle(
  labelText: string,
  checked: boolean,
  onChange: (checked: boolean) => void
): HTMLElement {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => {
    onChange(input.checked);
  });
  label.dataset.collapser = '';
  label.appendChild(input);
  label.appendChild(document.createTextNode(` ${labelText}`));
  return label;
}

// For quick testing diffs
// FAKE_DIFF_LINE_ANNOTATIONS.length = 0;
// (() => {
//   const oldFile = {
//     name: 'file_old.ts',
//     contents: FILE_OLD,
//   };
//   const newFile = {
//     name: 'file_new.ts',
//     contents: FILE_NEW,
//   };
//   const parsed = parseDiffFromFile(oldFile, newFile);
//   renderDiff([{ files: [parsed] }], poolManager);
// })();
