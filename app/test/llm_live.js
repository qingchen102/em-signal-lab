/* ==========================================================================
 * llm_live.js — 真的把一次问答发给模型，验证整条链路
 *
 * 它验的是 llm.js 最容易出错的两件事：
 *   1. probe() 能不能找到本机 server.py
 *   2. SSE 流能不能被正确解析成一段完整回答
 *
 * 需要 app/server.py 正在跑。跑法：
 *     python app/server.py
 *     node app/test/llm_live.js
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'js');

const store = {};
const sandbox = {
  window: {},
  Math, console, JSON, Object, Array, String, Number, Boolean, Date, RegExp, Error,
  Promise, isFinite, isNaN, setTimeout, clearTimeout, fetch, AbortController, TextDecoder,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  },
  location: { protocol: 'file:', origin: 'null', search: '' }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['signal.js', 'fft.js', 'advisor.js', 'llm.js']) {
  vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), sandbox, { filename: f });
}
const NS = sandbox.window.SignalLab;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '   ' + detail); }
}

/* 造一份"学生把采样率拧到 1500 Sa/s"的状态 */
function makeCtx() {
  const p = {
    wave: 'sine', freq: 1000, amp: 1, offset: 0, phase: 0, duty: 0.5, noise: 0,
    bandwidth: 100000,
    timePerDiv: 2e-3, voltsPerDiv: 0.5, sampleRate: 1500,
    triggerLevel: 0, coupling: 'DC', probe: 1, spanHz: 20000
  };
  const m = NS.signal.makeModel(p);
  const tp = NS.signal.triggerPath(m, p);
  const trig = NS.signal.findTrigger(tp, p.triggerLevel, p.freq);
  const acq = NS.signal.acquire(p, m, 0, trig);
  const range = NS.signal.signalRange(tp, p.freq);
  const cards = NS.advisor.advise({ p, acq, kMax: m.kMax, range });
  return {
    p, acq, kMax: m.kMax, range, clipped: false, cards,
    history: [{ id: 'sampleRate', from: 1e6, to: 1500 }]
  };
}

(async () => {
  console.log('\n[1] 探测本机服务');
  const r = await NS.llm.probe();
  check('找到本机服务', !!r.url, r.url || '（没找到，先跑 python app/server.py）');
  check('服务端已配 Key', !!(r.health && r.health.hasKey),
    r.health ? JSON.stringify(r.health) : '');
  if (!r.url) { console.log('\n没找到服务，后面的测不了。'); process.exit(1); }

  console.log('\n[2] brief() 把仪器状态拼成人话');
  const ctx = makeCtx();
  const text = NS.llm.brief(ctx);
  console.log(text.split('\n').map((l) => '      ' + l).join('\n'));
  check('带上了混叠推导', /混叠/.test(text), '');
  check('算出了折叠频率 500 Hz', /500/.test(text), '');
  check('带上了学生刚动过的旋钮', /采样率/.test(text), '');
  check('报告了每周期采样点数', /每周期/.test(text), '');

  console.log('\n[3] 真的问一次（流式）');
  const t0 = Date.now();
  let reasonLen = 0, chunks = 0;
  const answer = await NS.llm.chat({
    messages: [
      { role: 'system', content: NS.llm.SYSTEM_PROMPT + '\n\n===== 当前仪器状态 =====\n' + text },
      { role: 'user', content: '屏幕上这个波为什么长这样？' }
    ],
    onReasoning: (c) => { reasonLen += c.length; },
    onDelta: () => { chunks++; }
  });
  const ms = Date.now() - t0;

  console.log('      ── 模型回答（' + ms + ' ms，' + chunks + ' 个分片，'
    + '思考 ' + reasonLen + ' 字）──');
  console.log(answer.trim().split('\n').map((l) => '      ' + l).join('\n'));

  check('拿到了回答', answer.trim().length > 10, answer.length + ' 字');
  check('是流式回来的', chunks > 1, chunks + ' 个分片');
  check('用了屏幕上的数字（500）', /500/.test(answer), '');
  check('没编造章节号/页码', !/第\s*\d+\s*[章节]|P\s*\d+|页/.test(answer), '');

  console.log('\n' + (fail ? '✗ ' : '') + pass + ' passed, ' + fail + ' failed\n');
  // 让 undici 把 socket 收干净再退，否则 Windows 上会撞 libuv 断言
  setTimeout(() => process.exit(fail ? 1 : 0), 400);
})().catch((e) => {
  console.error('\n崩了：name=' + (e && e.name)
    + ' message=' + JSON.stringify(e && e.message));
  if (e && e.stack) console.error(e.stack);
  else console.error(require('util').inspect(e, { depth: 3 }));
  setTimeout(() => process.exit(1), 400);
});
