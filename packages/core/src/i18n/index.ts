import type { Lang } from '../util/format';
import { en } from './en';
import { tr } from './tr';

// Re-exported from `util/format` rather than declared again: two independent
// `Lang` aliases would make `export *` from the package root ambiguous.
export type { Lang };

/**
 * Shape of a dictionary: the Turkish tree with its string literals widened, so
 * `en` can be typed as a `Dict` (a literal-typed `typeof tr` would demand the
 * Turkish strings themselves) while a missing or misspelled key still fails to
 * compile.
 */
export type Dict = Widen<typeof tr>;

type Widen<T> = {
  [K in keyof T]: T[K] extends string ? string : Widen<T[K]>;
};

/** Dot paths to every leaf string, e.g. `'player.shuffle'`. */
export type TKey = LeafKeys<Dict>;

type LeafKeys<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafKeys<T[K]>}`;
}[keyof T & string];

export const LANGS: Array<{ id: Lang; label: string }> = [
  { id: 'tr', label: 'Türkçe' },
  { id: 'en', label: 'English' },
];

export function dict(lang: Lang): Dict {
  return lang === 'en' ? en : tr;
}

function lookup(source: Dict, key: string): string | undefined {
  let node: unknown = source;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, params: Record<string, string | number>): string {
  const values = Object.values(params);
  const placeholders = template.match(/\{\w+\}/g);
  // One placeholder, one value: substitute regardless of the name the caller
  // chose. Call sites disagree on it ({name} vs {context} for the same label)
  // and a visible "{context}" in the UI is worse than the obvious guess.
  const loneValue = placeholders?.length === 1 && values.length === 1 ? values[0] : undefined;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name] ?? loneValue;
    // Otherwise an unknown placeholder is left verbatim: visible in the UI and
    // far easier to spot than a silently empty string.
    return value === undefined ? whole : String(value);
  });
}

/**
 * Translator bound to one language. Falls back to Turkish (the source of truth)
 * and finally to the key itself, so a missing string can never throw mid-render.
 */
export function createT(lang: Lang): (key: TKey, params?: Record<string, string | number>) => string {
  const active = dict(lang);
  return (key, params) => {
    const template = lookup(active, key) ?? lookup(tr, key) ?? key;
    return params === undefined ? template : interpolate(template, params);
  };
}

export { en, tr };
