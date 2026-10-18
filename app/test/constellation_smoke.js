/* ==========================================================================
 * constellation_smoke.js — 星座图的冒烟测试
 *
 * 只验证调制、加噪、判决、误码这几步算得对不对，不碰 DOM（画的部分在
 * Chrome 里人工看）。跑法：
 *   node test/constellation_smoke.js
 *
 * 这里有一条贯穿全篇的原则：凡是教科书上有闭式答案的（点距、每符号能量、
 * 理论误符号率），都必须拿解析值对一遍，仿真跑出来跟它吻合，才说明
 * 实现没写错；只跟自己比是发现不了错的。
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
    Float64Array, Uint8Array, Int32Array, Set, RegExp, Date, Error
  };
  sandbox.window.SignalLab = {};
  vm.createContext(sandbox);
  for (const f of (files || ['signal.js', 'constellation.js'])) {
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
function head(s) { console.log('\n== ' + s + ' =='); }

const NS = load();
const CO = NS.constellation;

/* 独立实现一遍标准正态尾概率（Abramowitz & Stegun 7.1.26，误差 < 7.5e-8）。
   用它去对模块里的 serTheory，才叫"拿闭式答案对一遍"。 */
function Qstd(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
    + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? p : 1 - p;
}
function gammaOf(snrDb) { return Math.pow(10, snrDb / 10); }

/* 教科书闭式：M-PSK 与方阵 M-QAM 的理论误符号率 */
function serTheoryRef(mod, snrDb) {
  const M = 1 << mod.bits, g = gammaOf(snrDb);
  if (mod.kind === 'psk') {
    if (M === 2) return Qstd(Math.sqrt(2 * g));
    return 2 * Qstd(Math.sqrt(2 * g) * Math.sin(Math.PI / M));
  }
  const side = Math.sqrt(M);
  const p = 2 * (1 - 1 / side) * Qstd(Math.sqrt(3 * g / (M - 1)));
  return 1 - (1 - p) * (1 - p);
}

/* 解析点距：能量归一化成 Es = 1 之后的最近邻距离 */
const DMIN_EXACT = {
  bpsk: 2,                              // 两点在 ±1
  qpsk: Math.SQRT2,                     // 在单位圆上隔 90°
  psk8: 2 * Math.sin(Math.PI / 8),      // 单位圆上隔 45°
  qam16: 2 / Math.sqrt(10),             // 4×4，Es = 10
  qam64: 2 / Math.sqrt(42)              // 8×8，Es = 42
};

/* ---------------------------------------------------------------- A. 调制表 */
head('A. 调制表');
ok('五种调制', CO.MODS.length === 5);
ok('顺序是 bpsk/qpsk/psk8/qam16/qam64',
  CO.MODS.map((m) => m.id).join(',') === 'bpsk,qpsk,psk8,qam16,qam64');
for (const m of CO.MODS) {
  ok(m.name + ' 每符号比特数 = log2(M)',
    m.bits === Math.round(Math.log2(1 << m.bits)));
  ok(m.name + ' 有 note', typeof m.note === 'string' && m.note.length > 8);
  ok(m.name + ' 有中文名', /QAM|PSK/.test(m.name));
}
ok('modById 认得 qam64', CO.modById('qam64').name === '64QAM');
ok('modById 遇到野名字退回 QPSK', CO.modById('nope').id === 'qpsk');
ok('modById 遇到 undefined 也不炸', CO.modById(undefined).id === 'qpsk');

/* ------------------------------------------------------------ B. 点距与能量 */
head('B. 星座点的几何（拿解析值对）');
for (const m of CO.MODS) {
  const pts = CO.buildPoints(m);
  const M = 1 << m.bits;
  ok(m.name + ' 点数 = ' + M, pts.length === M);

  let e = 0;
  for (const p of pts) e += p[0] * p[0] + p[1] * p[1];
  e /= pts.length;
  ok(m.name + ' 每符号平均能量归一化成 1', near(e, 1, 1e-12), 'Es = ' + e);

  ok(m.name + ' 最小点距 = ' + DMIN_EXACT[m.id].toFixed(5),
    near(CO.minDist(pts), DMIN_EXACT[m.id], 1e-12),
    '实得 ' + CO.minDist(pts).toFixed(9));
}

/* PSK 都落在单位圆上；QAM 是方阵，坐标只取 ±1、±3… 这几个值 */
for (const id of ['bpsk', 'qpsk', 'psk8']) {
  const pts = CO.buildPoints(CO.modById(id));
  const worst = Math.max(...pts.map((p) => Math.abs(Math.hypot(p[0], p[1]) - 1)));
  ok(id + ' 所有点都在单位圆上（半径归一到 1）', worst < 1e-12, '最大偏差 ' + worst);
}
for (const [id, side] of [['qam16', 4], ['qam64', 8]]) {
  const pts = CO.buildPoints(CO.modById(id));
  const xs = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b);
  ok(id + ' 每一维只有 ' + side + ' 个坐标', xs.length === side);
  ok(id + ' 坐标等间距', near(xs[1] - xs[0], 2 / Math.sqrt(side === 4 ? 10 : 42), 1e-12));
  ok(id + ' 坐标关于原点对称', near(xs[0], -xs[xs.length - 1], 1e-12));
}
ok('BPSK 只有实轴两个点',
  CO.buildPoints(CO.modById('bpsk')).every((p) => Math.abs(p[1]) < 1e-15));

/* --------------------------------------------------------- C. 灰色码与比特 */
head('C. 格雷码映射');
for (const m of CO.MODS) {
  const M = 1 << m.bits;
  const seen = new Set();
  for (let i = 0; i < M; i++) {
    const b = CO.bitsOf(m, i);
    ok0(m.name + ' 第 ' + i + ' 点的比特数是 ' + m.bits, b.length === m.bits);
    seen.add(b.join(''));
  }
  ok(m.name + ' ' + M + ' 个点对应 ' + M + ' 种互不相同的比特', seen.size === M);
}
function ok0(name, cond) { if (!cond) ok(name, cond); }   // 内层循环用，成功不刷屏

for (const id of ['bpsk', 'qpsk', 'psk8']) {
  const m = CO.modById(id), M = 1 << m.bits;
  let worst = 0;
  for (let i = 0; i < M; i++) {
    const a = CO.bitsOf(m, i), b = CO.bitsOf(m, (i + 1) % M);
    let h = 0;
    for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) h++;
    worst = Math.max(worst, h);
  }
  ok(m.name + ' 相邻点只差 1 个比特（格雷码）', worst === 1, '最大差 ' + worst);
}
for (const [id, side] of [['qam16', 4], ['qam64', 8]]) {
  const m = CO.modById(id);
  let worst = 0;
  for (let row = 0; row < side; row++) {
    for (let c = 0; c + 1 < side; c++) {
      const a = CO.bitsOf(m, row * side + c), b = CO.bitsOf(m, row * side + c + 1);
      let h = 0;
      for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) h++;
      worst = Math.max(worst, h);
    }
  }
  ok(m.name + ' 同一行相邻点只差 1 个比特', worst === 1, '最大差 ' + worst);
}

/* ------------------------------------------------------------- D. 判决规则 */
head('D. 最近点判决');
for (const m of CO.MODS) {
  const pts = CO.buildPoints(m);
  let bad = 0;
  for (let i = 0; i < pts.length; i++) if (CO.decide(pts, pts[i][0], pts[i][1]) !== i) bad++;
  ok(m.name + ' 理想点判回自己', bad === 0, bad + ' 个判错');
}
{
  const pts = CO.buildPoints(CO.modById('bpsk'));   // 两个点，哪个编号在前不保证
  const iNeg = pts[0][0] < 0 ? 0 : 1, iPos = 1 - iNeg;
  ok('BPSK 两点关于原点对称', near(pts[0][0], -pts[1][0], 1e-15));
  ok('BPSK 原点左边判负轴上的那个点', CO.decide(pts, -0.01, 0) === iNeg);
  ok('BPSK 原点右边判正轴上的那个点', CO.decide(pts, 0.01, 0) === iPos);
  ok('BPSK 判决边界就是中垂线 x = 0',
    CO.decide(pts, -1e-9, 5) === iNeg && CO.decide(pts, 1e-9, 5) === iPos);
}
{
  const pts = CO.buildPoints(CO.modById('qpsk'));
  ok('QPSK 第一象限的点被判成同一个', (() => {
    const k = CO.decide(pts, 0.9, 0.9);
    for (const q of [[0.2, 0.3], [1.4, 0.05], [0.4, 1.1]]) {
      if (CO.decide(pts, q[0], q[1]) !== k) return false;
    }
    return true;
  })());
}

/* ---------------------------------------------------- E. 噪声强度与信噪比 */
head('E. σ 与 Es/N0 的换算');
for (const db of [0, 3, 6, 10, 20, 30]) {
  const g = gammaOf(db);
  ok('Es/N0 = ' + db + ' dB → γ = ' + g.toFixed(4),
    near(CO.sigmaOf(db), Math.sqrt(1 / (2 * g)), 1e-15));
}
ok('Es/N0 加 10 dB（功率 ×10），σ 除以 √10',
  near(CO.sigmaOf(10) / CO.sigmaOf(20), Math.sqrt(10), 1e-12));
ok('Es/N0 加 3 dB（功率近两倍），σ 约除以 √2',
  near(CO.sigmaOf(10) / CO.sigmaOf(13), Math.pow(10, 0.15), 1e-12));
ok('σ 随信噪比单调下降',
  CO.sigmaOf(0) > CO.sigmaOf(10) && CO.sigmaOf(10) > CO.sigmaOf(20));
/* 实测一下：加噪后每个坐标的样本标准差应当贴着 σ */
{
  const r = CO.analyze({ mod: 'qpsk', snrDb: 6, nSym: 40000, seed: 4242 });
  /* 去掉理想点本身，看残差 */
  let s2 = 0;
  for (let k = 0; k < r.nSym; k++) {
    const p = r.ideal[r.txIdx[k]];
    const di = r.rx[2 * k] - p[0], dq = r.rx[2 * k + 1] - p[1];
    s2 += di * di + dq * dq;
  }
  const rms = Math.sqrt(s2 / (2 * r.nSym));
  ok('实收点相对理想点的每维 RMS ≈ σ',
    Math.abs(rms - r.sigma) / r.sigma < 0.03,
    'rms ' + rms.toFixed(5) + ' vs σ ' + r.sigma.toFixed(5));
}

/* --------------------------------------------------------- F. 理论误符号率 */
head('F. 理论误符号率（拿自己独立实现的闭式对）');
for (const m of CO.MODS) {
  for (const db of [0, 5, 10, 15, 20]) {
    const a = CO.serTheory(m, db), b = serTheoryRef(m, db);
    ok(m.name + ' @ ' + db + ' dB 理论 SER 与教科书闭式一致',
      /* 参照式本身是 A&S 近似（误差 < 7.5e-8），概率很小时它的相对误差会上去，
         所以容差要含一个绝对项，不能只按相对误差卡 */
      Math.abs(a - b) <= 1.5e-7 + 2e-2 * b, '模块 ' + a + ' 参照 ' + b);
  }
}
ok('BPSK @ 10 dB 理论误符号率 ≈ 3.87e-6',
  Math.abs(CO.serTheory(CO.modById('bpsk'), 10) - 3.872e-6) < 1e-8,
  '' + CO.serTheory(CO.modById('bpsk'), 10));
ok('QPSK @ 10 dB 理论误符号率 ≈ 1.57e-3',
  Math.abs(CO.serTheory(CO.modById('qpsk'), 10) - 1.565e-3) < 1e-6);
for (const m of CO.MODS) {
  let mono = true;
  for (let db = 0; db <= 20; db += 2) if (CO.serTheory(m, db) < CO.serTheory(m, db + 2)) mono = false;
  ok(m.name + ' 理论误符号率随信噪比单调下降', mono);
}
/* 四条曲线的相对位置：同样的信噪比，阶数越高越吃力 */
{
  const db = 12;
  const v = CO.MODS.map((m) => CO.serTheory(m, db));
  ok('12 dB 下 理论 SER 按阶数递增（BPSK 最好、64QAM 最差）',
    v[0] < v[1] && v[1] < v[2] && v[2] < v[3] && v[3] < v[4],
    v.map((x) => x.toExponential(2)).join(' < '));
}
ok('Q 函数：Q(0) = 0.5（模块用 erf 近似，误差在 1e-8 量级）',
  near(CO.Q(0), 0.5, 1e-7));
ok('Q 函数：Q(-x) = 1 - Q(x)', near(CO.Q(-1.3), 1 - CO.Q(1.3), 1e-12));
ok('Q 函数：Q(1) ≈ 0.1587', near(CO.Q(1), 0.1586552539, 1e-6));

/* --------------------------------------------- G. 仿真 vs 理论（大样本） */
head('G. 仿真的 SER 落在理论上（每种调制各挑一个能看清的档位）');
/* 模块内部把符号数夹在 8…4000，这里从模块自己读上限，
   免得测试里写个大数、实际却只跑了 4000 个还拿 2 万去算期望 */
const NSYM = CO.analyze({ nSym: 1e9 }).nSym;
const CASES = [
  ['bpsk', 2], ['qpsk', 6], ['psk8', 10], ['qam16', 10], ['qam64', 10]
];
for (const [id, db] of CASES) {
  const m = CO.modById(id);
  const r = CO.analyze({ mod: id, snrDb: db, nSym: NSYM, seed: 20261016 });
  const theo = serTheoryRef(m, db);
  const rel = Math.abs(r.ser - theo) / theo;
  /* 用泊松涨落判据，而不是拍一个百分比：理论误符号率只有 0.5% 时，
     期望只出几十个错，涨落本来就有好几个 */
  const need = theo * r.nSym;
  const z = Math.abs(r.nSymErr - need) / Math.sqrt(need);
  ok(m.name + ' @ ' + db + ' dB 实测误符号数落在理论值的 4σ 内',
    z <= 4,
    '实测 ' + r.nSymErr + ' 期望 ' + need.toFixed(1) + '，偏 ' + z.toFixed(2) + 'σ');
  ok(m.name + ' @ ' + db + ' dB 仿真与理论同一量级',
    rel < 0.25,
    '仿真 ' + r.ser.toFixed(5) + ' 理论 ' + theo.toFixed(5)
    + ' 差 ' + (rel * 100).toFixed(1) + '%（' + r.nSym + ' 个符号）');
  ok(m.name + ' @ ' + db + ' dB 逐比特 BER 不超过逐符号 SER', r.ber <= r.ser + 1e-12);
  ok(m.name + ' @ ' + db + ' dB 误符号数 = 出错符号列表长度',
    r.nSymErr === r.wrong.length);
}
{
  /* 高信噪比下不该再有错 */
  const r = CO.analyze({ mod: 'qpsk', snrDb: 30, nSym: NSYM, seed: 1 });
  ok('QPSK @ 30 dB 一个符号都不错', r.nSymErr === 0 && r.ser === 0 && r.ber === 0);
  ok('QPSK @ 30 dB 理论值也是 0 量级', CO.serTheory(CO.modById('qpsk'), 30) < 1e-14);
}
{
  /* 低信噪比下应当烂到接近瞎猜 */
  const r = CO.analyze({ mod: 'qam64', snrDb: 0, nSym: NSYM, seed: 5 });
  ok('64QAM @ 0 dB 几乎全错', r.ser > 0.8, 'SER = ' + r.ser.toFixed(4));
  ok('64QAM @ 0 dB 但仍不是 100%（判决还是沾了点边）', r.ser < 1);
}
{
  /* 每个信噪比档都跑一遍：实测误符号数必须落在理论期望值的 4σ 里。
     用统计判据而不是固定百分比，理论值小的时候样本量本来就不够，
     固定百分比会把正常的统计涨落当成 bug。 */
  let worstZ = 0, worstAt = '', checked = 0;
  for (const m of CO.MODS) {
    for (const db of [4, 8, 12, 16, 20]) {
      const theo = serTheoryRef(m, db);
      const r = CO.analyze({ mod: m.id, snrDb: db, nSym: NSYM, seed: 700 + db });
      const need = theo * r.nSym;
      if (need < 30 || need > 0.98 * r.nSym) continue;  // 期望错误太少、或已经错到饱和的档位跳过
      const z = Math.abs(r.nSymErr - need) / Math.sqrt(need);
      checked++;
      if (z > worstZ) { worstZ = z; worstAt = m.name + '@' + db + 'dB'; }
    }
  }
  ok('整条瀑布曲线每一档都在 4σ 内（查了 ' + checked + ' 档）',
    checked >= 8 && worstZ <= 4,
    '最差 ' + worstAt + ' 偏 ' + worstZ.toFixed(2) + 'σ');
}

/* ---------------------------------------------------------- H. 结果的结构 */
head('H. analyze() 返回的结构');
{
  const r = CO.analyze({ mod: 'qam16', snrDb: 12, nSym: 500, seed: 99 });
  ok('mod / modName / kind 对得上',
    r.mod === 'qam16' && r.modName === '16QAM' && r.kind === 'qam');
  ok('bits = 4', r.bits === 4);
  ok('M = 16', r.M === 16);
  ok('rx 交错存了 2×nSym 个数', r.rx.length === 2 * r.nSym);
  ok('txIdx / rxIdx 长度 = nSym', r.txIdx.length === r.nSym && r.rxIdx.length === r.nSym);
  ok('ideal 就是 buildPoints 的结果',
    r.ideal.length === 16 && near(CO.minDist(r.ideal), DMIN_EXACT.qam16, 1e-12));
  ok('margin = d_min / (2σ)', near(r.margin, r.dmin / (2 * r.sigma), 1e-12));
  ok('判决域描述：QAM 是矩形、PSK 是角度',
    r.region === '矩形' && CO.analyze({ mod: 'qpsk' }).region === '角度');
  ok('seed 原样带回', r.seed === 99);
  ok('axis 容得下所有理想点',
    r.ideal.every((p) => Math.abs(p[0]) <= r.axis && Math.abs(p[1]) <= r.axis));
  ok('axis 也容得下收到的点',
    (() => {
      for (let k = 0; k < r.nSym; k++) {
        if (Math.abs(r.rx[2 * k]) > r.axis + 1e-12) return false;
        if (Math.abs(r.rx[2 * k + 1]) > r.axis + 1e-12) return false;
      }
      return true;
    })());
  ok('bitsOf 挂在了结果上，能取到第 3 点的比特',
    r.bitsOf(3).length === 4);
  /* 判错的定义：rxIdx 与 txIdx 不一致的个数就是 nSymErr */
  let n = 0;
  for (let k = 0; k < r.nSym; k++) if (r.rxIdx[k] !== r.txIdx[k]) n++;
  ok('nSymErr 等于逐符号比对出来的个数', n === r.nSymErr, n + ' vs ' + r.nSymErr);
  ok('BER 的分母是 总符号数 × 每符号比特',
    near(r.ber, r.nBitErr / (r.nSym * r.bits), 1e-15));
  ok('点数少的时候 d_min/(2σ) 更大（同信噪比下 BPSK 最稳）',
    CO.analyze({ mod: 'bpsk', snrDb: 12 }).margin
    > CO.analyze({ mod: 'qam64', snrDb: 12 }).margin);
}

/* ------------------------------------------------------- I. 确定性与种子 */
head('I. 确定性');
{
  const a = CO.analyze({ mod: 'psk8', snrDb: 9, nSym: 800, seed: 31415 });
  const b = CO.analyze({ mod: 'psk8', snrDb: 9, nSym: 800, seed: 31415 });
  ok('同一个种子跑两遍，收点完全一样', (() => {
    for (let i = 0; i < a.rx.length; i++) if (a.rx[i] !== b.rx[i]) return false;
    return true;
  })());
  ok('同一个种子跑两遍，误符号数一样', a.nSymErr === b.nSymErr);
  const c = CO.analyze({ mod: 'psk8', snrDb: 9, nSym: 800, seed: 31416 });
  ok('换个种子，收点就不一样了', (() => {
    for (let i = 0; i < a.rx.length; i++) if (a.rx[i] !== c.rx[i]) return true;
    return false;
  })());
}
{
  /* 默认参数：不传 cfg 也不该炸 */
  const d = CO.analyze();
  ok('analyze() 不传参数也能跑（默认 QPSK / 14 dB / 400 符号）',
    d.mod === 'qpsk' && d.snrDb === 14 && d.nSym === 400);
  const e = CO.analyze({});
  ok('analyze({}) 与不传等价', e.nSym === 400 && e.mod === 'qpsk');
  const f = CO.analyze({ mod: 'bogus', snrDb: 8 });
  ok('野名字回退成 QPSK 而不是抛异常', f.mod === 'qpsk');
}

/* ---------------------------------------------------------------- J. 边界 */
head('J. 边界条件');
ok('符号数下限被夹到 8', CO.analyze({ nSym: 1 }).nSym === 8);
ok('符号数上限被夹到 4000', CO.analyze({ nSym: 1e9 }).nSym === 4000);
ok('符号数取整', CO.analyze({ nSym: 123.7 }).nSym === 124);
ok('nSym = 0 被夹到 8', CO.analyze({ nSym: 0 }).nSym === 8);
ok('nSym 是 NaN 也能兜住（回落到默认 400）', CO.analyze({ nSym: NaN }).nSym === 400);
ok('snrDb 是 NaN 也能兜住', CO.analyze({ snrDb: NaN }).snrDb === 14);
ok('seed 是 NaN 也能兜住', CO.analyze({ seed: NaN }).seed === 20261016);
ok('入参全不合法时仍然给出一份完整结果', (() => {
  const r = CO.analyze({ mod: null, snrDb: NaN, nSym: NaN, seed: NaN });
  return r.nSym === 400 && r.mod === 'qpsk' && isFinite(r.ser) && isFinite(r.margin);
})());
ok('0 dB 不炸', CO.analyze({ snrDb: 0 }).sigma > 0.5);
ok('30 dB 不炸', CO.analyze({ snrDb: 30 }).margin > 10);
ok('只发 8 个符号也不会出错', CO.analyze({ nSym: 8, seed: 3 }).rx.length === 16);
ok('serTheory 在 0 dB 时对 BPSK 也不算太糟',
  CO.serTheory(CO.modById('bpsk'), 0) < 0.1);

/* --------------------------------------------------------------- K. sweep */
head('K. sweep：一条瀑布曲线');
{
  const sw = CO.sweep('qam16', [4, 8, 12, 16, 20], 3000, 500);
  ok('返回 5 个点', sw.length === 5);
  ok('每点带 snrDb / ser / ber / serTheory',
    sw.every((p) => typeof p.snrDb === 'number' && typeof p.ser === 'number'
      && typeof p.ber === 'number' && typeof p.serTheory === 'number'));
  ok('信噪比按给的顺序排', sw.map((p) => p.snrDb).join(',') === '4,8,12,16,20');
  let mono = true;
  for (let i = 0; i + 1 < sw.length; i++) if (sw[i].ser < sw[i + 1].ser) mono = false;
  ok('仿真 SER 随信噪比单调不增', mono, sw.map((p) => p.ser.toFixed(4)).join(' → '));
  ok('每个点都换了种子（不然曲线会有假的台阶）',
    sw[0].ser !== sw[1].ser || sw[1].ser !== sw[2].ser);
  const sw2 = CO.sweep('qam16', [4, 8, 12, 16, 20], 3000, 500);
  ok('同样的入参跑两遍结果一致',
    sw.map((p) => p.ser).join(',') === sw2.map((p) => p.ser).join(','));
}

/* ----------------------------------------------------------- L. 数字格式化 */
head('L. 格式化');
ok("fmtPct(0) = '0'", CO.fmtPct(0) === '0');
ok("fmtPct(0.5) = '50.0%'", CO.fmtPct(0.5) === '50.0%');
ok("fmtPct(0.0123) = '1.23%'", CO.fmtPct(0.0123) === '1.23%');
ok("fmtPct(0.005) = '0.50%'", CO.fmtPct(0.005) === '0.50%');
ok("fmtPct(1.23e-5) = '0.0012%'", CO.fmtPct(1.23e-5) === '0.0012%');
ok("fmtPct(5.39e-7) = '0.000054%'（超小值不吐 12 位小数）", CO.fmtPct(5.39e-7) === '0.000054%');
ok("fmtPct(1e-9) 不写成科学计数法", !/e/i.test(CO.fmtPct(1e-9)), CO.fmtPct(1e-9));
ok('fmtPct 对负数/NaN 也不吐 NaN', CO.fmtPct(NaN) === '0' && CO.fmtPct(-1) === '0');
ok("fmt2(3.14159) = '3.14'", CO.fmt2(3.14159) === '3.14');
ok("fmt2(2) = '2.00'", CO.fmt2(2) === '2.00');

/* --------------------------------------------------------- M. 画布上的读数 */
head('M. 画之前的自检（给知识面板和 AI 提示词用的量）');
for (const m of CO.MODS) {
  const r = CO.analyze({ mod: m.id, snrDb: 14, nSym: 400, seed: 7 });
  ok(m.name + ' 的 margin 是有限的', isFinite(r.margin) && r.margin > 0);
  ok(m.name + ' 的 sigma 是有限的', isFinite(r.sigma) && r.sigma > 0);
  ok(m.name + ' 的 dmin 与解析值一致',
    near(r.dmin, DMIN_EXACT[m.id], 1e-12));
}
{
  /* 同一个信噪比下，阶数越高 margin 越小，这就是整个实验台想讲的那句话 */
  const ms = CO.MODS.map((m) => CO.analyze({ mod: m.id, snrDb: 14 }).margin);
  ok('14 dB 下 margin 按阶数递减', ms.every((v, i) => i === 0 || v < ms[i - 1]),
    ms.map((v) => v.toFixed(2)).join(' > '));
}
{
  /* 查一遍：知识面板和 AI 提示词会读到的每个字段都不能是 NaN/undefined */
  let dirty = '';
  for (const m of CO.MODS) {
    for (const db of [0, 4, 8, 12, 16, 20, 25, 30]) {
      const r = CO.analyze({ mod: m.id, snrDb: db, nSym: 400, seed: 11 });
      for (const k of ['modName', 'kind', 'bits', 'M', 'snrDb', 'sigma', 'dmin',
        'margin', 'nSym', 'ser', 'ber', 'serTheory', 'region', 'axis']) {
        const v = r[k];
        if (v === undefined || (typeof v === 'number' && !isFinite(v))) {
          dirty += m.id + '@' + db + '.' + k + ' ';
        }
      }
      if (/undefined|NaN|Infinity/.test(CO.fmtPct(r.ser) + CO.fmtPct(r.ber))) {
        dirty += m.id + '@' + db + '.fmt ';
      }
    }
  }
  ok('5 种调制 × 8 个信噪比 下所有对外字段都干净', dirty === '', dirty);
}

/* ------------------------------------------------- N. 知识面板与 AI 提示词 */
head('N. 知识面板与 AI 提示词');
{
  const S2 = load(['signal.js', 'fft.js', 'spectrum.js', 'array.js',
    'timefreq.js', 'constellation.js', 'advisor.js', 'llm.js']);
  const A = S2.advisor, C2 = S2.constellation, LL = S2.llm;

  /* 造一份「别的屏什么都没发生」的基础状态：规则表里星座那几张前面还有
     示波器、频谱仪、阵列、时频的卡，它们会直接读 acq / p 上的字段，
     缺一个就当场抛异常。这份 base 让前面那些卡全部退场。 */
  const base = (con) => ({
    p: { wave: 'sine', freq: 1000, sampleRate: 1e6, coupling: 'DC', probe: 1,
      amp: 1, voltsPerDiv: 1, duty: 0.5, offset: 0, phase: 0, noise: 0, bandwidth: 1,
      timePerDiv: 1e-3, triggerLevel: 0 },
    kMax: 1, range: null,
    acq: { triggered: true, periods: 10, samplesPerPeriod: 10, N: 0, samples: [], removedDC: 0 },
    con: con
  });
  const cardsOf = (con) => A.advise(base(con));

  const ids = ['bpsk', 'qpsk', 'psk8', 'qam16', 'qam64'];
  let tooMany = 0, badPair = '', dirty = '', incomplete = '', extra = '';
  const seen = {};
  for (const id of ids) {
    for (let db = 0; db <= 30; db += 0.5) {
      const r = C2.analyze({ mod: id, snrDb: db, nSym: 400, seed: 11 });
      const con = cardsOf(r).filter((c) => c.key === 'con');
      if (con.length < 1 || con.length > 2) tooMany++;
      /* 高阶调制最多同报两张：前面一张是“已经在判错”或“噪声圆快碰边界”，
         后面跟一张“点太挤”的机理卡。其它任何组合都是错的 */
      if (con.length === 2
        && !(con[1].id === 'con-tradeoff' && /^con-(errors|crowded)$/.test(con[0].id))) {
        badPair += id + '@' + db + '=' + con.map((c) => c.id).join('+') + ' ';
      }
      for (const c of con) {
        seen[c.id] = true;
        const blob = [c.title, c.what, c.why, c.course, c.tryIt].join(' ');
        if (/undefined|NaN|Infinity/.test(blob)) dirty += c.id + '@' + id + db + ' ';
        if (!c.title || !c.what || !c.why || !c.course || !c.tryIt) incomplete += c.id + ' ';
      }
      for (const c of cardsOf(r)) {
        if (c.key === 'con') continue;
        if (/undefined|NaN|Infinity/.test([c.title, c.what, c.why, c.course, c.tryIt].join(' '))) {
          extra += c.id + '@' + id + db + ' ';
          break;
        }
      }
    }
  }
  ok('每档信噪比弹 1～2 张星座卡，不会刷屏',
    tooMany === 0 && badPair === '', tooMany + ' 档张数不对；' + badPair);
  ok('四张卡都会在某个档位出现',
    Object.keys(seen).sort().join(',') === 'con-crowded,con-errors,con-normal,con-tradeoff',
    Object.keys(seen).join(','));
  ok('任何调制 × 任何信噪比下，星座卡文字都不含 undefined/NaN/Infinity',
    dirty === '', dirty);
  ok('每张卡四段齐全（现在看到的 / 为什么 / 哪门课 / 再试试）', incomplete === '', incomplete);
  ok('星座卡不会把别的屏的卡弄脏', extra === '', extra);

  /* 分界线应当随阶数整体右移，这就是「要多少 dB 才够」的定量答案 */
  const firstClean = {};
  for (const id of ids) {
    for (let db = 0; db <= 30; db += 0.5) {
      const r = C2.analyze({ mod: id, snrDb: db, nSym: 400, seed: 11 });
      const c = cardsOf(r).filter((x) => x.key === 'con')[0];
      if (c.id === 'con-normal' || c.id === 'con-tradeoff') { firstClean[id] = db; break; }
    }
  }
  ok('阶数越高，要信噪比多高才不再告警',
    firstClean.bpsk < firstClean.qpsk && firstClean.qpsk < firstClean.psk8
    && firstClean.psk8 < firstClean.qam16 && firstClean.qam16 < firstClean.qam64,
    ids.map((i) => i + '≥' + firstClean[i] + 'dB').join('  '));

  /* 面板的排序：具体问题必须排在默认卡前面 */
  const rErr = C2.analyze({ mod: 'qam64', snrDb: 10, nSym: 400, seed: 3 });
  const list = cardsOf(rErr);
  ok('已经在判错时，告警卡排在面板最前面', list[0].id === 'con-errors',
    list.map((c) => c.id).join(' > '));
  ok('卡片按 priority 升序',
    list.every((c, i) => i === 0 || c.priority >= list[i - 1].priority));

  /* AI 提示词：星座那一段必须在，而且不能带 NaN */
  ok('llm 模块导出了 brief', typeof LL.brief === 'function');
  const briefOf = (r) => LL.brief({
    p: base(r).p, acq: base(r).acq, kMax: 1, range: null,
    con: r, cards: cardsOf(r), history: []
  });
  const text = briefOf(rErr);
  ok('提示词里有【星座】段', text.indexOf('【星座】') >= 0);
  ok('提示词里有实测的误符号率', text.indexOf('【星座实测】') >= 0);
  ok('提示词里有 d_min/(2σ) 这个判据', text.indexOf('d_min/(2σ)') >= 0);
  /* 只看【星座】那几行：其它仪器的字段要 main.js 里那份完整的 context
     才凑得齐，这里是模块级测试，不替它们背锅 */
  const conLines = text.split('\n').filter((s) => s.indexOf('【星座') === 0).join('\n');
  ok('【星座】那几行里没有 NaN / undefined / Infinity',
    conLines.length > 60 && !/NaN|undefined|Infinity/.test(conLines),
    (conLines.match(/.{0,40}(NaN|undefined|Infinity).{0,40}/) || [''])[0]);
  ok('信噪比低时提示词会点出「噪声圆快蹭到判决边界」', (() => {
    const r2 = C2.analyze({ mod: 'psk8', snrDb: 13, nSym: 400, seed: 4 });
    return briefOf(r2).indexOf('噪声圆快蹭到判决边界') >= 0;
  })());
  ok('信噪比很高时提示词不再提判决裕量告警', (() => {
    const r2 = C2.analyze({ mod: 'bpsk', snrDb: 25, nSym: 400, seed: 6 });
    return briefOf(r2).indexOf('噪声圆快蹭到判决边界') < 0;
  })());
}

console.log('\n========== ' + pass + ' passed, ' + fail + ' failed ==========');
process.exit(fail ? 1 : 0);
