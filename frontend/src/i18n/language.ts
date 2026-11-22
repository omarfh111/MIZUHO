import { createContext, useContext } from 'react';
import { exploreJa, explorePatterns } from './explore.ts';
import { planningJa, planningPatterns } from './planning.ts';
import { commonJa } from './common.ts';
import { guardianJa, guardianTn } from './guardian.ts';
import { tunisianMessages } from './tunisianMessages.ts';
import { tunisianPatterns } from './tunisianPatterns.ts';

export type Language = 'en' | 'ja' | 'aeb';
export type PhrasePattern = [RegExp, (...matches: string[]) => string];
export const LanguageContext = createContext<Language>('en');
export const useLanguage = () => useContext(LanguageContext);

const phrases: Record<string, string> = { ...exploreJa, ...planningJa, ...commonJa, ...guardianJa };
const patterns: PhrasePattern[] = [...explorePatterns, ...planningPatterns];
const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const monthsTn = 'جانفي فيفري مارس أفريل ماي جوان جويلية أوت سبتمبر أكتوبر نوفمبر ديسمبر'.split(' ');
const phrasesTn = { ...tunisianMessages, ...guardianTn };

function tunisian(text: string, depth = 0): string {
  const key = text.trim().replace(/\s+/g, ' ');
  let result = Object.hasOwn(phrasesTn, key) ? phrasesTn[key] : undefined;
  if (result === undefined && depth < 3) {
    for (const [pattern, template] of tunisianPatterns) {
      const match = pattern.exec(key);
      if (!match) continue;
      result = template.replace(/\{(\d+)\}/g, (_, index: string) => tunisian(match[Number(index)] ?? '', depth + 1));
      break;
    }
  }
  result = (result ?? key).replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec) (\d{4})\b/g,
    (_, day: string, month: string, year: string) => `${Number(day)} ${monthsTn[months.indexOf(month.slice(0, 3))]} ${year}`);
  return text.slice(0, text.length - text.trimStart().length) + result.trim() + text.slice(text.trimEnd().length);
}

export function translate(text: string, language: Language): string {
  if (language === 'en' || !/[a-z]/i.test(text)) return text;
  if (language === 'aeb') return tunisian(text);
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
function supportedLanguage(value: string | null): Language | undefined {
  const tag = value?.toLowerCase();
  if (tag === 'aeb' || tag?.startsWith('aeb-') || tag === 'ar-tn') return 'aeb';
  if (tag === 'ja' || tag?.startsWith('ja-')) return 'ja';
  if (tag === 'en' || tag?.startsWith('en-')) return 'en';
}
export function initialLanguage(): Language {
  const url = supportedLanguage(new URL(window.location.href).searchParams.get('lang'));
  if (url) return url;
  try {
    const saved = supportedLanguage(localStorage.getItem(storageKey));
    if (saved) return saved;
  } catch { /* URL and browser settings also work with private storage. */ }
  return supportedLanguage(navigator.language) ?? 'en';
}

export function selectLanguage(language: Language) {
  const url = new URL(window.location.href);
  url.searchParams.set('lang', language);
  window.history.replaceState(null, '', url);
  try { localStorage.setItem(storageKey, language); } catch { /* The shared URL retains the choice. */ }
  window.dispatchEvent(new Event('mizhuo-language'));
}
