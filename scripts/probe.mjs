import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (!process.argv[2]) throw new Error('Usage: node scripts/probe.mjs /path/to/chrome [output.json]');
const binary = process.argv[2];
const output = process.argv[3] ?? path.resolve('evidence/stock-observation.json');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'chromium-hardware-probe-'));
const workerCode = `const values = () => ({hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory,cpuPerformance:navigator.cpuPerformance,userAgent:navigator.userAgent});`;
const server = createServer((req, res) => {
  if (req.url === '/sw.js') {
    res.setHeader('content-type', 'text/javascript');
    res.end(workerCode + `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('message',e=>e.ports[0].postMessage(values()));`);
  } else {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><title>Local hardware API observation</title>');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}/`;
let xvfb, browser, socket;
const pending = new Map();
let sequence = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
}
function send(method, params = {}, sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
try {
  xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const displayResult = await Promise.race([once(xvfb.stdio[3], 'data'), delay(10000).then(() => { throw new Error('Xvfb startup timeout'); })]);
  const display = displayResult[0].toString().trim();
  const args = [`--user-data-dir=${temporary}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--window-size=1280,800', '--ozone-platform=x11', ...(process.env.PROBE_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), 'about:blank'];
  let browserStderr = '';
  browser = spawn(binary, args, { env: { ...process.env, DISPLAY: `:${display}` }, stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', data => { browserStderr += data.toString(); });
  let endpoint;
  for (let n = 0; n < 100; ++n) {
    if (browser.exitCode !== null || browser.signalCode !== null) throw new Error(`browser exited ${browser.exitCode ?? browser.signalCode}: ${browserStderr}`);
    try { endpoint = (await readFile(path.join(temporary, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; } catch {}
    await delay(100);
  }
  if (!endpoint) throw new Error('browser endpoint not ready');
  socket = new WebSocket(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const transaction = pending.get(message.id);
    if (!transaction) return;
    pending.delete(message.id); clearTimeout(transaction.timer);
    message.error ? transaction.reject(new Error(JSON.stringify(message.error))) : transaction.resolve(message.result);
  });
  const version = await send('Browser.getVersion');
  const { targetId } = await send('Target.createTarget', { url: origin });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (let n = 0; n < 50; ++n) {
    const ready = await send('Runtime.evaluate', { expression: `location.href === ${JSON.stringify(origin)} && document.readyState === 'complete'`, returnByValue: true }, sessionId);
    if (ready.result.value) break;
    await delay(50);
  }
  const expression = `(${async function observe() {
    const attempt = async fn => { try { return await fn(); } catch (e) { return { error: e.name + ': ' + e.message }; } };
    const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k] ?? null]));
    const out = { secureContext: isSecureContext, crossOriginIsolated, navigator: pick(navigator, ['hardwareConcurrency','deviceMemory','cpuPerformance','maxTouchPoints','platform','userAgent','language','languages','pdfViewerEnabled']) };
    out.window = pick(window, ['innerWidth','innerHeight','outerWidth','outerHeight','screenX','screenY','devicePixelRatio']);
    out.screen = { ...pick(screen, ['width','height','availWidth','availHeight','availLeft','availTop','colorDepth','pixelDepth','isExtended']), orientation: pick(screen.orientation, ['type','angle']) };
    out.css = Object.fromEntries(['pointer:fine','pointer:coarse','any-pointer:fine','hover:hover','any-hover:hover','color-gamut:srgb','color-gamut:p3','color-gamut:rec2020','dynamic-range:high','video-dynamic-range:high','update:fast','prefers-color-scheme:dark','prefers-reduced-motion:reduce','forced-colors:active','inverted-colors:inverted'].map(q => [q, matchMedia('(' + q + ')').matches]));
    out.connection = pick(navigator.connection, ['type','effectiveType','downlink','downlinkMax','rtt','saveData']);
    out.performanceMemory = pick(performance.memory, ['jsHeapSizeLimit','totalJSHeapSize','usedJSHeapSize']);
    out.storage = await attempt(() => navigator.storage.estimate());
    out.battery = await attempt(async () => pick(await navigator.getBattery(), ['charging','chargingTime','dischargingTime','level']));
    out.uaData = await attempt(() => navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','wow64']));
    out.permissions = {};
    for (const name of ['window-management','local-fonts','camera','microphone','geolocation','accelerometer','gyroscope','magnetometer','idle-detection']) out.permissions[name] = await attempt(async () => (await navigator.permissions.query({name})).state);
    out.exposure = Object.fromEntries(['gpu','usb','hid','serial','bluetooth','getGamepads'].map(k => [k, typeof navigator[k]]));
    out.exposure.getScreenDetails = typeof getScreenDetails;
    out.exposure.queryLocalFonts = typeof queryLocalFonts;
    out.exposure.PressureObserver = typeof PressureObserver;
    out.exposure.measureUserAgentSpecificMemory = typeof performance.measureUserAgentSpecificMemory;
    out.mediaDevices = await attempt(async () => (await navigator.mediaDevices.enumerateDevices()).map(d => ({kind:d.kind,hasLabel:!!d.label,hasDeviceId:!!d.deviceId,hasGroupId:!!d.groupId})));
    out.webgl = {};
    for (const name of ['webgl','webgl2']) out.webgl[name] = await attempt(() => {
      const gl = document.createElement('canvas').getContext(name);
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { vendor:gl.getParameter(gl.VENDOR), renderer:gl.getParameter(gl.RENDERER), version:gl.getParameter(gl.VERSION), unmaskedVendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null, unmaskedRenderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null, maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE), maxRenderbufferSize:gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), extensions:gl.getSupportedExtensions() };
    });
    out.webgpu = await attempt(async () => { const a=await navigator.gpu?.requestAdapter(); return a ? {info:pick(a.info,['vendor','architecture','device','description','subgroupMinSize','subgroupMaxSize','isFallbackAdapter']),features:[...a.features]} : null; });
    out.audio = await attempt(async () => { const a=new AudioContext(); const v={...pick(a,['sampleRate','baseLatency','outputLatency','state']), maxChannelCount:a.destination.maxChannelCount};await a.close();return v; });
    out.raf = await attempt(async () => { const stamps=[];await new Promise(resolve=>{const tick=t=>{stamps.push(t);stamps.length<31?requestAnimationFrame(tick):resolve();};requestAnimationFrame(tick);});const gaps=stamps.slice(1).map((t,i)=>t-stamps[i]).sort((a,b)=>a-b);return {samples:gaps.length,min:gaps[0],median:gaps[Math.floor(gaps.length/2)],max:gaps.at(-1)}; });
    out.worker = await attempt(async () => { const code='postMessage({hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory,cpuPerformance:navigator.cpuPerformance,userAgent:navigator.userAgent})';const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));const w=new Worker(url);try{return await new Promise((resolve,reject)=>{w.onmessage=e=>resolve(e.data);w.onerror=reject;});}finally{w.terminate();URL.revokeObjectURL(url);} });
    out.serviceWorker = await attempt(async () => { const registration=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;const channel=new MessageChannel();try{const response=new Promise(resolve=>channel.port1.onmessage=e=>resolve(e.data));registration.active.postMessage({},[channel.port2]);return await response;}finally{channel.port1.close();await registration.unregister();} });
    return out;
  }.toString()})()`;
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  const report = { observedAt:new Date().toISOString(), binary, version, sourceResearchVersion:'156.0.8078.73', observationVersion:version.product.split('/')[1], environment:{display:'Xvfb 1920x1080x24 / X11', platform:os.platform(), arch:os.arch(), logicalCpuCount:os.cpus().length, availableParallelism:os.availableParallelism(), totalMemoryBytes:os.totalmem()}, launchArgs:args.map(a=>a.startsWith('--user-data-dir=')?'--user-data-dir=<temporary>':a), values:result.result.value };
  await mkdir(path.dirname(output), { recursive:true });
  await writeFile(output, JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,version,navigator:report.values.navigator,worker:report.values.worker,serviceWorker:report.values.serviceWorker,screen:report.values.screen,window:report.values.window},null,2));
} finally {
  for (const transaction of pending.values()) { clearTimeout(transaction.timer);transaction.reject(new Error('probe closed')); }
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  await terminate(browser);
  await terminate(xvfb);
  server.closeAllConnections();server.close();
  await rm(temporary, { recursive:true,force:true });
}
