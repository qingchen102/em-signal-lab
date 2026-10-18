/* ==========================================================================
 * sandbox.js — 城市沙盒：多径是从哪来的
 *
 * 前面五块屏的信号都是「造」出来的：想要两根谱线就画两根谱线。
 * 这一块屏不一样，只告诉你东西摆在哪，信号是算出来的。
 *
 * 要回答的问题只有一个（也是《电磁场与波》里最难讲的一课）：
 *   只有一台发射机，阵列上凭什么会看到好几个方向？
 *
 * 答案是多径：电磁波会从墙上弹回来。屏幕上的每一条折线都是几何光学的
 * 镜像法（image method）算出来的真实反射路径，不是画上去的装饰：
 *   · 反射点 = 镜像点与接收点的连线与墙面的交点（交点必须落在墙上）
 *   · 幅度   = 自由空间路损 λ/(4πd) 再乘每个反射点的菲涅尔反射系数
 *   · 时延   = 总路长 ÷ 光速
 *
 * 于是时域上多出一串回波（时延扩展），频域上某些频率被抵消（频率选择性
 * 衰落），空域上多出几个方向（测向失效）。这就是「城市峡谷低飞」那一课。
 *
 * 二维俯视图约定：
 *   · 坐标单位是米，地图 y 轴向上（屏幕 y 轴向下，viewOf 里换算）
 *   · 阵列沿地图 x 轴摆成一排，法线朝 +y
 *   · 到达角 θ = −asin(v·e)，v 是从接收机指向来波方向的单位向量，
 *     e = (1,0)。这个符号是为了和 array.js 的 a_m(θ) = exp(−j2π(d/λ)m·sinθ)
 *     对齐，物理推导：平面波场 ∝ exp(+j(2π/λ) v·p)，阵元 p_m = m·(d·λ)·e，
 *     两式匹配得 −sinθ = v·e。
 *   · 因此 θ = 0 是阵元法线方向，±90° 是端射。线性阵前后不分，这是它的
 *     固有缺陷，不是 bug。
 * ========================================================================== */
(function () {
  'use strict';

  var NS = window.SignalLab = window.SignalLab || {};

  var C_LIGHT = 299792458;        // 光速 m/s
  var MAP_W = 600;                // 地图宽（米）
  var MAP_H = 400;                // 地图高（米）
  var EPS_R = 5.5;                // 混凝土相对介电常数（2.4 GHz 附近）
  var OCC_EPS = 0.6;              // 遮挡判断时把楼往内缩这么多米，允许贴着墙走
  var MIN_LEG = 1e-3;             // 线段长度下限，防除零

  var COL = {
    bg: '#16202c',
    grid: '#1b2532',
    gridMajor: '#26323f',
    axis: '#3b4959',
    text: '#9dabbc',
    dim: '#7a8798',
    bld: '#1b2431',
    bldEdge: '#33404f',
    los: '#7ee787',
    r1: '#ffa657',
    r2: '#d2a8ff',
    tx: '#ff7b72',
    rx: '#58a6ff',
    wall: '#3a4654',
    gone: '#ff7b72',
    spec: '#58a6ff'
  };

  /* ======================================================================
   * 预设场景
   * ==================================================================== */

  var SCENES = [
    {
      id: 'open',
      name: '开阔地',
      note: '空场，只有一条直达路径。这是其它场景的对照组。',
      tx: { x: 300, y: 340 },
      rx: { x: 300, y: 60 },
      buildings: []
    },
    {
      id: 'canyon',
      name: '城市峡谷',
      note: '两排高楼夹出一条竖向街道。只有一台发射机，可墙上弹回来的波也进了阵列。',
      tx: { x: 300, y: 340 },
      rx: { x: 300, y: 60 },
      buildings: [
        { x: 80, y: 120, w: 140, h: 220 },
        { x: 380, y: 120, w: 140, h: 220 }
      ]
    },
    {
      id: 'corner',
      name: '街角（挡住了）',
      note: '直达被挡死，信号只能从侧面的楼上弹过来，测出来的方向是反射点的方向，不是发射机的方向。',
      tx: { x: 300, y: 350 },
      rx: { x: 300, y: 50 },
      buildings: [
        { x: 240, y: 170, w: 120, h: 70 },
        { x: 60, y: 120, w: 100, h: 160 }
      ]
    },
    {
      id: 'dense',
      name: '密集楼群',
      note: '两栋楼一近一远，弹回来的两个角度差得很开，时延扩展和方向数都上去了。',
      tx: { x: 280, y: 360 },
      rx: { x: 320, y: 50 },
      buildings: [
        { x: 200, y: 110, w: 60, h: 190 },
        { x: 450, y: 130, w: 60, h: 160 }
      ]
    }
  ];

  function scenById(id) {
    for (var i = 0; i < SCENES.length; i++) if (SCENES[i].id === id) return SCENES[i];
    return SCENES[0];
  }

  function cloneScene(sc) {
    var b = [];
    for (var i = 0; i < sc.buildings.length; i++) {
      var s = sc.buildings[i];
      b.push({ x: s.x, y: s.y, w: s.w, h: s.h });
    }
    return {
      id: sc.id, name: sc.name, note: sc.note,
      tx: { x: sc.tx.x, y: sc.tx.y },
      rx: { x: sc.rx.x, y: sc.rx.y },
      buildings: b
    };
  }

  /* ======================================================================
   * 平面几何小工具
   * ==================================================================== */

  function dist(p, q) { return Math.hypot(q.x - p.x, q.y - p.y); }

  function unit(p, q) {
    var dx = q.x - p.x, dy = q.y - p.y;
    var L = Math.hypot(dx, dy);
    if (L < MIN_LEG) return { x: 0, y: 0 };
    return { x: dx / L, y: dy / L };
  }

  /* 把 p 关于直线 ab 镜像（镜像法的核心） */
  function reflectPoint(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) return null;
    var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
    var fx = a.x + t * dx, fy = a.y + t * dy;
    return { x: 2 * fx - p.x, y: 2 * fy - p.y };
  }

  /* 直线 pq 与直线 ab 的交点，返回参数 {t, u, x, y}
     t 是沿 p→q 的参数，u 是沿 a→b 的参数；u∈[0,1] 表示交点落在线段 ab 上 */
  function lineHit(p, q, a, b) {
    var rx = q.x - p.x, ry = q.y - p.y;
    var sx = b.x - a.x, sy = b.y - a.y;
    var den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    var t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / den;
    var u = ((a.x - p.x) * ry - (a.y - p.y) * rx) / den;
    return { t: t, u: u, x: p.x + t * rx, y: p.y + t * ry };
  }

  /* 线段 pq 是否穿过某个矩形的内部（矩形四边往内缩 shrink 米） */
  function segHitsRect(p, q, r, shrink) {
    var e = shrink || 0;
    var x0 = r.x + e, x1 = r.x + r.w - e;
    var y0 = r.y + e, y1 = r.y + r.h - e;
    if (x1 <= x0 || y1 <= y0) return false;
    // Liang-Barsky 裁剪
    var dx = q.x - p.x, dy = q.y - p.y;
    var t0 = 0, t1 = 1, i, pp = [-dx, dx, -dy, dy], qq = [p.x - x0, x1 - p.x, p.y - y0, y1 - p.y];
    for (i = 0; i < 4; i++) {
      if (Math.abs(pp[i]) < 1e-12) {
        if (qq[i] < 0) return false;
      } else {
        var t = qq[i] / pp[i];
        if (pp[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
      }
    }
    return t0 < t1;
  }

  function segBlocked(p, q, buildings) {
    for (var i = 0; i < buildings.length; i++) {
      if (segHitsRect(p, q, buildings[i], OCC_EPS)) return true;
    }
    return false;
  }

  /* 一栋楼拆成四条墙段 */
  function wallsOf(buildings) {
    var out = [];
    for (var i = 0; i < buildings.length; i++) {
      var b = buildings[i];
      var x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
      var segs = [
        [{ x: x0, y: y0 }, { x: x1, y: y0 }],
        [{ x: x1, y: y0 }, { x: x1, y: y1 }],
        [{ x: x1, y: y1 }, { x: x0, y: y1 }],
        [{ x: x0, y: y1 }, { x: x0, y: y0 }]
      ];
      for (var k = 0; k < 4; k++) {
        out.push({
          b: i,
          a: segs[k][0], c: segs[k][1],
          dx: segs[k][1].x - segs[k][0].x,
          dy: segs[k][1].y - segs[k][0].y
        });
      }
    }
    return out;
  }

  /* ======================================================================
   * 反射与传播
   * ==================================================================== */

  /* 垂直极化的菲涅尔反射系数（二维俯视图里电场垂直于纸面）
   *   Γ⊥ = (cosθi − √(εr − sin²θi)) / (cosθi + √(εr − sin²θi))
   * 法向入射（cos=1, εr=5.5）→ Γ = −0.402（−7.9 dB）
   * 掠入射（cos→0）→ Γ → −1（全反射）
   * 负号代表相位翻转。这就是多径有时候会互相抵消的原因。 */
  function fresnelPerp(cosI, epsR) {
    var er = epsR || EPS_R;
    var ci = Math.abs(cosI);
    if (ci > 1) ci = 1;
    if (ci < 1e-9) ci = 1e-9;
    var si2 = 1 - ci * ci;
    var root = Math.sqrt(Math.max(0, er - si2));
    return (ci - root) / (ci + root);
  }

  /* 在 P 点反射：来向 inP→P，去向 P→outP，墙面 wall */
  function reflCoef(inP, P, wall) {
    var u = unit(inP, P);
    var nx = -wall.dy, ny = wall.dx;
    var nL = Math.hypot(nx, ny) || 1;
    nx /= nL; ny /= nL;
    return fresnelPerp(u.x * nx + u.y * ny, EPS_R);
  }

  /* 到达角：v 是从接收机指向来波方向的单位向量，e = (1,0) */
  function angleOf(v) {
    var c = v.x;
    if (c > 1) c = 1;
    if (c < -1) c = -1;
    return -Math.asin(c) * 180 / Math.PI;
  }

  /* ======================================================================
   * 主分析：镜像法找路径
   * ==================================================================== */

  function analyze(cfg) {
    cfg = cfg || {};
    var sc = cfg.scene || SCENES[0];
    var buildings = cfg.buildings || sc.buildings;
    var tx = cfg.tx || sc.tx;
    var rx = cfg.rx || sc.rx;
    var freqHz = cfg.freqHz || 2400e6;
    var lambda = C_LIGHT / freqHz;
    var maxOrder = cfg.maxOrder == null ? 2 : Math.max(0, Math.min(2, Math.round(cfg.maxOrder)));
    var M = Math.max(1, Math.round(cfg.arrayM || 8));
    var dW = cfg.arrayD || 0.5;
    var i, j, k;

    var walls = wallsOf(buildings);
    var paths = [];

    function addPath(order, pts, wallsHit) {
      var len = 0;
      for (var q = 1; q < pts.length; q++) len += dist(pts[q - 1], pts[q]);
      if (len < MIN_LEG) return null;
      var amp = lambda / (4 * Math.PI * len);
      var g = 1;
      for (var w = 0; w < wallsHit.length; w++) {
        var idx = wallsHit[w];
        g *= reflCoef(pts[w], pts[w + 1], walls[idx]);
      }
      amp *= g;
      var tau = len / C_LIGHT;
      // 到达方向：从接收机指向最后一个反射点（直达时指向发射机）
      var from = pts.length >= 2 ? pts[pts.length - 2] : tx;
      var v = unit(rx, from);
      var ph = (amp < 0 ? Math.PI : 0) - 2 * Math.PI * freqHz * tau;
      var p = {
        order: order,
        kind: order === 0 ? 'los' : 'refl',
        pts: pts,
        walls: wallsHit.slice(),
        len: len,
        tau: tau,
        amp: amp,
        gainDb: 20 * Math.log10(Math.max(Math.abs(amp), 1e-12)),
        angle: angleOf(v),
        phase: ph,
        deltaTau: 0
      };
      paths.push(p);
      return p;
    }

    /* ---- 0 阶：直达 ---- */
    var losBlocked = segBlocked(tx, rx, buildings);
    if (!losBlocked) addPath(0, [tx, rx], []);

    /* ---- 1 阶：绕一面墙 ---- */
    if (maxOrder >= 1) {
      for (i = 0; i < walls.length; i++) {
        var w = walls[i];
        var I = reflectPoint(tx, w.a, w.c);
        if (!I) continue;
        var hit = lineHit(I, rx, w.a, w.c);
        if (!hit || hit.u < 0 || hit.u > 1 || hit.t <= 0 || hit.t >= 1) continue;
        var P = { x: hit.x, y: hit.y };
        if (segBlocked(tx, P, buildings) || segBlocked(P, rx, buildings)) continue;
        addPath(1, [tx, P, rx], [i]);
      }
    }

    /* ---- 2 阶：连着弹两面墙 ---- */
    if (maxOrder >= 2) {
      for (i = 0; i < walls.length; i++) {
        var w1 = walls[i];
        var I1 = reflectPoint(tx, w1.a, w1.c);
        if (!I1) continue;
        for (j = 0; j < walls.length; j++) {
          if (j === i) continue;
          var w2 = walls[j];
          var I2 = reflectPoint(I1, w2.a, w2.c);
          if (!I2) continue;
          var h2 = lineHit(I2, rx, w2.a, w2.c);
          if (!h2 || h2.u < 0 || h2.u > 1 || h2.t <= 0 || h2.t >= 1) continue;
          var P2 = { x: h2.x, y: h2.y };
          var h1 = lineHit(I1, P2, w1.a, w1.c);
          if (!h1 || h1.u < 0 || h1.u > 1 || h1.t <= 0 || h1.t >= 1) continue;
          var P1 = { x: h1.x, y: h1.y };
          if (segBlocked(tx, P1, buildings)) continue;
          if (segBlocked(P1, P2, buildings)) continue;
          if (segBlocked(P2, rx, buildings)) continue;
          addPath(2, [tx, P1, P2, rx], [i, j]);
        }
      }
    }

    /* ---- 按幅度从强到弱排，并算相对时延 ---- */
    paths.sort(function (a, b) { return Math.abs(b.amp) - Math.abs(a.amp); });
    var first = paths.length ? paths[0].tau : 0;
    for (i = 0; i < paths.length; i++) paths[i].deltaTau = paths[i].tau - first;

    /* ---- 功率加权统计：总功率、平均时延、RMS 时延扩展 ---- */
    var pTot = 0, tMean = 0, t2Mean = 0;
    for (i = 0; i < paths.length; i++) {
      var pw = paths[i].amp * paths[i].amp;
      pTot += pw;
      tMean += pw * paths[i].deltaTau;
      t2Mean += pw * paths[i].deltaTau * paths[i].deltaTau;
    }
    if (pTot > 0) tMean /= pTot; else tMean = 0;
    if (pTot > 0) t2Mean /= pTot; else t2Mean = 0;
    var spreadRms = Math.sqrt(Math.max(0, t2Mean - tMean * tMean));
    var coherentBw = spreadRms > 1e-15 ? 1 / (5 * spreadRms) : Infinity;

    /* ---- 喂给阵列屏的路径表（同一路信号的相干多径） ---- */
    var arrPaths = [];
    for (i = 0; i < paths.length; i++) {
      arrPaths.push({
        angle: paths[i].angle,
        gain: Math.abs(paths[i].amp),
        phase: paths[i].phase,
        order: paths[i].order
      });
    }

    var angles = [];
    for (i = 0; i < paths.length; i++) angles.push(paths[i].angle);

    // 最强路径按 |amp| 比，amp 带菲涅尔反射的正负号，直接比大小会把所有反射都漏掉
    var strongest = null;
    for (i = 0; i < paths.length; i++) {
      if (!strongest || Math.abs(paths[i].amp) > Math.abs(strongest.amp)) strongest = paths[i];
    }
    var lastArrival = 0;
    for (i = 0; i < paths.length; i++) {
      if (paths[i].deltaTau > lastArrival) lastArrival = paths[i].deltaTau;
    }

    return {
      scene: sc,
      sceneId: sc.id,
      sceneName: sc.name,
      tx: tx, rx: rx, buildings: buildings,
      walls: walls,
      freqHz: freqHz, lambda: lambda, maxOrder: maxOrder,
      M: M, dW: dW,
      paths: paths,
      nPaths: paths.length,
      nLos: (function () { var c = 0; for (i = 0; i < paths.length; i++) if (paths[i].order === 0) c++; return c; })(),
      nOrder1: (function () { var c = 0; for (i = 0; i < paths.length; i++) if (paths[i].order === 1) c++; return c; })(),
      nOrder2: (function () { var c = 0; for (i = 0; i < paths.length; i++) if (paths[i].order === 2) c++; return c; })(),
      losBlocked: losBlocked,
      strongest: strongest,
      lastArrival: lastArrival,
      spreadRms: spreadRms,
      coherenceBw: coherentBw,
      meanDelay: tMean,
      pTot: pTot,
      arrPaths: arrPaths,
      angles: angles,
      /* 相干带宽越过之后就开始挑频率：给一个直观的判据 */
      freqSelective: spreadRms > 0 && (1 / (5 * spreadRms)) < freqHz * 0.02
    };
  }

  /* ======================================================================
   * 画城市地图
   * ==================================================================== */
  /* 顶部那条「测向结果」带：真实到达角是哪儿条、阵列谱又报出哪些峰。
     沙盒真正的结论页就在这里，一台发射机，阵列上却不止一个方向。 */
  function drawDoaStrip(ctx, x, y, w, h, sb, doa) {
    ctx.save();
    ctx.fillStyle = COL.bg;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    var padL = 34, padR = 10, labH = 11;
    var px = x + padL, pw = w - padL - padR;
    var half = pw / 2;
    var top = y + 4, bot = y + h - labH - 3;

    function X(deg) { return px + half * (1 + Math.max(-90, Math.min(90, deg)) / 90); }

    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var degs = [-90, -45, 0, 45, 90];
    for (var i = 0; i < degs.length; i++) {
      ctx.strokeStyle = degs[i] === 0 ? COL.axis : COL.grid;
      ctx.beginPath();
      ctx.moveTo(X(degs[i]), y + 3);
      ctx.lineTo(X(degs[i]), y + h - labH - 1);
      ctx.stroke();
      ctx.fillStyle = COL.dim;
      ctx.fillText(degs[i] + '°', X(degs[i]), y + h - labH);
    }

    if (!sb) { ctx.restore(); return; }
    var paths = sb.paths || [];
    var gmax = 0, q;
    for (q = 0; q < paths.length; q++) if (Math.abs(paths[q].amp) > gmax) gmax = Math.abs(paths[q].amp);
    if (gmax <= 0) gmax = 1;

    // 阵列谱垫底（归一化 dB → 高度）
    if (doa && doa.bartlett) {
      ctx.beginPath();
      var n = doa.bartlett.length;
      for (var k = 0; k < n; k++) {
        var vDb = Math.max(-30, doa.bartlett[k]);
        var yy = bot - (vDb + 30) / 30 * (bot - top);
        if (k === 0) ctx.moveTo(X(doa.theta[k]), yy); else ctx.lineTo(X(doa.theta[k]), yy);
      }
      ctx.strokeStyle = COL.spec;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // 真实路径：竖条，高度按相对幅度
    ctx.lineWidth = 2;
    for (q = 0; q < paths.length; q++) {
      var pt = paths[q];
      var hh = (bot - top) * Math.max(0.12, Math.abs(pt.amp) / gmax);
      ctx.strokeStyle = pt.kind === 'los' ? COL.los : (pt.order === 1 ? COL.r1 : COL.r2);
      ctx.beginPath();
      ctx.moveTo(X(pt.angle), bot);
      ctx.lineTo(X(pt.angle), bot - hh);
      ctx.stroke();
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = COL.text;
    ctx.fillText('到达角', x + 4, y + (h - labH) / 2);
    ctx.restore();
  }

  function viewOf(W, H, yOff) {
    var pad = 10;
    var off = yOff || 0;
    var s = Math.min((W - pad * 2) / MAP_W, (H - pad * 2) / MAP_H);
    var ox = (W - MAP_W * s) / 2;
    var oy = off + (H - MAP_H * s) / 2;
    return {
      s: s, ox: ox, oy: oy,
      sx: function (x) { return ox + x * s; },
      sy: function (y) { return oy + (MAP_H - y) * s; },
      mx: function (X) { return (X - ox) / s; },
      my: function (Y) { return MAP_H - (Y - oy) / s; }
    };
  }

  function fmtM(m) {
    if (!isFinite(m)) return '—';
    if (m >= 1000) return (m / 1000).toFixed(2) + ' km';
    if (m >= 10) return m.toFixed(1) + ' m';
    return m.toFixed(2) + ' m';
  }

  function fmtNs(t) {
    if (!isFinite(t)) return '—';
    var ns = t * 1e9;
    if (ns >= 1000) return (ns / 1000).toFixed(2) + ' µs';
    if (ns >= 10) return ns.toFixed(1) + ' ns';
    return ns.toFixed(0) + ' ns';
  }

  function fmtDb(v) {
    if (!isFinite(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB';
  }

  function draw(ctx, W, H, res, opts) {
    if (!res || typeof document === 'undefined') return;
    opts = opts || {};
    var clean = !!opts.clean;
    var topPad = Math.max(0, opts.topPad || 0);
    var v = viewOf(W, H - topPad, topPad);
    var i, k;

    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);

    /* ---- 50 米方格 ---- */
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    for (i = 0; i <= MAP_W; i += 50) {
      var gx = Math.round(v.sx(i)) + 0.5;
      ctx.strokeStyle = (i % 100 === 0) ? COL.gridMajor : COL.grid;
      ctx.beginPath(); ctx.moveTo(gx, v.sy(0)); ctx.lineTo(gx, v.sy(MAP_H)); ctx.stroke();
    }
    for (i = 0; i <= MAP_H; i += 50) {
      var gy = Math.round(v.sy(i)) + 0.5;
      ctx.strokeStyle = (i % 100 === 0) ? COL.gridMajor : COL.grid;
      ctx.beginPath(); ctx.moveTo(v.sx(0), gy); ctx.lineTo(v.sx(MAP_W), gy); ctx.stroke();
    }

    /* ---- 楼 ---- */
    for (i = 0; i < res.buildings.length; i++) {
      var b = res.buildings[i];
      var x0 = v.sx(b.x), y0 = v.sy(b.y + b.h);
      var w = b.w * v.s, h = b.h * v.s;
      ctx.fillStyle = COL.bld;
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = COL.bldEdge;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(w), Math.round(h));
    }

    /* ---- 路径：先画弱的，强的压在上面 ---- */
    var order = res.paths.slice().sort(function (a, c) { return Math.abs(a.amp) - Math.abs(c.amp); });
    for (i = 0; i < order.length; i++) {
      var p = order[i];
      var col = p.order === 0 ? COL.los : (p.order === 1 ? COL.r1 : COL.r2);
      var strong = Math.abs(p.amp) / Math.max(1e-12, Math.abs(res.strongest ? res.strongest.amp : 1));
      ctx.strokeStyle = col;
      ctx.globalAlpha = clean ? 0.85 : (0.35 + 0.6 * Math.min(1, Math.sqrt(strong)));
      ctx.lineWidth = p.order === 0 ? 2.4 : (p.order === 1 ? 1.8 : 1.3);
      ctx.beginPath();
      ctx.moveTo(v.sx(p.pts[0].x), v.sy(p.pts[0].y));
      for (k = 1; k < p.pts.length; k++) ctx.lineTo(v.sx(p.pts[k].x), v.sy(p.pts[k].y));
      ctx.stroke();
      ctx.globalAlpha = 1;
      // 反射点
      for (k = 1; k < p.pts.length - 1; k++) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(v.sx(p.pts[k].x), v.sy(p.pts[k].y), 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* ---- 发射机 ---- */
    var txX = v.sx(res.tx.x), txY = v.sy(res.tx.y);
    ctx.fillStyle = COL.tx;
    ctx.beginPath(); ctx.arc(txX, txY, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = COL.tx; ctx.globalAlpha = 0.45; ctx.lineWidth = 1.4;
    for (k = 1; k <= 2; k++) {
      ctx.beginPath(); ctx.arc(txX, txY, 6 + k * 5, -Math.PI * 0.75, -Math.PI * 0.25); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* ---- 接收机 + 阵列 ---- */
    var rxX = v.sx(res.rx.x), rxY = v.sy(res.rx.y);
    // 阵列画成符号（真实阵长只有几十厘米，在这张 600 米的图上按比例画就是一个点）
    var halfPx = 16;
    ctx.strokeStyle = COL.rx; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(rxX - halfPx - 5, rxY); ctx.lineTo(rxX + halfPx + 5, rxY);
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (k = 0; k < res.M; k++) {
      var ex = rxX - halfPx + (res.M === 1 ? halfPx : (2 * halfPx) * k / (res.M - 1));
      ctx.fillStyle = COL.rx;
      ctx.beginPath(); ctx.arc(ex, rxY, 2.1, 0, Math.PI * 2); ctx.fill();
    }

    /* ---- 标注 ---- */
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.tx;
    ctx.fillText('TX', txX + 9, txY - 7);
    ctx.fillStyle = COL.rx;
    ctx.fillText('RX 阵列 M=' + res.M, rxX - 6, rxY + 18);

    if (!clean) {
      // 比例尺
      var bx = v.sx(0) + 6, by = v.sy(0) - 8;
      var lenM = 100, lenPx = lenM * v.s;
      ctx.strokeStyle = COL.axis; ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(bx, by); ctx.lineTo(bx + lenPx, by);
      ctx.moveTo(bx, by - 3); ctx.lineTo(bx, by + 3);
      ctx.moveTo(bx + lenPx, by - 3); ctx.lineTo(bx + lenPx, by + 3);
      ctx.stroke();
      ctx.fillStyle = COL.dim;
      ctx.textAlign = 'left';
      ctx.fillText('100 m', bx + lenPx + 6, by + 4);

      // 图例
      var lx = 10, ly = 14;
      ctx.textAlign = 'left';
      var legend = [
        [COL.los, '直达'],
        [COL.r1, '一次反射'],
        [COL.r2, '二次反射']
      ];
      for (i = 0; i < legend.length; i++) {
        ctx.strokeStyle = legend[i][0];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(lx, ly + i * 14); ctx.lineTo(lx + 16, ly + i * 14);
        ctx.stroke();
        ctx.fillStyle = COL.text;
        ctx.fillText(legend[i][1], lx + 22, ly + i * 14 + 4);
      }

      /* ---- 右栏读数 ---- */
      var pw = 196, px = W - pw - 8, py = (opts.topPad || 0) + 8;
      ctx.fillStyle = 'rgba(8,11,16,0.82)';
      ctx.fillRect(px, py, pw, 150);
      ctx.strokeStyle = COL.axis; ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, 149);

      var rows = [
        ['路径数', String(res.nPaths) + ' 条'],
        ['直达', res.losBlocked ? '被挡住' : '通'],
        ['一次 / 二次', res.nOrder1 + ' / ' + res.nOrder2],
        ['最强路径', fmtDb(res.strongest ? res.strongest.gainDb : -Infinity)],
        ['最晚到达', fmtNs(res.lastArrival)],
        ['时延扩展 σ', fmtNs(res.spreadRms)],
        ['相干带宽', res.coherenceBw === Infinity ? '—' : (res.coherenceBw / 1e6).toFixed(2) + ' MHz']
      ];
      ctx.textAlign = 'left';
      for (i = 0; i < rows.length; i++) {
        var ry = py + 18 + i * 18;
        ctx.fillStyle = COL.dim;
        ctx.fillText(rows[i][0], px + 10, ry);
        ctx.fillStyle = (i === 1 && res.losBlocked) ? COL.gone : COL.text;
        ctx.textAlign = 'right';
        ctx.fillText(rows[i][1], px + pw - 10, ry);
        ctx.textAlign = 'left';
      }

      // 场景说明
      if (res.scene && res.scene.note) {
        /* 说明文字贴着画布底边画，地图是居中缩放的，地图靠得近时这两行会压到格子上，
           所以先铺一块底色，无论地图多大都读得清。 */
        var note = res.scene.note;
        if (note.length > 46) {
          /* 优先断在句号上，退而求其次断在分号、逗号，不要把半句话截在中间 */
          var cut = note.lastIndexOf('。', 46);
          if (cut < 10) cut = note.lastIndexOf('；', 46);
          if (cut < 10) cut = note.lastIndexOf('，', 46);
          note = cut > 10 ? note.slice(0, cut + 1) : note.slice(0, 45) + '…';
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        var wCap = Math.max(ctx.measureText(res.scene.name).width,
          ctx.measureText(note).width) + 16;
        ctx.fillStyle = 'rgba(8, 11, 16, 0.86)';
        ctx.fillRect(0, H - 32, Math.min(W, wCap), 32);
        ctx.fillStyle = COL.dim;
        ctx.fillText(res.scene.name, 10, H - 22);
        ctx.fillText(note, 10, H - 8);
      }
    }
  }

  /* ======================================================================
   * 鼠标交互：抓住发射机 / 接收机 / 一栋楼
   * ==================================================================== */

  function hitTest(res, x, y, tol) {
    var t = tol == null ? 14 : tol;      // 单位是米
    if (dist({ x: x, y: y }, res.rx) <= t) return { kind: 'rx' };
    if (dist({ x: x, y: y }, res.tx) <= t) return { kind: 'tx' };
    for (var i = res.buildings.length - 1; i >= 0; i--) {
      var b = res.buildings[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        return { kind: 'bld', index: i, dx: x - b.x, dy: y - b.y };
      }
    }
    return null;
  }

  function clampToMap(p, w) {
    var hw = w ? w / 2 : 0;
    return {
      x: Math.max(hw + 4, Math.min(MAP_W - hw - 4, p.x)),
      y: Math.max(hw + 4, Math.min(MAP_H - hw - 4, p.y))
    };
  }

  NS.sandbox = {
    scenById: scenById,
    MAP_W: MAP_W,
    MAP_H: MAP_H,
    cloneScene: cloneScene,
    analyze: analyze,
    draw: draw,
    drawDoaStrip: drawDoaStrip,
    viewOf: viewOf,
    hitTest: hitTest,
    clampToMap: clampToMap,
    reflectPoint: reflectPoint,
    lineHit: lineHit,
    segHitsRect: segHitsRect,
    segBlocked: segBlocked,
    wallsOf: wallsOf,
    fresnelPerp: fresnelPerp,
    angleOf: angleOf,
    fmtM: fmtM,
    fmtNs: fmtNs,
    fmtDb: fmtDb,
    COL: COL,
    MAP_W: MAP_W,
    MAP_H: MAP_H,
    C_LIGHT: C_LIGHT,
    EPS_R: EPS_R
  };
})();
