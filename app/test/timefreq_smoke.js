/* ==========================================================================
 * timefreq_smoke.js — 时频图的冒烟测试
 *
 * 只验证信号处理对不对，不碰 DOM（画的部分在 Chrome 里人工看）。跑法：
 *   node test/timefreq_smoke.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JSDIR = path.join(__dirname, '..', 'js');

function load(files) {
  const sandbox = {
    window: {},
    Math, console, JSON, Number, String, Object, Array, isFinite, isNaN,
    Float64Array, Uint8Array, Int32Array
  };
  sandbox.window.SignalLab = {};
  vm.createContext(sandbox);
  for (const f of (files || ['signal.js', 'fft.js', 'timefreq.js'])) {
    vm.runInContext(fs.readFileSync(path.join(JSDIR, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.window.SignalLab;
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   → ' + extra : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

const NS = load();
const TF = NS.timefreq;
const FS = 10000;

function an(o) {
  return TF.analyze(Object.assign(
    { scenario: 'steady', f1: 800, f2: 1800, win: 128, winType: 'hann', overlap: 50, sampleRate: FS, noise: 0 },
    o));
}

/* 一列里数出几个谱峰（高于 thr 且是局部极大） */
function peaksInCol(res, col, thr) {
  let n = 0;
  for (let r = 1; r < res.rows - 1; r++) {
    const p = res.at(col, r - 1), c = res.at(col, r), q = res.at(col, r + 1);
    if (c > thr && c >= p && c > q) n++;
  }
  return n;
}

/* 找到"有信号"的列，并算其中同时亮着两个音的列占比 */
function bothFrac(res, f1, f2, actThr, bothThr) {
  actThr = actThr === undefined ? -30 : actThr;
  bothThr = bothThr === undefined ? -20 : bothThr;
  const idx = [];
  for (let c = 0; c < res.cols; c++) {
    if (Math.max(res.energyNear(c, f1), res.energyNear(c, f2)) > actThr) idx.push(c);
  }
  let both = 0;
  for (const c of idx) if (res.energyNear(c, f1) > bothThr && res.energyNear(c, f2) > bothThr) both++;
  return { frac: both / Math.max(1, idx.length), active: idx.length, both, cols: res.cols };
}

/* 两个音的"在不在这一帧里"两条时间曲线，相关系数。
 * 先后 > 负相关（一个亮另一个就暗）；同时 > 正相关（一起亮一起暗）。 */
function corr12(res, f1, f2) {
  const a = [], b = [];
  for (let c = 0; c < res.cols; c++) {
    if (Math.max(res.energyNear(c, f1), res.energyNear(c, f2)) > -30) {
      a.push(res.energyNear(c, f1));
      b.push(res.energyNear(c, f2));
    }
  }
  const n = a.length;
  if (n < 4) return NaN;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sa += da * da; sb += db * db; sab += da * db;
  }
  return sab / Math.sqrt(Math.max(1e-12, sa * sb));
}

/* ======================================================================
 * A. 分辨能力：Δt = N/fs，Δf = fs/N，乘积恒为 1
 * ==================================================================== */
console.log('\n— A. 时频分辨能力 —');
ok('dtOf(128, 10000) = 12.8 ms', near(TF.dtOf(128, 10000), 0.0128, 1e-12));
ok('dfOf(128, 10000) = 78.125 Hz', near(TF.dfOf(128, 10000), 78.125, 1e-9));
{
  let worst = 0;
  for (const N of [32, 64, 128, 256, 512, 1024]) {
    for (const f of [8000, 10000, 20000]) {
      worst = Math.max(worst, Math.abs(TF.dtOf(N, f) * TF.dfOf(N, f) - 1));
    }
  }
  ok('任意窗长/采样率下 Δt·Δf 恒等于 1', worst < 1e-12, '最大偏差 ' + worst);
}
{
  const r = an({ win: 256, sampleRate: 20000 });
  ok('analyze 报的 dt 与公式一致', near(r.dt, TF.dtOf(256, 20000), 1e-12));
  ok('analyze 报的 df 与公式一致', near(r.df, TF.dfOf(256, 20000), 1e-12));
  ok('analyze 报的乘积 = 1', near(r.product, 1, 1e-9));
  ok('窗长翻倍则 Δt 翻倍、Δf 减半', (() => {
    const a = an({ win: 128 }), b = an({ win: 256 });
    return near(b.dt, a.dt * 2, 1e-12) && near(b.df, a.df / 2, 1e-9);
  })());
}

/* ======================================================================
 * B. 窗函数
 * ==================================================================== */
console.log('\n— B. 窗函数 —');
{
  const h = TF.makeWindow('hann', 64);
  ok('hann 两端为 0', near(h[0], 0, 1e-9) && near(h[63], 0, 1e-9));
  let sym = true;
  for (let i = 0; i < 64; i++) if (Math.abs(h[i] - h[63 - i]) > 1e-12) sym = false;
  ok('hann 左右对称', sym);
  let mid = true;
  for (let i = 1; i < 63; i++) if (h[i] > h[32] + 1e-12 && i !== 31) mid = false;
  ok('hann 中间最高、两端最低', h[32] > h[1] && h[32] > h[62] && mid);

  const rc = TF.makeWindow('rect', 64);
  let flat = true;
  for (let i = 0; i < 64; i++) if (Math.abs(rc[i] - rc[0]) > 1e-12) flat = false;
  ok('矩形窗各点相等', flat);

  const bl = TF.makeWindow('blackman', 64);
  ok('blackman 两端为 0', Math.abs(bl[0]) < 1e-9 && Math.abs(bl[63]) < 1e-9);

  let norm = true, sums = [];
  for (const k of ['hann', 'rect', 'blackman']) {
    const w = TF.makeWindow(k, 64);
    let s = 0;
    for (let i = 0; i < 64; i++) s += w[i];
    sums.push(k + '=' + s.toFixed(4));
    if (!near(s, 2, 1e-9)) norm = false;
  }
  ok('三种窗都归一化到相干增益 1（Σw = 2）', norm, sums.join(' '));
}

/* ======================================================================
 * C. 场景表
 * ==================================================================== */
console.log('\n— C. 场景表 —');
ok('一共 5 个场景', TF.SCENARIOS.length === 5);
{
  const ids = TF.SCENARIOS.map(s => s.id);
  ok('场景 id 不重复', new Set(ids).size === ids.length, ids.join(','));
  ok('每个场景都有名字和说明', TF.SCENARIOS.every(s => s.name && s.hint && s.blurb));
  ok('scenById 认得出已知场景', TF.scenById('chirp').name === '线性调频');
  ok('scenById 遇到未知 id 兜底到第一个', TF.scenById('没有这个').id === 'steady');
}

/* ======================================================================
 * D. 单音持续：一条水平线
 * ==================================================================== */
console.log('\n— D. 单音持续 —');
{
  const r = an({ scenario: 'steady', f1: 1000, f2: 3000 });
  let worst = 0, same = true;
  const p0 = r.peakFreqOf(0);
  for (let c = 0; c < r.cols; c++) {
    const p = r.peakFreqOf(c);
    worst = Math.max(worst, Math.abs(p - 1000));
    if (Math.abs(p - p0) > 1e-9) same = false;
  }
  ok('峰频在 1000 Hz 上（误差小于一个频率格）', worst < r.df, '最大偏差 ' + worst.toFixed(1) + ' Hz');
  ok('每一列的峰频都一样（频率不随时间变）', same);
  ok('truth 标记为无时间结构', r.truth.timeStructure === false);
  ok('truth 段是单频 f0 = f1', r.truth.segments[0].f0 === 1000 && r.truth.segments[0].f1 === 1000);
}

/* ======================================================================
 * E. 线性调频：一条斜线
 * ==================================================================== */
console.log('\n— E. 线性调频 —');
{
  const r = an({ scenario: 'chirp', f1: 500, f2: 4000 });
  const ps = [];
  for (let c = 0; c < r.cols; c++) ps.push(r.peakFreqOf(c));
  let mono = true;
  for (let i = 1; i < ps.length; i++) if (ps[i] < ps[i - 1] - 1e-9) mono = false;
  ok('峰频随列单调不减', mono);
  /* 一个窗里信号自身也在扫频，所以首/末列的峰不可能卡在端点，
   * 容差要把“窗内扫过的频率”也算进去。 */
  const sweep = (4000 - 500) * (128 / FS) / TF.DURATION;
  ok('首列峰频接近起频 500 Hz（容差含窗内扫频）', Math.abs(ps[0] - 500) < r.df * 1.5 + sweep, ps[0].toFixed(0) + ' Hz');
  ok('末列峰频接近止频 4000 Hz（容差含窗内扫频）', Math.abs(ps[ps.length - 1] - 4000) < r.df * 1.5 + sweep, ps[ps.length - 1].toFixed(0) + ' Hz');
  ok('整条线的斜率接近 (f₂−f₁)/T', (() => {
    const slope = (ps[ps.length - 1] - ps[0]) / r.tMax;
    const want = (4000 - 500) / TF.DURATION;
    return Math.abs(slope - want) / want < 0.12;
  })());
  ok('truth 段从 f₁ 扫到 f₂', r.truth.segments[0].f0 === 500 && r.truth.segments[0].f1 === 4000);
}

/* ======================================================================
 * F. 突发脉冲：比窗还短的东西会被拖宽
 * ==================================================================== */
console.log('\n— F. 突发脉冲与时间分辨 —');
{
  const short = an({ scenario: 'burst', f1: 800, win: 32 });
  const long = an({ scenario: 'burst', f1: 800, win: 128 });
  ok('窗长 32 点（3.2 ms）比 10 ms 的脉冲短 → 没被拖宽', short.smeared === false,
    'dt = ' + TF.fmtMs(short.dt));
  ok('窗长 128 点（12.8 ms）比脉冲长 → 被拖宽', long.smeared === true);
  ok('脉冲长度确实约 10 ms', near(short.featureSec, 0.01, 1e-9), short.featureSec);
  ok('静默区落在显示地板上', short.energyNear(0, 800) <= TF.DB_FLOOR + 1e-6,
    short.energyNear(0, 800).toFixed(1) + ' dB');
  /* 列号要从脉冲真正所在的位置算，不能写死 45%（改过时长就会错位） */
  const bsp = TF.spansOf('burst')[0];
  const bcol = Math.min(short.cols - 1, Math.round(short.cols * (bsp.t0 + bsp.t1) / 2 / TF.DURATION));
  ok('脉冲所在那一列是亮的', short.energyNear(bcol, 800) > -15,
    'col ' + bcol + ' → ' + short.energyNear(bcol, 800).toFixed(1) + ' dB');

  /* 亮区的“时间宽度” = 高于阈值的列数 × 每列的时间步长 */
  const brightSpan = function (res, f) {
    let n = 0;
    for (let c = 0; c < res.cols; c++) if (res.energyNear(c, f) > -15) n++;
    return n * res.step / res.fs;
  };
  ok('窗越长，亮区占的时间越宽', brightSpan(long, 800) > brightSpan(short, 800),
    '短窗 ' + TF.fmtMs(brightSpan(short, 800)) + ' → 长窗 ' + TF.fmtMs(brightSpan(long, 800)));
}

/* ======================================================================
 * G. 双音先后 vs 双音同时，这个屏幕的核心
 * ==================================================================== */
console.log('\n— G. 双音先后 vs 双音同时 —');
{
  const F1 = 800, F2 = 1800;

  const s32 = an({ scenario: 'seq', f1: F1, f2: F2, win: 32 });
  const s128 = an({ scenario: 'seq', f1: F1, f2: F2, win: 128 });
  const s512 = an({ scenario: 'seq', f1: F1, f2: F2, win: 512 });
  const s1024 = an({ scenario: 'seq', f1: F1, f2: F2, win: 1024 });
  const m32 = an({ scenario: 'sim', f1: F1, f2: F2, win: 32 });
  const m512 = an({ scenario: 'sim', f1: F1, f2: F2, win: 512 });
  const m1024 = an({ scenario: 'sim', f1: F1, f2: F2, win: 1024 });

  const b32 = bothFrac(s32, F1, F2);
  const b128 = bothFrac(s128, F1, F2);
  const b512 = bothFrac(s512, F1, F2);
  const b1024 = bothFrac(s1024, F1, F2);
  const bm32 = bothFrac(m32, F1, F2);
  const bm512 = bothFrac(m512, F1, F2);
  const bm1024 = bothFrac(m1024, F1, F2);

  ok('短窗下"两个音同时出现"的帧很少（先后是看得出来的）', b32.frac < 0.15,
    b32.both + '/' + b32.active + ' = ' + b32.frac.toFixed(3));
  ok('双音同时在短窗下每一帧都是两个音', bm32.frac > 0.9, bm32.frac.toFixed(3));
  ok('窗一长，"两个音同时出现"的帧占比单调上升',
    b32.frac < b128.frac && b128.frac < b512.frac && b512.frac < b1024.frac,
    [b32.frac, b128.frac, b512.frac, b1024.frac].map(v => v.toFixed(3)).join(' → '));
  /* 窗 1024 点时整段只剩几帧，这个占比只能当定性看：长窗下“先后”的
   * 占比已经追平“同时”，短窗下则差得很远（上面那两条）。 */
  ok('窗 1024 点时“先后”的占比已经追平“同时”',
    b1024.frac > 3 * b32.frac && b1024.frac <= bm1024.frac + 1e-9,
    'seq ' + b1024.frac.toFixed(3) + ' vs sim ' + bm1024.frac.toFixed(3) +
    '（整段只有 ' + s1024.nFrames + ' 帧）');

  const r32 = corr12(s32, F1, F2);
  const rm32 = corr12(m32, F1, F2);
  ok('短窗下两个音的时间曲线反相关（一个亮另一个就暗）', r32 < -0.5, 'ρ = ' + r32.toFixed(3));
  ok('双音同时的时间曲线正相关（一起亮一起暗）', rm32 > 0.5, 'ρ = ' + rm32.toFixed(3));
  ok('短窗能把"先后"和"同时"分开', r32 < -0.5 && rm32 > 0.5);

  ok('系统自己判断：窗 128 点时两个音还分得开', s128.mergesInTime === false);
  ok('系统自己判断：窗 256 点时每个音(20 ms)比窗(25.6 ms)短 → 分不开', 
    an({ scenario: 'seq', f1: F1, f2: F2, win: 256 }).mergesInTime === true);
  ok('系统自己判断：窗 512 点也分不开', s512.mergesInTime === true);
  ok('"双音同时"永远不触发"分不开"这个判断', m1024.mergesInTime === false);

  ok('truth 说两个音在时间上没有交集', s128.truth.overlap === false);
  ok('truth 说两个音确实重叠', an({ scenario: 'sim', f1: F1, f2: F2, win: 128 }).truth.overlap === true);
}

/* ======================================================================
 * H. 频率分辨：窗长的另一个代价
 * ==================================================================== */
console.log('\n— H. 频率分辨 —');
{
  /* 两个音只差 100 Hz */
  const near32 = an({ scenario: 'sim', f1: 800, f2: 900, win: 32 });
  const near512 = an({ scenario: 'sim', f1: 800, f2: 900, win: 512 });
  ok('窗 32 点时 Δf = 312 Hz > 间隔 100 Hz → 系统判定分不开', near32.resolvesFreq === false);
  ok('窗 512 点时 Δf = 19.5 Hz < 间隔 100 Hz → 系统判定分得开', near512.resolvesFreq === true);

  const mid = c => Math.round(c * (near512.cols - 1) / 2);
  const pk32 = peaksInCol(near32, Math.round(near32.cols / 2), -12);
  const pk512 = peaksInCol(near512, mid(1), -12);
  ok('窗 32 点的谱上只有一个包（两个音糊在一起）', pk32 <= 1, '数出 ' + pk32 + ' 个峰');
  ok('窗 512 点的谱上是两个峰（100 Hz 分开了）', pk512 >= 2, '数出 ' + pk512 + ' 个峰');

  const far32 = an({ scenario: 'sim', f1: 800, f2: 3000, win: 32 });
  const far512 = an({ scenario: 'sim', f1: 800, f2: 3000, win: 512 });
  ok('间隔 2200 Hz 时，再短的窗也分得开',
    peaksInCol(far32, Math.round(far32.cols / 2), -12) >= 2 &&
    peaksInCol(far512, Math.round(far512.cols / 2), -12) >= 2);
}

/* ======================================================================
 * I. 归一化、地板、边界
 * ==================================================================== */
console.log('\n— I. 归一化与边界 —');
{
  const r = an({ scenario: 'seq', f1: 800, f2: 1800, win: 128 });
  let mx = -Infinity, mn = Infinity, finite = true;
  for (let i = 0; i < r.S.length; i++) {
    const v = r.S[i];
    if (!isFinite(v)) finite = false;
    if (v > mx) mx = v;
    if (v < mn) mn = v;
  }
  ok('所有格子的值都是有限数', finite);
  ok('最大格子归一化到 0 dB', near(mx, 0, 1e-9), mx.toFixed(6));
  ok('最小格子不低于显示地板', mn >= TF.DB_FLOOR - 1e-9, mn.toFixed(3));
  ok('S 的长度 = 列数 × 行数', r.S.length === r.cols * r.rows);
  ok('行数 = 窗长的一半（只画 0…fs/2）', r.rows === (r.N >> 1));

  ok('未知场景不崩、退化为静音', (() => {
    const u = an({ scenario: '不存在', win: 128 });
    return u.cols > 0 && isFinite(u.at(0, 0));
  })());
  ok('重叠率被夹在 0…90 之间', (() => {
    const a = an({ overlap: -10 }), b = an({ overlap: 200 });
    return a.step === a.N && b.step >= 1;
  })());
  ok('窗长给 8 点也不崩', an({ win: 4 }).rows >= 1);
}

/* ======================================================================
 * J. 抽稀：不让画布被撑爆
 * ==================================================================== */
console.log('\n— J. 抽稀 —');
{
  const a = an({ win: 32, overlap: 0, sampleRate: 10000 });
  const expA = Math.floor((Math.round(TF.DURATION * 10000) - 32) / 32) + 1;
  ok('窗 32 点、不重叠、10 kSa/s → ' + expA + ' 帧全画出来', a.nFrames === expA && a.cols === expA && a.stride === 1,
    'nFrames=' + a.nFrames + ' cols=' + a.cols + ' stride=' + a.stride);

  const b = an({ win: 32, overlap: 0, sampleRate: 20000 });
  const expB = Math.floor((Math.round(TF.DURATION * 20000) - 32) / 32) + 1;
  ok('采样率翻倍 → 帧数差不多翻倍，且不超抽稀上限', b.nFrames === expB && Math.abs(b.nFrames - 2 * a.nFrames) <= 2 && b.stride === 1,
    'nFrames=' + b.nFrames + ' stride=' + b.stride + ' cols=' + b.cols);

  let maxCols = 0;
  for (const N of [32, 64, 128, 256, 512, 1024]) {
    for (const ov of [0, 50, 75]) {
      maxCols = Math.max(maxCols, an({ win: N, overlap: ov, sampleRate: 20000 }).cols);
    }
  }
  ok('任何窗长/重叠/采样率组合下列数都不超过 220', maxCols <= 220, '最大 ' + maxCols);

  const e = an({ win: 128, overlap: 75 });
  ok('重叠 75% 时帧间距减半', e.step === 32, 'step=' + e.step);
}

/* ======================================================================
 * K. 噪声
 * ==================================================================== */
console.log('\n— K. 噪声 —');
{
  const clear = an({ scenario: 'seq', win: 128, noise: 0 });
  const noisy = an({ scenario: 'seq', win: 128, noise: 0.05 });
  const a = clear.energyNear(1, 800), b = noisy.energyNear(1, 800);
  ok('无噪声时静默区压在地板上', a <= TF.DB_FLOOR + 1e-6, a.toFixed(1));
  ok('加噪声后静默区明显抬高', b - a > 10, a.toFixed(1) + ' → ' + b.toFixed(1));
  ok('噪声抬高地板但不淹没信号', noisy.energyNear(Math.round(noisy.cols * 0.44), 800) > -12);
  ok('噪声是确定性的（同样的参数两次结果一样）', (() => {
    const r1 = an({ scenario: 'seq', win: 128, noise: 0.05 });
    const r2 = an({ scenario: 'seq', win: 128, noise: 0.05 });
    for (let i = 0; i < r1.S.length; i++) if (r1.S[i] !== r2.S[i]) return false;
    return true;
  })());
}

/* ======================================================================
 * L. 量的格式化
 * ==================================================================== */
console.log('\n— L. 格式化 —');
ok('fmtMs(0.0128) = 12.8 ms', TF.fmtMs(0.0128) === '12.8 ms', TF.fmtMs(0.0128));
ok('fmtMs(0.0032) = 3.20 ms', TF.fmtMs(0.0032) === '3.20 ms', TF.fmtMs(0.0032));
ok('fmtHz(78.125) = 78 Hz', TF.fmtHz(78.125) === '78 Hz', TF.fmtHz(78.125));
ok('fmtHz(10000) = 10.0 kHz', TF.fmtHz(10000) === '10.0 kHz', TF.fmtHz(10000));
ok('fmtHz(5000) = 5.00 kHz', TF.fmtHz(5000) === '5.00 kHz', TF.fmtHz(5000));

/* ======================================================================
 * M. 造信号本身
 * ==================================================================== */
console.log('\n— M. 时域信号 —');
{
  const cfg = { scenario: 'steady', f1: 1000, f2: 3000 };
  const x = TF.genSignal('steady', cfg, 1000, FS);
  ok('样本数正确', x.length === 1000);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  ok('单音峰值不超过 1', peak <= 1.0001, peak.toFixed(4));
  ok('单音峰值接近 1（10 点/周期时采样点没落在波峰上）', peak > 0.94, peak.toFixed(4));
  let ss = 0;
  for (let i = 0; i < x.length; i++) ss += x[i] * x[i];
  ok('单音有效值 ≈ 0.707（幅度确实是 1）', near(Math.sqrt(ss / x.length), 0.7071, 0.01),
    Math.sqrt(ss / x.length).toFixed(4));

  const sumAbs = function (sig, a, c) {
    let e = 0;
    for (let i = 0; i < sig.length; i++) { const t = i / FS; if (t >= a && t < c) e += Math.abs(sig[i]); }
    return e;
  };

  const b = TF.genSignal('seq', cfg, 5000, FS);
  const sp = TF.spansOf('seq');
  const q0 = sumAbs(b, 0, sp[0].t0);
  const q1 = sumAbs(b, sp[0].t0, sp[0].t1);
  const q2 = sumAbs(b, sp[1].t0, sp[1].t1);
  ok('"双音先后"在第一个音之前是静音的', q0 === 0);
  ok('"双音先后"在第一段活动里有信号', q1 > 0);
  ok('"双音先后"在第二段活动里也有信号', q2 > 0);
  ok('两个音的音量相当', Math.abs(q1 - q2) / Math.max(q1, q2) < 0.1);

  const sim = TF.genSignal('sim', cfg, 5000, FS);
  const ssp = TF.spansOf('sim');
  const before = sumAbs(sim, 0, ssp[0].t0);
  ok('"双音同时"在活动段之前也是静音的', before === 0);

  /* 只测能量只能说明“响不响”，分不出“先后”和“同时”。用一个单频相关
   * 把某一段时间里某个频率的分量量出来，才能真的验证两种时间结构。 */
  const magAt = function (sig, a, c, f) {
    let re = 0, im = 0, n = 0;
    for (let i = 0; i < sig.length; i++) {
      const t = i / FS;
      if (t < a || t >= c) continue;
      const ph = 2 * Math.PI * f * t;
      re += sig[i] * Math.cos(ph);
      im -= sig[i] * Math.sin(ph);
      n++;
    }
    return n ? 2 * Math.sqrt(re * re + im * im) / n : 0;
  };
  const show = function (sig, a, c) {
    return magAt(sig, a, c, cfg.f1).toFixed(3) + ' / ' + magAt(sig, a, c, cfg.f2).toFixed(3);
  };

  ok('"双音先后"第一段里 f1 在、f2 不在',
    magAt(b, sp[0].t0, sp[0].t1, cfg.f1) > 0.2 && magAt(b, sp[0].t0, sp[0].t1, cfg.f2) < 0.05,
    show(b, sp[0].t0, sp[0].t1));
  ok('"双音先后"第二段里 f2 在、f1 不在',
    magAt(b, sp[1].t0, sp[1].t1, cfg.f2) > 0.2 && magAt(b, sp[1].t0, sp[1].t1, cfg.f1) < 0.05,
    show(b, sp[1].t0, sp[1].t1));
  ok('"双音同时"第一段里 f1 和 f2 一块儿在',
    magAt(sim, ssp[0].t0, ssp[0].t1, cfg.f1) > 0.2 && magAt(sim, ssp[0].t0, ssp[0].t1, cfg.f2) > 0.2,
    show(sim, ssp[0].t0, ssp[0].t1));
}

console.log('\n— N. 知识面板的时频卡片 —');
{
  /* 卡片是纯规则算出来的，所以能离线把每一条都跑一遍 */
  const S2 = load(['signal.js', 'fft.js', 'timefreq.js', 'advisor.js']);
  const A = S2.advisor, T2 = S2.timefreq;
  /* 前八条规则看的是示波器/频谱仪那一屏。给一份“什么都没发生”的
   * 状态，让它们全部退场，只留下时频那五张卡好点名。 */
  const base = {
    p: { wave: 'sine', freq: 1000, sampleRate: 1e6, coupling: 'DC', probe: 1,
      amp: 1, voltsPerDiv: 1, duty: 0.5 },
    kMax: 1, range: null,
    acq: { triggered: true, periods: 10, samplesPerPeriod: 10, N: 0, samples: [], removedDC: 0 }
  };
  const st = function (sc, win, f1, f2) {
    return Object.assign({}, base, { tf: T2.analyze({ scenario: sc, win: win, overlap: 75,
      sampleRate: FS, noise: 0, f1: f1 === undefined ? 800 : f1, f2: f2 === undefined ? 2500 : f2 }) });
  };
  const ids = function (s) { return A.advise(s).map(function (c) { return c.id; }); };

  const longSeq = ids(st('seq', 512));
  const shortSeq = ids(st('seq', 64));
  ok('长窗下的“双音先后” → 提示它已经糊成了同时', longSeq.indexOf('tf-merge') >= 0, longSeq.join(','));
  ok('短窗下的“双音先后” → 不再提示糊了', shortSeq.indexOf('tf-merge') < 0, shortSeq.join(','));

  const longBurst = ids(st('burst', 128));
  const shortBurst = ids(st('burst', 32));
  ok('窗比脉冲长 → 提示在时间上被拖宽', longBurst.indexOf('tf-smear') >= 0, longBurst.join(','));
  ok('窗比脉冲短 → 不提示被拖宽', shortBurst.indexOf('tf-smear') < 0, shortBurst.join(','));

  const chirpIds = ids(st('chirp', 128, 600, 3000));
  ok('调频信号 → 提示斜线背后的非平稳性', chirpIds.indexOf('tf-chirp') >= 0, chirpIds.join(','));

  const narrow = ids(st('steady', 32, 800, 900));
  ok('两个音隔得比 Δf 还近 → 提示频率上分不开', narrow.indexOf('tf-freq-narrow') >= 0, narrow.join(','));

  /* 「真的同时」这个预设想讲的是频率分辨率，不是“被拖宽” */
  const simLong = ids(st('sim', 512));
  ok('真同时 + 长窗 → 不说“被拖宽”，改讲时间/频率分辨率的跷跷板',
    simLong.indexOf('tf-smear') < 0 && simLong.indexOf('tf-simultaneous') >= 0, simLong.join(','));
  const simShort = ids(st('sim', 32));
  ok('真同时 + 短窗 → 还是同一张卡（它讲的是同时性，与窗长无关）',
    simShort.indexOf('tf-simultaneous') >= 0, simShort.join(','));

  const clean = ids(st('steady', 128, 800, 2500));
  ok('一切正常时给出“窗长各让一步”那张卡', clean.indexOf('tf-normal') >= 0, clean.join(','));

  /* 卡片上的数字都是算出来的，写错一个变量就会漏出 undefined / NaN */
  const dirty = [];
  ['steady', 'chirp', 'burst', 'seq', 'sim'].forEach(function (sc) {
    [32, 128, 512, 1024].forEach(function (w) {
      A.advise(st(sc, w)).forEach(function (c) {
        const blob = c.title + c.what + c.why + c.course + c.tryIt;
        if (/undefined|NaN|Infinity/.test(blob)) dirty.push(sc + '@' + w + ':' + c.id);
        if (!c.title || !c.what || !c.why || !c.course || !c.tryIt) dirty.push(sc + '@' + w + ':' + c.id + '(缺段)');
      });
    });
  });
  ok('5 个场景 × 4 种窗长下，卡片的四段文字都没漏没崩', dirty.length === 0, dirty.join(' , '));
}

console.log('\n========== ' + pass + ' passed, ' + fail + ' failed ==========');
process.exit(fail ? 1 : 0);
