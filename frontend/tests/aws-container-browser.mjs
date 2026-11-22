import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, request } from 'playwright-core';

// Run the release image exactly as shipped. A disposable TLS proxy stands in for
// the AWS load balancer. Only this test's loopback endpoint trusts its certificate.
const image = process.argv[2] || 'mizuho:ci';
const prefix = 'mizuho-test-' + randomUUID();
const password = randomBytes(32).toString('hex');
const salt = randomBytes(16);
const digest = pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('hex');
const auth = {
  MIZUHO_JUDGE_USER: 'judge',
  MIZUHO_JUDGE_PASSWORD_HASH: ['pbkdf2_sha256', '600000', salt.toString('hex'), digest].join('$'),
  MIZHUO_MANAGER_APPROVAL_CODE: randomBytes(24).toString('hex'),
};
const docker = (...args) => execFileSync('docker', args, {
  env: { ...process.env, ...auth }, encoding: 'utf8', timeout: 180_000,
}).trim();

const containers = [];
let browser;
let client;
docker('network', 'create', prefix);
try {
  for (const [name, args] of [
    ['app', ['--network-alias', 'app', ...Object.keys(auth).flatMap(key => ['-e', key]), image]],
    ['edge', ['-p', '127.0.0.1::8443', 'caddy:2-alpine', 'caddy', 'reverse-proxy', '--from',
      'https://localhost:8443', '--to', 'http://app:8000', '--internal-certs', '--disable-redirects']],
  ]) {
    const container = prefix + '-' + name;
    containers.push(container);
    docker('run', '-d', '--network', prefix, '--name', container, ...args);
  }
  const portBinding = docker('port', prefix + '-edge', '8443/tcp');
  assert.match(portBinding, /^127\.0\.0\.1:\d+$/);
  const origin = 'https://localhost:' + portBinding.split(':')[1];
  client = await request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  let healthy = false;
  for (let attempt = 0; !healthy && attempt < 60; attempt++) {
    try { healthy = (await client.get('/deploy-healthz', { timeout: 2000 })).status() === 200; }
    catch { /* The proxy and application start independently. */ }
    if (!healthy) await delay(1000);
  }
  assert.ok(healthy, 'The packaged application answered the load balancer probe');
  for (const path of ['/', '/api/health']) assert.equal((await client.get(path)).status(), 401);

  browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, reducedMotion: 'reduce',
    httpCredentials: { username: auth.MIZUHO_JUDGE_USER, password, origin } });
  await page.goto(origin + '/?intro=0&lang=en#tunisia');
  await page.getByRole('group', { name: 'Interactive map of Tunisia' }).waitFor();
  const result = await page.evaluate(async () => {
    const scenarios = await (await fetch('/api/scenarios')).json();
    const mini = scenarios.find(scenario => scenario.id === 'mini');
    const response = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: mini.id, state: mini.state, solar_option_id: null,
        outage_slots: mini.slots.filter(slot => !slot.grid_available).map(slot => slot.slot) }) });
    if (!response.ok) throw new Error('Authenticated compare returned ' + response.status);
    const plans = await response.json();
    return [plans.baseline, plans.optimized].map(plan => plan.plot_results.map(row => row.delivered_on_time_m3));
  });
  assert.deepEqual(result, [[10, 0], [5, 5]]);

  const ready = await page.evaluate(() => new Promise((resolve, reject) => {
    const socket = new WebSocket('wss://' + location.host + '/api/guardian/call');
    const timer = setTimeout(() => { socket.close(); reject(new Error('Guardian did not respond')); }, 10000);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'start', reason: 'accessibility', language: 'ja', site_id: 'jendouba-pilote' }));
    socket.onmessage = event => { clearTimeout(timer); resolve(JSON.parse(event.data)); socket.close(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Authenticated Guardian handshake failed')); };
  }));
  assert.equal(ready.type, 'ready');
  assert.equal(ready.language, 'ja');
  assert.ok(ready.text);
  console.log('Release image passed HTTPS access, Tunisia map, A/B planning and Japanese Guardian WebSocket checks.');
} finally {
  await browser?.close();
  await client?.dispose();
  for (const name of containers.reverse()) {
    try { docker('rm', '-f', '-v', name); } catch { /* Container creation may have failed. */ }
  }
  docker('network', 'rm', prefix);
}
