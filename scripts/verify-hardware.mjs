import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const usage = 'Usage: node scripts/verify-hardware.mjs /path/to/chrome [output.json] [--stock-only]';
if (process.argv.includes('--help')) {
  console.log(usage);
  process.exit(0);
}
const stockOnly = process.argv.includes('--stock-only');
const positional = process.argv.slice(2).filter(argument => argument !== '--stock-only');
if (positional.length < 1 || positional.length > 2 || positional.some(argument => argument.startsWith('--'))) {
  throw new Error(usage);
}
const [binary, output = path.resolve('evidence/hardware-verification.json')] = positional;
const extraArgs = JSON.parse(process.env.PROBE_BROWSER_ARGS ?? '[]');
if (!Array.isArray(extraArgs) || extraArgs.some(argument => typeof argument !== 'string')) {
  throw new Error('PROBE_BROWSER_ARGS must be a JSON string array');
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function bounded(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminate(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  try {
    await bounded(exited, 3000, 'process termination');
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await bounded(exited, 3000, 'forced process termination');
  }
}

class CDP {
  #socket;
  #sequence = 0;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const transaction = this.#pending.get(message.id);
      if (!transaction) return;
      this.#pending.delete(message.id);
      clearTimeout(transaction.timer);
      if (message.error) transaction.reject(new Error(JSON.stringify(message.error)));
      else transaction.resolve(message.result);
    });
    socket.addEventListener('close', () => this.#rejectPending(new Error('CDP connection closed')));
    socket.addEventListener('error', () => this.#rejectPending(new Error('CDP connection error')));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    const connection = new CDP(socket);
    try {
      await bounded(once(socket, 'open'), 10000, 'CDP connection');
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      if (this.#socket.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP connection is not open: ${method}`));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  #rejectPending(error) {
    for (const transaction of this.#pending.values()) {
      clearTimeout(transaction.timer);
      transaction.reject(error);
    }
    this.#pending.clear();
  }

  close() {
    this.#rejectPending(new Error('verification session closed'));
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.close();
    }
  }
}

// Every document and worker runs this before its messaging or test setup.
function firstSnapshot() {
  const memory = globalThis.performance.memory;
  return {
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    cpuPerformance: navigator.cpuPerformance ?? null,
    cpuPerformanceExposed: 'cpuPerformance' in navigator,
    secureContext: isSecureContext,
    href: location.href,
    performanceMemory: memory ? {
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
      totalJSHeapSize: memory.totalJSHeapSize,
      usedJSHeapSize: memory.usedJSHeapSize,
    } : null,
  };
}

// This function executes in the page, with no injected scripts or emulation.
async function collectHardware() {
  const { run, crossOrigin } = window.__hardwareConfig;
  const query = `run=${encodeURIComponent(run)}`;
  const within = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const frameSnapshot = async (origin, kind) => {
    const frame = document.createElement('iframe');
    frame.src = `${origin}/frame?${query}&kind=${kind}`;
    const response = new Promise((resolve, reject) => {
      const receive = event => {
        if (event.source !== frame.contentWindow || event.origin !== origin ||
            event.data?.run !== run || event.data?.kind !== kind) return;
        window.removeEventListener('message', receive);
        resolve(event.data.first);
      };
      window.addEventListener('message', receive);
      frame.onerror = () => {
        window.removeEventListener('message', receive);
        reject(new Error(`${kind} frame failed`));
      };
    });
    document.body.appendChild(frame);
    // Keep frames alive so the CDP target list can confirm the OOPIF exists.
    return within(response, `${kind} frame`);
  };

  const dedicatedSnapshot = async () => {
    const worker = new Worker(`/dedicated.js?${query}`);
    try {
      return await within(new Promise((resolve, reject) => {
        worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
        worker.onerror = event => reject(new Error(event.message || 'dedicated worker failed'));
      }), 'dedicated/nested worker');
    } finally {
      worker.terminate();
    }
  };

  const sharedSnapshot = async () => {
    const worker = new SharedWorker(`/shared.js?${query}`, `hardware-${run}`);
    try {
      return await within(new Promise((resolve, reject) => {
        worker.port.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message || 'shared worker failed'));
        worker.port.start();
      }), 'shared worker');
    } finally {
      worker.port.close();
    }
  };

  const serviceSnapshot = async () => {
    const registration = await within(navigator.serviceWorker.register(`/service.js?${query}`), 'service worker registration');
    const channel = new MessageChannel();
    try {
      const ready = await within(navigator.serviceWorker.ready, 'service worker activation');
      const response = new Promise(resolve => { channel.port1.onmessage = event => resolve(event.data); });
      (registration.active ?? ready.active).postMessage('first snapshot', [channel.port2]);
      return await within(response, 'service worker snapshot');
    } finally {
      channel.port1.close();
      channel.port2.close();
      await registration.unregister();
    }
  };

  const [sameOriginFrame, crossOriginFrame, dedicated, sharedWorker, serviceWorker] = await Promise.all([
    frameSnapshot(location.origin, 'same-origin'),
    frameSnapshot(crossOrigin, 'cross-origin'),
    dedicatedSnapshot(),
    sharedSnapshot(),
    serviceSnapshot(),
  ]);
  return {
    page: window.__firstHardware,
    sameOriginFrame,
    crossOriginFrame,
    dedicatedWorker: dedicated.first,
    nestedWorker: dedicated.nested,
    sharedWorker,
    serviceWorker,
  };
}

const requests = [];
const snapshotSource = `const first = (${firstSnapshot.toString()})();\n`;
const memoryHeaderNames = ['device-memory', 'sec-ch-device-memory'];
const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const run = url.searchParams.get('run');
  requests.push({
    run,
    host: request.headers.host,
    pathname: url.pathname,
    memoryHeaders: Object.fromEntries(memoryHeaderNames.map(name => [name, request.headers[name] ?? null])),
  });
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/warmup' || url.pathname === '/observed') {
    response.setHeader('Accept-CH', 'Device-Memory, Sec-CH-Device-Memory');
  }
  if (url.pathname === '/subresource') {
    response.setHeader('Content-Type', 'image/svg+xml');
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    return;
  }
  if (url.pathname.endsWith('.js')) {
    response.setHeader('Content-Type', 'text/javascript');
    let script = snapshotSource;
    if (url.pathname === '/nested.js') {
      script += 'postMessage(first);';
    } else if (url.pathname === '/dedicated.js') {
      script += `const worker = new Worker('/nested.js?run=${encodeURIComponent(run)}');
        worker.onmessage = event => { postMessage({first, nested:event.data}); worker.terminate(); };
        worker.onerror = event => postMessage({error:event.message || 'nested worker failed'});`;
    } else if (url.pathname === '/shared.js') {
      script += 'self.onconnect = event => { event.ports[0].postMessage(first); };';
    } else if (url.pathname === '/service.js') {
      script += `self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
        self.addEventListener('activate', event => event.waitUntil(clients.claim()));
        self.addEventListener('message', event => event.ports[0].postMessage(first));`;
    } else {
      response.writeHead(404).end();
      return;
    }
    response.end(script);
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/frame') {
    response.end(`<!doctype html><script>${snapshotSource}
      parent.postMessage({run:${JSON.stringify(run)},kind:${JSON.stringify(url.searchParams.get('kind'))},first}, '*');
      </script><title>Frame first snapshot</title>`);
    return;
  }
  const address = server.address();
  const config = { run, crossOrigin: `http://127.0.0.2:${address.port}` };
  response.end(`<!doctype html><script>${snapshotSource}
    window.__firstHardware = first;
    window.__hardwareConfig = ${JSON.stringify(config)};
    window.__collectHardware = (${collectHardware.toString()});
    </script><title>Hardware functional verification</title><body>
    ${url.pathname === '/observed' ? `<img alt="" src="/subresource?run=${encodeURIComponent(run)}">` : ''}
    </body>`);
});

async function reservePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function evaluate(connection, sessionId, expression, awaitPromise = false) {
  const result = await connection.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function navigate(connection, sessionId, url) {
  const result = await connection.send('Page.navigate', { url }, sessionId);
  if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
  for (let attempt = 0; attempt < 200; ++attempt) {
    try {
      const first = await evaluate(connection, sessionId,
        `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' ? window.__firstHardware : null`);
      if (first) return first;
    } catch (error) {
      if (!/context|Cannot find|Inspected target navigated/i.test(error.message)) throw error;
    }
    await delay(50);
  }
  throw new Error(`Document first snapshot was not ready: ${url}`);
}

function checkSnapshot(value, expected, label, worker = false) {
  assert.ok(value, `${label}: missing snapshot`);
  assert.equal(value.secureContext, true, `${label}: expected a trustworthy loopback origin`);
  assert.ok(Number.isInteger(value.hardwareConcurrency) && value.hardwareConcurrency > 0, `${label}: invalid hardwareConcurrency`);
  assert.ok(typeof value.deviceMemory === 'number' && value.deviceMemory > 0, `${label}: missing deviceMemory`);
  assert.equal(value.hardwareConcurrency, expected.hardwareConcurrency, `${label}: hardwareConcurrency`);
  assert.equal(value.deviceMemory, expected.deviceMemory, `${label}: deviceMemory`);
  assert.equal(value.cpuPerformanceExposed, !worker, `${label}: cpuPerformance exposure`);
  if (worker) {
    assert.equal(value.cpuPerformance, null, `${label}: WorkerNavigator must not expose cpuPerformance`);
  } else {
    assert.ok(Number.isInteger(value.cpuPerformance) && value.cpuPerformance >= 0 && value.cpuPerformance <= 4, `${label}: invalid cpuPerformance`);
    assert.equal(value.cpuPerformance, expected.cpuPerformance, `${label}: cpuPerformance`);
    assert.ok(value.performanceMemory?.jsHeapSizeLimit > 0, `${label}: missing real heap limit`);
  }
}

async function runScenario(scenario, display, temporary, origins, report) {
  const run = `${scenario.name}-${randomUUID()}`;
  const userDirectory = await mkdtemp(path.join(temporary, `${scenario.name}-`));
  const browserEnvironment = { ...process.env, DISPLAY: display };
  delete browserEnvironment.INVISIBLE_CHROMIUM_PROFILE;
  if (scenario.profile !== null) browserEnvironment.INVISIBLE_CHROMIUM_PROFILE = JSON.stringify(scenario.profile);
  const debuggingPort = await reservePort();
  const args = [
    `--user-data-dir=${userDirectory}`, '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debuggingPort}`, '--site-per-process',
    '--window-size=1280,800', '--ozone-platform=x11',
    ...(process.env.PROBE_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ...extraArgs, 'about:blank',
  ];
  const result = {
    name: scenario.name,
    profileEnvironmentPresent: Object.hasOwn(browserEnvironment, 'INVISIBLE_CHROMIUM_PROFILE'),
    profileEnvironment: browserEnvironment.INVISIBLE_CHROMIUM_PROFILE ?? null,
    launchArgs: args.map(argument => argument.startsWith('--user-data-dir=') ? '--user-data-dir=<temporary>' : argument),
    status: 'running',
  };
  report.scenarios.push(result);
  let browser, connection, stderr = '', spawnError;
  try {
    browser = spawn(binary, args, { env: browserEnvironment, stdio: ['ignore', 'ignore', 'pipe'] });
    browser.on('error', error => { spawnError = error; });
    browser.stderr.on('data', data => {
      stderr = (stderr + data.toString()).slice(-20000);
      if (process.env.PROBE_LOG_STDERR === '1') process.stderr.write(data);
    });
    let endpoint;
    for (let attempt = 0; attempt < 150; ++attempt) {
      if (spawnError) throw spawnError;
      if (browser.exitCode !== null || browser.signalCode !== null) {
        throw new Error(`Browser exited ${browser.exitCode ?? browser.signalCode}: ${stderr}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/version`, { signal: AbortSignal.timeout(500) });
        if (response.ok) endpoint = await response.json();
      } catch {}
      if (endpoint?.webSocketDebuggerUrl) break;
      await delay(100);
    }
    if (!endpoint?.webSocketDebuggerUrl) throw new Error(`Browser endpoint not ready: ${stderr}`);
    connection = await CDP.connect(endpoint.webSocketDebuggerUrl);
    result.version = await connection.send('Browser.getVersion');
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    await connection.send('Page.enable', {}, sessionId);
    await connection.send('Target.activateTarget', { targetId });
    const url = (origin, pathname) => `${origin}${pathname}?run=${encodeURIComponent(run)}`;
    result.initial = await navigate(connection, sessionId, url(origins.main, '/unprimed'));
    await navigate(connection, sessionId, url(origins.main, '/warmup'));
    await navigate(connection, sessionId, url(origins.main, '/observed'));
    result.snapshots = await evaluate(connection, sessionId, 'window.__collectHardware()', true);
    const expected = scenario.expected ?? {
      hardwareConcurrency: result.snapshots.page.hardwareConcurrency,
      deviceMemory: result.snapshots.page.deviceMemory,
      cpuPerformance: result.snapshots.page.cpuPerformance,
    };
    result.expected = expected;
    checkSnapshot(result.initial, expected, `${scenario.name}: initial document`);
    for (const [label, snapshot] of Object.entries(result.snapshots)) {
      checkSnapshot(snapshot, expected, `${scenario.name}: ${label}`, label.endsWith('Worker'));
    }
    const { targetInfos } = await connection.send('Target.getTargets');
    result.crossOriginIframeTargets = targetInfos.filter(target => target.type === 'iframe' && target.url.startsWith(`${origins.cross}/frame?`));
    assert.ok(result.crossOriginIframeTargets.length > 0, `${scenario.name}: cross-origin frame must be an OOPIF`);
    result.lifecycle = {
      crossOriginNavigation: await navigate(connection, sessionId, url(origins.cross, '/lifecycle')),
      returnNavigation: await navigate(connection, sessionId, url(origins.main, '/lifecycle')),
    };
    for (const [label, snapshot] of Object.entries(result.lifecycle)) {
      checkSnapshot(snapshot, expected, `${scenario.name}: ${label}`);
    }
    const recorded = requests.filter(request => request.run === run);
    const requestFor = pathname => {
      const request = recorded.find(request => request.host === new URL(origins.main).host && request.pathname === pathname);
      assert.ok(request, `${scenario.name}: missing ${pathname} request`);
      return request;
    };
    result.clientHints = {
      initialNavigation: requestFor('/unprimed'),
      warmupNavigation: requestFor('/warmup'),
      optedInNavigation: requestFor('/observed'),
      optedInSubresource: requestFor('/subresource'),
    };
    for (const name of memoryHeaderNames) {
      assert.equal(result.clientHints.initialNavigation.memoryHeaders[name], null, `${scenario.name}: ${name} without opt-in`);
      assert.equal(result.clientHints.warmupNavigation.memoryHeaders[name], null, `${scenario.name}: ${name} before the Accept-CH response`);
      for (const kind of ['optedInNavigation', 'optedInSubresource']) {
        assert.equal(result.clientHints[kind].memoryHeaders[name], String(expected.deviceMemory), `${scenario.name}: ${kind} ${name}`);
      }
    }
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = error.stack ?? String(error);
    result.browserStderr = stderr;
    throw error;
  } finally {
    if (connection) {
      try { await connection.send('Browser.close'); } catch {}
      connection.close();
    }
    await terminate(browser);
    await rm(userDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'chromium-hardware-verification-'));
const report = {
  observedAt: new Date().toISOString(),
  binary,
  mode: stockOnly ? 'stock-only' : 'stock-and-profile',
  environment: {
    display: process.env.PROBE_DISPLAY ? 'external X11 desktop' : 'Xvfb 1920x1080x24 / X11',
    platform: os.platform(), arch: os.arch(),
    logicalCpuCount: os.cpus().length,
    availableParallelism: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
  },
  scenarios: [],
  status: 'running',
};
let xvfb;
try {
  let display = process.env.PROBE_DISPLAY;
  if (!display) {
    xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    const displayReady = Promise.race([
      once(xvfb.stdio[3], 'data').then(([data]) => `:${data.toString().trim()}`),
      once(xvfb, 'error').then(([error]) => { throw error; }),
    ]);
    display = await bounded(displayReady, 10000, 'Xvfb startup');
  }
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const { port } = server.address();
  const origins = { main: `http://127.0.0.1:${port}`, cross: `http://127.0.0.2:${port}` };
  report.origins = origins;
  const scenarios = [{ name: 'stock', profile: null }];
  if (!stockOnly) {
    scenarios.push(
      { name: 'defaults', profile: {}, expected: { hardwareConcurrency: 8, deviceMemory: 8, cpuPerformance: 3 } },
      { name: 'configured', profile: { hardwareConcurrency: 4, deviceMemory: 16, cpuPerformance: 2 }, expected: { hardwareConcurrency: 4, deviceMemory: 16, cpuPerformance: 2 } },
    );
  }
  for (const scenario of scenarios) await runScenario(scenario, display, temporary, origins, report);
  const stockHeapLimit = report.scenarios[0].snapshots.page.performanceMemory.jsHeapSizeLimit;
  for (const scenario of report.scenarios.slice(1)) {
    assert.equal(scenario.snapshots.page.performanceMemory.jsHeapSizeLimit, stockHeapLimit,
      `${scenario.name}: desktop memory profile must preserve the upstream heap ceiling`);
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await terminate(xvfb);
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    status: report.status,
    scenarios: report.scenarios.map(scenario => ({
      name: scenario.name,
      status: scenario.status,
      version: scenario.version?.product,
      expected: scenario.expected,
      heapSizeLimit: scenario.snapshots?.page.performanceMemory?.jsHeapSizeLimit,
    })),
    ...(report.error ? { error: report.error } : {}),
  }, null, 2));
}
