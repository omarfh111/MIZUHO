import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import './styles.css';
import { ExperienceGate } from './experience/index.ts';

createRoot(document.getElementById('root')!).render(
  <ExperienceGate mountChildrenEarly>
    <App />
  </ExperienceGate>,
);
