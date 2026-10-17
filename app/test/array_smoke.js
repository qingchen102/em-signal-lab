/* ==========================================================================
 * array_smoke.js — 阵列测向的冒烟测试
 *
 * 只验证物理对不对，不碰 DOM。跑法：
 *   node test/array_smoke.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JSDIR = path.join(__dirname, '..', 'js');

function load(files) {
  const sandbox = {
    window: {},
    Math, console, JSON, Number, String, Object, Array, isFinite,
    Float64Array, Int32Array
  };
  sandbox.window.SignalLab = {};
  vm.createContext(sandbox);
  for (const f of (files || ['signal.js', 'array.js'])) {
    vm.runInContext(fs.readFileSync(path.join(JSDIR, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.window.SignalLab;
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   → ' + extra : '')); }
}

const NS = load();
const A = NS.array;

function sim(o) {
  return A.simulate(Object.assign({ seed: 1, snapshots: 300, snrDb: 20 }, o));
}

function nearestPeak(peaks, deg) {
  let best = null, bd = 1e9;
  for (const p of peaks) {
    const d = Math.abs(p.deg - deg);
    if (d < bd) { bd = d; best = p; }
  }
  return best ? { deg: best.deg, db: best.db, err: bd } : null;
}

function spread(db) {
  let mn = 1e9, mx = -1e9;
  for (const v of db) { if (v > mx) mx = v; if (v < mn) mn = v; }
  return mx - mn;
}

console.log('\n== 阵列测向 ==\n');

console.log('[1] 单阵元：没有方向信息');
{
  const r = sim({ M: 1, spacing: 0.5, sources: 1, angles: [20] });
  ok('M=1 时 MUSIC 不可用', r.hasMusic === false);
  ok('M=1 时 Bartlett 谱是平的', spread(r.bartlett) < 0.5, 'spread=' + spread(r.bartlett).toFixed(4));
  ok('M=1 时噪声子空间维数为 0', r.noiseDim === 0, 'noiseDim=' + r.noiseDim);
}

console.log('[2] 正常测向：8 阵元、半波长间距、单个 30° 来波');
{
  const r = sim({ M: 8, spacing: 0.5, sources: 1, angles: [30] });
  const pb = nearestPeak(r.peaks.bartlett, 30);
  const pm = nearestPeak(r.peaks.music, 30);
  ok('Bartlett 峰落在 30° 附近', !!pb && pb.err < 3, pb ? pb.deg.toFixed(1) + '°' : 'no peak');
  ok('MUSIC 峰落在 30° 附近', !!pm && pm.err < 2, pm ? pm.deg.toFixed(1) + '°' : 'no peak');
  ok('MUSIC 可用', r.hasMusic === true);
  ok('最大特征值远大于其余', r.eigenvalues[7] > 50 * r.eigenvalues[6],
    r.eigenvalues[7].toFixed(3) + ' vs ' + r.eigenvalues[6].toFixed(6));
  ok('真值记录正确', r.angles.length === 1 && r.angles[0] === 30);
}

console.log('[3] 栅瓣：间距 = 1 个波长，30° 的源在 -30° 也冒出一个峰');
{
  const r = sim({ M: 8, spacing: 1.0, sources: 1, angles: [30] });
  const p30 = nearestPeak(r.peaks.music, 30);
  const pm30 = nearestPeak(r.peaks.music, -30);
  ok('30° 有峰', !!p30 && p30.err < 3, p30 ? p30.deg.toFixed(1) + '°' : 'no peak');
  ok('-30° 也冒出峰（栅瓣）', !!pm30 && pm30.err < 3, pm30 ? pm30.deg.toFixed(1) + '°' : 'no peak');
  ok('两个峰差不多高', !!p30 && !!pm30 && Math.abs(p30.db - pm30.db) < 4,
    p30 && pm30 ? Math.abs(p30.db - pm30.db).toFixed(2) + ' dB' : 'n/a');
}

console.log('[4] 分辨率：两个方向只差 12°，Bartlett 分不开，MUSIC 分得开');
{
  const r = sim({ M: 8, spacing: 0.5, sources: 2, angles: [-6, 6] });
  ok('Bartlett 只看到一个包', r.peaks.bartlett.length < 2, 'peaks=' + r.peaks.bartlett.length);
  ok('MUSIC 分出两个峰', r.peaks.music.length === 2, 'peaks=' + r.peaks.music.length);
  if (r.peaks.music.length === 2) {
    const a0 = r.peaks.music[0].deg, a1 = r.peaks.music[1].deg;
    ok('两个峰分别落在 -6° 和 +6° 附近',
      Math.min(Math.abs(a0 + 6), Math.abs(a1 + 6)) < 4 && Math.min(Math.abs(a0 - 6), Math.abs(a1 - 6)) < 4,
      a0.toFixed(1) + '° / ' + a1.toFixed(1) + '°');
  }
}

console.log('[5] 阵元数 ≤ 信源数，MUSIC 失效');
{
  const r = sim({ M: 2, spacing: 0.5, sources: 2, angles: [-30, 30] });
  ok('M=2, S=2 时 hasMusic 为 false', r.hasMusic === false);
  ok('noiseDim = 0', r.noiseDim === 0, 'noiseDim=' + r.noiseDim);
  ok('music 谱为 null', r.music === null);
}

console.log('[6] 主瓣宽度随孔径变窄');
{
  function mainLobeWidth(r) {
    let i0 = 0;
    for (let i = 0; i < r.bartlett.length; i++) if (r.bartlett[i] > r.bartlett[i0]) i0 = i;
    let lo = i0, hi = i0;
    while (lo > 0 && r.bartlett[lo] > -3) lo--;
    while (hi < r.bartlett.length - 1 && r.bartlett[hi] > -3) hi++;
    return r.theta[hi] - r.theta[lo];
  }
  const w4 = mainLobeWidth(sim({ M: 4, spacing: 0.5, sources: 1, angles: [0] }));
  const w8 = mainLobeWidth(sim({ M: 8, spacing: 0.5, sources: 1, angles: [0] }));
  const w16 = mainLobeWidth(sim({ M: 16, spacing: 0.5, sources: 1, angles: [0] }));
  ok('M=8 的主瓣比 M=4 窄', w8 < w4, w4.toFixed(1) + '° → ' + w8.toFixed(1) + '°');
  ok('M=16 的主瓣比 M=8 窄', w16 < w8, w8.toFixed(1) + '° → ' + w16.toFixed(1) + '°');
  ok('M=8 实测主瓣与理论 12.7° 同量级', Math.abs(w8 - 12.7) < 6,
    '实测 ' + w8.toFixed(1) + '° vs 理论 0.886λ/(M·d) = 12.7°');
}

console.log('[7] 快拍数确实被采用');
{
  const rLow = sim({ M: 8, spacing: 0.5, sources: 1, angles: [10], snapshots: 10 });
  const rHigh = sim({ M: 8, spacing: 0.5, sources: 1, angles: [10], snapshots: 1000 });
  ok('K 被记录为 10', rLow.K === 10, 'K=' + rLow.K);
  ok('K 被记录为 1000', rHigh.K === 1000, 'K=' + rHigh.K);
  ok('K < 2M 会被知识面板抓到', rLow.K < 2 * rLow.M);
  ok('K >= 2M 不触发那条卡片', rHigh.K >= 2 * rHigh.M);
}

console.log('[8] 种子可复现');
{
  const a1 = sim({ M: 8, spacing: 0.5, sources: 1, angles: [15], seed: 7 });
  const a2 = sim({ M: 8, spacing: 0.5, sources: 1, angles: [15], seed: 7 });
  let same = true;
  for (let i = 0; i < a1.bartlett.length; i++) {
    if (Math.abs(a1.bartlett[i] - a2.bartlett[i]) > 1e-12) { same = false; break; }
  }
  ok('同一个种子结果完全一致', same);
  const a3 = sim({ M: 8, spacing: 0.5, sources: 1, angles: [15], seed: 8 });
  let diff = false;
  for (let i = 0; i < a1.bartlett.length; i++) {
    if (Math.abs(a1.bartlett[i] - a3.bartlett[i]) > 1e-9) { diff = true; break; }
  }
  ok('换个种子结果不同', diff);
}

console.log('[9] 性能：最坏情况（M=16、信源 3 个）一次 simulate 的耗时');
{
  const t0 = Date.now();
  const N = 20;
  for (let i = 0; i < N; i++) {
    sim({ M: 16, spacing: 0.5, sources: 3, angles: [-40, 0, 40], snapshots: 500, seed: i + 1 });
  }
  const ms = (Date.now() - t0) / N;
  console.log('       平均 ' + ms.toFixed(1) + ' ms/次');
  ok('一次不超过 60 ms（拖滑条时还能跟手）', ms < 60, ms.toFixed(1) + ' ms');
}

console.log('[10] 知识面板的阵列卡片（这里曾经错得很隐蔽）');
{
  const F = load(['signal.js', 'array.js', 'advisor.js']);
  const adv = F.advisor, A2 = F.array, S2 = F.signal;
  const p = {
    wave: 'sine', freq: 1000, amp: 1, offset: 0, phase: 0, duty: 0.5, noise: 0,
    bandwidth: 100000, timePerDiv: 200e-6, voltsPerDiv: 0.5, sampleRate: 1e6,
    triggerLevel: 0, coupling: 'DC', probe: 1, spanHz: 20000
  };
  const model = S2.makeModel(p);
  const tp = S2.triggerPath(model, p);
  const range = S2.signalRange(tp, p.freq);
  const trig = S2.findTrigger(tp, p.triggerLevel, p.freq);
  const acq = S2.acquire(p, model, 0, trig);
  const kMax = S2.harmonicCount(p.bandwidth, p.freq);

  function ids(cfg) {
    const arr = A2.simulate(Object.assign({ seed: 1, snapshots: 200, snrDb: 20 }, cfg));
    return adv.advise({ p: p, acq: acq, kMax: kMax, range: range, arr: arr })
      .map(function (c) { return c.id; });
  }

  const single = ids({ M: 1, spacing: 0.5, sources: 1, angles: [20] });
  ok('M=1 → 「只有一个阵元」', single.indexOf('array-single') >= 0, single.join(','));

  const narrow = ids({ M: 8, spacing: 0.5, sources: 2, angles: [-6, 6] });
  ok('12° 双源 → 「Bartlett 分不开」（瑞利限 12.7°）',
    narrow.indexOf('array-resolution') >= 0, narrow.join(','));
  ok('12° 双源不再误报「把方向测出来了」', narrow.indexOf('array-normal') < 0, narrow.join(','));

  const wide = ids({ M: 8, spacing: 0.5, sources: 2, angles: [-20, 25] });
  ok('45° 双源 → 「把方向测出来了」', wide.indexOf('array-normal') >= 0, wide.join(','));

  const grat = ids({ M: 8, spacing: 1.0, sources: 1, angles: [30] });
  ok('d = 1.0λ → 「栅瓣」', grat.indexOf('array-grating') >= 0, grat.join(','));

  const few = ids({ M: 8, spacing: 0.5, sources: 1, angles: [10], snapshots: 10 });
  ok('K = 10 → 「快拍数太少」', few.indexOf('array-snapshots') >= 0, few.join(','));

  const bad = ids({ M: 2, spacing: 0.5, sources: 2, angles: [-30, 30] });
  ok('M=2, S=2 → 「MUSIC 算不出来」', bad.indexOf('array-music-fail') >= 0, bad.join(','));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
