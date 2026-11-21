import { explanationPanel } from './explanation.js';

const byId = id => document.getElementById(id);
const stage = byId('sim-stage');
const play = byId('sim-play');
const speed = byId('sim-speed');
const source = byId('sim-mode');
const stationSelect = byId('sim-site');
const network = byId('sim-network');
const config = byId('sim-config');
const seedInput = byId('sim-seed');
const scenarioInput = byId('sim-scenario');
const canvas = byId('sim-chart');
const faultButtons = [...document.querySelectorAll('[data-fault]')];
const number = new Intl.NumberFormat('en', { maximumFractionDigits: 3 });
const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Tunis', hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Tunis', day: 'numeric', month: 'short', year: 'numeric' });
const display = (value, unit) => value == null ? '—' : `${number.format(value)} ${unit}`;
let simulatedHour = 3;
let faultQueues = {};
let simulatedSite = 'jendouba-pilote';
let connectedSite;
let running = true;
let visible = false;
let timer;
let request;
let snapshot;
let timelineKey;
let seed = 21;
let scenario = 'routine';
let solarSelection = { option_id: 'toiture', day: '2023-06-21' };
const selectedSite = () => source.value === 'simulated' ? simulatedSite : connectedSite;
const explanation = byId('sim-explanation');
explanation.append(explanationPanel(() => {
  const reading = snapshot?.records.at(-1);
  return { id: snapshot?.explanation_id, context: reading ? `${snapshot.label} ${time.format(new Date(reading.timestamp))}` : '' };
}));

function intensity(row) {
  return row?.grid_available && row.pumped_m3 > 0 && row.consumed_wh != null ? row.consumed_wh / 1000 / row.pumped_m3 : null;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function message(text, kind = '') {
  const box = byId('sim-status');
  box.hidden = !text;
  box.textContent = text;
  box.className = `status ${kind}`;
}

function renderChart() {
  const { clientWidth: width, clientHeight: height } = canvas;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const rows = snapshot?.records ?? [];
  const values = rows.map(intensity);
  const limit = snapshot?.reference == null ? null : snapshot.reference * 1.2;
  const cap = Math.ceil(Math.max(limit ?? 0.6, ...values.filter(value => value != null)) * 5 + 1) / 5;
  const left = 38, right = width - 22, top = 17, bottom = height - 31;
  const x = index => left + index * (right - left) / 23;
  const y = value => bottom - value * (bottom - top) / cap;
  ctx.font = '12px system-ui';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#506b65';
  ctx.strokeStyle = '#dce9e4';
  for (let i = 0; i < 5; i++) {
    const value = cap * i / 4;
    ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
    ctx.fillText(number.format(value), left - 7, y(value) + 4);
  }
  if (limit != null) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#a45b18';
    ctx.beginPath(); ctx.moveTo(left, y(limit)); ctx.lineTo(right, y(limit)); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = '#107e6a'; ctx.fillStyle = '#107e6a'; ctx.lineWidth = 2.5;
  ctx.beginPath();
  let joining = false;
  values.forEach((value, index) => {
    if (value == null) { joining = false; return; }
    if (joining) ctx.lineTo(x(index), y(value));
    else ctx.moveTo(x(index), y(value));
    joining = true;
  });
  ctx.stroke();
  values.forEach((value, index) => {
    if (value == null) return;
    ctx.beginPath(); ctx.arc(x(index), y(value), limit != null && value > limit ? 4 : 2.8, 0, 2 * Math.PI); ctx.fill();
  });
  ctx.fillStyle = '#506b65'; ctx.textAlign = 'center';
  for (const index of (width < 420 ? [0, 6, 12, 18, 23] : [0, 4, 8, 12, 16, 20, 23])) {
    const label = rows[index] ? time.format(new Date(rows[index].timestamp)) : (source.value === 'simulated' ? `${String(index).padStart(2, '0')}:00` : '');
    ctx.fillText(label, x(index), bottom + 18);
  }
}

function renderNetwork(stations) {
  const existing = new Map([...network.children].map(card => [card.dataset.site, card]));
  if (stations.map(station => station.site_id).join('|') !== [...existing.keys()].join('|')) {
    network.replaceChildren(...stations.map(station => {
      const card = element('button', '', 'card station-overview-item');
      card.type = 'button';
      card.dataset.site = station.site_id;
      card.append(element('strong', station.label), element('span', '', 'network-status'), element('small'));
      card.addEventListener('click', () => selectStation(station.site_id));
      return card;
    }));
    stationSelect.replaceChildren(...stations.map(station => new Option(station.label, station.site_id)));
  }
  stationSelect.disabled = !stations.length;
  if (selectedSite()) stationSelect.value = selectedSite();
  for (const [index, station] of stations.entries()) {
    const card = network.children[index];
    card.setAttribute('aria-pressed', String(station.site_id === selectedSite()));
    const badge = card.querySelector('.network-status');
    badge.textContent = station.alerts ? `${station.alerts} ${station.alerts === 1 ? 'alert' : 'alerts'}` : '0 alerts';
    badge.classList.toggle('has-alert', station.alerts > 0);
    const grid = ({ true: 'Grid available', false: 'Grid outage' })[station.grid_available] ?? 'Grid unknown';
    card.querySelector('small').textContent = `${time.format(new Date(station.timestamp))} · ${display(station.stock_m3, 'm³')} in tank · ${grid}`;
  }
}

function renderTimeline(alerts, hasReadings) {
  const key = JSON.stringify([alerts, hasReadings]);
  if (timelineKey === key) return;
  timelineKey = key;
  const list = byId('sim-alerts');
  if (!alerts.length) {
    list.replaceChildren(element('li', hasReadings ? 'No anomalies detected so far.' : 'Waiting for telemetry.', 'incident-empty'));
    return;
  }
  list.replaceChildren(...alerts.slice().reverse().map(alert => {
    const pump = alert.type === 'high_pump_energy_intensity';
    const row = element('li', '', 'incident');
    row.append(element('span', time.format(new Date(alert.period.start)), 'incident-time'),
      element('strong', pump ? 'High pump energy intensity' : 'Unexplained water balance'),
      element('p', pump ? `${display(alert.value, alert.unit)} against ${display(alert.reference, alert.unit)} reference` : `${display(alert.value, alert.unit)} after accounting for tank stock`));
    return row;
  }));
}

function render(data) {
  snapshot = data;
  explanation.hidden = !data?.explanation_id;
  const records = data?.records ?? [];
  const row = records.at(-1);
  const simulated = source.value === 'simulated';
  if (data) source.options[1].disabled = !data.connected_available;
  if (data) renderNetwork(data.stations ?? []);
  byId('sim-station').textContent = data?.label ?? (simulated ? 'Station simulation' : 'Connected station');
  byId('sim-clock').textContent = row ? time.format(new Date(row.timestamp)) : '––:––';
  byId('sim-date').textContent = row ? day.format(new Date(row.timestamp)) : '';
  byId('sim-pump').textContent = display(row?.pumped_m3, 'm³');
  byId('sim-stock').textContent = display(row?.tank_stock_m3, 'm³');
  byId('sim-delivery').textContent = display(row?.distributed_m3, 'm³');
  byId('sim-energy').textContent = display(row?.consumed_wh == null ? null : row.consumed_wh / 1000, 'kWh');
  byId('sim-intensity').textContent = display(intensity(row), 'kWh/m³');
  byId('sim-reference').textContent = data?.reference == null ? 'Station reference unavailable' : `Alert threshold ${display(data.reference * 1.2, 'kWh/m³')}`;
  byId('sim-threshold-key').hidden = data?.reference == null;
  byId('sim-count').textContent = data?.alerts.length ?? 0;
  byId('sim-grid').textContent = ({ true: 'Grid available', false: 'Grid outage' })[row?.grid_available] ?? 'Grid status unavailable';
  byId('sim-water').style.height = data?.capacity_m3 ? `${Math.min(100, (row?.tank_stock_m3 ?? 0) * 100 / data.capacity_m3)}%` : '0%';
  stage.classList.toggle('offline-grid', row?.grid_available === false);
  stage.classList.toggle('flow-in', running && row?.pumped_m3 > 0);
  stage.classList.toggle('flow-out', running && row?.distributed_m3 > 0);
  byId('sim-rate').textContent = simulated ? `${scenario === 'stress' ? 'Stress test' : 'Routine irrigation'} · seed ${seed} · 1 hour per tick` : data ? `Last poll ${time.format(new Date(data.retrieved_at))} Tunisia time` : 'Polling station readings';
  const table = element('table');
  const head = table.createTHead().insertRow();
  for (const label of ['Hour', 'Energy', 'Pumped', 'Stock', 'Delivered']) head.append(element('th', label));
  const body = table.createTBody();
  for (const sample of records.slice(-8).reverse()) {
    const entry = body.insertRow();
    for (const value of [time.format(new Date(sample.timestamp)), display(sample.consumed_wh == null ? null : sample.consumed_wh / 1000, 'kWh'), display(sample.pumped_m3, 'm³'), display(sample.tank_stock_m3, 'm³'), display(sample.distributed_m3, 'm³')]) entry.append(element('td', value));
  }
  byId('sim-readings').replaceChildren(table);
  renderSensors(data);
  renderTimeline(data?.alerts ?? [], !!row);
  renderChart();
  updateControls();
}

function renderSensors(data) {
  const card = byId('sim-sensors-card');
  const measurements = data?.measurements ?? [];
  card.hidden = !measurements.length;
  if (card.hidden) return;
  const profile = data.solar_input;
  byId('sim-solar-input').textContent = profile ? `PVGIS reference · ${profile.label} · ${profile.profile_date}` : 'Solar reference unavailable for this station.';
  const latestSlot = data.records.at(-1).simulation_slot;
  const latest = measurements.filter(reading => reading.simulation_slot === latestSlot);
  const missingFlow = latest.some(reading => reading.sensor_id === 'pump-flow-01' && reading.quality === 'missing');
  const quality = missingFlow ? 'Insufficient data for pump efficiency. Flow sensor reading missing.' : '';
  if (byId('sim-quality').textContent !== quality) byId('sim-quality').textContent = quality;
  const labels = {
    tank_volume: 'Tank stock', pumped_flow: 'Pump flow', inlet_flow: 'Tank inlet flow', distributed_flow: 'Delivery flow',
    pump_power: 'Pump power', pump_energy_total: 'Cumulative pump energy', solar_generation: 'Solar generation',
    solar_self_consumption: 'Solar used by pump', grid_import_for_pumping: 'Grid energy for pump', grid_available: 'Grid state',
  };
  const table = element('table');
  const head = table.createTHead().insertRow();
  for (const label of ['Sensor', 'Metric', 'Reading', 'Quality']) head.append(element('th', label));
  const body = table.createTBody();
  for (const reading of latest) {
    const tr = body.insertRow();
    const unit = reading.unit.replace('m3', 'm³');
    const value = typeof reading.value === 'boolean' ? (reading.value ? 'Available' : 'Outage') : display(reading.value, unit);
    for (const valueText of [reading.sensor_id, labels[reading.metric], value, reading.quality]) tr.append(element('td', valueText));
    tr.classList.toggle('sensor-missing', reading.quality === 'missing');
  }
  byId('sim-sensors').replaceChildren(table);
}

function updateControls() {
  const simulated = source.value === 'simulated';
  const complete = simulated && simulatedHour >= 23;
  play.textContent = complete ? 'Replay feed' : running ? 'Pause feed' : 'Play feed';
  speed.disabled = !simulated;
  config.hidden = !simulated;
  byId('sim-reset').disabled = !simulated;
  byId('sim-injection-target').textContent = `Inject at ${stationSelect.selectedOptions[0]?.text ?? 'selected station'}`;
  for (const button of faultButtons) button.disabled = !simulated || complete || simulatedHour >= (['inefficiency', 'sensor_dropout'].includes(button.dataset.fault) ? 22 : 23);
  byId('sim-source').textContent = `${simulated ? 'SIMULATED FEED' : 'CONNECTED FEED'} · ${complete ? 'COMPLETE' : running ? 'RUNNING' : 'PAUSED'}`;
  stage.classList.toggle('running', running);
}

function schedule() {
  clearTimeout(timer);
  if (!running || !visible) return;
  timer = setTimeout(() => refresh(source.value === 'simulated' ? simulatedHour + 1 : simulatedHour),
    source.value === 'simulated' ? Number(speed.value) : 10_000);
}

async function refresh(target) {
  const controller = new AbortController();
  request?.abort();
  request = controller;
  try {
    const response = await fetch('/api/simulation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: source.value, site_id: selectedSite(), hour: target, fault_queues: faultQueues, seed, scenario,
        solar_selection: solarSelection, include_explanation: true }), signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (controller.signal.aborted) return;
    simulatedHour = target;
    if (source.value === 'connected') connectedSite = data.site_id;
    if (source.value === 'simulated' && target >= 23) running = false;
    const latest = data.records.at(-1);
    const stale = source.value === 'connected' && latest && Date.now() - Date.parse(latest.timestamp) > 7_200_000;
    const waiting = (faultQueues[simulatedSite] ?? []).some(event => event.hour > simulatedHour);
    message(stale ? 'Latest station measurement is over two hours old.' : source.value === 'simulated' && waiting ? 'Test event queued at the selected station.' : '', 'notice');
    render(data);
  } catch (error) {
    if (controller.signal.aborted) return;
    running = false;
    updateControls();
    message(error.message || 'Could not retrieve telemetry. Resume to retry.', 'error');
  } finally {
    if (!controller.signal.aborted) { request = undefined; schedule(); }
  }
}

play.addEventListener('click', () => {
  if (source.value === 'simulated' && simulatedHour === 23) {
    faultQueues = {};
    running = true;
    refresh(3);
    return;
  }
  running = !running;
  render(snapshot);
  if (running && !request) refresh(!snapshot || source.value === 'connected' ? simulatedHour : simulatedHour + 1);
  else schedule();
});
byId('sim-reset').addEventListener('click', () => { faultQueues = {}; clearTimeout(timer); refresh(3); });
config.addEventListener('submit', event => {
  event.preventDefault();
  seed = seedInput.valueAsNumber;
  scenario = scenarioInput.value;
  faultQueues = {};
  clearTimeout(timer);
  render(undefined);
  refresh(3);
});
speed.addEventListener('change', schedule);
source.addEventListener('change', () => {
  if (source.value === 'connected') connectedSite = undefined;
  running = true;
  clearTimeout(timer);
  renderNetwork([]);
  render(undefined);
  refresh(simulatedHour);
});
function selectStation(siteId) {
  if (!siteId || siteId === selectedSite()) return;
  if (source.value === 'simulated') simulatedSite = siteId;
  else connectedSite = siteId;
  clearTimeout(timer);
  stationSelect.value = siteId;
  updateControls();
  refresh(simulatedHour);
}
stationSelect.addEventListener('change', () => selectStation(stationSelect.value));
for (const button of faultButtons) button.addEventListener('click', () => {
  const hour = simulatedHour + (request ? 2 : 1);
  const kind = button.dataset.fault;
  if (hour + (['inefficiency', 'sensor_dropout'].includes(kind) ? 1 : 0) >= 24) return;
  const queued = faultQueues[simulatedSite] ?? [];
  faultQueues[simulatedSite] = [...queued.filter(event => event.hour !== hour || (event.kind === 'sensor_dropout') !== (kind === 'sensor_dropout')), { hour, kind }];
  const label = stationSelect.selectedOptions[0]?.text ?? simulatedSite;
  message(`Test event queued at ${label} for ${String(hour).padStart(2, '0')}:00${running ? '.' : '. Press Play feed to continue.'}`, 'notice');
});

byId('sim-export').addEventListener('click', () => {
  if (!snapshot?.measurements) return;
  const { explanation_id, ...result } = snapshot;
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = `mizu-sensors-${snapshot.site_id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

new ResizeObserver(renderChart).observe(canvas);

export const simulation = {
  enter() { visible = true; if (snapshot) { render(snapshot); schedule(); } else refresh(simulatedHour); },
  leave() { visible = false; clearTimeout(timer); request?.abort(); request = undefined; },
  applySolar(option_id, day) {
    solarSelection = { option_id, day };
    simulatedSite = 'jendouba-pilote';
    source.value = 'simulated';
    snapshot = undefined;
    clearTimeout(timer);
    if (visible) refresh(simulatedHour);
  },
};
