import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ExperienceGate } from '../../src/experience/index.ts';
import { DashboardStandIn } from './DashboardStandIn.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ExperienceGate play="always">
      <DashboardStandIn />
    </ExperienceGate>
  </StrictMode>,
);
