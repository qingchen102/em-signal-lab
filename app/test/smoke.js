/* 冒烟测试：不碰 DOM，只验证信号链和频谱是否算对 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = 'D:/srtp/EM-benchmark/em-signal-lab/app/js';
const sandbox = { window: {}, Math, console, Float64Array, Array, isFinite, Number, Object };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['signal.js', 'fft.js', 'advisor.js']) {
  vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), sandbox, { filename: f });
}
const NS = sandbox.window.SignalLab;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '   ' + detail); }
}

const BASE = {
  wave: 'sine', freq: 1000, amp: 1, offset: 0, phase: 0, duty: 0.5, noise: 0,
  bandwidth: 100000,
  timePerDiv: 200e-6, voltsPerDiv: 0.5, sampleRate: 1e6,
  triggerLevel: 0, coupling: 'DC', probe: 1, spanHz: 20000
};
const P = (over) => Object.assign({}, BASE, over);

function run(p, frame) {
  const m = NS.signal.makeModel(p);
  // 和 main.js 一样：触发比较器看到的是耦合与探头衰减之后的信号
  const tp = NS.signal.triggerPath(m, p);
  const trig = NS.signal.findTrigger(tp, p.triggerLevel, p.freq);
  const acq = NS.signal.acquire(p, m, frame || 0, trig);
  const range = NS.signal.signalRange(tp, p.freq);
  return { m, tp, trig, acq, range };
}

console.log('\n[1] 干净正弦：1 kHz @ 1 MSa/s, 200 µs/div');
{
  const p = P({});
  const { m, acq } = run(p);
  check('kMax = 带宽/基频 = 100', m.kMax === 100, 'kMax=' + m.kMax);
  check('触发锁定', acq.triggered === true);
  check('一屏 2 个周期', Math.abs(acq.periods - 2) < 1e-9, 'periods=' + acq.periods);
  check('每周期 1000 点', Math.abs(acq.samplesPerPeriod - 1000) < 1e-9);
  check('N = 2000', acq.N === 2000, 'N=' + acq.N);
  // 正弦波采样点应该在 [-1,1]
  let lo = 9, hi = -9;
  for (const v of acq.samples) { if (v < lo) lo = v; if (v > hi) hi = v; }
  check('幅度落在 ±1 内', lo > -1.001 && hi < 1.001, `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
}

console.log('\n[2] 混叠：1 kHz @ 1500 Sa/s, 2 ms/div  → 应该看到约 500 Hz');
{
  const p = P({ sampleRate: 1500, timePerDiv: 2e-3 });
  const { acq } = run(p);
  check('每周期 1.5 点', Math.abs(acq.samplesPerPeriod - 1.5) < 1e-9, 'spp=' + acq.samplesPerPeriod);
  check('N = 30', acq.N === 30, 'N=' + acq.N);
  check('别名 = 500 Hz', NS.advisor.aliasOf(1000, 1500) === 500);
  // 数一下 30 个点里过零几次，反推频率
  let zc = 0;
  for (let i = 1; i < acq.N; i++) if (acq.samples[i - 1] < 0 && acq.samples[i] >= 0) zc++;
  const estF = (zc / acq.Tdisp);
  check('从屏幕反推频率 ≈ 500 Hz', Math.abs(estF - 500) < 120, 'est=' + estF.toFixed(0) + ' Hz');
  const cards = NS.advisor.advise({ p, acq, kMax: 199, range: { min: -1, max: 1 } });
  check('知识面板报混叠', cards[0].id === 'aliasing', 'top=' + cards[0].id);
}

console.log('\n[3] 触发丢失：触发电平 4 V，信号只有 ±1 V');
{
  const p = P({ triggerLevel: 4 });
  const { acq, range } = run(p);
  check('未触发', acq.triggered === false);
  check('信号范围 ±1', Math.abs(range.max - 1) < 0.02 && Math.abs(range.min + 1) < 0.02,
    `[${range.min.toFixed(2)}, ${range.max.toFixed(2)}]`);
  const cards = NS.advisor.advise({ p, acq, kMax: 199, range });
  check('知识面板报触发丢失', cards[0].id === 'no-trigger', 'top=' + cards[0].id);
  // 自由运行：不同 frame 应该得到不同的时间原点
  const a0 = run(p, 0).acq.t0, a5 = run(p, 5).acq.t0;
  check('自由运行时 t0 每帧在动', a0 !== a5, `t0(0)=${a0.toExponential(2)} t0(5)=${a5.toExponential(2)}`);
}

console.log('\n[4] 方波谐波：1 kHz 方波，谱线应在 1k/3k/5k… 且幅度按 1/n');
{
  const p = P({ wave: 'square' });
  const { m } = run(p);
  const spec = NS.fft.harmonicSpectrum(m, p.freq, 1024);
  const a1 = spec.bins[1].amp, a3 = spec.bins[3].amp, a5 = spec.bins[5].amp, a2 = spec.bins[2].amp;
  check('基波幅度 ≈ 4/π', Math.abs(a1 - 4 / Math.PI) < 0.02, 'a1=' + a1.toFixed(4));
  check('3 次谐波 ≈ a1/3', Math.abs(a3 - a1 / 3) < 0.02, 'a3=' + a3.toFixed(4));
  check('5 次谐波 ≈ a1/5', Math.abs(a5 - a1 / 5) < 0.02, 'a5=' + a5.toFixed(4));
  check('偶次谐波 ≈ 0', a2 < 0.01, 'a2=' + a2.toFixed(5));
}

console.log('\n[5] 带宽限制 4000 Hz @ 1 kHz → 只留 4 次谐波');
{
  const p = P({ wave: 'square', bandwidth: 4000 });
  const { m } = run(p);
  check('kMax = 4', m.kMax === 4, 'kMax=' + m.kMax);
  const spec = NS.fft.harmonicSpectrum(m, p.freq, 1024);
  const a5 = spec.bins[5].amp, a3 = spec.bins[3].amp;
  check('5 次谐波被砍掉', a5 < 0.01, 'a5=' + a5.toFixed(5));
  check('3 次谐波还在', a3 > 0.3, 'a3=' + a3.toFixed(4));
  // 时域：边沿应该变缓（最大值明显小于理想方波的吉布斯尖峰）
  const cards = NS.advisor.advise({ p, acq: run(p).acq, kMax: m.kMax, range: { min: -1.2, max: 1.2 } });
  check('知识面板报带宽限制', cards.some(c => c.id === 'bandwidth-limit'),
    'ids=' + cards.map(c => c.id).join(','));
}

console.log('\n[6] 其余规则：超量程 / AC 耦合 / 探头 / 时基');
{
  let p = P({ amp: 3 });           // ±3 V，档位 0.5 V/div → 屏幕只能 ±2 V
  let r = run(p);
  let ids = NS.advisor.advise({ p, acq: r.acq, kMax: r.m.kMax, range: r.range }).map(c => c.id);
  check('报超量程', ids.includes('overrange'), ids.join(','));

  p = P({ offset: 2, coupling: 'AC' });
  r = run(p);
  ids = NS.advisor.advise({ p, acq: r.acq, kMax: r.m.kMax, range: r.range }).map(c => c.id);
  check('报 AC 耦合隔直流', ids.includes('ac-coupling'), ids.join(','));
  check('AC 后均值 ≈ 0', Math.abs(r.acq.removedDC - 2) < 0.01, 'removedDC=' + r.acq.removedDC.toFixed(3));

  p = P({ probe: 10 });
  r = run(p);
  ids = NS.advisor.advise({ p, acq: r.acq, kMax: r.m.kMax, range: r.range }).map(c => c.id);
  check('报探头 ×10', ids.includes('probe'), ids.join(','));
  let peak = 0;
  for (const v of r.acq.samples) peak = Math.max(peak, Math.abs(v));
  check('×10 探头把电压压到 1/10', Math.abs(peak - 0.1) < 0.002, 'peak=' + peak.toFixed(4));

  p = P({ timePerDiv: 20e-6 });
  r = run(p);
  ids = NS.advisor.advise({ p, acq: r.acq, kMax: r.m.kMax, range: r.range }).map(c => c.id);
  check('报一屏不到一个周期', ids.includes('timebase-fast'), ids.join(','));
}

console.log('\n[7] 各种波形都能算出有限值（防止 NaN 混进画布）');
{
  for (const w of ['sine', 'square', 'triangle', 'sawtooth', 'pulse']) {
    for (const duty of [0.1, 0.5, 0.9]) {
      const p = P({ wave: w, duty, noise: 0.1 });
      const { m } = run(p);
      const spec = NS.fft.harmonicSpectrum(m, p.freq, 1024);
      let bad = 0;
      for (const b of spec.bins) if (!isFinite(b.amp)) bad++;
      const acq = run(p).acq;
      for (const v of acq.samples) if (!isFinite(v)) bad++;
      check(`${w} duty=${duty}`, bad === 0, bad ? bad + ' 个非法值' : '');
    }
  }
}

console.log('\n[8] 触发比较器看到的是耦合与探头衰减之后的信号');
{
  const ac = run(P({ offset: 2, coupling: 'AC' }));
  check('AC 耦合下触发锁定', ac.acq.triggered === true,
    `range=[${ac.range.min.toFixed(2)}, ${ac.range.max.toFixed(2)}]`);
  check('AC 后比较器看到的范围变成 ±1',
    Math.abs(ac.range.min + 1) < 0.02 && Math.abs(ac.range.max - 1) < 0.02,
    `[${ac.range.min.toFixed(2)}, ${ac.range.max.toFixed(2)}]`);

  const dc = run(P({ offset: 2, coupling: 'DC' }));
  check('DC 耦合下同一个电平不触发', dc.acq.triggered === false,
    `range=[${dc.range.min.toFixed(2)}, ${dc.range.max.toFixed(2)}]`);

  const pr = run(P({ probe: 10, triggerLevel: 0.05 }));
  check('×10 探头下 0.05 V 触发电平能锁定', pr.acq.triggered === true,
    `range=[${pr.range.min.toFixed(3)}, ${pr.range.max.toFixed(3)}]`);
  const pr2 = run(P({ probe: 1, triggerLevel: 0.05 }));
  check('×1 探头下 0.05 V 电平也在范围内', pr2.acq.triggered === true);
}

console.log(`\n========== ${pass} passed, ${fail} failed ==========\n`);
process.exit(fail ? 1 : 0);
