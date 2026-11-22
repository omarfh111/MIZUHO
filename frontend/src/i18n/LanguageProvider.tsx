import { useEffect, useState, type ReactNode } from 'react';
import { initialLanguage, LanguageContext, selectLanguage, useLanguage } from './language.ts';

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(initialLanguage);
  useEffect(() => {
    const update = () => setLanguage(initialLanguage());
    window.addEventListener('mizhuo-language', update);
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener('mizhuo-language', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === 'ja' ? 'Mizhuo · 灌漑観測所' : 'Mizhuo · Irrigation Observatory';
  }, [language]);
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

export function LanguageSelector() {
  const language = useLanguage();
  return <select className="language-select" aria-label="Language" value={language}
    onChange={event => selectLanguage(event.currentTarget.value === 'ja' ? 'ja' : 'en')}>
    <option lang="en" value="en" translate="no">English</option>
    <option lang="ja" value="ja" translate="no">日本語</option>
  </select>;
}
