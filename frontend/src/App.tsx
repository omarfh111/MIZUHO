import { Activity, ArrowLeft, ArrowUpRight, Droplets, FlaskConical, Globe2, Map, MapPin, Radio, Sparkles, Sun, Waves } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { getCatalog, type Catalog } from './api.ts';
import EvidencePanel from './components/EvidencePanel.tsx';
import SiteMap from './components/SiteMap.tsx';
import SolarComparison from './components/SolarComparison.tsx';
import type { AssistantSimulationContext, RegionPlanContext, SolarOption, TunisiaCity, TunisiaPeriod } from './types.ts';
import SitePicker from './components/SitePicker.tsx';
import CivicContinuity from './components/CivicContinuity.tsx';

const Simulation = lazy(() => import('./components/Simulation.tsx'));
const AssistantPanel = lazy(() => import('./components/AssistantPanel.tsx'));
const TunisiaExplorer = lazy(() => import('./components/TunisiaExplorer.tsx'));
const ResourceView = lazy(() => import('./components/ResourceView.tsx'));
const RegionalPlanning = lazy(() => import('./components/RegionalPlanning.tsx'));
type Page = 'tunisia' | 'map' | 'energy' | 'simulation';
const currentPage = (): Page => {
  const hash = window.location.hash;
  return hash === '#simulation' ? 'simulation' : hash === '#energy' ? 'energy' : hash === '#map' ? 'map' : 'tunisia';
};

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
  const [assistantOpen, setAssistantOpen] = useState<boolean>();
  const [assistantSimulation, setAssistantSimulation] = useState<AssistantSimulationContext>();
  const [zonePlan, setZonePlan] = useState<RegionPlanContext>();
  const [city, setCity] = useState<TunisiaCity | null>(null);
  const [cityId, setCityId] = useState(() => new URLSearchParams(window.location.search).get('city') ?? '');
  const [period, setPeriod] = useState<TunisiaPeriod>();
  const applySite = useCallback((id: string) => {
    setSiteId(id);
    setSolar(null);
    setSolarIds(null);
    setSource(null);
    setAssistantSimulation(undefined);
    setZonePlan(undefined);
  }, []);
  const selectSite = useCallback((id: string) => {
    if (id !== siteId) applySite(id);
    const url = new URL(window.location.href);
    url.searchParams.set('site', id);
    window.history.replaceState(null, '', url);
  }, [applySite, siteId]);
  const selectCity = useCallback((next: TunisiaCity | null, nearby: string[]) => {
    const id = next?.id ?? '';
    if (id === cityId) return;
    setCityId(id);
    setCity(next);
    setPeriod(undefined);
    if (next) selectSite(nearby.length === 1 ? nearby[0] : nearby.includes(siteId) ? siteId : '');
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('city', id);
    else url.searchParams.delete('city');
    window.history.replaceState(null, '', url);
  }, [cityId, siteId, selectSite]);

  useEffect(() => {
    const controller = new AbortController();
    getCatalog(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setCatalog(result);
      const requested = new URLSearchParams(window.location.search).get('site');
      setSiteId(requested === null ? result.sites.features[0]?.properties.site_id ?? '' :
        result.sites.features.find(s => s.properties.site_id === requested)?.properties.site_id ?? '');
    }).catch((error) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : 'Service unavailable.');
    });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const followLocation = () => {
      const query = new URLSearchParams(window.location.search);
      const restoredCity = query.get('city') ?? '';
      if (restoredCity !== cityId) {
        setCityId(restoredCity);
        setCity(null);
        setPeriod(undefined);
      }
      if (!catalog) return;
      const requested = query.get('site');
      const next = requested === null ? catalog.sites.features[0]?.properties.site_id :
        catalog.sites.features.find(s => s.properties.site_id === requested)?.properties.site_id;
      if ((next ?? '') !== siteId) applySite(next ?? '');
    };
    window.addEventListener('popstate', followLocation);
    return () => window.removeEventListener('popstate', followLocation);
  }, [applySite, catalog, siteId, cityId]);

  useEffect(() => {
    const followHash = () => {
      const next = currentPage();
      setPage(next);
      if (next === 'simulation') setVisitedSimulation(true);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, []);

  const navigate = (next: Page) => {
    window.location.hash = next;
    if (page !== next) window.scrollTo(0, 0);
    setPage(next);
    if (next === 'simulation') setVisitedSimulation(true);
  };
  const site = catalog?.sites.features.find(({ properties }) => properties.site_id === siteId);
  const allScenarios = catalog?.scenarios.filter(({ site_id }) => site_id === siteId) ?? [];
  const scenarios = [...allScenarios.filter(({ id }) => id === 'normal'), ...allScenarios.filter(({ id }) => id !== 'normal')];
  const displayMode = catalog?.mode === 'demo' || site?.properties.status === 'simulated';
  const citySites = catalog?.mode === 'live' ? catalog.sites.features.map(({ geometry, properties }) => ({
    id: properties.site_id,
    coordinates: [geometry.coordinates[0], geometry.coordinates[1]] as const,
    label: properties.field_zone ? `Open ${properties.label} zone`
      : properties.survey_available ? `Open ${properties.label} survey` : `Open simulated ${properties.label} pilot`,
    onOpen: () => { selectSite(properties.site_id); navigate('map'); },
  })) : [];
  const activeCity = page === 'tunisia' ? city : null;
  const activeSite = page === 'tunisia' ? undefined : site;

  return <>
    <a href="#main-content" className="skip-link" onClick={(event) => {
      event.preventDefault();
      document.getElementById('main-content')?.focus();
    }}>Skip to content</a>
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#tunisia" aria-label="Mizhuo · Tunisia">
          <span className="brand-mark"><Waves size={24} strokeWidth={2.4} /></span>
          <span>Miz<strong>huo</strong><small>WATER &amp; ENERGY OBSERVATORY</small></span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <a href={page === 'map' ? '#map' : '#tunisia'} aria-current={page === 'map' || page === 'tunisia' ? 'page' : undefined}><Globe2 size={16} /> Land &amp; agriculture</a>
          <a href="#energy" aria-current={page === 'energy' ? 'page' : undefined}><Sun size={16} /> Water &amp; energy</a>
          <a href="#simulation" aria-current={page === 'simulation' ? 'page' : undefined}><Activity size={17} /> Irrigation planning</a>
        </nav>
        <div className="topbar-meta">
          {page !== 'tunisia' && catalog && site && <span className={`mode-tag ${displayMode ? '' : 'live-mode'}`}>
            {displayMode ? <FlaskConical size={14} /> : <Radio size={14} />}
            {catalog.mode === 'demo' ? 'Simulated data' : displayMode ? 'API · simulated site' : 'API connected'}
          </span>}
          <span className="locale" aria-label="Tunisia">TN</span>
        </div>
      </div>
    </header>

    <main className="page" id="main-content" tabIndex={-1}>
      {(page === 'tunisia' || page === 'map') && <nav className="land-nav" aria-label="Geographic view">
        <a href="#tunisia" aria-current={page === 'tunisia' ? 'page' : undefined}><Globe2 size={15} /> Tunisia</a>
        <a href="#map" aria-current={page === 'map' ? 'page' : undefined}><Map size={15} /> Site map</a>
      </nav>}
      {page === 'tunisia' ? <Suspense fallback={<div className="surface page-fallback" role="status">Loading Tunisia explorer…</div>}>
        <TunisiaExplorer selectedCityId={cityId} onCityResolved={setCity} selectedPeriod={period}
          onCityChange={selectCity} onPeriodChange={setPeriod} sites={citySites} />
      </Suspense> : <section className="hero">
        <div>
          <div className="eyebrow"><span className="eyebrow-rule" />
            {page === 'map' ? 'RESOURCE MAPPING' : page === 'energy' ? 'RESOURCE ASSESSMENT' : 'IRRIGATION CONTINUITY'}
          </div>
          <h1>{page === 'map' ? <><em>Irrigation</em> observatory</> : page === 'energy' ? <><em>Water</em> &amp; energy</> : <><em>Irrigation</em> simulation</>}</h1>
          <p>{page === 'map' ? site?.properties.field_zone
              ? 'Inspect the terrain, land cover, and evidence behind this agricultural zone.'
              : 'Explore the site, compare solar options, and plan irrigation.'
            : page === 'energy' ? 'Inspect the water and solar inputs available for the selected site.'
            : 'Choose an outage, replay water deliveries and see how long essential household loads can stay powered.'}</p>
        </div>
        {page === 'map' && site && <div className="hero-location"><MapPin size={19} />
          <div><strong>{site.properties.label}</strong><small>{site.properties.locality ?? 'Agricultural site'}</small></div></div>}
        {(page === 'energy' || page === 'simulation') && site && catalog && <div className="theme-site">
          <span><MapPin size={15} /> {site.properties.label}</span>
          <SitePicker sites={catalog.sites.features} siteId={siteId} select={selectSite} />
          <button type="button" className="text-button" onClick={() => navigate('map')}><ArrowLeft size={14} /> Back to map</button>
        </div>}
      </section>}

      {page !== 'tunisia' && !catalog && <div className="surface page-fallback">
        <Droplets size={23} />
        {failure ? <><p role="alert">{failure}</p><button type="button" className="button button-secondary" onClick={() => {
          setFailure(''); setAttempt((version) => version + 1);
        }}>Try again</button><a className="text-button" href="?mode=demo#map">Open the local demo <ArrowUpRight size={13} /></a></>
          : <p role="status">Loading the site…</p>}
      </div>}
      {page !== 'tunisia' && catalog && !site && <section className="surface resource-card">
        <h2>Choose a field site</h2>
        <p>{city ? `Select a registered site to leave the ${city.name} city profile and inspect local inputs.` :
          'Select a site from the catalogue to continue.'}</p>
        <SitePicker sites={catalog.sites.features} siteId="" select={selectSite} />
      </section>}
      {catalog && site && page === 'map' && <SiteMap key={siteId} site={site} sites={catalog.sites.features} scenario={scenarios[0]}
        mode={catalog.mode} selectedOption={solar} onSelectSite={selectSite}
        onCompare={setSolarIds} onEvidence={setSource} onSimulate={() => navigate('simulation')} />}
      {catalog && site && page === 'energy' && <Suspense fallback={<p role="status">Loading site resources…</p>}>
        <ResourceView key={siteId} site={site} sites={catalog.sites.features} onMap={id => { selectSite(id); navigate('map'); }}
          scenario={scenarios[0]} mode={catalog.mode} onCompare={setSolarIds}
          onEvidence={setSource} onPlan={() => navigate('simulation')} />
      </Suspense>}
      {page === 'energy' && catalog?.mode === 'live' && <CivicContinuity key={siteId || cityId} city={site?.properties.label ?? city?.name ?? 'the selected area'} />}
      {catalog && site && visitedSimulation && <div hidden={page !== 'simulation'}>
        {site.properties.field_zone ? <Suspense fallback={<p role="status">Loading regional planner…</p>}>
          <RegionalPlanning key={siteId} site={site} visible={page === 'simulation'} onPlanChange={setZonePlan} />
        </Suspense> : scenarios.length ? <Suspense fallback={<div className="surface page-fallback" role="status">Loading the simulator…</div>}>
          <Simulation key={siteId} site={site} visible={page === 'simulation'} scenarios={scenarios} mode={catalog.mode} solar={solar} onClearSolar={() => setSolar(null)} onEvidence={setSource}
            onAssistantContext={setAssistantSimulation} />
        </Suspense> : <section className="surface resource-card"><h2>Planning inputs unavailable</h2>
          <p>This survey has mapped parcel boundaries and satellite water-use estimates. Its farmer allocations, irrigation demands, equipment and delivery windows still need field verification.</p>
          <a className="text-button" href="#map">Inspect the parcel survey <ArrowUpRight size={15} /></a>
        </section>}
      </div>}
      <footer className="footer"><span><Waves size={15} /> Mizhuo</span>
        <span>{catalog?.mode === 'demo' ? 'Demo mode · local layers and scenarios' : 'Water and electricity continuity · Tunisia'}</span></footer>
    </main>
    {catalog && solarIds && <SolarComparison site={siteId} options={solarIds} mode={catalog.mode} startWithArchive={page === 'energy' && catalog.mode === 'live'}
      selectedOption={solar} close={() => setSolarIds(null)} onEvidence={setSource} onUse={(option) => {
        setSolar(option); setSolarIds(null); navigate('simulation');
      }} />}
    {catalog && source && <EvidencePanel key={source} source={source} mode={catalog.mode} close={() => setSource(null)} />}
    {(activeCity || activeSite) && <button type="button" className="assistant-launch button button-primary" aria-haspopup="dialog"
      onClick={() => setAssistantOpen(true)}><Sparkles size={19} /> Ask Mizhuo</button>}
    {(activeCity || activeSite) && assistantOpen !== undefined && <Suspense fallback={null}>
      <AssistantPanel site={activeSite} city={activeCity ?? undefined} period={activeCity ? period : undefined}
        mode={activeCity ? 'live' : catalog?.mode ?? 'demo'}
        solar={activeSite ? solar : null} simulation={activeSite ? assistantSimulation : undefined}
        zonePlan={activeSite?.properties.field_zone ? zonePlan : undefined} open={assistantOpen}
        close={() => setAssistantOpen(false)} />
    </Suspense>}
  </>;
}
