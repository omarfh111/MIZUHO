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
    document.documentElement.lang = language === 'aeb' ? 'aeb-TN' : language;
    document.documentElement.dir = language === 'aeb' ? 'rtl' : 'ltr';
    document.title = { en: 'Mizhuo · Irrigation Observatory', ja: 'Mizhuo · 灌漑観測所', aeb: 'Mizhuo · مرصد السقي' }[language];
  }, [language]);
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

export function LanguageSelector() {
  const language = useLanguage();
  return <select className="language-select" aria-label="Language" value={language}
    onChange={event => { const value = event.currentTarget.value; if (value === 'ja' || value === 'aeb' || value === 'en') selectLanguage(value); }}>
    <option lang="en" value="en" translate="no">English</option>
    <option lang="ja" value="ja" translate="no">日本語</option>
    <option lang="aeb-TN" value="aeb" translate="no">تونسي</option>
  </select>;
}
