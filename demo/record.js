// 录屏：一次连续操作，按旁白时长排期。用法 node _rec2.js
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '_rec');
const FRAMES = path.join(OUT, 'frames');
const URL = 'http://127.0.0.1:8770/';

const DUR = JSON.parse(fs.readFileSync(path.join(__dirname, 'vo', 'durs.json'), 'utf8'));
const TAIL = 300;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let ws, msgId = 0;
const pending = new Map();
let frames = [], t0 = 0, marks = {}, clicks = [];
let recvBytes = 0;
let lastKeep = 0, dropped = 0;
const MIN_GAP = 42; // 最多约 24 fps，够用且不至于压死事件循环

function log(s) { fs.appendFileSync(path.join(__dirname, '_rec.log'), s + "\n"); console.error(s); }

function send(method, params) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error('timeout ' + method));
    }, 20000);
    pending.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
}

async function cursor(x, y) {
  await evaluate(`window.__cursor && window.__cursor(${Math.round(x)},${Math.round(y)})`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), buttons: 0 });
}

async function mouse(type, x, y, button) {
  await send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y),
    button: button || 'left', buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0
  });
}

async function glide(x, y, ms) {
  const steps = Math.max(4, Math.round(ms / 45));
  const from = await evaluate('(window.__cx===undefined?null:[window.__cx,window.__cy])');
  const sx = from ? from[0] : x, sy = from ? from[1] : y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await cursor(sx + (x - sx) * e, sy + (y - sy) * e);
    await evaluate(`window.__cx=${sx + (x - sx) * e};window.__cy=${sy + (y - sy) * e}`);
    await sleep(ms / steps);
  }
}

async function rect(sel) {
  const v = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height];})()`);
  if (!v) throw new Error('no element ' + sel);
  return { x: v[0], y: v[1], w: v[2], h: v[3] };
}

async function clickSel(sel, ms) {
  const r = await rect(sel);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  await glide(cx, cy, ms || 320);
  await evaluate(`window.__ripple && window.__ripple(${Math.round(cx)},${Math.round(cy)})`);
  await mouse('mousePressed', cx, cy);
  await sleep(55);
  await mouse('mouseReleased', cx, cy);
  clicks.push(Date.now());
  await sleep(120);
}

async function clickText(sel, text, ms) {
  const box = await evaluate(`(()=>{const ns=[...document.querySelectorAll(${JSON.stringify(sel)})];
    const e=ns.find(n=>n.textContent.trim().indexOf(${JSON.stringify(text)})>=0);
    if(!e)return null; const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height];})()`);
  if (!box) throw new Error('no text ' + text);
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  await glide(cx, cy, ms || 320);
  await evaluate(`window.__ripple && window.__ripple(${Math.round(cx)},${Math.round(cy)})`);
  await mouse('mousePressed', cx, cy);
  await sleep(55);
  await mouse('mouseReleased', cx, cy);
  clicks.push(Date.now());
  await sleep(150);
}

// 真的按住滑条拖，不是设值
async function dragSlider(id, toFrac, ms) {
  const sel = `[data-param="${id}"]`;
  const r = await rect(sel);
  const info = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
    return [Number(e.value), Number(e.min), Number(e.max)];})()`);
  const [v, mn, mx] = info;
  const thumb = r.x + 7 + (v - mn) / (mx - mn) * (r.w - 14);
  const cy = r.y + r.h / 2;
  await glide(thumb, cy, 320);
  await mouse('mousePressed', thumb, cy);
  const tx = r.x + 7 + toFrac * (r.w - 14);
  const steps = Math.max(8, Math.round(ms / 40));
  for (let i = 1; i <= steps; i++) {
    const x = thumb + (tx - thumb) * (i / steps);
    await mouse('mouseMoved', x, cy);
    await evaluate(`window.__cx=${x};window.__cy=${cy}`);
    await sleep(ms / steps);
  }
  await mouse('mouseReleased', tx, cy);
  await sleep(120);
}

async function typeText(text, per) {
  for (const ch of text) {
    await send('Input.insertText', { text: ch });
    await sleep(per);
  }
}

async function scrollBy(sel, dy, ms) {
  const r = await rect(sel);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  await glide(cx, cy, 260);
  const steps = Math.max(6, Math.round(ms / 60));
  for (let i = 0; i < steps; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(cx), y: Math.round(cy), deltaX: 0, deltaY: dy / steps });
    await sleep(ms / steps);
  }
}

// 画布上按住一栋楼拖动
async function waitCanvas(sel, ms) {
  const t = Date.now();
  while (Date.now() - t < (ms || 4000)) {
    const w = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.getBoundingClientRect().width:0;})()`);
    if (w > 200) return w;
    await sleep(120);
  }
  throw new Error('canvas ' + sel + ' 没有尺寸');
}

async function dragBuilding(bx, by, dx, dy, ms) {
  await waitCanvas('#sb', 5000);
  const dpr = await evaluate('window.devicePixelRatio||1');
  const js = '(function(){try{'
    + 'var c=document.getElementById("sb");'
    + 'var rr=c.getBoundingClientRect();'
    + 'var pad=Math.min(66,Math.max(42,Math.round(rr.height*0.24)));'
    + 'var v=window.SignalLab.sandbox.viewOf(c.width/' + dpr + ', c.height/' + dpr + '-pad, pad);'
    + 'return {x: rr.x + v.sx(' + bx + '), y: rr.y + v.sy(' + by + '), err: null};'
    + '}catch(e){return {err: e.message};}})()';
  const p = await evaluate(js);
  if (!p || p.err) throw new Error('viewOf 失败: ' + (p && p.err));
  const sx = p.x, sy = p.y;
  log('  drag from ' + Math.round(sx) + ',' + Math.round(sy));
  await glide(sx, sy, 380);
  await mouse('mousePressed', sx, sy);
  await sleep(90);
  const steps = Math.max(10, Math.round(ms / 40));
  for (let i = 1; i <= steps; i++) {
    const x = sx + dx * (i / steps), y = sy + dy * (i / steps);
    await mouse('mouseMoved', x, y);
    await evaluate('window.__cx=' + x + ';window.__cy=' + y);
    await sleep(ms / steps);
  }
  await mouse('mouseReleased', sx + dx, sy + dy);
  await sleep(150);
}

async function injectCursor() {
  await evaluate(`(()=>{
    if(document.getElementById('__cur'))return;
    const s=document.createElement('style');
    s.textContent='#__cur{position:fixed;left:0;top:0;width:17px;height:17px;margin:-8.5px 0 0 -8.5px;border-radius:50%;'
      +'background:rgba(255,255,255,.95);box-shadow:0 0 0 1.5px rgba(10,16,24,.55),0 3px 10px rgba(0,0,0,.6);'
      +'pointer-events:none;z-index:2147483647;transition:transform .09s linear}'
      +'#__rip{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;'
      +'border:2px solid rgba(116,185,255,.95);pointer-events:none;z-index:2147483646;opacity:0}';
    document.head.appendChild(s);
    const d=document.createElement('div');d.id='__cur';document.body.appendChild(d);
    const r=document.createElement('div');r.id='__rip';document.body.appendChild(r);
    window.__cursor=(x,y)=>{d.style.transform='translate('+x+'px,'+y+'px)';};
    window.__ripple=(x,y)=>{
      r.style.transition='none';r.style.opacity='.9';r.style.transform='translate('+x+'px,'+y+'px) scale(.35)';
      requestAnimationFrame(()=>{r.style.transition='opacity .5s ease-out, transform .5s ease-out';
        r.style.opacity='0';r.style.transform='translate('+x+'px,'+y+'px) scale(1.7)';});
    };
    window.__cursor(window.innerWidth*0.72, window.innerHeight*0.55);
    window.__cx=window.innerWidth*0.72; window.__cy=window.innerHeight*0.55;
  })()`);
}

async function chapter(name, fn, seconds) {
  log('chapter ' + name + ' start t=' + ((Date.now() - t0) / 1000).toFixed(1));
  marks[name] = Date.now();
  const t = Date.now();
  await fn();
  const left = seconds * 1000 - (Date.now() - t);
  if (left > 0) await sleep(left);
  else log('  超时 ' + name + ' ' + Math.round(-left) + 'ms');
  log('chapter ' + name + ' done t=' + ((Date.now() - t0) / 1000).toFixed(1) + ' frames=' + frames.length);
}

async function main() {
  const list = await fetch('http://127.0.0.1:9333/json/list').then(r => r.json());
  const page = list.find(t => t.type === 'page' && /127\.0\.0\.1:8770/.test(t.url)) || list.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method === 'Page.screencastFrame') {
      send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
      var now = Date.now();
      if (now - lastKeep < MIN_GAP) { dropped++; return; }
      lastKeep = now;
      const f = path.join(FRAMES, String(frames.length + 1).padStart(5, '0') + '.jpg');
      const buf = Buffer.from(m.params.data, 'base64');
      recvBytes += buf.length;
      fs.writeFileSync(f, buf);
      frames.push({ file: f, ts: m.params.metadata.timestamp ? m.params.metadata.timestamp * 1000 : now });
    }
  };

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.writeFileSync(path.join(__dirname, '_rec.log'), '');
  fs.mkdirSync(FRAMES, { recursive: true });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await sleep(2200);
  await evaluate('document.fonts && document.fonts.ready');
  await injectCursor();
  await sleep(300);

  await send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
  t0 = Date.now();

  // 0 开场
  await chapter('00', async () => {
    await glide(760, 470, 2600);
    await sleep(400);
  }, DUR['00'] / 1000 + TAIL / 1000);

  // 1 混叠
  await chapter('01', async () => {
    await clickText('.preset', '混叠', 420);
    await sleep(500);
    await dragSlider('sampleRate', 0.62, 4200);
    await sleep(600);
    await dragSlider('sampleRate', 0.14, 2600);
  }, DUR['01'] / 1000 + TAIL / 1000);

  // 2 方波与谐波
  await chapter('02', async () => {
    await clickText('.preset', '方波与谐波', 420);
    await sleep(500);
    await dragSlider('freq', 0.42, 2400);
    await sleep(400);
    await dragSlider('freq', 0.34, 1200);
  }, DUR['02'] / 1000 + TAIL / 1000);

  // 3 带宽限制
  await chapter('03', async () => {
    await clickText('.preset', '带宽限制', 420);
    await sleep(500);
    await dragSlider('bandwidth', 0.06, 3000);
  }, DUR['03'] / 1000 + TAIL / 1000);

  // 4 沙盒
  await chapter('04', async () => {
    await clickSel('.tab[data-instr="sb"]', 460);
    await sleep(600);
    await clickText('.preset', '一台发射机，三个方向', 420);
    await sleep(700);
    await dragBuilding(150, 230, 26, 34, 2200);
  }, DUR['04'] / 1000 + TAIL / 1000);

  // 5 街角 + 提问
  await chapter('05', async () => {
    await clickText('.preset', '楼把直达挡死了', 420);
    await sleep(500);
    await clickSel('.ptab[data-tab="ai"]', 380);
    await sleep(300);
    await clickSel('#ask', 320);
    await sleep(200);
    await typeText('为什么测出来的方向差了这么多', 34);
    await sleep(250);
    await clickSel('#sendBtn', 260);
  }, DUR['05'] / 1000 + TAIL / 1000);

  // 6 教师端
  await chapter('06', async () => {
    await clickSel('#teacherBtn', 420);
    await sleep(600);
    await clickSel('#teacherOverlay [data-tab="class"]', 320);
    await sleep(500);
    const files = fs.readdirSync(path.join(__dirname, 'pilot', 'cohort')).map(f => path.join(__dirname, 'pilot', 'cohort', f));
    const doc = await send('DOM.getDocument', { depth: -1 });
    const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#tchFiles' });
    await send('DOM.setFileInputFiles', { files, nodeId: q.nodeId });
    await sleep(900);
    await scrollBy('#tchBody', 520, 2400);
  }, DUR['06'] / 1000 + TAIL / 1000);

  // 7 出练习
  await chapter('07', async () => {
    await clickSel('#teacherOverlay [data-tab="make"]', 320);
    await sleep(400);
    await clickSel('#tchGen', 340);
    await sleep(700);
    await scrollBy('#tchBody', 900, 3200);
  }, DUR['07'] / 1000 + TAIL / 1000);

  // 8 AI 助教
  await chapter('08', async () => {
    await clickSel('#tchClose', 320);
    await sleep(600);
    await scrollBy('#chat', 420, 6000);
    await sleep(500);
    await scrollBy('#chat', 420, 5600);
  }, DUR['08'] / 1000 + TAIL / 1000);

  // 9 收尾
  await chapter('09', async () => {
    await clickSel('.tab[data-instr="wave"]', 420);
    await sleep(400);
    await clickText('.preset', '干净正弦', 380);
    await sleep(500);
    await glide(1080, 300, 1800);
  }, DUR['09'] / 1000 + TAIL / 1000);

  await sleep(250);
  await send('Page.stopScreencast');
  await sleep(300);

  const end = Date.now();
  fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(frames.map(function (f) { return [f.file, f.ts]; })));
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
    t0, end, frames: frames.length, dropped, marks, clicks,
    totalMs: end - t0, recvBytes
  }, null, 1));
  console.log('丢弃', dropped, '帧数', frames.length, '时长', ((end - t0) / 1000).toFixed(1) + 's', '点击', clicks.length);
  ws.close();
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
