import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const usage = 'Usage: node scripts/verify-desktop.mjs /path/to/chrome [output.json]';
if (process.argv.includes('--help')) {
  console.log(usage);
  process.exit(0);
}
if (!process.argv[2]) throw new Error(usage);
const binary = process.argv[2];
const output = process.argv[3] ?? path.resolve('evidence/desktop-verification.json');
const extraArgs = JSON.parse(process.env.PROBE_BROWSER_ARGS ?? '[]');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
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

class PipeCDP {
  #writer;
  #sequence = 0;
  #pending = new Map();
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor(reader, writer) {
    this.#writer = writer;
    reader.on('data', chunk => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      let zeroIdx;
      while ((zeroIdx = this.#buffer.indexOf(0)) !== -1) {
        const raw = this.#buffer.subarray(0, zeroIdx).toString('utf8');
        this.#buffer = this.#buffer.subarray(zeroIdx + 1);
        if (!raw) continue;
        const msg = JSON.parse(raw);
        if (msg.id) {
          const tx = this.#pending.get(msg.id);
          if (tx) {
            this.#pending.delete(msg.id);
            clearTimeout(tx.timer);
            if (msg.error) tx.reject(new Error(JSON.stringify(msg.error)));
            else tx.resolve(msg.result);
          }
        }
      }
    });
    const onClose = () => {
      this.#closed = true;
      for (const tx of this.#pending.values()) {
        clearTimeout(tx.timer);
        tx.reject(new Error('Pipe CDP closed'));
      }
      this.#pending.clear();
    };
    reader.on('close', onClose);
    reader.on('error', onClose);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      if (this.#closed) return reject(new Error(`Pipe closed: ${method}`));
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30000);
      this.#pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      this.#writer.write(Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0])]));
    });
  }

  close() {
    this.#closed = true;
    for (const tx of this.#pending.values()) {
      clearTimeout(tx.timer);
      tx.reject(new Error('closed'));
    }
    this.#pending.clear();
    try { this.#writer.end(); } catch {}
  }
}

class SocketCDP {
  #socket;
  #sequence = 0;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      const tx = this.#pending.get(msg.id);
      if (!tx) return;
      this.#pending.delete(msg.id);
      clearTimeout(tx.timer);
      if (msg.error) tx.reject(new Error(JSON.stringify(msg.error)));
      else tx.resolve(msg.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await bounded(once(socket, 'open'), 10000, 'WebSocket CDP');
    return new SocketCDP(socket);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    for (const tx of this.#pending.values()) {
      clearTimeout(tx.timer);
      tx.reject(new Error('closed'));
    }
    this.#pending.clear();
    try { this.#socket.close(); } catch {}
  }
}

function firstSnapshot() {
  const memory = globalThis.performance.memory;
  let webgl = null;
  try {
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(16, 16);
    const gl2 = canvas.getContext('webgl2');
    const caveat = typeof document !== 'undefined'
      ? !!document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true })
      : !!new OffscreenCanvas(16, 16).getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (gl2) {
      const dbg = gl2.getExtension('WEBGL_debug_renderer_info');
      const shd = gl2.getExtension('WEBGL_debug_shaders');
      const vs = gl2.createShader(gl2.VERTEX_SHADER);
      gl2.shaderSource(vs, '#version 300 es\nin vec4 a;void main(){gl_Position=a;}');
      gl2.compileShader(vs);
      const translated = shd ? shd.getTranslatedShaderSource(vs) : '';
      gl2.deleteShader(vs);
      const rb = gl2.createRenderbuffer();
      gl2.bindRenderbuffer(gl2.RENDERBUFFER, rb);
      const maxSamples = gl2.getParameter(gl2.MAX_SAMPLES);
      gl2.renderbufferStorageMultisample(gl2.RENDERBUFFER, maxSamples, gl2.RGBA8, 32, 32);
      const msaaError = gl2.getError();
      gl2.deleteRenderbuffer(rb);
      const lowInt = gl2.getShaderPrecisionFormat(gl2.FRAGMENT_SHADER, gl2.LOW_INT);
      webgl = {
        supported: true,
        caveatSucceeded: caveat,
        unmaskedVendor: dbg ? gl2.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        aliasedLineWidthRange: Array.from(gl2.getParameter(gl2.ALIASED_LINE_WIDTH_RANGE)),
        aliasedPointSizeRange: Array.from(gl2.getParameter(gl2.ALIASED_POINT_SIZE_RANGE)),
        maxTextureSize: gl2.getParameter(gl2.MAX_TEXTURE_SIZE),
        max3dTextureSize: gl2.getParameter(gl2.MAX_3D_TEXTURE_SIZE),
        maxVaryingVectors: gl2.getParameter(gl2.MAX_VARYING_VECTORS),
        maxElementsIndices: gl2.getParameter(gl2.MAX_ELEMENTS_INDICES),
        maxElementsVertices: gl2.getParameter(gl2.MAX_ELEMENTS_VERTICES),
        minProgramTexelOffset: gl2.getParameter(gl2.MIN_PROGRAM_TEXEL_OFFSET),
        maxProgramTexelOffset: gl2.getParameter(gl2.MAX_PROGRAM_TEXEL_OFFSET),
        maxSamples,
        msaaError,
        maxTextureLodBias: gl2.getParameter(gl2.MAX_TEXTURE_LOD_BIAS),
        uniformBufferOffsetAlignment: gl2.getParameter(gl2.UNIFORM_BUFFER_OFFSET_ALIGNMENT),
        lowIntPrecision: [lowInt.rangeMin, lowInt.rangeMax, lowInt.precision],
        translatedPrefix: translated.slice(0, 40),
      };
    } else {
      webgl = { supported: false, caveatSucceeded: caveat };
    }
  } catch (e) {
    webgl = { supported: false, error: String(e) };
  }
  return {
    webdriver: navigator.webdriver,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    cpuPerformance: navigator.cpuPerformance ?? null,
    cpuPerformanceExposed: 'cpuPerformance' in navigator,
    secureContext: isSecureContext,
    performanceMemory: memory ? { jsHeapSizeLimit: memory.jsHeapSizeLimit } : null,
    webgl,
  };
}

async function collectAll() {
  const { run, crossOrigin } = window.__cfg;
  const q = `run=${encodeURIComponent(run)}`;
  const frameSnap = (origin, kind) => new Promise((resolve, reject) => {
    const f = document.createElement('iframe');
    f.src = `${origin}/frame?${q}&kind=${kind}`;
    const onMsg = ev => {
      if (ev.source !== f.contentWindow || ev.data?.run !== run || ev.data?.kind !== kind) return;
      window.removeEventListener('message', onMsg);
      resolve(ev.data.first);
    };
    window.addEventListener('message', onMsg);
    f.onerror = () => reject(new Error(`${kind} frame error`));
    document.body.appendChild(f);
  });
  const dedicatedSnap = async () => {
    const w = new Worker(`/dedicated.js?${q}`);
    try {
      return await new Promise((res, rej) => { w.onmessage = e => res(e.data); w.onerror = rej; });
    } finally {
      w.terminate();
    }
  };
  const sharedSnap = async () => {
    const w = new SharedWorker(`/shared.js?${q}`, `sw-${run}`);
    try {
      return await new Promise((res, rej) => { w.port.onmessage = e => res(e.data); w.onerror = rej; w.port.start(); });
    } finally {
      w.port.close();
    }
  };
  const serviceSnap = async () => {
    const reg = await navigator.serviceWorker.register(`/service.js?${q}`);
    const ready = await navigator.serviceWorker.ready;
    const ch = new MessageChannel();
    try {
      const p = new Promise(res => { ch.port1.onmessage = e => res(e.data); });
      (reg.active ?? ready.active).postMessage('snap', [ch.port2]);
      return await p;
    } finally {
      ch.port1.close();
      ch.port2.close();
      await reg.unregister();
    }
  };
  const [sameOriginFrame, crossOriginFrame, dedicated, sharedWorker, serviceWorker] = await Promise.all([
    frameSnap(location.origin, 'same-origin'),
    frameSnap(crossOrigin, 'cross-origin'),
    dedicatedSnap(),
    sharedSnap(),
    serviceSnap(),
  ]);
  const video = document.createElement('video');
  const audio = document.createElement('audio');
  const devices = (await navigator.mediaDevices.enumerateDevices()).map(d => d.kind);
  const ac = new AudioContext();
  const audioInfo = { sampleRate: ac.sampleRate, maxChannels: ac.destination.maxChannelCount };
  await ac.close();
  return {
    page: window.__first,
    sameOriginFrame,
    crossOriginFrame,
    dedicatedWorker: dedicated.first,
    nestedWorker: dedicated.nested,
    sharedWorker,
    serviceWorker,
    desktop: {
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
      },
      window: {
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        chromeHeight: outerHeight - innerHeight,
      },
      codecs: {
        h264: video.canPlayType('video/mp4; codecs="avc1.42E01E"'),
        aac: audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
      },
      devices,
      audioInfo,
      voicesCount: speechSynthesis.getVoices().length,
      bodyFont: getComputedStyle(document.body).fontFamily,
      desktopFontsAvailable: {
        ubuntu: document.fonts.check('16px "Ubuntu"'),
        notoSans: document.fonts.check('16px "Noto Sans"'),
        notoCjk: document.fonts.check('16px "Noto Sans CJK SC"'),
        dejavuMono: document.fonts.check('16px "DejaVu Sans Mono"'),
      },
      intlTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lastModified: document.lastModified,
    },
  };
}

const requests = [];
const snapCode = `const first = (${firstSnapshot.toString()})();\n`;
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const run = url.searchParams.get('run');
  requests.push({
    run,
    host: req.headers.host,
    pathname: url.pathname,
    deviceMemory: req.headers['device-memory'] ?? null,
    secChDeviceMemory: req.headers['sec-ch-device-memory'] ?? null,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Last-Modified', 'Thu, 01 Jan 2026 12:00:00 GMT');
  if (url.pathname === '/warmup' || url.pathname === '/observed') {
    res.setHeader('Accept-CH', 'Device-Memory, Sec-CH-Device-Memory');
  }
  if (url.pathname === '/sub.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    return;
  }
  if (url.pathname.endsWith('.js')) {
    res.setHeader('Content-Type', 'text/javascript');
    if (url.pathname === '/nested.js') return res.end(snapCode + 'postMessage(first);');
    if (url.pathname === '/dedicated.js') {
      return res.end(snapCode + `const w = new Worker('/nested.js?run=${encodeURIComponent(run)}');w.onmessage=e=>{postMessage({first,nested:e.data});w.terminate();};`);
    }
    if (url.pathname === '/shared.js') return res.end(snapCode + 'self.onconnect=e=>e.ports[0].postMessage(first);');
    if (url.pathname === '/service.js') {
      return res.end(snapCode + 'self.addEventListener("install",e=>e.waitUntil(self.skipWaiting()));self.addEventListener("activate",e=>e.waitUntil(clients.claim()));self.addEventListener("message",e=>e.ports[0].postMessage(first));');
    }
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/frame') {
    return res.end(`<!doctype html><script>${snapCode}parent.postMessage({run:${JSON.stringify(run)},kind:${JSON.stringify(url.searchParams.get('kind'))},first},'*');</script>`);
  }
  const crossOrigin = `http://127.0.0.2:${server.address().port}`;
  res.end(`<!doctype html><script>${snapCode}window.__first=first;window.__cfg=${JSON.stringify({ run, crossOrigin })};window.__collectAll=(${collectAll.toString()});</script><body><button id="hit" style="position:fixed;left:120px;top:130px;width:80px;height:50px">Hit</button>${url.pathname === '/observed' ? `<img src="/sub.svg?run=${encodeURIComponent(run)}">` : ''}</body>`);
});

async function reservePort() {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}

async function evalValue(cdp, sessionId, expression, awaitPromise = false) {
  const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result.value;
}

async function navigateAndWait(cdp, sessionId, url) {
  await cdp.send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 150; i++) {
    try {
      const ok = await evalValue(cdp, sessionId, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && !!window.__first`);
      if (ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`Navigation did not complete: ${url}`);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'chr-desktop-verify-'));
const report = { observedAt: new Date().toISOString(), binary, scenarios: [], status: 'running' };

try {
  const display = process.env.PROBE_DISPLAY;
  if (!display) throw new Error('Run verify-desktop.mjs inside the desktop container (PROBE_DISPLAY required)');

  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const mainOrigin = `http://127.0.0.1:${server.address().port}`;

  const scenarios = [
    {
      name: 'stock-port',
      transport: 'port',
      profile: null,
      extraCli: ['--ignore-gpu-blocklist'],
    },
    {
      name: 'desktop-defaults-pipe',
      transport: 'pipe',
      profile: {},
      extraCli: [],
      expected: {
        hardwareConcurrency: 8,
        deviceMemory: 8,
        cpuPerformance: 3,
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)',
      },
    },
    {
      name: 'configured-4gb-port',
      transport: 'port',
      profile: {
        hardwareConcurrency: 4,
        deviceMemory: 4,
        cpuPerformance: 2,
        webglVendor: 'Google Inc. (AMD)',
        webglRenderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir, ACO), OpenGL 4.6)',
      },
      extraCli: [],
      expected: {
        hardwareConcurrency: 4,
        deviceMemory: 4,
        cpuPerformance: 2,
        webglVendor: 'Google Inc. (AMD)',
        webglRenderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir, ACO), OpenGL 4.6)',
      },
    },
  ];

  for (const scenario of scenarios) {
    const run = `${scenario.name}-${randomUUID()}`;
    const userDir = await mkdtemp(path.join(temporary, `${scenario.name}-`));
    const env = { ...process.env, DISPLAY: display };
    delete env.INVISIBLE_CHROMIUM_PROFILE;
    if (scenario.profile !== null) env.INVISIBLE_CHROMIUM_PROFILE = JSON.stringify(scenario.profile);

    const port = scenario.transport === 'port' ? await reservePort() : null;
    const args = [
      `--user-data-dir=${userDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      scenario.transport === 'pipe' ? '--remote-debugging-pipe' : `--remote-debugging-port=${port}`,
      '--site-per-process',
      '--window-size=1280,800',
      '--ozone-platform=x11',
      '--use-gl=angle',
      '--use-angle=gl',
      ...(process.env.PROBE_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      ...scenario.extraCli,
      ...extraArgs,
      'about:blank',
    ];

    let browser, cdp, stderr = '';
    const entry = { name: scenario.name, transport: scenario.transport, profile: scenario.profile, status: 'running' };
    report.scenarios.push(entry);

    try {
      const stdio = scenario.transport === 'pipe'
        ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
        : ['ignore', 'ignore', 'pipe'];
      browser = spawn(binary, args, { env, stdio });
      browser.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-16000); });

      if (scenario.transport === 'pipe') {
        cdp = new PipeCDP(browser.stdio[4], browser.stdio[3]);
      } else {
        let wsUrl;
        for (let i = 0; i < 120; i++) {
          if (browser.exitCode !== null) throw new Error(`Exited early: ${stderr}`);
          try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
            if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
          } catch {}
          await delay(100);
        }
        if (!wsUrl) throw new Error(`Port CDP not ready: ${stderr}`);
        cdp = await SocketCDP.connect(wsUrl);
      }

      entry.version = await cdp.send('Browser.getVersion');
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Target.activateTarget', { targetId });

      await navigateAndWait(cdp, sessionId, `${mainOrigin}/warmup?run=${encodeURIComponent(run)}`);
      await navigateAndWait(cdp, sessionId, `${mainOrigin}/observed?run=${encodeURIComponent(run)}`);
      const collected = await evalValue(cdp, sessionId, 'window.__collectAll()', true);
      entry.collected = collected;

      // Common desktop assertions
      assert.equal(collected.desktop.screen.width, 1920);
      assert.equal(collected.desktop.screen.height, 1080);
      assert.ok(collected.desktop.screen.availHeight < 1080, 'Desktop panel workarea margin must make availHeight < height');
      assert.equal(collected.desktop.codecs.h264, 'probably', 'H.264 codec must be supported');
      assert.equal(collected.desktop.codecs.aac, 'probably', 'AAC codec must be supported');
      assert.ok(collected.desktop.devices.includes('audioinput'), 'Virtual microphone must be present');
      assert.ok(collected.desktop.devices.includes('audiooutput'), 'Audio output sink must be present');
      assert.equal(collected.desktop.audioInfo.sampleRate, 48000);
      assert.equal(collected.desktop.voicesCount, 0, 'speech-dispatcher must not leak espeak voices');
      assert.equal(collected.desktop.desktopFontsAvailable.ubuntu, true, 'Ubuntu desktop font must be installed');
      assert.equal(collected.desktop.desktopFontsAvailable.notoSans, true, 'Noto Sans font must be installed');
      assert.equal(collected.desktop.desktopFontsAvailable.notoCjk, true, 'Noto Sans CJK SC font must be installed');
      assert.equal(collected.desktop.desktopFontsAvailable.dejavuMono, true, 'DejaVu Sans Mono font must be installed');

      if (scenario.expected) {
        assert.ok(collected.desktop.window.chromeHeight < 105, `Warning infobar detected: chromeHeight=${collected.desktop.window.chromeHeight}`);
        for (const [ctxName, snap] of Object.entries(collected)) {
          if (ctxName === 'desktop') continue;
          const isWorker = ctxName.endsWith('Worker');
          assert.equal(snap.webdriver, isWorker ? undefined : false, `${scenario.name}/${ctxName}: webdriver exposure`);
          assert.equal(snap.hardwareConcurrency, scenario.expected.hardwareConcurrency, `${scenario.name}/${ctxName}: hardwareConcurrency`);
          assert.equal(snap.deviceMemory, scenario.expected.deviceMemory, `${scenario.name}/${ctxName}: deviceMemory`);
          assert.equal(snap.cpuPerformanceExposed, !isWorker, `${scenario.name}/${ctxName}: cpuPerformance exposure`);
          if (!isWorker) {
            assert.equal(snap.cpuPerformance, scenario.expected.cpuPerformance, `${scenario.name}/${ctxName}: cpuPerformance`);
          }
          if (snap.webgl && ctxName !== 'sharedWorker' && ctxName !== 'serviceWorker') {
            assert.equal(snap.webgl.supported, true, `${scenario.name}/${ctxName}: WebGL2 must work without --ignore-gpu-blocklist`);
            assert.equal(snap.webgl.caveatSucceeded, true, `${scenario.name}/${ctxName}: failIfMajorPerformanceCaveat must succeed`);
            assert.equal(snap.webgl.unmaskedVendor, scenario.expected.webglVendor, `${scenario.name}/${ctxName}: unmaskedVendor`);
            assert.equal(snap.webgl.unmaskedRenderer, scenario.expected.webglRenderer, `${scenario.name}/${ctxName}: unmaskedRenderer`);
            assert.deepEqual(snap.webgl.aliasedLineWidthRange, [1, 7.375]);
            assert.deepEqual(snap.webgl.aliasedPointSizeRange, [1, 255]);
            assert.equal(snap.webgl.maxElementsIndices, 1048576);
            assert.equal(snap.webgl.maxElementsVertices, 1048576);
            assert.equal(snap.webgl.minProgramTexelOffset, -8);
            assert.equal(snap.webgl.maxProgramTexelOffset, 7);
            assert.equal(snap.webgl.maxSamples, 8);
            assert.equal(snap.webgl.msaaError, 0, '8x MSAA renderbufferStorageMultisample must not produce GL error');
            assert.equal(snap.webgl.maxTextureLodBias, 15);
            assert.ok(snap.webgl.uniformBufferOffsetAlignment >= 64);
            assert.deepEqual(snap.webgl.lowIntPrecision, [31, 30, 0]);
            assert.ok(snap.webgl.translatedPrefix.startsWith('#version 450'));
          }
        }

        // Verify Client Hints
        const obsNav = requests.find(r => r.run === run && r.pathname === '/observed');
        const obsSub = requests.find(r => r.run === run && r.pathname === '/sub.svg');
        assert.equal(obsNav?.deviceMemory, String(scenario.expected.deviceMemory));
        assert.equal(obsNav?.secChDeviceMemory, String(scenario.expected.deviceMemory));
        assert.equal(obsSub?.deviceMemory, String(scenario.expected.deviceMemory));
        assert.equal(obsSub?.secChDeviceMemory, String(scenario.expected.deviceMemory));

        // Verify V8 Runtime.enable getter/Proxy stealth
        await cdp.send('Runtime.enable', {}, sessionId);
        const getterProbe = await evalValue(cdp, sessionId, `(() => {
          let hits = 0;
          const ownErr = new Error('a');
          Object.defineProperty(ownErr, 'stack', { get() { hits++; return 'own'; } });
          console.debug(ownErr);
          console.log(ownErr);

          class ProtoErr extends Error {
            get stack() { hits++; return 'proto'; }
          }
          console.debug(new ProtoErr());

          const proxyObj = new Proxy({ a: 1 }, {
            get(t, k) { hits++; return t[k]; },
            ownKeys(t) { hits++; return Reflect.ownKeys(t); }
          });
          console.table(proxyObj);
          console.dir(proxyObj);

          const div = document.createElement('div');
          Object.defineProperty(div, 'id', { get() { hits++; return 'x'; } });
          console.log(div);
          return hits;
        })()`);
        entry.runtimeEnableGetterHits = getterProbe;
        assert.equal(getterProbe, 0, `Runtime.enable must not trigger user JS getters/Proxies on console calls (got ${getterProbe})`);

        // Verify CDP Input.dispatchMouseEvent pressure, movementX/Y, pointerId, screenX/Y
        await evalValue(cdp, sessionId, `(() => {
          window.__events = [];
          const btn = document.getElementById('hit');
          for (const type of ['pointermove', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            btn.addEventListener(type, ev => {
              window.__events.push({
                type: ev.type,
                isTrusted: ev.isTrusted,
                pointerId: ev.pointerId ?? null,
                pointerType: ev.pointerType ?? null,
                pressure: ev.pressure ?? null,
                buttons: ev.buttons,
                movementX: ev.movementX,
                movementY: ev.movementY,
                clientX: ev.clientX,
                clientY: ev.clientY,
                screenX: ev.screenX,
                screenY: ev.screenY,
              });
            });
          }
        })()`);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 135, y: 145 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 155, y: 160 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 155, y: 160, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 155, y: 160, button: 'left', buttons: 0, clickCount: 1 }, sessionId);

        const inputEvents = await evalValue(cdp, sessionId, 'window.__events');
        entry.inputEvents = inputEvents;
        const pMoves = inputEvents.filter(e => e.type === 'pointermove');
        const pDown = inputEvents.find(e => e.type === 'pointerdown');
        const pUp = inputEvents.find(e => e.type === 'pointerup');
        const click = inputEvents.find(e => e.type === 'click');
        assert.ok(pMoves.length >= 2 && pDown && pUp && click, 'Expected complete pointer/mouse/click sequence');
        assert.ok(inputEvents.every(e => e.isTrusted === true), 'All dispatched events must be trusted');
        assert.equal(pDown.pointerId, 1);
        assert.equal(pDown.pointerType, 'mouse');
        assert.equal(pDown.pressure, 0.5, 'Active mouse button pressure must be 0.5 per PointerEvents spec');
        assert.equal(pUp.pressure, 0, 'Released mouse button pressure must be 0');
        assert.equal(pMoves[1].movementX, 20);
        assert.equal(pMoves[1].movementY, 15);
        assert.ok(pDown.screenY > pDown.clientY, 'screenY must reflect window chrome offset');
      }

      entry.status = 'passed';
    } catch (err) {
      entry.status = 'failed';
      entry.error = err.stack ?? String(err);
      entry.stderr = stderr;
      throw err;
    } finally {
      if (cdp) cdp.close();
      await terminate(browser);
      await rm(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  // Verify 4 GiB V8 heap limit is smaller than 8 GiB / 32 GiB ceiling
  const heap8 = report.scenarios[1].collected.page.performanceMemory.jsHeapSizeLimit;
  const heap4 = report.scenarios[2].collected.page.performanceMemory.jsHeapSizeLimit;
  assert.ok(heap4 < heap8, `4 GiB profile heap limit (${heap4}) must be smaller than 8 GiB heap limit (${heap8})`);

  report.status = 'passed';
} catch (err) {
  report.status = 'failed';
  report.error = err.stack ?? String(err);
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(r => server.close(r));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({
    output,
    status: report.status,
    scenarios: report.scenarios.map(s => ({
      name: s.name,
      transport: s.transport,
      status: s.status,
      version: s.version?.product,
      heapLimit: s.collected?.page?.performanceMemory?.jsHeapSizeLimit,
      getterHits: s.runtimeEnableGetterHits ?? null,
    })),
    ...(report.error ? { error: report.error } : {}),
  }, null, 2));
}
