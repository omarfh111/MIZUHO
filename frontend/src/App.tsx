import { Activity, ArrowLeft, ArrowUpRight, Droplets, FlaskConical, Map, MapPin, Radio, Sparkles, Waves } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { getCatalog, type Catalog } from './api.ts';
import EvidencePanel from './components/EvidencePanel.tsx';
import SiteMap from './components/SiteMap.tsx';
import SolarComparison from './components/SolarComparison.tsx';
import type { CompareRequest, SolarOption } from './types.ts';

const Simulation = lazy(() => import('./components/Simulation.tsx'));
const AssistantPanel = lazy(() => import('./components/AssistantPanel.tsx'));
type Page = 'map' | 'simulation';
const currentPage = (): Page => window.location.hash === '#simulation' ? 'simulation' : 'map';

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<Page>(currentPage);
  const [visitedSimulation, setVisitedSimulation] = useState(page === 'simulation');
  const [siteId, setSiteId] = useState('');
  const [solar, setSolar] = useState<SolarOption | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [solarIds, setSolarIds] = useState<string[] | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [comparison, setComparison] = useState<CompareRequest>();

  useEffect(() => {
    const controller = new AbortController();
    getCatalog(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setCatalog(result);
      setSiteId(result.sites.features[0]?.properties.site_id ?? '');
    }).catch((error) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : 'Service unavailable.');
    });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const followHash = () => {
      const next = currentPage();
      setPage(next);
      if (next === 'simulation') setVisitedSimulation(true);
      if (next !== page) window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, [page]);

  const navigate = (next: Page) => {
    window.location.hash = next === 'map' ? 'map' : 'simulation';
    if (page !== next) window.scrollTo(0, 0);
    setPage(next);
    if (next === 'simulation') setVisitedSimulation(true);
  };
  const site = catalog?.sites.features.find(({ properties }) => properties.site_id === siteId);
  const allScenarios = catalog?.scenarios.filter(({ site_id }) => site_id === siteId) ?? [];
  const scenarios = [...allScenarios.filter(({ id }) => id === 'normal'), ...allScenarios.filter(({ id }) => id !== 'normal')];
  const displayMode = catalog?.mode === 'demo' || site?.properties.status === 'simulated';

  return <>
    <a href="#main-content" className="skip-link" onClick={(event) => {
      event.preventDefault();
      document.getElementById('main-content')?.focus();
    }}>Skip to content</a>
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#map" aria-label="Mizhuo · Site map">
          <span className="brand-mark"><Waves size={24} strokeWidth={2.4} /></span>
          <span>Miz<strong>huo</strong><small>AGRICULTURAL OBSERVATORY</small></span>
        </a>
        <nav className="main-nav" aria-label="Navigation principale">
          <a href="#map" aria-current={page === 'map' ? 'page' : undefined}><Map size={16} /> Site map</a>
          <a href="#simulation" aria-current={page === 'simulation' ? 'page' : undefined}><Activity size={17} /> Simulation</a>
        </nav>
        <div className="topbar-meta">
          {catalog && <span className={`mode-tag ${displayMode ? '' : 'live-mode'}`}>
            {displayMode ? <FlaskConical size={14} /> : <Radio size={14} />}
            {catalog.mode === 'demo' ? 'Simulated data' : displayMode ? 'API · simulated site' : 'API connected'}
          </span>}
          <span className="locale" aria-label="Tunisia">TN</span>
        </div>
      </div>
    </header>

    <main className="page" id="main-content" tabIndex={-1}>
      <section className="hero">
        <div>
          <div className="eyebrow"><span className="eyebrow-rule" />
            {page === 'map' ? 'RESOURCE MAPPING' : 'IRRIGATION CONTINUITY'}
          </div>
          <h1>{page === 'map' ? <><em>Irrigation</em> observatory</> : <><em>Irrigation</em> simulation</>}</h1>
          <p>{page === 'map' ? 'Explore the site, compare solar options, and plan irrigation.'
            : 'Compare fixed and proposed irrigation schedules during outages using the same water stock and quota.'}</p>
        </div>
        {page === 'map' && site && <div className="hero-location"><MapPin size={19} />
          <div><strong>{site.properties.label}</strong><small>{site.properties.locality ?? 'Agricultural site'}</small></div></div>}
        {page === 'simulation' && <button type="button" className="button button-secondary back-button" onClick={() => navigate('map')}><ArrowLeft size={16} /> Back to map</button>}
      </section>

      {!catalog && <div className="surface page-fallback">
        <Droplets size={23} />
        {failure ? <><p role="alert">{failure}</p><button type="button" className="button button-secondary" onClick={() => {
          setFailure(''); setAttempt((version) => version + 1);
        }}>Try again</button><a className="text-button" href="?mode=demo#map">Open the local demo <ArrowUpRight size={13} /></a></>
          : <p role="status">Loading the site…</p>}
      </div>}
      {catalog && !site && <div className="surface page-fallback"><p>No site data available.</p></div>}
      {catalog && site && page === 'map' && <SiteMap key={siteId} site={site} sites={catalog.sites.features} scenario={scenarios[0]}
        mode={catalog.mode} selectedOption={solar} onSelectSite={(id) => { setSiteId(id); setSolar(null); }}
        onCompare={setSolarIds} onEvidence={setSource} onSimulate={() => navigate('simulation')} />}
      {catalog && site && visitedSimulation && <div hidden={page !== 'simulation'}>
        {scenarios.length ? <Suspense fallback={<div className="surface page-fallback" role="status">Loading the simulator…</div>}>
          <Simulation key={siteId} scenarios={scenarios} mode={catalog.mode} solar={solar} onClearSolar={() => setSolar(null)} onEvidence={setSource}
            onAssistantContext={setComparison} />
        </Suspense> : <div className="surface page-fallback"><p>No scenarios are available for this site.</p></div>}
      </div>}
      <footer className="footer"><span><Waves size={15} /> Mizhuo</span>
        <span>{catalog?.mode === 'demo' ? 'Demo mode · local layers and scenarios' : 'Irrigation continuity · Tunisia'}</span></footer>
    </main>
    {catalog && solarIds && <SolarComparison site={siteId} options={solarIds} mode={catalog.mode}
      selectedOption={solar} close={() => setSolarIds(null)} onEvidence={setSource} onUse={(option) => {
        setSolar(option); setSolarIds(null); navigate('simulation');
      }} />}
    {catalog && source && <EvidencePanel key={source} source={source} mode={catalog.mode} close={() => setSource(null)} />}
    {catalog && site && <button type="button" className="assistant-launch button button-primary" aria-haspopup="dialog"
      onClick={() => setAssistantOpen(true)}><Sparkles size={19} /> Ask Mizhuo</button>}
    {catalog && site && assistantOpen && <Suspense fallback={null}>
      <AssistantPanel site={site} mode={catalog.mode} solar={solar} comparison={comparison}
        close={() => setAssistantOpen(false)} />
    </Suspense>}
  </>;
}
