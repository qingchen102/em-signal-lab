/* ==========================================================================
 * constellation.js — 星座图：把比特摆到 I/Q 平面上
 *
 * 这是「通信原理 / 数字通信」那一站。要回答的问题只有一个：
 *   同样一份功率、同样吵的信道，凭什么有的调制方式更抗造？
 *
 * 物理：数字调制就是把每 k 个比特映射成 I/Q 平面上的一个点。
 *       I 叫同相分量，Q 叫正交分量，它们最后是同一路载波的两个相位，
 *       所以「一个复数点」=「一次可以同时搬两个数」，这就是正交的意义。
 *
 *       发出去的是理想点，收到的点被噪声推着走。推过判决边界就判错。
 *       于是「抗噪能力」就变成一句人话：
 *           点到点的距离 d_min   vs   噪声圆圈的大小 σ
 *       这两个数的比值决定一切，跟「信号的形状好不好看」没关系。
 *
 *       为什么 64QAM 快但脆？因为要在一模一样的平均功率里塞 64 个点，
 *       只能挤，d_min 掉到 BPSK 的 1/6.5，同样的噪声就先垮了。
 *       这就是「用抗噪能力换频谱效率」，香农公式说的那笔交易。
 *
 * 数据流：比特 → 星座映射 → 加高斯噪声 → 最近点判决 → 数错
 * ========================================================================== */
(function () {
  'use strict';

  var NS = window.SignalLab = window.SignalLab || {};

  var AXIS_MIN = 1.25;   // 画布至少画到 ±1.25
  var AXIS_MUL = 1.22;   // 或者最远点 × 1.22，取大的那个

  var COL = {
    bg: '#16202c',
    grid: '#1e2836',
    axis: '#3b4959',
    text: '#9dabbc',
    dim: '#7a8798',
    ideal: '#58a6ff',
    rx: '#9dabbc',
    error: '#ff7b72',
    region: '#1b2532',
    circle: '#d2a8ff',
    good: '#7ee787'
  };

  /* ======================================================================
   * 数学小工具
   * ====================================================================== */

  /* 互补误差函数，Numerical Recipes 的切比雪夫拟合，精度约 1.2e-7。
     用它是因为后面要跟理论误码率对账，凑合的近似会对不上。 */
  function erfcc(x) {
    var z = Math.abs(x);
    var t = 1 / (1 + z / 2);
    var r = t * Math.exp(-z * z - 1.26551223 +
      t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
      t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }

  function Q(x) { return 0.5 * erfcc(x / Math.SQRT2); }

  /* 格雷码：相邻的两个编号只差一个比特。
     映射时用它，是为了「判决偏到隔壁点」时只错 1 bit 而不是错一片。 */
  function gray(n) { return n ^ (n >> 1); }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* 均匀线阵那边也用过同一套随机数，保证同种子同结果 */
  function rngOf(seed) {
    var f = (NS.signal && NS.signal.mulberry32) ? NS.signal.mulberry32 : null;
    if (f) return f(seed >>> 0);
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* ======================================================================
   * 星座表
   * ====================================================================== */

  /* 方阵 QAM：M = 4^n，n 个点一排。levels 是奇数 1,3,5,… 归一化前的取值 */
  function squareLevels(side) {
    var L = [];
    for (var k = 0; k < side; k++) L.push(2 * k - (side - 1));
    return L;
  }

  function buildPoints(mod) {
    var pts = [];
    var k = mod.bits;
    var M = 1 << k;
    if (mod.kind === 'psk') {
      /* PSK 全部落在单位圆上；QPSK 转 45° 让点不压在坐标轴上 */
      var ph0 = (M === 4) ? Math.PI / 4 : 0;
      if (M === 2) ph0 = 0;
      for (var i = 0; i < M; i++) {
        var th = ph0 + 2 * Math.PI * i / M;
        pts.push([Math.cos(th), Math.sin(th)]);
      }
    } else {
      var side = Math.round(Math.sqrt(M));
      var L = squareLevels(side);
      for (var a = 0; a < side; a++) {
        for (var b = 0; b < side; b++) pts.push([L[a], L[b]]);
      }
    }
    /* 归一化到每符号平均能量 Es = 1。
       这一步是公平比较的前提：不然 64QAM 光靠点摆得远就赢了。 */
    var pw = 0;
    for (var j = 0; j < pts.length; j++) pw += pts[j][0] * pts[j][0] + pts[j][1] * pts[j][1];
    pw /= pts.length;
    var g = 1 / Math.sqrt(pw);
    for (var j2 = 0; j2 < pts.length; j2++) { pts[j2][0] *= g; pts[j2][1] *= g; }
    return pts;
  }

  var MODS = [
    { id: 'bpsk', kind: 'psk', name: 'BPSK', bits: 1,
      note: '一个比特压在一个点上，两点相距最远，最抗造但最慢' },
    { id: 'qpsk', kind: 'psk', name: 'QPSK', bits: 2,
      note: '四个点摆在四个象限中间，容量翻倍只掉了 3 dB' },
    { id: 'psk8', kind: 'psk', name: '8PSK', bits: 3,
      note: '八个点挤在一圈上，点距掉得比容量涨得快' },
    { id: 'qam16', kind: 'qam', name: '16QAM', bits: 4,
      note: '开始用幅度也传信息了，同一份功率塞 16 个点' },
    { id: 'qam64', kind: 'qam', name: '64QAM', bits: 6,
      note: 'Wi-Fi 和 5G 高速档用的就是它，代价是点距只有 BPSK 的六分之一' }
  ];

  /* 每符号能量已经归一化成 1，所以 Es/N0（dB）就是 10·log10(γ) */
  function gammaOf(snrDb) { return Math.pow(10, snrDb / 10); }

  /* 每一维的噪声标准差：σ² = Es/(2γ)，两维各一半 */
  function sigmaOf(snrDb) { return Math.sqrt(1 / (2 * gammaOf(snrDb))); }

  function modById(id) {
    for (var i = 0; i < MODS.length; i++) if (MODS[i].id === id) return MODS[i];
    return MODS[1];
  }

  /* 编号 → 比特数组。
     PSK 直接对编号取格雷码；方阵 QAM 把编号拆成 I、Q 两个下标，各自格雷码。 */
  function bitsOf(mod, index) {
    var k = mod.bits, out = [], j;
    if (mod.kind === 'psk') {
      var g = gray(index);
      for (j = k - 1; j >= 0; j--) out.push((g >> j) & 1);
    } else {
      var side = 1 << (k / 2);
      var half = k / 2;
      var iIdx = Math.floor(index / side), qIdx = index % side;
      var gi = gray(iIdx), gq = gray(qIdx);
      for (j = half - 1; j >= 0; j--) out.push((gi >> j) & 1);
      for (j = half - 1; j >= 0; j--) out.push((gq >> j) & 1);
    }
    return out;
  }

  /* 最近点判决。AWGN 下的最优判决就是「离谁近算谁」，
     判决边界正好是相邻两点的中垂线，画面上那几条线就是它。 */
  function decide(pts, i, q) {
    var best = 0, bd = Infinity;
    for (var n = 0; n < pts.length; n++) {
      var di = i - pts[n][0], dq = q - pts[n][1];
      var d = di * di + dq * dq;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  /* 最小点距：暴力两两比。点数最多 64，不心疼 */
  function minDist(pts) {
    var m = Infinity;
    for (var a = 0; a < pts.length; a++) {
      for (var b = a + 1; b < pts.length; b++) {
        var di = pts[a][0] - pts[b][0], dq = pts[a][1] - pts[b][1];
        var d = Math.sqrt(di * di + dq * dq);
        if (d < m) m = d;
      }
    }
    return m;
  }

  function hamming(a, b) {
    var n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
  }

  /* ======================================================================
   * 理论误符号率
   *
   * 这两条是教科书上的闭式近似，放在这里不是装饰：
   * 仿真跑出来跟它对不上，就说明我写错了。
   * ====================================================================== */
  function serTheory(mod, snrDb) {
    var M = 1 << mod.bits, g = gammaOf(snrDb);
    if (mod.kind === 'psk') {
      if (M === 2) return Q(Math.sqrt(2 * g));                    // BPSK
      return 2 * Q(Math.sqrt(2 * g) * Math.sin(Math.PI / M));      // M-PSK
    }
    /* 方阵 M-QAM：两个维度各自可能越界，合并后就是这个式子 */
    var side = Math.sqrt(M);
    var p = 2 * (1 - 1 / side) * Q(Math.sqrt(3 * g / (M - 1)));
    return 1 - (1 - p) * (1 - p);
  }

  /* ======================================================================
   * 仿真：发 → 加噪 → 判
   * ====================================================================== */
  function analyze(cfg) {
    cfg = cfg || {};
    var mod = modById(cfg.mod || 'qpsk');
    /* 这三个都过一遍 isFinite：UI 传上来的总是数字，但 cfg 是公开接口，
       NaN 一旦漏进去会一路污染 rx / ser / margin，最后变成满屏 NaN */
    var snrDb = (cfg.snrDb == null) ? 14 : cfg.snrDb;
    if (!isFinite(snrDb)) snrDb = 14;
    var nRaw = Math.round(cfg.nSym == null ? 400 : cfg.nSym);
    if (!isFinite(nRaw)) nRaw = 400;
    var nSym = clamp(nRaw, 8, 4000);
    var seed = (cfg.seed == null) ? 20261016 : cfg.seed;
    if (!isFinite(seed)) seed = 20261016;

    var pts = buildPoints(mod);
    var sigma = sigmaOf(snrDb);
    var dmin = minDist(pts);
    var rnd = rngOf(seed);
    var k = mod.bits;

    var rx = new Float64Array(2 * nSym);   // 收到的点，交错存 [i0,q0,i1,q1,…]
    var txIdx = new Int32Array(nSym);
    var rxIdx = new Int32Array(nSym);
    var wrong = [];                         // 判错的符号编号
    var nSymErr = 0, nBitErr = 0;

    for (var s = 0; s < nSym; s++) {
      var tx = Math.floor(rnd() * pts.length);
      txIdx[s] = tx;
      /* Box-Muller 造一对独立高斯数，一维一个 */
      var u1 = rnd(); if (u1 < 1e-12) u1 = 1e-12;
      var u2 = rnd();
      var mag = Math.sqrt(-2 * Math.log(u1));
      var ni = mag * Math.cos(2 * Math.PI * u2) * sigma;
      var nq = mag * Math.sin(2 * Math.PI * u2) * sigma;
      var i = pts[tx][0] + ni, q = pts[tx][1] + nq;
      rx[2 * s] = i; rx[2 * s + 1] = q;

      var got = decide(pts, i, q);
      rxIdx[s] = got;
      if (got !== tx) {
        nSymErr++;
        nBitErr += hamming(bitsOf(mod, tx), bitsOf(mod, got));
        wrong.push(s);
      }
    }

    var serSim = nSymErr / nSym;
    var berSim = nBitErr / (nSym * k);
    var serTh = serTheory(mod, snrDb);

    /* 坐标范围：容得下最远的理想点，也容得下被噪声推到最远的那个点 */
    var far = AXIS_MIN;
    for (var p = 0; p < pts.length; p++) {
      far = Math.max(far, Math.abs(pts[p][0]), Math.abs(pts[p][1]));
    }
    for (var s2 = 0; s2 < nSym; s2++) {
      far = Math.max(far, Math.abs(rx[2 * s2]), Math.abs(rx[2 * s2 + 1]));
    }
    var axis = Math.min(far * AXIS_MUL, 3.2);

    return {
      mod: mod.id, modName: mod.name, kind: mod.kind, bits: k,
      M: pts.length, note: mod.note,
      snrDb: snrDb, gamma: gammaOf(snrDb), sigma: sigma,
      dmin: dmin, margin: dmin / (2 * sigma),
      nSym: nSym, seed: seed, axis: axis,
      ideal: pts, rx: rx, txIdx: txIdx, rxIdx: rxIdx, wrong: wrong,
      nSymErr: nSymErr, nBitErr: nBitErr,
      ser: serSim, ber: berSim, serTheory: serTh,
      /* 一个短小的「判决域」描述，给知识面板和 AI 提示词用 */
      region: (mod.kind === 'psk') ? '角度' : '矩形',
      bitsOf: function (idx) { return bitsOf(mod, idx); }
    };
  }

  /* 同一个调制、不同信噪比，跑一串出来，用来画那条「瀑布曲线」 */
  function sweep(modId, snrList, nSym, seed) {
    var out = [];
    for (var i = 0; i < snrList.length; i++) {
      var r = analyze({ mod: modId, snrDb: snrList[i], nSym: nSym || 400, seed: (seed || 1) + i });
      out.push({ snrDb: snrList[i], ser: r.ser, ber: r.ber, serTheory: r.serTheory });
    }
    return out;
  }

  /* ======================================================================
   * 画
   * ====================================================================== */

  /* 误码率跨度极大：10⁻¹ 到 10⁻⁷ 都可能出现，
     所以小的那一头不能直接 toExponential，那个 "5.4e-5%" 会让人多看一眼才反应过来 */
  function fmtPct(v) {
    if (!(v > 0)) return '0';
    var p = v * 100;
    if (p >= 10) return p.toFixed(1) + '%';
    if (p >= 0.1) return p.toFixed(2) + '%';
    if (p >= 0.0001) return p.toFixed(4) + '%';
    /* 再小的就只保留两位有效数字：p = 5.39e-5 显示 0.000054%，
       而不是一串 12 位的 0.000053902962 */
    var d = 1 - Math.floor(Math.log10(p));
    if (!isFinite(d)) d = 12;
    d = Math.max(4, Math.min(12, d));
    var s = p.toFixed(d).replace(/0+$/, '');
    if (s.slice(-1) === '.') s += '0';
    return s + '%';
  }

  function fmt2(v) { return Number(v).toFixed(2); }

  /* 判决边界：
     - PSK 是相邻两点角平分线发出的射线（因为点都在圆周上，中垂线过原点）
     - 方阵 QAM 是相邻电平的中点，拉出的竖直/水平线 */
  function drawRegions(ctx, res, X, Y) {
    var pts = res.ideal;
    ctx.save();
    ctx.strokeStyle = COL.region;
    ctx.lineWidth = 1;
    if (res.kind === 'psk') {
      var M = pts.length;
      var ph0 = (M === 4) ? Math.PI / 4 : 0;
      if (M === 2) ph0 = 0;
      var R = res.axis * 2;
      for (var k = 0; k < M; k++) {
        var th = ph0 + 2 * Math.PI * (k + 0.5) / M;
        ctx.beginPath();
        ctx.moveTo(X(0), Y(0));
        ctx.lineTo(X(R * Math.cos(th)), Y(R * Math.sin(th)));
        ctx.stroke();
      }
      /* BPSK 只有两条射线，看上去不像「域」，补一条竖直中线当边界 */
      if (M === 2) {
        ctx.beginPath();
        ctx.moveTo(X(0), Y(-res.axis));
        ctx.lineTo(X(0), Y(res.axis));
        ctx.stroke();
      }
    } else {
      var side = Math.round(Math.sqrt(pts.length));
      var levels = [];
      for (var a = 0; a < side; a++) levels.push(pts[a * side + 0][0]);
      levels.sort(function (p, q) { return p - q; });
      for (var b = 0; b + 1 < levels.length; b++) {
        var mid = (levels[b] + levels[b + 1]) / 2;
        ctx.beginPath();
        ctx.moveTo(X(mid), Y(-res.axis)); ctx.lineTo(X(mid), Y(res.axis));
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(X(-res.axis), Y(mid)); ctx.lineTo(X(res.axis), Y(mid));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function draw(ctx, W, H, res, opts) {
    if (!res || typeof document === 'undefined') return;
    opts = opts || {};
    var clean = !!opts.clean;

    /* 这块屏幕跟时频图并排，通常只有 350～400 px 宽，
       右栏读数得随宽度收窄，否则正方形绘图区会被挤成一条 */
    var narrow = W < 560;
    var padL = narrow ? 30 : 40, padT = 16;
    var padR = clean ? 16 : (narrow ? 132 : 168);
    var padB = narrow ? 26 : 30;
    var plotW = Math.max(40, W - padL - padR);
    var plotH = Math.max(40, H - padT - padB);
    /* 画成正方形，免得圆的看成椭圆 */
    var side = Math.min(plotW, plotH);
    var ox = padL + (plotW - side) / 2;
    var oy = padT + (plotH - side) / 2;
    var A = res.axis;

    function X(v) { return ox + (v + A) / (2 * A) * side; }
    function Y(v) { return oy + side - (v + A) / (2 * A) * side; }

    ctx.save();
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);

    /* ---- 底格 ---- */
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    var g;
    for (g = -2; g <= 2; g++) {
      var v = g * A / 2;
      if (Math.abs(v) < 1e-9) continue;
      ctx.beginPath(); ctx.moveTo(X(v), Y(-A)); ctx.lineTo(X(v), Y(A)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(-A), Y(v)); ctx.lineTo(X(A), Y(v)); ctx.stroke();
    }

    /* ---- 判决边界（先画，压在点下面） ---- */
    if (!clean) drawRegions(ctx, res, X, Y);

    /* ---- 坐标轴 ---- */
    ctx.strokeStyle = COL.axis;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(-A), Y(0)); ctx.lineTo(X(A), Y(0)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(0), Y(-A)); ctx.lineTo(X(0), Y(A)); ctx.stroke();

    /* ---- 噪声 1σ 圆：画在一个理想点上，直观说明「噪声圆圈多大」 ----
       放在右上方那个点上，避免压住坐标轴文字 */
    if (!clean) {
      var anchor = res.ideal[0];
      for (var ai = 1; ai < res.ideal.length; ai++) {
        if (res.ideal[ai][0] + res.ideal[ai][1] > anchor[0] + anchor[1]) anchor = res.ideal[ai];
      }
      var rpx = res.sigma / (2 * A) * side;
      ctx.strokeStyle = COL.circle;
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(X(anchor[0]), Y(anchor[1]), Math.max(3, rpx), 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      /* 再画一条 d_min/2 的参考半径：这就是判决边界的距离 */
      var rb = res.dmin / 2 / (2 * A) * side;
      ctx.strokeStyle = COL.good;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(X(anchor[0]), Y(anchor[1]), Math.max(2, rb), 0, 2 * Math.PI);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* ---- 收到的点（一个一个画，nSym 最多 4000 还能接受） ---- */
    ctx.fillStyle = COL.rx;
    ctx.globalAlpha = clean ? 0.6 : 0.55;
    for (var s = 0; s < res.nSym; s++) {
      ctx.fillRect(X(res.rx[2 * s]) - 0.6, Y(res.rx[2 * s + 1]) - 0.6, 1.7, 1.7);
    }
    ctx.globalAlpha = 1;

    /* ---- 判错的点：红圈挑出来 ---- */
    if (res.wrong.length) {
      ctx.strokeStyle = COL.error;
      ctx.lineWidth = 1.2;
      var lim = Math.min(res.wrong.length, 400);
      for (var w = 0; w < lim; w++) {
        var si = res.wrong[w];
        var px = X(res.rx[2 * si]), py = Y(res.rx[2 * si + 1]);
        ctx.beginPath();
        ctx.arc(px, py, 2.6, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }

    /* ---- 理想点：画在最上面 ---- */
    ctx.strokeStyle = COL.ideal;
    ctx.fillStyle = COL.bg;
    ctx.lineWidth = 1.6;
    var r = res.ideal.length > 16 ? 2.4 : 3.4;
    for (var n = 0; n < res.ideal.length; n++) {
      var cx = X(res.ideal[n][0]), cy = Y(res.ideal[n][1]);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }

    /* ---- 轴文字 ---- */
    if (!clean) {
      ctx.fillStyle = COL.text;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('I', X(A) - 10, Y(0) - 5);
      ctx.fillText('Q', X(0) + 6, Y(A) + 10);
      ctx.fillStyle = COL.dim;
      ctx.textAlign = 'center';
      ctx.fillText('判决边界', X(0), oy + side + 20);
    }

    /* ---- 右栏数字 ---- */
    if (!clean) {
      var px0 = W - padR + 12;
      var py = padT + 12;
      ctx.textAlign = 'left';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

      function line(txt, color, bold) {
        ctx.fillStyle = color || COL.text;
        ctx.font = (bold ? '600 ' : '') + '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(txt, px0, py);
        py += 15;
      }

      line(res.modName, '#e3ebf5', true);
      line('每符号 ' + res.bits + ' bit', COL.dim);
      py += 4;
      line('点距 d_min  ' + fmt2(res.dmin));
      line('噪声 σ      ' + fmt2(res.sigma), COL.text);
      line('d_min / 2σ  ' + fmt2(res.margin),
        res.margin > 2 ? COL.good : (res.margin > 1 ? '#ffa657' : COL.error), true);
      py += 4;
      line('Es/N0       ' + res.snrDb.toFixed(0) + ' dB');
      line('符号数      ' + res.nSym, COL.dim);
      py += 6;
      line('误符号率 SER', COL.text, true);
      line('  仿真  ' + fmtPct(res.ser), '#e3ebf5');
      line('  理论  ' + fmtPct(res.serTheory), COL.dim);
      line('误比特率 BER', COL.text, true);
      line('  仿真  ' + fmtPct(res.ber), '#e3ebf5');
      py += 6;
      line('红圈 = 判错的符号', COL.error);
      if (res.margin < 2) {
        ctx.fillStyle = '#ffa657';
        ctx.fillText('噪声圆快碰到边界了', px0, py);
      }
    }

    ctx.restore();
  }

  NS.constellation = {
    analyze: analyze,
    sweep: sweep,
    draw: draw,
    MODS: MODS,
    modById: modById,
    bitsOf: bitsOf,
    buildPoints: buildPoints,
    minDist: minDist,
    decide: decide,
    sigmaOf: sigmaOf,
    serTheory: serTheory,
    fmtPct: fmtPct,
    fmt2: fmt2,
    Q: Q,
    COL: COL
  };
})();
