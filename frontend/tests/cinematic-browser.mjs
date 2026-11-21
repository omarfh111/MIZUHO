import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const visible = (locator, timeout = 45000) => locator.waitFor({ state: 'visible', timeout });
const shown = (page) => visible(page.locator('.mx-app[data-experience=done] .terrain-surface canvas'));
const skip = (page) => page.getByRole('button', { name: 'Skip intro' });
const replay = (page) => page.getByRole('button', { name: 'Replay the intro' });

async function watch(page, desktop) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if ((message.type() === 'error' && /shader/i.test(message.text())) || /multiple instances of three\.js/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  await page.addInitScript((desktop) => {
    if (desktop) {
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8 });
      Object.defineProperty(navigator, 'deviceMemory', { value: 8 });
    }
    const getContext = HTMLCanvasElement.prototype.getContext;
    window.testWebGLContexts = new Map();
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const context = getContext.call(this, type, ...args);
      if (context && type === 'webgl2') window.testWebGLContexts.set(this, context);
      return context;
    };
  }, desktop);
}

async function rendererCount(page) {
  return page.evaluate(() => [...window.testWebGLContexts]
    .filter(([canvas, gl]) => !gl.isContextLost() && !canvas.classList.contains('mx-open__field')).length);
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1000, height: 680 } });
  await watch(desktop, true);
  await desktop.goto(base.href);
  await visible(desktop.getByRole('progressbar', { name: /Loading MIZUHO/ }));
  await visible(desktop.locator('.mx-gate[data-phase=film][data-mode="3d"][data-quality=high] .mx-canvas canvas'));
  await desktop.locator('.mx-open__field').waitFor({ state: 'detached', timeout: 30000 });
  await desktop.waitForFunction(() => [...window.testWebGLContexts]
    .filter(([canvas]) => canvas.classList.contains('mx-open__field')).every(([, gl]) => gl.isContextLost()));
  assert.equal(await rendererCount(desktop), 1);
  assert.equal(await desktop.locator('.terrain-surface canvas').count(), 0);
  await desktop.keyboard.press('End');
  await shown(desktop);
  assert.equal(await desktop.locator('.mx-gate canvas').count(), 0);
  assert.equal(await rendererCount(desktop), 1);
  assert.equal(await desktop.evaluate(() => document.activeElement?.id), 'main-content');
  for (let attempt = 0; attempt < 2; attempt++) {
    await replay(desktop).click();
    await visible(desktop.locator('.mx-gate[data-phase=film][data-mode="3d"] .mx-canvas canvas'));
    assert.equal(await rendererCount(desktop), 1);
    if (attempt === 1) {
      await desktop.locator('.mx-canvas canvas').evaluate((canvas) => {
        window.testWebGLContexts.get(canvas).getExtension('WEBGL_lose_context').loseContext();
      });
      await visible(desktop.locator('.mx-gate[data-phase=film][data-mode=fallback]'));
      assert.equal(await rendererCount(desktop), 0);
    }
    await skip(desktop).click();
    await shown(desktop);
    assert.equal(await rendererCount(desktop), 1);
  }
  await desktop.reload();
  await shown(desktop);
  assert.equal(await desktop.locator('.mx-gate').count(), 0);
  await desktop.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await watch(mobile, false);
  await mobile.goto(base.href);
  await visible(mobile.locator('.mx-gate[data-phase=loading][data-quality=low]'));
  await skip(mobile).tap();
  await shown(mobile);
  await replay(mobile).tap();
  await visible(mobile.locator('.mx-gate[data-phase=film][data-mode="3d"][data-quality=low] .mx-canvas canvas'));
  assert.equal(await mobile.locator('.mx-open__field').count(), 0);
  assert.equal(await rendererCount(mobile), 1);
  await mobile.getByRole('button', { name: 'Rain', exact: true }).tap();
  await mobile.locator('.mx-rail button[aria-label=Rain][aria-current=step]').waitFor({ state: 'attached' });
  await skip(mobile).tap();
  await shown(mobile);
  assert.equal(await rendererCount(mobile), 1);
  await mobile.close();

  const reduced = await browser.newPage({ reducedMotion: 'reduce' });
  await watch(reduced, false);
  await reduced.goto(base.href);
  await shown(reduced);
  assert.equal(await reduced.locator('.mx-gate').count(), 0);
  await replay(reduced).click();
  await visible(reduced.locator('.mx-gate[data-phase=film][data-mode=fallback]'));
  assert.equal(await reduced.locator('.mx-gate canvas').count(), 0);
  assert.equal(await rendererCount(reduced), 0);
  await reduced.getByRole('button', { name: 'Rain', exact: true }).click();
  await reduced.locator('.mx-rail button[aria-label=Rain][aria-current=step]').waitFor({ state: 'attached' });
  await reduced.keyboard.press('Escape');
  await shown(reduced);
  await reduced.close();

  const unsupported = await browser.newPage();
  await watch(unsupported, false);
  await unsupported.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type === 'webgl2' ? null : getContext.call(this, type, ...args);
    };
  });
  await unsupported.goto(base.href);
  await visible(unsupported.locator('.mx-gate[data-phase=film][data-mode=fallback]'));
  await skip(unsupported).click();
  await visible(unsupported.getByText(/3D view unavailable/));
  assert.equal(await unsupported.locator('canvas').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Chrome passed the cinematic handoff, repeated replays, WebGL cleanup and recovery, mobile, reduced motion, and no-WebGL fallback.');
} finally {
  await browser.close();
}
