import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
