import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import './styles.css';
import { ExperienceGate } from './experience/index.ts';
import { LanguageProvider } from './i18n/LanguageProvider.tsx';

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <ExperienceGate mountChildrenEarly>
      <App />
    </ExperienceGate>
  </LanguageProvider>,
);
