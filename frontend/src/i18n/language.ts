import { createContext, useContext } from 'react';
import { exploreJa, explorePatterns } from './explore.ts';
import { planningJa, planningPatterns } from './planning.ts';
import { commonJa } from './common.ts';

export type Language = 'en' | 'ja';
export type PhrasePattern = [RegExp, (...matches: string[]) => string];
export const LanguageContext = createContext<Language>('en');
export const useLanguage = () => useContext(LanguageContext);

const phrases: Record<string, string> = { ...exploreJa, ...planningJa, ...commonJa };
const patterns: PhrasePattern[] = [...explorePatterns, ...planningPatterns];
const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

export function translate(text: string, language: Language): string {
  if (language === 'en' || !/[a-z]/i.test(text)) return text;
  const key = text.trim().replace(/\s+/g, ' ');
  let result = Object.hasOwn(phrases, key) ? phrases[key] : undefined;
  if (result === undefined) {
    for (const [pattern, render] of patterns) {
      const match = pattern.exec(key);
      if (match) { result = render(...match); break; }
    }
  }
  // Date fragments can occur alongside another date, a unit or a translated label.
  result = (result ?? text.trim()).replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec) (\d{4})\b/g,
    (_, day: string, month: string, year: string) => `${year}年${months.indexOf(month.slice(0, 3)) + 1}月${Number(day)}日`);
  return text.slice(0, text.length - text.trimStart().length) + result + text.slice(text.trimEnd().length);
}

const storageKey = 'mizhuo.language';
export function initialLanguage(): Language {
  const url = new URL(window.location.href).searchParams.get('lang');
  if (url === 'ja' || url === 'en') return url;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch { /* URL and browser settings also work with private storage. */ }
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function selectLanguage(language: Language) {
  const url = new URL(window.location.href);
  url.searchParams.set('lang', language);
  window.history.replaceState(null, '', url);
  try { localStorage.setItem(storageKey, language); } catch { /* The shared URL retains the choice. */ }
  window.dispatchEvent(new Event('mizhuo-language'));
}
