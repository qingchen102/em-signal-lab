/* ==========================================================================
 * sandbox_smoke.js — 多径沙盒的冒烟测试
 *
 * 只验证几何光学与多径信道算得对不对，不碰 DOM（画的部分在 Chrome 里人工看）。
 * 跑法：
 *   node test/sandbox_smoke.js
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
    Float64Array, Uint8Array, Int32Array, Set, Map
  };
  sandbox.window.SignalLab = {};
  vm.createContext(sandbox);
  for (const f of (files || ['signal.js', 'fft.js', 'spectrum.js', 'array.js', 'sandbox.js'])) {
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
const SB = NS.sandbox;
const AR = NS.array;

const C_LIGHT = 299792458;

/* 跑一遍沙盒，参数可以覆盖 */
function an(id, o) {
  const sc = SB.scenById(id);
  return SB.analyze(Object.assign({
    scene: sc, buildings: sc.buildings, tx: sc.tx, rx: sc.rx,
    maxOrder: 2, freqHz: 2400e6, arrayM: 8
  }, o || {}));
}

/* 找出某个点落在哪条墙段上 */
function wallOfPoint(res, P) {
  for (let i = 0; i < res.walls.length; i++) {
    const w = res.walls[i];
    const dx = w.c.x - w.a.x, dy = w.c.y - w.a.y;
    const L2 = dx * dx + dy * dy;
    if (!(L2 > 0)) continue;
    const t = ((P.x - w.a.x) * dx + (P.y - w.a.y) * dy) / L2;
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const px = w.a.x + t * dx, py = w.a.y + t * dy;
    if (Math.hypot(px - P.x, py - P.y) < 1e-6) return w;
  }
  return null;
}

/* 把沙盒给的路径表喂给阵列（和 main.js 里一模一样的做法） */
function feedArray(res, M) {
  if (!res.arrPaths.length) return null;
  const g0 = res.arrPaths[0].gain || 1;
  return AR.simulate({
    M: M || 8, spacing: 0.5, snrDb: 20, snapshots: 400, sources: 1, seed: 7,
    paths: res.arrPaths.map((q) => ({ angle: q.angle, gain: q.gain / g0, phase: q.phase }))
  });
}

console.log('\n=== A. 几何原语 ===');
{
  // 关于竖直线 x = 100 做镜像
  const I = SB.reflectPoint({ x: 0, y: 0 }, { x: 100, y: -50 }, { x: 100, y: 50 });
  ok('点关于墙的镜像', near(I.x, 200, 1e-9) && near(I.y, 0, 1e-9),
    '(' + I.x + ', ' + I.y + ')');

  const H = SB.lineHit({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 });
  ok('两直线交于中点', near(H.x, 50, 1e-9) && near(H.y, 50, 1e-9));
  ok('交点的两个参数都在 0～1', H.t > 0 && H.t < 1 && H.u > 0 && H.u < 1);

  const miss = SB.lineHit({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 });
  ok('平行线不相交（给 null）', miss === null, JSON.stringify(miss));

  // 到达角：e = (1,0)，法线朝 +y
  ok('正前方（+y）来波 = 0°', near(SB.angleOf({ x: 0, y: 1 }), 0, 1e-12));
  ok('右手边（+x）来波是负角', near(SB.angleOf({ x: 1, y: 0 }), -90, 1e-12));
  ok('左手边（−x）来波是正角', near(SB.angleOf({ x: -1, y: 0 }), 90, 1e-12));
  ok('斜 30° 来波', near(SB.angleOf({ x: Math.sin(Math.PI / 6), y: Math.cos(Math.PI / 6) }), -30, 1e-9));

  // 菲涅尔：法向入射与掠入射
  const g0 = SB.fresnelPerp(1, 5.5);
  ok('法向入射 Γ ≈ −0.402（混凝土 εr=5.5）', near(g0, (1 - Math.sqrt(5.5)) / (1 + Math.sqrt(5.5)), 1e-12),
    g0.toFixed(5));
  ok('Γ 是负的，反射带相位翻转', g0 < 0);
  ok('掠入射 Γ → −1（全反射）', SB.fresnelPerp(1e-6, 5.5) < -0.99);
  ok('法向入射的反射最弱', Math.abs(g0) < Math.abs(SB.fresnelPerp(0.3, 5.5)));
}

console.log('\n=== B. 场景表 ===');
{
  const ids = ['open', 'canyon', 'corner', 'dense'];
  ok('四个场景都在', ids.every((id) => SB.scenById(id) && SB.scenById(id).id === id));
  ok('未知场景回落到第一个', SB.scenById('nope').id === 'open');
  ok('地图是 600×400 米', SB.MAP_W === 600 && SB.MAP_H === 400);
  ok('光速常数', SB.C_LIGHT === 299792458 || near(SB.C_LIGHT, C_LIGHT, 1));

  let cloned = 0;
  ids.forEach((id) => {
    const a = SB.scenById(id), b = SB.cloneScene(a);
    if (a !== b && b.tx !== a.tx && b.buildings !== a.buildings) cloned++;
  });
  ok('cloneScene 是深拷贝', cloned === 4);

  const a = SB.scenById('canyon');
  const b = SB.cloneScene(a);
  b.tx.x = -999; b.buildings[0].x = -999;
  ok('改副本不动原场景', a.tx.x !== -999 && a.buildings[0].x !== -999);
}

console.log('\n=== C. 开阔地：只有一条直达 ===');
{
  const r = an('open');
  ok('只有 1 条路径', r.nPaths === 1, 'nPaths=' + r.nPaths);
  ok('那一条就是直达', r.nLos === 1 && r.nOrder1 === 0 && r.nOrder2 === 0);
  ok('直线通着', r.losBlocked === false);
  ok('来波方向 0°', near(r.angles[0], 0, 1e-9));
  ok('路径长度 = 收发距离', near(r.paths[0].len, 280, 1e-6), 'len=' + r.paths[0].len);
  ok('时延 = 路长 / c', near(r.paths[0].tau, 280 / C_LIGHT, 1e-15));
  ok('没有时延扩展', r.spreadRms === 0);
  ok('相干带宽是无限（只有一条路）', r.coherenceBw === Infinity);
  ok('不挑频率', r.freqSelective === false);
  ok('直达的幅度是正的（无反射，Γ=1）', r.paths[0].amp > 0);
  ok('最强路径就是那条直达', r.strongest === r.paths[0]);
  ok('自由空间损耗约 −89 dB（280 m @ 2.4 GHz）', near(r.paths[0].gainDb, -89.0, 0.5),
    r.paths[0].gainDb.toFixed(2));
}

console.log('\n=== D. 城市峡谷：一台发射机，五条来波 ===');
{
  const r = an('canyon');
  ok('共 5 条路径', r.nPaths === 5, 'nPaths=' + r.nPaths);
  ok('直达 1 条', r.nLos === 1);
  ok('一次反射 2 条', r.nOrder1 === 2, 'nOrder1=' + r.nOrder1);
  ok('两次反射 2 条', r.nOrder2 === 2, 'nOrder2=' + r.nOrder2);
  ok('直线通着', r.losBlocked === false);

  const ang = r.angles.slice().sort((a, b) => a - b);
  const want = [-48.8, -29.7, 0, 29.7, 48.8];
  ok('五个方向左右对称', ang.every((v, i) => near(v, want[i], 0.6)),
    ang.map((v) => v.toFixed(1)).join(' / '));

  const los = r.paths.filter((p) => p.order === 0)[0];
  const refl = r.paths.filter((p) => p.order > 0);
  ok('直达幅度为正', los.amp > 0);
  ok('一次反射的幅度是负的（菲涅尔 Γ<0，相位翻转）',
    r.paths.filter((p) => p.order === 1).every((p) => p.amp < 0));
  ok('弹两次翻了两次，回到正号',
    r.paths.filter((p) => p.order === 2).every((p) => p.amp > 0));
  ok('反射都比直达弱', refl.every((p) => Math.abs(p.amp) < Math.abs(los.amp)));
  ok('二次反射比一次反射弱',
    Math.max.apply(null, r.paths.filter((p) => p.order === 2).map((p) => Math.abs(p.amp)))
    < Math.max.apply(null, r.paths.filter((p) => p.order === 1).map((p) => Math.abs(p.amp))));
  ok('最强路径是直达', r.strongest === los);

  ok('最晚到达比最早晚了几百 ns', r.lastArrival > 3e-7 && r.lastArrival < 1e-6,
    (r.lastArrival * 1e9).toFixed(1) + ' ns');
  ok('时延扩展 σ > 0', r.spreadRms > 0, (r.spreadRms * 1e9).toFixed(1) + ' ns');
  ok('相干带宽是有限的', isFinite(r.coherenceBw) && r.coherenceBw > 0,
    (r.coherenceBw / 1e6).toFixed(2) + ' MHz');
  ok('相干带宽 = 1/(5σ)', near(r.coherenceBw, 1 / (5 * r.spreadRms), 1e-6));

  const back = SB.scenById('canyon');
  const r2 = SB.analyze({
    scene: back, buildings: back.buildings, tx: back.tx, rx: back.rx,
    maxOrder: 2, freqHz: 2400e6, arrayM: 8
  });
  ok('同样的输入给同样的结果',
    JSON.stringify(r.paths.map((p) => [p.kind, p.angle, p.len]))
    === JSON.stringify(r2.paths.map((p) => [p.kind, p.angle, p.len])));
}

console.log('\n=== E. 街角：直线被挡死，报出来的是墙的方向 ===');
{
  const r = an('corner');
  ok('直线被挡住', r.losBlocked === true);
  ok('一条直达都没有', r.nLos === 0);
  ok('只剩 1 条一次反射', r.nPaths === 1 && r.nOrder1 === 1, 'nPaths=' + r.nPaths);
  ok('来波方向约 43°', near(r.strongest.angle, 43.0, 0.5), r.strongest.angle.toFixed(2));

  // 发射机在阵列的正前方（同一列，y 更大）→ 真实方位 0°
  const dx = r.tx.x - r.rx.x, dy = r.tx.y - r.rx.y;
  const bear = -Math.asin(dx / Math.hypot(dx, dy)) * 180 / Math.PI;
  ok('发射机真实方位是 0°（正前方）', near(bear, 0, 1e-9), bear.toFixed(3));
  ok('报出来的方向差了 40° 以上', Math.abs(r.strongest.angle - bear) > 40,
    Math.abs(r.strongest.angle - bear).toFixed(1) + '°');

  ok('只有一条路 → 没有时延扩展', r.spreadRms === 0 && r.coherenceBw === Infinity);
  ok('绕路比直线长', r.strongest.len > Math.hypot(dx, dy),
    r.strongest.len.toFixed(1) + ' m vs ' + Math.hypot(dx, dy).toFixed(1) + ' m');
  ok('反射点落在墙上', !!wallOfPoint(r, r.strongest.pts[1]));
  ok('直线确实穿过那栋楼（楼自己挡的）', SB.segBlocked(r.tx, r.rx, r.buildings) === true);
  ok('绕行路径的两条腿都不穿楼',
    SB.segBlocked(r.tx, r.paths[0].pts[1], r.buildings) === false &&
    SB.segBlocked(r.paths[0].pts[1], r.rx, r.buildings) === false);
}

console.log('\n=== F. 密集楼群 ===');
{
  const r = an('dense');
  ok('至少 3 条路径', r.nPaths >= 3, 'nPaths=' + r.nPaths);
  ok('有直达', r.nLos >= 1);
  ok('有反射', r.nOrder1 + r.nOrder2 >= 1);
  const spread = new Set(r.angles.map((v) => v.toFixed(1)));
  ok('方向不止一个', spread.size >= 2, r.angles.map((v) => v.toFixed(1)).join(' / '));
}

console.log('\n=== G. 反射阶数开关 ===');
{
  const r0 = an('canyon', { maxOrder: 0 });
  ok('只算直达时只剩 1 条', r0.nPaths === 1 && r0.nLos === 1, 'nPaths=' + r0.nPaths);
  ok('只算直达时没有时延扩展', r0.spreadRms === 0);

  const r1 = an('canyon', { maxOrder: 1 });
  ok('一次反射时 3 条', r1.nPaths === 3 && r1.nOrder2 === 0, 'nPaths=' + r1.nPaths);

  const c0 = an('corner', { maxOrder: 0 });
  ok('街角把直达关掉就一条都不剩', c0.nPaths === 0, 'nPaths=' + c0.nPaths);
  ok('没有路径时 strongest 是 null', c0.strongest === null);
  ok('没有路径时不崩（arrPaths 为空）', Array.isArray(c0.arrPaths) && c0.arrPaths.length === 0);
}

console.log('\n=== H. 物理自检 ===');
{
  const sc = SB.scenById('open');
  const far = SB.analyze({ scene: sc, buildings: [], tx: { x: 300, y: 340 }, rx: { x: 300, y: 60 }, maxOrder: 0, freqHz: 2400e6, arrayM: 8 });
  const near_ = SB.analyze({ scene: sc, buildings: [], tx: { x: 300, y: 340 }, rx: { x: 300, y: 200 }, maxOrder: 0, freqHz: 2400e6, arrayM: 8 });
  ok('距离减半，幅度翻倍（自由空间 1/L）',
    near(near_.paths[0].amp / far.paths[0].amp, 2, 0.02),
    (near_.paths[0].amp / far.paths[0].amp).toFixed(4));
  ok('距离减半，dB 只差 6 dB',
    near(far.paths[0].gainDb - near_.paths[0].gainDb, -6.02, 0.05),
    (far.paths[0].gainDb - near_.paths[0].gainDb).toFixed(2) + ' dB');

  const fc = SB.analyze({ scene: sc, buildings: [], tx: { x: 300, y: 340 }, rx: { x: 300, y: 60 }, maxOrder: 0, freqHz: 1200e6, arrayM: 8 });
  ok('频率降一半，损耗少 6 dB',
    near(fc.paths[0].gainDb - far.paths[0].gainDb, 6.02, 0.05),
    (fc.paths[0].gainDb - far.paths[0].gainDb).toFixed(2) + ' dB');

  // 到达角映射：把发射机横向挪一挪
  const right = SB.analyze({ scene: sc, buildings: [], tx: { x: 300 + 100, y: 60 + 100 }, rx: { x: 300, y: 60 }, maxOrder: 0, freqHz: 2400e6, arrayM: 8 });
  const left = SB.analyze({ scene: sc, buildings: [], tx: { x: 300 - 100, y: 60 + 100 }, rx: { x: 300, y: 60 }, maxOrder: 0, freqHz: 2400e6, arrayM: 8 });
  ok('发射机在右手边 → 到达角是负的', right.angles[0] < -1, right.angles[0].toFixed(2));
  ok('发射机在左手边 → 到达角是正的', left.angles[0] > 1, left.angles[0].toFixed(2));
  ok('到达角 = −asin(横向分量)', near(right.angles[0], -45, 1e-6), right.angles[0].toFixed(4));
  ok('左右对称', near(left.angles[0], -right.angles[0], 1e-9));

  // 入射角 = 反射角
  const c = an('canyon');
  let checked = 0, worst = 0;
  c.paths.filter((p) => p.order === 1).forEach((p) => {
    const P = p.pts[1], w = wallOfPoint(c, P);
    if (!w) return;
    const nL = Math.hypot(-w.dy, w.dx);
    const n = { x: -w.dy / nL, y: w.dx / nL };
    const uin = { x: P.x - c.tx.x, y: P.y - c.tx.y };
    const uout = { x: c.rx.x - P.x, y: c.rx.y - P.y };
    const ci = Math.abs((uin.x * n.x + uin.y * n.y) / Math.hypot(uin.x, uin.y));
    const co = Math.abs((uout.x * n.x + uout.y * n.y) / Math.hypot(uout.x, uout.y));
    worst = Math.max(worst, Math.abs(ci - co));
    checked++;
  });
  ok('一次反射的入射角 = 反射角', checked === 2 && worst < 1e-9, 'checked=' + checked + ' 误差=' + worst);

  // 镜面：反射点必须落在「发射机的镜像」与接收机的连线上
  const one = c.paths.filter((p) => p.order === 1)[0];
  const P = one.pts[1], w = wallOfPoint(c, P);
  const I = SB.reflectPoint(c.tx, w.a, w.c);
  const cross = (c.rx.x - I.x) * (P.y - I.y) - (c.rx.y - I.y) * (P.x - I.x);
  ok('镜像法：镜像点、反射点、接收机共线', Math.abs(cross) < 1e-3, cross.toExponential(2));
  ok('反射点到发射机的距离 = 反射点到镜像点的距离',
    near(Math.hypot(P.x - c.tx.x, P.y - c.tx.y), Math.hypot(P.x - I.x, P.y - I.y), 1e-9));

  // 路径长度 = 各段之和
  ok('路径长度等于各段之和', near(one.len, one.pts.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - one.pts[i].x, q.y - one.pts[i].y), 0), 1e-9));

  // 遮挡：把发射机拖到楼里面，直线必被挡
  const inside = SB.analyze({
    scene: SB.scenById('canyon'), buildings: SB.scenById('canyon').buildings,
    tx: { x: 150, y: 120 }, rx: { x: 540, y: 210 }, maxOrder: 0, freqHz: 2400e6, arrayM: 8
  });
  ok('发射机在楼里时直线被挡', inside.losBlocked === true);
}

console.log('\n=== I. 喂给阵列的路径表 ===');
{
  const o = an('open');
  ok('开阔地只有一条来波给阵列', o.arrPaths.length === 1);
  ok('幅度是正数（阵列权重没有符号）', o.arrPaths.every((p) => p.gain > 0));
  ok('开阔地的来波方向 0°', near(o.arrPaths[0].angle, 0, 1e-9));

  const oa = feedArray(o);
  ok('开阔地的谱峰落在 0°', oa.peaks.music.length === 1 && near(oa.peaks.music[0].deg, 0, 1.0),
    JSON.stringify(oa.peaks.music));

  const c = an('canyon');
  ok('峡谷有五条来波给阵列', c.arrPaths.length === 5);
  ok('最强的来波权重归一化后是 1', near(Math.max.apply(null, c.arrPaths.map((p) => p.gain)) / c.arrPaths[0].gain, 1, 1e-12));

  const ca = feedArray(c);
  ok('五条相干多径只声明 1 个源', ca.S === 1 && ca.declared === 1, 'S=' + ca.S + ' declared=' + ca.declared);
  ok('噪声子空间按声明的源数算：M − 1 = 7', ca.noiseDim === 7, 'noiseDim=' + ca.noiseDim);
  ok('一台发射机，谱上却不止一个峰', ca.peaks.bartlett.length >= 2,
    '峰数=' + ca.peaks.bartlett.length + ' ' + ca.peaks.bartlett.map((q) => q.deg + '°').join(' '));
  ok('直达方向上有峰', ca.peaks.bartlett.some((q) => Math.abs(q.deg) < 2.5),
    ca.peaks.bartlett.map((q) => q.deg + '°').join(' '));

  const k = an('corner');
  const ka = feedArray(k);
  ok('被挡死时阵列报出的峰在 43° 附近',
    ka.peaks.bartlett.some((q) => Math.abs(q.deg - 43) < 2.5),
    ka.peaks.bartlett.map((q) => q.deg + '°').join(' '));

  // 阵列的三种算法在开阔地都该只看到一个峰
  ok('开阔地 Bartlett / MVDR / MUSIC 各一个峰',
    oa.peaks.bartlett.length === 1 && oa.peaks.mvdr.length === 1 && oa.peaks.music.length === 1,
    JSON.stringify([oa.peaks.bartlett.length, oa.peaks.mvdr.length, oa.peaks.music.length]));
}

console.log('\n=== J. 拖动与边界 ===');
{
  const inMap = SB.clampToMap({ x: -50, y: 9999 }, 0);
  ok('拖出地图会被夹回来', inMap.x >= 0 && inMap.x <= SB.MAP_W && inMap.y >= 0 && inMap.y <= SB.MAP_H,
    JSON.stringify(inMap));
  const pad = SB.clampToMap({ x: -50, y: 9999 }, 40);
  ok('带半径的夹取留了边距', pad.x >= 20 && pad.y <= SB.MAP_H - 20);

  const r = an('canyon');
  ok('能抓住发射机', SB.hitTest(r, r.tx.x, r.tx.y, 20).kind === 'tx');
  ok('能抓住阵列', SB.hitTest(r, r.rx.x, r.rx.y, 20).kind === 'rx');
  const b = r.buildings[0];
  const hb = SB.hitTest(r, b.x + 5, b.y + 5, 20);
  ok('能抓住楼，且带住了楼内的偏移', hb.kind === 'bld' && near(hb.dx, 5, 1e-9) && near(hb.dy, 5, 1e-9));
  ok('空地上什么都抓不住', SB.hitTest(r, 0, 0, 5) === null);

  // 把发射机挪到楼外之后，路径表要跟着变
  const sc2 = SB.cloneScene(SB.scenById('canyon'));
  const before = SB.analyze({ scene: sc2, buildings: sc2.buildings, tx: sc2.tx, rx: sc2.rx, maxOrder: 1, freqHz: 2400e6, arrayM: 8 });
  sc2.tx = { x: 60, y: 120 };
  const after = SB.analyze({ scene: sc2, buildings: sc2.buildings, tx: sc2.tx, rx: sc2.rx, maxOrder: 1, freqHz: 2400e6, arrayM: 8 });
  ok('挪了发射机，角度就变了',
    JSON.stringify(before.angles) !== JSON.stringify(after.angles),
    before.angles.map((v) => v.toFixed(1)).join('/') + '  →  ' + after.angles.map((v) => v.toFixed(1)).join('/'));

  // 楼横在正中间：直连被挡，而且因为收发分居墙的两侧，反射也弹不过去
  const blocked = SB.analyze({
    scene: SB.scenById('open'), buildings: [{ x: 200, y: 120, w: 200, h: 80 }],
    tx: { x: 300, y: 340 }, rx: { x: 300, y: 60 }, maxOrder: 1, freqHz: 2400e6, arrayM: 8
  });
  ok('自己摆一栋楼挡在中间，直线就被挡了', blocked.losBlocked === true);
  ok('横在中间时没有一次反射（收发在墙两侧，弹不过去）', blocked.nOrder1 === 0,
    'nOrder1=' + blocked.nOrder1);

  // 楼在一侧：地面上弹一次绕过去（这才是多径的正经用法）
  const moved = SB.analyze({
    scene: SB.scenById('open'), buildings: [{ x: 120, y: 240, w: 360, h: 120 }],
    tx: { x: 60, y: 190 }, rx: { x: 540, y: 210 }, maxOrder: 1, freqHz: 2400e6, arrayM: 8
  });
  ok('楼在一侧时算得出一条一次反射', moved.nOrder1 >= 1, 'nOrder1=' + moved.nOrder1);
  ok('反射比直达晚到、而且更弱', moved.paths.some((p) =>
    p.order === 1 && p.deltaTau > 0 && Math.abs(p.amp) < Math.abs(moved.strongest.amp)));
  ok('墙段数 = 4 × 楼数', moved.walls.length === 4, 'walls=' + moved.walls.length);
}

console.log('\n=== K. 读数格式化 ===');
{
  ok('fmtM(1234) 是千米', SB.fmtM(1234).indexOf('km') > 0, SB.fmtM(1234));
  ok('fmtM(280) 是米', SB.fmtM(280).indexOf('m') > 0, SB.fmtM(280));
  ok('fmtNs 认纳秒', SB.fmtNs(4.84e-7).indexOf('ns') > 0, SB.fmtNs(4.84e-7));
  ok('fmtNs 认微秒', SB.fmtNs(4.84e-6).indexOf('µs') > 0, SB.fmtNs(4.84e-6));
  ok('fmtDb 带正负号', SB.fmtDb(-97.8).indexOf('-') === 0 && SB.fmtDb(-97.8).indexOf('dB') > 0, SB.fmtDb(-97.8));
  ok('读不出来时给破折号', SB.fmtM(Infinity) === '—' && SB.fmtDb(NaN) === '—');

  const r = an('canyon');
  ok('读数里没有 NaN / undefined', r.paths.every((p) =>
    isFinite(p.len) && isFinite(p.tau) && isFinite(p.angle) && isFinite(p.gainDb) && isFinite(p.amp)));
  ok('arrPaths 里也没有脏数据', r.arrPaths.every((p) =>
    isFinite(p.angle) && isFinite(p.gain) && isFinite(p.phase)));
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' passed / ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
