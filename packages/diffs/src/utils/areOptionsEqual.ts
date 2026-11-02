import type { CodeViewOptions } from '../components/CodeView';
import type { FileWindowOptions } from '../components/File';
import type {
  FileDiffOptions,
  FileDiffWindowOptions,
} from '../components/FileDiff';
import { DEFAULT_THEMES } from '../constants';
import type { FileOptions } from '../react';
import type { ParseDiffOptions } from '../types';
import { areObjectsEqual } from './areObjectsEqual';
import { areThemesEqual } from './areThemesEqual';
import type { DiffWindow } from './windowingCore';

type AnyOptions<L, C> =
  | CodeViewOptions<L, C>
  | (FileOptions<L, C> & FileWindowOptions)
  | (FileDiffOptions<L, C> & FileDiffWindowOptions)
  | undefined;

export function areOptionsEqual<LAnnotation, Caret>(
  optionsA: AnyOptions<LAnnotation, Caret>,
  optionsB: AnyOptions<LAnnotation, Caret>
): boolean {
  const themeA = optionsA?.theme ?? DEFAULT_THEMES;
  const themeB = optionsB?.theme ?? DEFAULT_THEMES;
  const diffOptsA = getParseDiffOptions(optionsA);
  const diffOptsB = getParseDiffOptions(optionsB);
  return (
    areThemesEqual(themeA, themeB) &&
    areObjectsEqual(optionsA, optionsB, [
      'theme',
      'parseDiffOptions' as keyof typeof optionsA,
      'window' as keyof typeof optionsA,
    ]) &&
    areObjectsEqual(diffOptsA, diffOptsB) &&
    // A windowed snippet's range is often passed as a fresh object literal;
    // compare it by value, like the theme and parse options.
    areObjectsEqual(getWindow(optionsA), getWindow(optionsB))
  );
}

function getWindow<L, C>(options: AnyOptions<L, C>): DiffWindow | undefined {
  if (options != null && 'window' in options) {
    return options.window;
  }
  return undefined;
}

function getParseDiffOptions<L, C>(
  options: AnyOptions<L, C>
): ParseDiffOptions | undefined {
  if (options != null && 'parseDiffOptions' in options) {
    return options.parseDiffOptions;
  }
  return undefined;
}
