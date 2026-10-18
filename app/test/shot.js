/* 用 Chrome DevTools Protocol 驱动无头 Chrome：打开页面、按顺序点几个元素、截图。
   比 --screenshot 强的地方是能「点」， 覆盖层、标签页、答题流程这些
   静态截图看不到的状态，必须先点出来。

   用法：node app/test/shot.js <url> <out.png> [选择器…]
   每个选择器依次点击，每次点完等 500ms。 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333);

const [, , url, out, ...clicks] = process.argv;
if (!url || !out) {
  console.error('用法: node app/test/shot.js <url> <out.png> [选择器…]');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const udd = path.join(os.tmpdir(), 'sl-cdp-' + process.pid);
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,1000',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + udd,
    'about:blank'
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    let targets = null;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
        targets = await r.json();
        if (targets && targets.length) break;
      } catch (e) { /* devtools 还没起来 */ }
      await sleep(150);
    }
    if (!targets || !targets.length) throw new Error('Chrome 没有起来（devtools 端口没响应）');
    const page = targets.find(t => t.type === 'page') || targets[0];

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let seq = 0;
    const pending = new Map();
    const waiters = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method) waiters.slice().forEach(w => w(m));
    };
    function send(method, params) {
      const id = ++seq;
      return new Promise((res) => {
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    }
    function once(method, timeoutMs) {
      return new Promise((res) => {
        const w = (m) => { if (m.method === method) { off(); res(true); } };
        const t = setTimeout(() => { off(); res(false); }, timeoutMs || 8000);
        function off() { clearTimeout(t); const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); }
        waiters.push(w);
      });
    }

    await send('Page.enable');
    await send('Runtime.enable');

    const loaded = once('Page.loadEventFired', 10000);
    await send('Page.navigate', { url });
    await loaded;
    await sleep(1400);

    for (const sel of clicks) {
      const r = await send('Runtime.evaluate', {
        expression: '(function(){var e=document.querySelector(' + JSON.stringify(sel) +
          ');if(!e)return "missing";if(e.disabled)return "disabled";e.click();return "ok";})()',
        returnByValue: true
      });
      const v = r.result && r.result.result && r.result.result.value;
      if (v !== 'ok') console.error('  点不到 ' + sel + ' → ' + v);
      await sleep(500);
    }

    await sleep(400);

    /* 设 SHOT_FILE="选择器=路径[|路径…][;选择器=路径…]" 就往 <input type=file> 里塞文件。
       无头浏览器弹不出文件选择框，只能走 CDP 的 DOM.setFileInputFiles。
       例：SHOT_FILE="#tchFiles=pilot/cohort-all.json" */
    if (process.env.SHOT_FILE) {
      await send('DOM.enable');
      const specs = process.env.SHOT_FILE.split(';').filter(s => s.trim());
      for (const spec of specs) {
        const i = spec.indexOf('=');
        if (i < 0) { console.error('  SHOT_FILE 格式错（要 选择器=路径）：' + spec); continue; }
        const fsel = spec.slice(0, i).trim();
        const files = spec.slice(i + 1).split('|').map(s => path.resolve(s.trim()));
        const missing = files.filter(f => !fs.existsSync(f));
        if (missing.length) { console.error('  文件不存在：' + missing.join(', ')); continue; }
        const r = await send('Runtime.evaluate', {
          expression: 'document.querySelector(' + JSON.stringify(fsel) + ')'
        });
        const objId = r.result && r.result.result && r.result.result.objectId;
        if (!objId) { console.error('  找不到文件框 ' + fsel); continue; }
        const res = await send('DOM.setFileInputFiles', { files, objectId: objId });
        if (res.error) console.error('  塞文件失败：' + res.error.message);
        else console.log('  已塞入 ' + files.length + ' 个文件到 ' + fsel);
        await sleep(1500);
      }
    }

    /* 设 SHOT_EVAL 就直接在页面里跑一小段 JS 并把结果打回终端。
       截图看不出来的东西（实际画到画布上的像素、内部状态）用它查。 */
    if (process.env.SHOT_EVAL) {
      const ev = await send('Runtime.evaluate', {
        expression: process.env.SHOT_EVAL,
        returnByValue: true,
        awaitPromise: true
      });
      const ex = ev.result && ev.result.exceptionDetails;
      if (ex) console.error('  SHOT_EVAL 抛错：' + (ex.exception && ex.exception.description || ex.text));
      else console.log('  SHOT_EVAL → ' + JSON.stringify(ev.result && ev.result.result && ev.result.result.value));
    }
    /* 想看某一块的细节就设 SHOT_SEL（元素选择器）+ SHOT_SCALE（放大倍数），
       只截那个元素；不设就整页截图。 */
    let clip = null;
    const sel = process.env.SHOT_SEL;
    if (sel) {
      const r = await send('Runtime.evaluate', {
        expression: '(function(){var e=document.querySelector(' + JSON.stringify(sel) +
          ');if(!e)return null;var b=e.getBoundingClientRect();' +
          'return {x:b.x,y:b.y,width:b.width,height:b.height};})()',
        returnByValue: true
      });
      const b = r.result && r.result.result && r.result.result.value;
      if (b && b.width > 0) {
        clip = {
          x: b.x, y: b.y, width: b.width, height: b.height,
          scale: Number(process.env.SHOT_SCALE || 2)
        };
      } else {
        console.error('  找不到元素 ' + sel + '，改成整页截图');
      }
    }
    const shot = await send('Page.captureScreenshot',
      clip ? { format: 'png', clip } : { format: 'png' });
    const data = shot.result && shot.result.data;
    if (!data) throw new Error('截图失败');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    console.log('已保存 ' + out);
  } finally {
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    chrome.kill();
    await sleep(400);
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch(e => { console.error('错误：' + e.message); process.exit(1); });
