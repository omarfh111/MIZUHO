import { simulation } from './simulation.js';

const pages = {
  simulation: ['Station network', 'Compare stations under the same replay conditions and investigate alerts.'],
  solar: ['Solar comparison', 'Compare generation and savings for two 10 kWp configurations at Jendouba.'],
  forecast: ['Load forecast', 'Run the 24-hour model and compare its test error with the previous-week baseline.'],
  anomalies: ['Anomaly checks', 'Test pump energy intensity and check balances against tank stock changes.'],
  weather: ['J+1 scenarios', 'Compare central and adverse solar availability for the day-ahead reserve.'],
};

const resultArea = document.querySelector('#results');
const status = document.querySelector('#status');
const download = document.querySelector('#download');
const forms = Object.fromEntries([...document.querySelectorAll('[data-form]')].map(form => [form.getAttribute('data-form'), form]));
const navButtons = [...document.querySelectorAll('[data-view]')];
const saved = new Map();
const dirty = new Set();
const started = new Set();
const defaultSite = 'jendouba-pilote';
let stationCatalog = [];
let active = 'simulation';
let pending;
let observer;

const number = (value, digits = 2) => value == null ? 'Unavailable' : new Intl.NumberFormat('en', { maximumFractionDigits: digits }).format(value);
const amount = (value, unit, digits) => value == null ? 'Unavailable' : `${number(value, digits)} ${unit}`;
const hour = index => `${String(index).padStart(2, '0')}:00`;
const localTime = value => value?.slice(0, 16).replace('T', ' ') ?? 'Unavailable';
const periodTime = value => value ? new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Tunis', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value)) : 'Unavailable';
const provenance = value => ({ simulated: 'Simulated', estimated: 'Estimated', observed: 'Observed' })[value] ?? 'Unknown provenance';

function element(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function showStatus(text, kind = '') {
  status.className = `status ${kind}`;
  status.textContent = text;
  status.hidden = !text;
}

function metric(label, value, detail) {
  return element('article', 'card metric', element('p', '', label), element('strong', '', value), element('p', 'detail', detail));
}

function card(title, detail, extra = '') {
  return element('article', `card output-card ${extra}`, element('h2', '', title), element('p', 'caption', detail));
}

function listing(values) {
  return element('dl', '', ...values.map(([key, value]) => element('div', '', element('dt', '', key), element('dd', '', value))));
}

function table(headers, rows) {
  const header = headers.map(label => {
    const cell = element('th', '', label);
    cell.scope = 'col';
    return cell;
  });
  return element('div', 'table-wrap', element('table', '', element('thead', '', element('tr', '', ...header)),
    element('tbody', '', ...rows.map(row => element('tr', '', ...row.map(cell => element('td', '', cell)))))));
}

function hourlyTable(labels, series, unit) {
  return element('details', 'card output-card full-card', element('summary', '', 'Hourly values'),
    table(['Local hour', ...series.map(item => item.label)], labels.map((label, index) => [
      label, ...series.map(item => amount(item.values[index], unit)),
    ])));
}

function drawChart(canvas, labels, series, unit, risk) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const left = 42, right = width - 21, top = 23, bottom = height - 28;
  const max = Math.max(0.1, ...series.flatMap(item => item.values.filter(Number.isFinite)));
  const rawStep = max / 4;
  const order = 10 ** Math.floor(Math.log10(rawStep));
  const step = ([1, 2, 2.5, 5, 10].find(item => item >= rawStep / order) ?? 10) * order;
  const ceiling = Math.ceil(max / step) * step;
  const x = index => left + (right - left) * index / (labels.length - 1);
  const y = value => bottom - (bottom - top) * value / ceiling;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#53665f';
  ctx.fillText(unit, left, 13);
  if (risk != null) {
    ctx.fillStyle = '#fcf2df';
    ctx.fillRect(x(risk), top, right - x(risk), bottom - top);
  }
  for (let tick = 0; tick <= Math.round(ceiling / step); tick++) {
    const value = tick * step;
    ctx.strokeStyle = '#dfebe5';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
    ctx.fillStyle = '#53665f'; ctx.textAlign = 'right';
    ctx.fillText(number(value, 3), left - 7, y(value) + 4);
  }
  ctx.textAlign = 'center';
  for (const index of (width < 420 ? [0, 8, 16, 23] : [0, 4, 8, 12, 16, 20, 23])) {
    ctx.fillText(labels[index].slice(-5), x(index), bottom + 19);
  }
  series.forEach((item, seriesIndex) => {
    ctx.strokeStyle = seriesIndex ? '#a45b18' : '#177a64';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(seriesIndex ? [5, 4] : []);
    ctx.beginPath();
    let connected = false;
    item.values.forEach((value, index) => {
      if (!Number.isFinite(value)) { connected = false; return; }
      if (connected) ctx.lineTo(x(index), y(value));
      else ctx.moveTo(x(index), y(value));
      connected = true;
    });
    ctx.stroke();
  });
}

function chartCard(title, detail, labels, series, unit, risk = null) {
  const plot = card(title, detail);
  const canvas = element('canvas', 'chart');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${title} in ${unit}. The same data is in the hourly values table.`);
  plot.append(element('ul', 'legend', ...series.map((item, index) => element('li', '',
    element('span', `swatch ${index ? 'other' : ''}`), item.label))), canvas);
  observer = new ResizeObserver(() => drawChart(canvas, labels, series, unit, risk));
  observer.observe(canvas);
  return plot;
}

function renderSolar(result) {
  const options = result.options;
  const day = options[0].profile_date;
  const labels = Array.from({ length: 24 }, (_, index) => hour(index));
  const series = options.map(option => ({ label: option.label, values: option.profile_wh.map(value => value / 1000) }));
  const top = element('div', 'summary', ...options.map(option => metric(option.label,
    amount(option.annual_production_kwh, 'kWh', 0), `Estimated ${option.series_year} generation`)),
  metric('Profile date', day, 'Hourly values in Tunisia time'));
  const details = card('Option results', 'Load and tariff determine the savings shown.');
  for (const option of options) {
    const apply = element('button', 'secondary', 'Apply to simulation');
    apply.type = 'button';
    apply.addEventListener('click', () => { simulation.applySolar(option.id, option.profile_date); navigate('simulation'); });
    details.append(element('div', 'item',
      element('div', 'item-title', element('h3', '', option.label), element('span', 'tag', `${option.capacity_kwp} kWp`)),
      listing([
        ['Daily generation', amount(option.production_kwh, 'kWh')],
        ['Self-consumed / grid avoided', amount(option.grid_avoided_kwh, 'kWh')],
        ['Daily gross savings', amount(option.gross_savings_tnd, 'TND')],
        ['Tilt / azimuth', `${option.tilt_deg}° / ${option.azimuth_deg}°`],
        ['System losses', `${option.losses_pct}%`],
      ]), apply));
  }
  return [top, element('div', 'result-grid', chartCard('Hourly generation', 'PVGIS estimates, before applying load and outages.', labels, series, 'kWh'), details), hourlyTable(labels, series, 'kWh')];
}

function renderForecast(result) {
  if (result.status === 'insufficient_history') {
    return [card('Insufficient history', 'Choose a later cutoff or upload a longer hourly telemetry series.', 'full-card')];
  }
  const top = element('div', 'summary',
    metric('Forecast horizon', `${result.points.length} hours`, `${provenance(result.provenance)} inputs`),
    metric('Regression error', amount(result.test.regression_mae_kw, 'kW', 4), 'Mean absolute error'),
    metric('Previous-week baseline error', amount(result.test.same_hour_last_week_mae_kw, 'kW', 4), `${result.test.hours} shared test hours`));
  const labels = result.points.map(point => localTime(point.timestamp));
  const series = [
    { label: 'Regression', values: result.points.map(point => point.load_kw) },
    { label: 'Same hour last week', values: result.points.map(point => point.same_hour_last_week_kw) },
  ];
  const details = card('Evaluation window', 'Chronological holdout, shown in Tunisia time.');
  details.append(listing([['From', periodTime(result.test.from)], ['Through', periodTime(result.test.through)], ['Cutoff', localTime(result.as_of)]]));
  return [top, element('div', 'result-grid', chartCard('Predicted load', `${labels[0]} to ${labels.at(-1)}`, labels, series, 'kW'), details), hourlyTable(labels, series, 'kW')];
}

function renderAnomalies(result) {
  const labels = { high_pump_energy_intensity: 'High pump energy intensity', unexplained_water: 'Unexplained water balance' };
  const state = value => value === 'ok' ? 'Evaluated' : 'Insufficient data';
  const alerts = card('Detected anomalies', result.alerts.length ? 'Periods shown in Tunisia time.' : 'No anomalies were detected in the available checks.', 'full-card');
  if (result.alerts.length) alerts.append(table(['Type', 'Site', 'Period', 'Value', 'Reference', 'Provenance'],
    result.alerts.map(alert => [labels[alert.type] ?? alert.type, alert.site_id,
      `${periodTime(alert.period.start)} to ${periodTime(alert.period.end)}`, amount(alert.value, alert.unit),
      amount(alert.reference, alert.unit), provenance(alert.provenance)])));
  const checks = card('Data coverage', 'Check which measurements were sufficient to evaluate each site.', 'full-card');
  checks.append(result.diagnostics.length ? table(['Site', 'Water balance', 'Pump energy'], result.diagnostics.map(item => [
    item.site_id, state(item.water_balance), state(item.pump_energy_intensity),
  ])) : element('p', 'hint', 'The selected CSV contains no records.'));
  return [alerts, checks];
}

function renderWeather(result) {
  const labels = result.central.slots.map(slot => hour(slot.slot));
  const series = [result.central, result.adverse].map((profile, index) => ({
    label: index ? 'Adverse' : 'Central', values: profile.slots.map(slot => slot.solar_wh / 1000),
  }));
  const afterRisk = series.map(item => item.values.slice(result.risk_start_slot).reduce((sum, value) => sum + value, 0));
  const top = element('div', 'summary',
    metric('Risk starts', hour(result.risk_start_slot), result.valid_date),
    metric('Central after risk starts', amount(afterRisk[0], 'kWh'), provenance(result.central.provenance)),
    metric('Adverse after risk starts', amount(afterRisk[1], 'kWh'), provenance(result.adverse.provenance)));
  const metadata = card('Scenario details', 'Amber shading marks the risk window.');
  metadata.append(listing([['Pair', result.id], ...(result.seed == null ? [] : [['Seed', String(result.seed)]]), ['Issued', localTime(result.central.issued_at)], ['Timezone', result.central.timezone],
    ['Central source', result.central.source_id], ['Adverse source', result.adverse.source_id]]));
  return [top, element('div', 'result-grid', chartCard('Available solar energy', 'Hourly profile inputs for the reserve calculation.', labels, series, 'kWh', result.risk_start_slot), metadata), hourlyTable(labels, series, 'kWh')];
}

const renderers = { solar: renderSolar, forecast: renderForecast, anomalies: renderAnomalies, weather: renderWeather };

function showResult(view) {
  observer?.disconnect();
  resultArea.replaceChildren();
  if (saved.has(view)) resultArea.append(...renderers[view](saved.get(view)));
  download.hidden = !saved.has(view) || dirty.has(view);
}

async function fileText(input, required = false) {
  const file = input.files[0];
  if (!file && required) throw new Error('Select an input file.');
  if (file?.size > 2_000_000) throw new Error('Select a file under 2 MB.');
  return file ? file.text() : undefined;
}

async function makePayload(view, form) {
  const fields = new FormData(form);
  const field = name => fields.get(name);
  const optionalNumber = name => field(name) === '' ? null : Number(field(name));
  const dataset = field('dataset');
  if (view === 'solar') return {
    option_ids: fields.getAll('option'), day: field('day'), price: optionalNumber('price'),
    dataset, load_csv: dataset === 'file' ? await fileText(form.elements.load, true) : undefined,
  };
  if (view === 'forecast') return {
    site_id: (dataset === 'file' ? field('custom_site') : field('site_id')).trim(), as_of: `${field('as_of')}:00+01:00`,
    dataset, telemetry_csv: dataset === 'file' ? await fileText(form.elements.telemetry, true) : undefined,
    weather_csv: await fileText(form.elements.weather),
  };
  if (view === 'anomalies') return {
    dataset, reference: optionalNumber('reference'), site_id: (dataset === 'file' ? field('custom_site') : field('site_id')).trim(),
    telemetry_csv: dataset === 'file' ? await fileText(form.elements.telemetry, true) : undefined,
  };
  const text = await fileText(form.elements.profiles);
  return text ? { pair: field('custom_pair'), profiles: JSON.parse(text) } : { pair: field('pair'), seed: optionalNumber('seed') };
}

async function run(view) {
  if (pending?.view === view) return;
  const form = forms[view];
  if (!form.reportValidity()) return;
  started.add(view);
  const button = form.querySelector('[type=submit]');
  const controller = new AbortController();
  pending = { view, controller };
  button.disabled = true;
  resultArea.setAttribute('aria-busy', 'true');
  download.hidden = true;
  showStatus('Calculating…');
  try {
    const payload = await makePayload(view, form);
    const response = await fetch(`/api/${view}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Calculation failed.');
    saved.set(view, data);
    dirty.delete(view);
    if (active === view) { showResult(view); showStatus(''); }
  } catch (error) {
    if (active === view && !controller.signal.aborted) {
      showStatus(`${error.message}${saved.has(view) ? ' The previous result is still visible.' : ''}`, 'error');
    }
  } finally {
    if (pending?.controller === controller) {
      button.disabled = false;
      pending = undefined;
      resultArea.setAttribute('aria-busy', 'false');
    }
  }
}

function cancel() {
  if (!pending) return;
  forms[pending.view].querySelector('[type=submit]').disabled = false;
  if (!saved.has(pending.view)) started.delete(pending.view);
  pending.controller.abort();
  pending = undefined;
  resultArea.setAttribute('aria-busy', 'false');
}

function navigate(view) {
  if (view === active) return;
  cancel();
  if (active === 'simulation') simulation.leave();
  active = view;
  document.querySelector('#simulation').hidden = view !== 'simulation';
  document.querySelector('#calculation-inputs').hidden = view === 'simulation';
  for (const [key, form] of Object.entries(forms)) form.hidden = key !== view;
  for (const button of navButtons) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  document.querySelector('#title').textContent = pages[view][0];
  document.querySelector('#description').textContent = pages[view][1];
  showResult(view);
  showStatus(dirty.has(view) && saved.has(view) ? 'Inputs changed. Run the calculation to refresh the results.' : '', 'notice');
  if (view === 'simulation') { simulation.enter(); return; }
  if (!saved.has(view) && !started.has(view)) run(view);
}

for (const button of navButtons) button.addEventListener('click', () => navigate(button.dataset.view));
for (const [view, form] of Object.entries(forms)) {
  form.addEventListener('submit', event => { event.preventDefault(); run(view); });
  form.addEventListener('input', () => {
    cancel();
    dirty.add(view);
    download.hidden = true;
    showStatus(saved.has(view) ? 'Inputs changed. Run the calculation to refresh the results.' : '', 'notice');
  });
}

function updateTelemetryInputs(view, form, siteChanged = false) {
  const station = form.querySelector('[data-station-select]');
  const dataset = form.elements.namedItem('dataset');
  const custom = dataset.value === 'file';
  const upload = form.querySelector('[data-custom-file]');
  upload.hidden = !custom;
  upload.querySelector('input').required = custom;
  if (!station) return;

  const customSite = form.querySelector('[data-custom-site]');
  station.closest('label').hidden = custom;
  customSite.hidden = !custom;
  customSite.querySelector('input').required = custom && view === 'forecast';
  const legacyDataset = dataset.querySelector('option[value=sample]');
  legacyDataset.disabled = station.value !== defaultSite;
  if (legacyDataset.disabled && dataset.value === 'sample') dataset.value = 'stress';
  if (view === 'anomalies' && siteChanged) {
    const selected = stationCatalog.find(item => item.site_id === station.value);
    if (selected) form.elements.reference.value = selected.reference;
  }
}

for (const view of ['solar', 'forecast', 'anomalies']) {
  const form = forms[view];
  form.elements.namedItem('dataset').addEventListener('change', () => updateTelemetryInputs(view, form));
  form.querySelector('[data-station-select]')?.addEventListener('change', () => updateTelemetryInputs(view, form, true));
}

fetch('/api/stations').then(response => {
  if (!response.ok) throw new Error('Could not load the station catalog.');
  return response.json();
}).then(({ stations }) => {
  stationCatalog = stations;
  for (const select of document.querySelectorAll('[data-station-select]')) {
    select.replaceChildren(...stations.map(station => new Option(station.label, station.site_id)));
  }
}).catch(error => console.warn(error.message));
function updateWeatherSeed() {
  const enabled = !forms.weather.elements.profiles.files.length && forms.weather.elements.pair.value === 'seeded';
  document.querySelector('#weather-seed').hidden = !enabled;
  forms.weather.elements.seed.required = enabled;
}
forms.weather.elements.pair.addEventListener('change', updateWeatherSeed);
forms.weather.elements.profiles.addEventListener('change', async event => {
  const input = event.target;
  const selected = input.files[0];
  const custom = document.querySelector('#custom-pair');
  updateWeatherSeed();
  document.querySelector('#bundled-pair').hidden = Boolean(selected);
  custom.hidden = !selected;
  const options = forms.weather.elements.custom_pair;
  options.required = Boolean(selected);
  options.replaceChildren();
  input.setCustomValidity('');
  if (!selected) return;
  try {
    const pairs = JSON.parse(await fileText(input));
    if (!pairs || typeof pairs !== 'object' || Array.isArray(pairs) || !Object.keys(pairs).length) throw new Error('Expected a JSON object keyed by scenario pair ID.');
    if (input.files[0] === selected) options.append(...Object.keys(pairs).map(key => new Option(key, key)));
  } catch (error) {
    if (input.files[0] === selected) {
      input.setCustomValidity(error.message);
      if (active === 'weather') showStatus(error.message, 'error');
    }
  }
});
download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(saved.get(active), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `mizu-${active}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

simulation.enter();
