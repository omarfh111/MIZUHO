import { Activity, ArrowLeft, ArrowUpRight, Droplets, FlaskConical, Map, MapPin, Radio, Waves } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { getCatalog, type Catalog } from './api.ts';
import EvidencePanel from './components/EvidencePanel.tsx';
import SiteMap from './components/SiteMap.tsx';
import SolarComparison from './components/SolarComparison.tsx';
import type { SolarOption } from './types.ts';

const Simulation = lazy(() => import('./components/Simulation.tsx'));
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

  useEffect(() => {
    const controller = new AbortController();
    getCatalog(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setCatalog(result);
      setSiteId(result.sites.features[0]?.properties.site_id ?? '');
    }).catch((error) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : 'Service indisponible.');
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
    window.location.hash = next === 'map' ? 'carte' : 'simulation';
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
    }}>Aller au contenu</a>
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#carte" aria-label="MIZU NEXUS · Carte">
          <span className="brand-mark"><Waves size={24} strokeWidth={2.4} /></span>
          <span>MIZU <strong>NEXUS</strong><small>OBSERVATOIRE AGRICOLE</small></span>
        </a>
        <nav className="main-nav" aria-label="Navigation principale">
          <a href="#carte" aria-current={page === 'map' ? 'page' : undefined}><Map size={16} /> Carte du site</a>
          <a href="#simulation" aria-current={page === 'simulation' ? 'page' : undefined}><Activity size={17} /> Simulation</a>
        </nav>
        <div className="topbar-meta">
          {catalog && <span className={`mode-tag ${displayMode ? '' : 'live-mode'}`}>
            {displayMode ? <FlaskConical size={14} /> : <Radio size={14} />}
            {catalog.mode === 'demo' ? 'Données simulées' : displayMode ? 'API · site simulé' : 'API connectée'}
          </span>}
          <span className="locale" aria-label="Tunisie">TN</span>
        </div>
      </div>
    </header>

    <main className="page" id="main-content" tabIndex={-1}>
      <section className="hero">
        <div>
          <div className="eyebrow"><span className="eyebrow-rule" />
            {page === 'map' ? 'CARTOGRAPHIE DES RESSOURCES' : 'CONTINUITÉ DE L’IRRIGATION'}
          </div>
          <h1>{page === 'map' ? <>Observatoire de <em>l’irrigation</em></> : <>Simulation des <em>tours d’eau</em></>}</h1>
          <p>{page === 'map' ? 'Explorez le périmètre, comparez les options solaires et préparez les tours d’eau.'
            : 'Comparez le tour fixe au plan proposé en cas de coupure, à partir du même stock et du même quota.'}</p>
        </div>
        {page === 'map' && site && <div className="hero-location"><MapPin size={19} />
          <div><strong>{site.properties.label}</strong><small>{site.properties.locality ?? 'Site agricole'}</small></div></div>}
        {page === 'simulation' && <button type="button" className="button button-secondary back-button" onClick={() => navigate('map')}><ArrowLeft size={16} /> Retour à la carte</button>}
      </section>

      {!catalog && <div className="surface page-fallback">
        <Droplets size={23} />
        {failure ? <><p role="alert">{failure}</p><button type="button" className="button button-secondary" onClick={() => {
          setFailure(''); setAttempt((version) => version + 1);
        }}>Réessayer</button><a className="text-button" href="?mode=demo#carte">Ouvrir la démo locale <ArrowUpRight size={13} /></a></>
          : <p role="status">Chargement du périmètre…</p>}
      </div>}
      {catalog && !site && <div className="surface page-fallback"><p>Données insuffisantes · aucun site disponible.</p></div>}
      {catalog && site && page === 'map' && <SiteMap key={siteId} site={site} sites={catalog.sites.features} scenario={scenarios[0]}
        mode={catalog.mode} selectedOption={solar} onSelectSite={(id) => { setSiteId(id); setSolar(null); }}
        onCompare={setSolarIds} onEvidence={setSource} onSimulate={() => navigate('simulation')} />}
      {catalog && site && visitedSimulation && <div hidden={page !== 'simulation'}>
        {scenarios.length ? <Suspense fallback={<div className="surface page-fallback" role="status">Chargement du simulateur…</div>}>
          <Simulation key={siteId} scenarios={scenarios} mode={catalog.mode} solar={solar} onClearSolar={() => setSolar(null)} onEvidence={setSource} />
        </Suspense> : <div className="surface page-fallback"><p>Données insuffisantes · aucun scénario pour ce site.</p></div>}
      </div>}
      <footer className="footer"><span><Waves size={15} /> MIZU NEXUS</span>
        <span>{catalog?.mode === 'demo' ? 'Mode démonstration · couches et scénarios locaux' : 'Continuité de l’irrigation · Tunisie'}</span></footer>
    </main>
    {catalog && solarIds && <SolarComparison site={siteId} options={solarIds} mode={catalog.mode}
      selectedOption={solar} close={() => setSolarIds(null)} onEvidence={setSource} onUse={(option) => {
        setSolar(option); setSolarIds(null); navigate('simulation');
      }} />}
    {catalog && source && <EvidencePanel key={source} source={source} mode={catalog.mode} close={() => setSource(null)} />}
  </>;
}
