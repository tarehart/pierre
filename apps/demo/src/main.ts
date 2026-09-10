import {
  DEFAULT_THEMES,
  type DiffLineAnnotation,
  DIFFS_TAG_NAME,
  type DiffsThemeNames,
  type DiffWindow,
  type ExpansionDirections,
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
        preferredHighlighter: 'shiki-wasm',
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
    'code-view-partial'
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
    'code-view-no-trailing-expansion-partial'
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
          'parsed-patch'
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
  parsedPatches = parsePatchFiles(content, 'parsed-patch');
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
  void preloadHighlighter({ langs, themes });
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
      parsedPatches ??= parsePatchFiles(
        await loadPatchContent(),
        'parsed-patch'
      );
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
    const patches = parsePatchFiles(await loadPatchContent(), 'parsed-patch');
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
// Windowed Demo
// Demonstrates the window option on FileDiff (diff windowing) and File (plain
// file windowing) side by side, with interactive expand and a custom separator.
// ---------------------------------------------------------------------------

// --- Shared separator renderer ---
// Renders a custom fold label for a windowed separator. Shared by every
// windowed-demo instance that opts out of the built-in separator, so custom
// vs. built-in rendering is directly comparable across variants.
function makeSeparatorEl(fold: WindowFold): HTMLElement {
  const btn = document.createElement('button');
  const label =
    fold.boundary === 'interior'
      ? `▼ ${fold.collapsedLines} unchanged lines`
      : fold.boundary === 'above'
        ? `▲ ${fold.collapsedLines} hidden lines${fold.containsChanges ? ' (contains changes)' : ''}`
        : `▼ ${fold.collapsedLines} hidden lines${fold.containsChanges ? ' (contains changes)' : ''}`;
  btn.textContent = label;
  btn.style.cssText =
    'all:unset;cursor:pointer;font:var(--diffs-font-size,13px)/1 var(--diffs-font-family,monospace);' +
    'color:var(--diffs-fg,currentcolor);opacity:0.6;padding:2px 8px;' +
    'text-decoration:underline dotted;';
  return btn;
}

// --- Section heading helper ---
function makeHeading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = text;
  h.style.cssText =
    'font:bold 14px system-ui,sans-serif;margin:16px 0 4px;color:var(--diffs-fg,currentcolor)';
  return h;
}

// --- Small note/caption helper, used under a heading to spell out what a
// variant is exercising (e.g. which onWindowExpand direction fired last, or
// what an out-of-range window's recovery affordance shows).
function makeNote(text: string): HTMLElement {
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText =
    'font:12px system-ui,sans-serif;margin:0 0 8px;color:var(--diffs-fg,currentcolor);opacity:0.7';
  return p;
}

// Shared window/expand step used across the fixed (non-interactive-control)
// variants below, mirroring the original demo's behavior: boundary folds
// widen the window by this many lines per click; interior folds peel in
// place via the built-in reveal.
const WINDOW_EXPAND_STEP = 20;

// Widens a DiffWindow at whichever boundary edge the fold sits on. Returns
// undefined for an interior fold, signaling "let the built-in reveal handle
// it" to callers.
function widenWindowForBoundary(
  current: DiffWindow,
  boundary: WindowFold['boundary'],
  step: number
): DiffWindow | undefined {
  if (boundary === 'above') {
    return { start: Math.max(1, current.start - step), end: current.end };
  }
  if (boundary === 'below') {
    return { start: current.start, end: current.end + step };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Windowed FileDiff config-driven builder
//
// Every FileDiff windowed variant below differs only in a handful of knobs:
// diff style, separator mode, context lines, hunk separator mode, and what
// onWindowExpand does. Rather than duplicating the ~30-line instance/render
// block per variant, this factors the shared plumbing (window state,
// setOptions + forceRender on expand, instance registration) and takes a
// compact config describing what's different about each demo instance.
// ---------------------------------------------------------------------------
interface WindowedFileDiffConfig {
  /** Heading text shown above this instance. */
  heading: string;
  /** Optional caption shown under the heading. */
  note?: string;
  diffStyle: 'unified' | 'split';
  window: DiffWindow;
  windowContextLines?: number;
  hunkSeparators?: FileDiffOptions<
    LineCommentMetadata,
    undefined
  >['hunkSeparators'];
  /** Use the custom separator (makeSeparatorEl) instead of the built-in one. */
  customSeparator?: boolean;
  /**
   * How onWindowExpand behaves for this variant:
   * - 'widen-boundary' (default): boundary folds widen the window and
   *   suppress the built-in reveal; interior folds fall through to it.
   * - 'reveal-in-place': every fold (including boundary folds) returns
   *   falsy, so the component's own in-place reveal always runs.
   * - 'omit': no onWindowExpand handler at all (pure default behavior).
   * - a custom function for variants that need bespoke behavior (e.g.
   *   surfacing the `direction` argument).
   */
  onExpandMode?:
    | 'widen-boundary'
    | 'reveal-in-place'
    | 'omit'
    | ((
        fold: WindowFold,
        direction: ExpansionDirections,
        widen: (next: DiffWindow) => void
      ) => boolean | void);
  lineAnnotations?: DiffLineAnnotation<LineCommentMetadata>[];
}

interface WindowedFileDiffHandle {
  instance: FileDiff<LineCommentMetadata>;
  container: HTMLElement;
  getWindow: () => DiffWindow;
  setWindow: (next: DiffWindow) => void;
}

// Builds, renders, and registers one windowed FileDiff demo instance from a
// compact config, returning a handle a page control can use to change its
// window later (clear/restore, out-of-range, programmatic expandHunk).
function buildWindowedFileDiff(
  wrapper: HTMLElement,
  fileDiff: FileDiffMetadata,
  config: WindowedFileDiffConfig
): WindowedFileDiffHandle {
  wrapper.appendChild(makeHeading(config.heading));
  if (config.note != null) {
    wrapper.appendChild(makeNote(config.note));
  }

  let windowState: DiffWindow = { ...config.window };
  const container = document.createElement(DIFFS_TAG_NAME);
  wrapper.appendChild(container);

  const rerenderWithWindow = (next: DiffWindow) => {
    windowState = next;
    instance.setOptions({ ...instance.options, window: windowState });
    instance.render({
      fileDiff,
      fileContainer: container,
      lineAnnotations: config.lineAnnotations,
      forceRender: true,
    });
  };

  const onExpandMode = config.onExpandMode ?? 'widen-boundary';
  const onWindowExpand:
    | FileDiffOptions<LineCommentMetadata, undefined>['onWindowExpand']
    | undefined =
    onExpandMode === 'omit'
      ? undefined
      : (fold, direction) => {
          if (typeof onExpandMode === 'function') {
            return onExpandMode(fold, direction, rerenderWithWindow);
          }
          if (onExpandMode === 'reveal-in-place') {
            // Always defer to the built-in reveal, including at boundary
            // folds, by never widening the window and always returning
            // falsy.
            return undefined;
          }
          // 'widen-boundary': boundary folds widen the window (host-owned);
          // interior folds fall through to the built-in in-place reveal.
          const widened = widenWindowForBoundary(
            windowState,
            fold.boundary,
            WINDOW_EXPAND_STEP
          );
          if (widened == null) return undefined;
          rerenderWithWindow(widened);
          return true;
        };

  const instance: FileDiff<LineCommentMetadata> =
    new FileDiff<LineCommentMetadata>({
      theme: DEMO_THEME,
      themeType: getThemeType(),
      diffStyle: config.diffStyle,
      window: windowState,
      windowContextLines: config.windowContextLines,
      hunkSeparators: config.hunkSeparators,
      renderAnnotation:
        config.lineAnnotations != null ? renderDiffAnnotation : undefined,
      onWindowExpand,
      renderWindowSeparator:
        config.customSeparator === true
          ? (fold) => makeSeparatorEl(fold)
          : undefined,
    });
  instance.render({
    fileDiff,
    fileContainer: container,
    lineAnnotations: config.lineAnnotations,
  });
  diffInstances.push(instance);

  return {
    instance,
    container,
    getWindow: () => windowState,
    setWindow: rerenderWithWindow,
  };
}

// ---------------------------------------------------------------------------
// Windowed File config-driven builder (mirrors buildWindowedFileDiff for the
// plain-file windowing engine, which has a smaller option surface: no
// hunkSeparators, no interior folds, no annotations-on-diff-side concept).
// ---------------------------------------------------------------------------
interface WindowedFileConfig {
  heading: string;
  note?: string;
  window: DiffWindow;
  customSeparator?: boolean;
  onExpandMode?:
    | 'widen-boundary'
    | 'reveal-in-place'
    | 'omit'
    | ((
        fold: WindowFold,
        direction: ExpansionDirections,
        widen: (next: DiffWindow) => void
      ) => boolean | void);
}

interface WindowedFileHandle {
  instance: File<LineCommentMetadata>;
  container: HTMLElement;
  getWindow: () => DiffWindow;
  setWindow: (next: DiffWindow) => void;
}

function buildWindowedFile(
  wrapper: HTMLElement,
  file: FileContents,
  config: WindowedFileConfig
): WindowedFileHandle {
  wrapper.appendChild(makeHeading(config.heading));
  if (config.note != null) {
    wrapper.appendChild(makeNote(config.note));
  }

  let windowState: DiffWindow = { ...config.window };
  const container = document.createElement(DIFFS_TAG_NAME);
  wrapper.appendChild(container);

  const rerenderWithWindow = (next: DiffWindow) => {
    windowState = next;
    instance.setOptions({ ...instance.options, window: windowState });
    instance.render({ file, fileContainer: container, forceRender: true });
  };

  const onExpandMode = config.onExpandMode ?? 'widen-boundary';
  const onWindowExpand:
    | FileOptions<LineCommentMetadata, undefined>['onWindowExpand']
    | undefined =
    onExpandMode === 'omit'
      ? undefined
      : (fold, direction) => {
          if (typeof onExpandMode === 'function') {
            return onExpandMode(fold, direction, rerenderWithWindow);
          }
          if (onExpandMode === 'reveal-in-place') {
            return undefined;
          }
          const widened = widenWindowForBoundary(
            windowState,
            fold.boundary,
            WINDOW_EXPAND_STEP
          );
          if (widened == null) return undefined;
          rerenderWithWindow(widened);
          return true;
        };

  const instance: File<LineCommentMetadata> = new File<LineCommentMetadata>({
    theme: DEMO_THEME,
    themeType: getThemeType(),
    disableFileHeader: false,
    window: windowState,
    onWindowExpand,
    renderWindowSeparator:
      config.customSeparator === true
        ? (fold) => makeSeparatorEl(fold)
        : undefined,
  });
  instance.render({ file, fileContainer: container });
  fileInstances.push(instance);

  return {
    instance,
    container,
    getWindow: () => windowState,
    setWindow: rerenderWithWindow,
  };
}

// Reads the expand index off the first rendered separator matching
// `selector` (e.g. the above-boundary or below-boundary fold) so a page
// control can call `expandHunk` programmatically instead of only via a
// click. Returns undefined if no matching separator is currently rendered
// (e.g. the window covers the whole file so there is nothing to expand).
function findExpandIndex(
  container: HTMLElement,
  selector: string
): number | undefined {
  const root = container.shadowRoot ?? container;
  const el = root.querySelector(selector);
  const raw = el?.getAttribute('data-expand-index');
  if (raw == null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Builds a labeled group of page controls (a heading plus one row per
// control) so the manually-driven variants (clear/restore window,
// out-of-range window, programmatic expandHunk) stay visually grouped and
// the page stays navigable despite the added instance count.
function buildControlGroup(
  wrapper: HTMLElement,
  heading: string,
  controls: HTMLElement[]
): void {
  wrapper.appendChild(makeHeading(heading));
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px';
  for (const control of controls) {
    row.appendChild(control);
  }
  wrapper.appendChild(row);
}

function makeButton(label: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
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
  // Show a change-dense region of the diff as the initial window. This range
  // has clustered edits separated by short unchanged runs, so the interior
  // context folding (see collapsedContextThreshold below) is visible without
  // collapsing nearly everything.
  const diffWindow: DiffWindow = { start: 350, end: 430 };
  // Show lines 200-260 of the plain file.
  const fileWindow: DiffWindow = { start: 200, end: 260 };

  // ── 1. Windowed diff (split, custom separator) ─────────────────────────
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading: 'Windowed FileDiff — lines 350-430 (split, 8 context lines)',
    diffStyle: 'split',
    window: diffWindow,
    windowContextLines: 8,
    customSeparator: true,
  });

  // ── 2. Windowed file (custom separator) ─────────────────────────────────
  buildWindowedFile(wrapper, newFile, {
    heading: 'Windowed File — lines 200-260',
    window: fileWindow,
    customSeparator: true,
  });

  // ── 3. Windowed diff, built-in separator (unified) ──────────────────────
  // Exercises the built-in line-info separator on FileDiff: no
  // renderWindowSeparator hook, so the default "N hidden lines" label and
  // expander are what actually render for a host that does not customize
  // fold rendering.
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading:
      'Windowed FileDiff (built-in separator) — lines 350-430 (unified, 8 context lines)',
    diffStyle: 'unified',
    window: diffWindow,
    windowContextLines: 8,
  });

  // ── 4. Gap 1 + gap 5: Windowed File, built-in separator ─────────────────
  // The invisible/unclickable-separator defect that motivated this demo
  // lived in FileRenderer (the File path), but until now the only built-in
  // separator instance was a FileDiff. This is the File equivalent: no
  // renderWindowSeparator, so the built-in label and expander render via
  // FileRenderer instead of DiffHunksRenderer.
  buildWindowedFile(wrapper, newFile, {
    heading: 'Windowed File (built-in separator) — lines 200-260',
    window: fileWindow,
  });

  // ── 5. Gap 5: Windowed diff, split + built-in separator ─────────────────
  // Fills the remaining cell of the style x separator matrix (the other
  // three cells -- split+custom, unified+custom (below), unified+built-in --
  // are covered elsewhere in this demo).
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading:
      'Windowed FileDiff (built-in separator) — lines 350-430 (split, 8 context lines)',
    diffStyle: 'split',
    window: diffWindow,
    windowContextLines: 8,
  });

  // ── 6. Gap 5: Windowed diff, unified + custom separator ─────────────────
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading:
      'Windowed FileDiff (custom separator) — lines 350-430 (unified, 8 context lines)',
    diffStyle: 'unified',
    window: diffWindow,
    windowContextLines: 8,
    customSeparator: true,
  });

  // ── 7. Gap 2: windowContextLines comparison, 3 vs 20 ────────────────────
  // Same style, separator, and window as instance 1 -- only the context
  // budget differs -- so the folding difference (how much unchanged context
  // survives around each change before folding to an interior separator) is
  // directly comparable between the two.
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading:
      'Windowed FileDiff — windowContextLines: 3 (split) — lines 350-430',
    note: 'Compare interior folding against the windowContextLines: 20 instance below.',
    diffStyle: 'split',
    window: diffWindow,
    windowContextLines: 3,
    customSeparator: true,
  });
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading:
      'Windowed FileDiff — windowContextLines: 20 (split) — lines 350-430',
    note: 'Same window and style as windowContextLines: 3 above -- only the context budget differs.',
    diffStyle: 'split',
    window: diffWindow,
    windowContextLines: 20,
    customSeparator: true,
  });

  // ── 8. Gap 3: onWindowExpand's direction argument ───────────────────────
  // Branches on `direction` (not fold.boundary) and writes what it saw into
  // the note element below the heading, so a reader can see what the
  // component actually reports without opening devtools.
  const directionNote = makeNote(
    'Click a fold above or below the window to see the reported direction.'
  );
  const directionHandle = buildWindowedFileDiff(wrapper, fileDiff, {
    heading: "Windowed FileDiff — onWindowExpand's direction argument",
    diffStyle: 'unified',
    window: diffWindow,
    windowContextLines: 8,
    customSeparator: true,
    onExpandMode: (fold, direction, widen) => {
      directionNote.textContent = `Last onWindowExpand call: boundary=${fold.boundary}, direction=${direction}`;
      const widened = widenWindowForBoundary(
        { start: diffWindow.start, end: diffWindow.end },
        fold.boundary,
        WINDOW_EXPAND_STEP
      );
      if (widened == null) return undefined; // interior fold: let it peel in place
      widen(widened);
      return true;
    },
  });
  // The note element is created above so onExpandMode can close over it, but
  // it needs to render right after the instance it describes, not at the
  // page's end -- insert it as the container's next sibling in the wrapper.
  directionHandle.container.insertAdjacentElement('afterend', directionNote);

  // ── 9. Gap 4a: boundary folds also get the built-in in-place reveal ─────
  // onWindowExpand returns falsy for every fold, including boundary folds
  // (not just interior ones), so the component's own reveal runs at the
  // window edge too -- clicking an above/below separator peels lines in
  // place instead of the host widening `window`.
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading:
      'Windowed FileDiff — in-place reveal at boundary folds (onWindowExpand always falsy)',
    note: 'Every fold, including above/below boundary folds, uses the built-in in-place reveal.',
    diffStyle: 'split',
    window: diffWindow,
    windowContextLines: 8,
    customSeparator: true,
    onExpandMode: 'reveal-in-place',
  });

  // ── 10. Gap 4b: no onWindowExpand handler at all ────────────────────────
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading: 'Windowed FileDiff — no onWindowExpand handler (pure default)',
    note: 'omits onWindowExpand entirely; every fold uses the built-in in-place reveal by default.',
    diffStyle: 'unified',
    window: diffWindow,
    windowContextLines: 8,
    onExpandMode: 'omit',
  });

  // ── 11. Gap 6: window + hunkSeparators 'simple' and 'metadata' ──────────
  // Two separate defects hid behind these two hunkSeparators modes:
  // 1. Rendering: every windowed fold rendered nothing at all (see
  //    FileDiff.windowedSeparatorModes.test.ts). Fixed -- a windowed fold now
  //    always renders a line-info-shaped label and expand button here,
  //    regardless of hunkSeparators mode.
  // 2. Click routing: even after the fold rendered correctly, clicking its
  //    expand button did nothing, because the InteractionManager wiring only
  //    turned on the expand handler for 'line-info'/'line-info-basic'/a
  //    custom function -- with no exception for a windowed fold, which needs
  //    the handler in every mode (see
  //    FileDiff.windowedClickRouting.test.ts and
  //    UnresolvedFile.windowedClickRouting.test.ts, which dispatch a real
  //    click at the rendered button rather than calling expandHunk directly).
  //    Fixed -- click the folds below; they expand like every other windowed
  //    instance on this page.
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading: "Windowed FileDiff — hunkSeparators: 'simple'",
    note: 'Windowed folds render and expand the same way regardless of hunkSeparators mode.',
    diffStyle: 'unified',
    window: diffWindow,
    windowContextLines: 8,
    hunkSeparators: 'simple',
  });
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading: "Windowed FileDiff — hunkSeparators: 'metadata'",
    note: 'Windowed folds render and expand the same way regardless of hunkSeparators mode.',
    diffStyle: 'unified',
    window: diffWindow,
    windowContextLines: 8,
    hunkSeparators: 'metadata',
  });

  // ── 12. Gap 10: window + annotations ────────────────────────────────────
  // Annotations placed inside the 350-430 window on both sides, reusing the
  // demo's existing LineCommentMetadata/renderDiffAnnotation pattern. The
  // deletions-side annotation uses an OLD-file line number (280, a real
  // change-deletion line in this diff) rather than a new-file line number --
  // DiffLineAnnotation.lineNumber for side: 'deletions' is old-file-relative,
  // distinct from the new-file line numbers the window itself is expressed in.
  const windowedAnnotations: DiffLineAnnotation<LineCommentMetadata>[] = [
    {
      lineNumber: 360,
      side: 'additions',
      metadata: {
        author: 'Windowed Demo',
        message: 'Annotation inside the window, additions side.',
      },
    },
    {
      lineNumber: 280,
      side: 'deletions',
      metadata: {
        author: 'Windowed Demo',
        message: 'Annotation inside the window, deletions side.',
      },
    },
  ];
  buildWindowedFileDiff(wrapper, fileDiff, {
    heading: 'Windowed FileDiff — window + lineAnnotations',
    note: 'Additions-side annotation at new-file line 360; deletions-side at old-file line 280 -- both inside the 350-430 window.',
    diffStyle: 'split',
    window: diffWindow,
    windowContextLines: 8,
    customSeparator: true,
    lineAnnotations: windowedAnnotations,
  });

  // ── 13. Gap 10: window + an edit session ────────────────────────────────
  // Probes whether a windowed FileDiff can enter edit mode. No explicit
  // guard against this combination was found in FileDiff/editor source, so
  // this is genuinely untested territory -- see FINDINGS.md for what was
  // observed when this was exercised live in the browser.
  const editWindowedHandle = buildWindowedFileDiff(wrapper, fileDiff, {
    heading: 'Windowed FileDiff — window + edit session',
    note: 'Click "Start editing" to probe window + edit compatibility live.',
    diffStyle: 'unified',
    window: diffWindow,
    windowContextLines: 8,
  });
  const editWindowedEditor = new Editor<'file-diff', LineCommentMetadata>(
    'file-diff',
    {}
  );
  let editWindowedActive = false;
  const editWindowedButton = makeButton('Start editing', () => {
    editWindowedActive = !editWindowedActive;
    if (editWindowedActive) {
      editWindowedButton.textContent = 'Stop editing';
      editWindowedEditor.edit(editWindowedHandle.instance);
    } else {
      editWindowedButton.textContent = 'Start editing';
      editWindowedEditor.cleanUp();
    }
  });
  wrapper.appendChild(editWindowedButton);

  // ── 14. Gaps 7-9: page controls, grouped so the page stays navigable ───
  // These operate on the split-custom-separator instance from step 1 (the
  // page's "reference" windowed diff) via the handle it returns.
  const controlTarget = buildWindowedFileDiff(wrapper, fileDiff, {
    heading: 'Windowed FileDiff — control target (split, 8 context lines)',
    note: 'The three control groups below act on this instance.',
    diffStyle: 'split',
    window: diffWindow,
    windowContextLines: 8,
    customSeparator: true,
  });

  // Gap 7: clear the window (restores the full-file view) and restore it.
  buildControlGroup(wrapper, 'Control: clear / restore window', [
    makeButton('Clear window (window: undefined)', () => {
      controlTarget.instance.setOptions({
        ...controlTarget.instance.options,
        window: undefined,
      });
      controlTarget.instance.render({
        fileDiff,
        fileContainer: controlTarget.container,
        forceRender: true,
      });
    }),
    makeButton('Restore window (350-430)', () => {
      controlTarget.setWindow({ ...diffWindow });
    }),
  ]);

  // Gap 8: set an out-of-range window (past EOF on a 711-line file) to show
  // the empty-window recovery affordance instead of a blank pane. Uses its
  // own instance (onExpandMode: 'omit') rather than the shared control
  // target: the control target's host-owned widen-boundary handler steps the
  // window by a fixed 20 lines per click, which can never walk back the
  // ~99,600-line gap this control creates -- the built-in in-place reveal
  // (peeling a much larger default per click) is what actually demonstrates
  // recovery here, matching how FileDiff.emptyWindowRecovery.test.ts exercises it.
  const outOfRangeHandle = buildWindowedFileDiff(wrapper, fileDiff, {
    heading: 'Windowed FileDiff — out-of-range window recovery target',
    note: 'Starts on the same 350-430 window; the control below moves it out of range.',
    diffStyle: 'split',
    window: diffWindow,
    windowContextLines: 8,
    customSeparator: true,
    onExpandMode: 'omit',
  });
  buildControlGroup(wrapper, 'Control: out-of-range window', [
    makeButton('Set out-of-range window (100000-100050)', () => {
      outOfRangeHandle.setWindow({ start: 100000, end: 100050 });
    }),
    makeButton('Restore window (350-430)', () => {
      outOfRangeHandle.setWindow({ ...diffWindow });
    }),
  ]);

  // Gap 9: call the public expandHunk programmatically -- reading the
  // rendered separator's data-expand-index attribute off the DOM (the same
  // routing InteractionManager uses for a real click) rather than clicking.
  buildControlGroup(wrapper, 'Control: programmatic expandHunk', [
    makeButton('expandHunk() on above-boundary fold', () => {
      const index = findExpandIndex(
        controlTarget.container,
        '[data-separator-first][data-expand-index]'
      );
      if (index == null) return;
      controlTarget.instance.expandHunk(index, 'down');
    }),
    makeButton('expandHunk() on below-boundary fold', () => {
      const index = findExpandIndex(
        controlTarget.container,
        '[data-separator-last][data-expand-index]'
      );
      if (index == null) return;
      controlTarget.instance.expandHunk(index, 'up');
    }),
  ]);
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
