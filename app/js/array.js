/* ==========================================================================
 * array.js — 阵列测向：均匀线阵 + 三种空间谱
 *
 * 这是「电磁场与波 / 天线」那一站。要回答的问题只有一个：
 *   一个阵元的时候你只知道「有信号」；摆成一排之后，凭什么就知道「从哪来」？
 *
 * 物理：平面波斜着到达一排等间距阵元，相邻阵元的波程差 = d·sinθ，
 *       对应的相位差是 2π(d/λ)·sinθ。方向信息全藏在这一串相位里。
 *       把这一串相位写成向量 a(θ)，就叫导向矢量。
 *
 * 三种算法：
 *   Bartlett  常规波束形成，P = a^H R a / M²，最稳健，分辨率卡在瑞利限
 *   MVDR      最小方差无畸变响应，P = 1/(a^H R⁻¹ a)，旁瓣低、分辨率略好
 *   MUSIC     子空间法，P = 1/‖E_n^H a‖²，能突破瑞利限，但要知道信源个数
 *
 * 复数的表示法：向量用 {re: Float64Array, im: Float64Array}，
 * 矩阵用两个 Float64Array(M*M) 分别装实部虚部，下标 i*M+j。
 * 这样比造一个 Complex 类快，也好调试。
 * ========================================================================== */
(function () {
  'use strict';

  var NS = window.SignalLab = window.SignalLab || {};

  var DB_FLOOR = -40;          // 纵轴下沿
  var THETA_STEP = 0.5;        // 角度网格步长（度）

  var COL = {
    bg: '#16202c',
    grid: '#1e2836',
    axis: '#3b4959',
    text: '#9dabbc',
    dim: '#7a8798',
    bartlett: '#58a6ff',
    mvdr: '#ffa657',
    music: '#7ee787',
    truth: '#d2a8ff',
    warn: '#ff7b72'
  };

  /* ======================================================================
   * 导向矢量
   *
   *   a_m(θ) = exp(-j·2π·d·m·sinθ)      m = 0 … M-1
   *
   * d 的单位是波长（d/λ）。d = 0.5 就是不模糊的最大间距。
   * ==================================================================== */
  function steering(M, d, thetaDeg) {
    var s = Math.sin(thetaDeg * Math.PI / 180);
    var re = new Float64Array(M), im = new Float64Array(M);
    for (var m = 0; m < M; m++) {
      var ph = -2 * Math.PI * d * m * s;
      re[m] = Math.cos(ph);
      im[m] = Math.sin(ph);
    }
    return { re: re, im: im };
  }

  /* 标准正态随机数（Box-Muller） */
  function gauss(rand) {
    var u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ======================================================================
   * 复数线性代数
   * ==================================================================== */

  /* a^H R a，R 是 Hermitian，结果必然是实数，取实部 */
  function quadForm(M, Rre, Rim, a) {
    var tre = new Float64Array(M), tim = new Float64Array(M);
    var i, j;
    for (i = 0; i < M; i++) {
      var sr = 0, si = 0;
      for (j = 0; j < M; j++) {
        var rr = Rre[i * M + j], ri = Rim[i * M + j];
        sr += rr * a.re[j] - ri * a.im[j];
        si += rr * a.im[j] + ri * a.re[j];
      }
      tre[i] = sr; tim[i] = si;
    }
    var acc = 0;
    for (i = 0; i < M; i++) acc += a.re[i] * tre[i] + a.im[i] * tim[i];
    return acc;
  }

  /* Cholesky：Hermitian 正定矩阵 A = L·L^H */
  function cholesky(M, Are, Aim) {
    var Lre = new Float64Array(M * M), Lim = new Float64Array(M * M);
    for (var i = 0; i < M; i++) {
      for (var j = 0; j <= i; j++) {
        var sr = Are[i * M + j], si = Aim[i * M + j];
        for (var k = 0; k < j; k++) {
          var lir = Lre[i * M + k], lii = Lim[i * M + k];
          var ljr = Lre[j * M + k], lji = Lim[j * M + k];
          sr -= lir * ljr + lii * lji;
          si -= lii * ljr - lir * lji;
        }
        if (i === j) {
          Lre[i * M + j] = Math.sqrt(Math.max(sr, 1e-18));
          Lim[i * M + j] = 0;
        } else {
          var dj = Lre[j * M + j];
          Lre[i * M + j] = sr / dj;
          Lim[i * M + j] = si / dj;
        }
      }
    }
    return { re: Lre, im: Lim };
  }

  /* 用 Cholesky 因子解 A x = b */
  function cholSolve(M, Lre, Lim, bre, bim) {
    var i, k;
    var yre = new Float64Array(M), yim = new Float64Array(M);
    for (i = 0; i < M; i++) {
      var sr = bre[i], si = bim[i];
      for (k = 0; k < i; k++) {
        var lr = Lre[i * M + k], li = Lim[i * M + k];
        sr -= lr * yre[k] - li * yim[k];
        si -= lr * yim[k] + li * yre[k];
      }
      var d = Lre[i * M + i];
      yre[i] = sr / d; yim[i] = si / d;
    }
    var xre = new Float64Array(M), xim = new Float64Array(M);
    for (i = M - 1; i >= 0; i--) {
      var tr = yre[i], ti = yim[i];
      for (k = i + 1; k < M; k++) {
        var lr2 = Lre[k * M + i], li2 = Lim[k * M + i];
        tr -= lr2 * xre[k] + li2 * xim[k];
        ti -= lr2 * xim[k] - li2 * xre[k];
      }
      var d2 = Lre[i * M + i];
      xre[i] = tr / d2; xim[i] = ti / d2;
    }
    return { re: xre, im: xim };
  }

  /* 实对称矩阵的 Jacobi 特征分解。A 会被就地改掉。
     返回 { values, vectors }，vectors 的第 j 列是第 j 个特征向量（列主序）。 */
  function jacobiSym(N, A) {
    var V = new Float64Array(N * N);
    var i, j, k, p, q;
    for (i = 0; i < N; i++) V[i * N + i] = 1;

    for (var sweep = 0; sweep < 60; sweep++) {
      var off = 0;
      for (p = 0; p < N; p++) {
        for (q = p + 1; q < N; q++) off += A[p * N + q] * A[p * N + q];
      }
      if (off < 1e-26) break;

      for (p = 0; p < N; p++) {
        for (q = p + 1; q < N; q++) {
          var apq = A[p * N + q];
          if (Math.abs(apq) < 1e-18) continue;
          var app = A[p * N + p], aqq = A[q * N + q];
          var theta = 0.5 * Math.atan2(2 * apq, aqq - app);
          var c = Math.cos(theta), s = Math.sin(theta);

          A[p * N + p] = c * c * app - 2 * s * c * apq + s * s * aqq;
          A[q * N + q] = s * s * app + 2 * s * c * apq + c * c * aqq;
          A[p * N + q] = 0; A[q * N + p] = 0;

          for (k = 0; k < N; k++) {
            if (k === p || k === q) continue;
            var akp = A[k * N + p], akq = A[k * N + q];
            var nkp = c * akp - s * akq;
            var nkq = s * akp + c * akq;
            A[k * N + p] = nkp; A[p * N + k] = nkp;
            A[k * N + q] = nkq; A[q * N + k] = nkq;
          }
          for (k = 0; k < N; k++) {
            var vkp = V[k * N + p], vkq = V[k * N + q];
            V[k * N + p] = c * vkp - s * vkq;
            V[k * N + q] = s * vkp + c * vkq;
          }
        }
      }
    }

    var values = new Float64Array(N);
    for (i = 0; i < N; i++) values[i] = A[i * N + i];
    return { values: values, vectors: V };
  }

  /* Hermitian 矩阵特征分解，按特征值从小到大。
     技巧：把 H = A + iB 嵌成实对称矩阵 [[A, -B], [B, A]]，
     它的每个特征值都会出现两次，对应的实特征向量 [u; w] 就给出 v = u + iw。
     这样只需要一个实 Jacobi，不用单独写复数版本。 */
  function eigHermitian(M, Rre, Rim) {
    var N = 2 * M;
    var S = new Float64Array(N * N);
    var i, j;
    for (i = 0; i < M; i++) {
      for (j = 0; j < M; j++) {
        var a = Rre[i * M + j];
        var b = Rim[i * M + j];
        S[i * N + j] = a;
        S[i * N + (M + j)] = -b;
        S[(M + i) * N + j] = b;
        S[(M + i) * N + (M + j)] = a;
      }
    }
    var res = jacobiSym(N, S);

    var idx = [];
    for (i = 0; i < N; i++) idx.push(i);
    idx.sort(function (x, y) { return res.values[x] - res.values[y]; });

    var values = new Float64Array(M);
    var vre = new Float64Array(M * M), vim = new Float64Array(M * M);
    for (var k = 0; k < M; k++) {
      var col = idx[2 * k];
      values[k] = res.values[col];
      for (i = 0; i < M; i++) {
        vre[i * M + k] = res.vectors[i * N + col];
        vim[i * M + k] = res.vectors[(M + i) * N + col];
      }
    }
    return { values: values, re: vre, im: vim };
  }

  /* ======================================================================
   * 主仿真
   *
   * cfg = { M, spacing, snrDb, angles:[度…], snapshots, seed }
   * ==================================================================== */
  function simulate(cfg) {
    var M = Math.max(1, Math.round(cfg.M));
    var d = cfg.spacing;
    var angles = (cfg.angles || []).slice(0, Math.max(1, Math.round(cfg.sources || 1)));
    var K = Math.max(2, Math.round(cfg.snapshots || 100));
    /* 多径模式下没有独立的“波源角度列表”，但对外报的“信源个数”仍应是声明的那个数 */
    var S = cfg.paths ? Math.max(1, Math.round(cfg.sources || 1)) : angles.length;
    var rand = NS.signal.mulberry32((cfg.seed || 1) >>> 0);

    /* ---- 1. 造数据 X = A·S + N，X 是 M×K ---- */
    var Xre = [], Xim = [];
    var m, k, i;
    for (m = 0; m < M; m++) { Xre.push(new Float64Array(K)); Xim.push(new Float64Array(K)); }

    var sigPower = 1;
    var noiseAmp = Math.sqrt(Math.pow(10, -(cfg.snrDb || 0) / 10) / 2);

    if (cfg.paths && cfg.paths.length) {
      /* 相干多径：所有路径是同一路信号的副本，共用同一串样值，信源协方差因此是秩 1 的，
         这正是 MUSIC 会栽跟头的地方（它假定各信源不相关）。 */
      var pre = new Float64Array(K), pim = new Float64Array(K);
      for (k = 0; k < K; k++) {
        pre[k] = Math.sqrt(sigPower / 2) * gauss(rand);
        pim[k] = Math.sqrt(sigPower / 2) * gauss(rand);
      }
      for (var pi = 0; pi < cfg.paths.length; pi++) {
        var pp = cfg.paths[pi];
        var ap = steering(M, d, pp.angle);
        var gr = pp.gain * Math.cos(pp.phase), gi = pp.gain * Math.sin(pp.phase);
        for (m = 0; m < M; m++) {
          var wr = ap.re[m] * gr - ap.im[m] * gi;
          var wi = ap.re[m] * gi + ap.im[m] * gr;
          for (k = 0; k < K; k++) {
            Xre[m][k] += wr * pre[k] - wi * pim[k];
            Xim[m][k] += wr * pim[k] + wi * pre[k];
          }
        }
      }
    }
    for (i = 0; !cfg.paths && i < S; i++) {
      var a = steering(M, d, angles[i]);
      // 每个信源在各快拍上的复高斯样值
      var sre = new Float64Array(K), sim = new Float64Array(K);
      for (k = 0; k < K; k++) {
        sre[k] = Math.sqrt(sigPower / 2) * gauss(rand);
        sim[k] = Math.sqrt(sigPower / 2) * gauss(rand);
      }
      for (m = 0; m < M; m++) {
        for (k = 0; k < K; k++) {
          Xre[m][k] += a.re[m] * sre[k] - a.im[m] * sim[k];
          Xim[m][k] += a.re[m] * sim[k] + a.im[m] * sre[k];
        }
      }
    }
    for (m = 0; m < M; m++) {
      for (k = 0; k < K; k++) {
        Xre[m][k] += noiseAmp * gauss(rand);
        Xim[m][k] += noiseAmp * gauss(rand);
      }
    }

    /* ---- 2. 样本协方差 R = X X^H / K ---- */
    var Rre = new Float64Array(M * M), Rim = new Float64Array(M * M);
    for (i = 0; i < M; i++) {
      for (var j = 0; j < M; j++) {
        var sr = 0, si = 0;
        for (k = 0; k < K; k++) {
          // X[i][k] · conj(X[j][k])
          sr += Xre[i][k] * Xre[j][k] + Xim[i][k] * Xim[j][k];
          si += Xim[i][k] * Xre[j][k] - Xre[i][k] * Xim[j][k];
        }
        Rre[i * M + j] = sr / K;
        Rim[i * M + j] = si / K;
      }
    }

    /* ---- 3. 角度网格上的导向矢量 ---- */
    var nTheta = Math.round((90 - (-90)) / THETA_STEP) + 1;
    var theta = new Float64Array(nTheta);
    var A = [];
    for (i = 0; i < nTheta; i++) {
      theta[i] = -90 + i * THETA_STEP;
      A.push(steering(M, d, theta[i]));
    }

    /* ---- 4. 三种空间谱 ---- */
    var bartlett = new Float64Array(nTheta);
    var mvdr = new Float64Array(nTheta);
    var music = null;

    for (i = 0; i < nTheta; i++) {
      bartlett[i] = quadForm(M, Rre, Rim, A[i]) / (M * M);
    }

    // MVDR：先做对角加载再 Cholesky，不然快拍数少时 R 可能是奇异的
    var load = 0;
    for (i = 0; i < M; i++) load += Rre[i * M + i];
    load = Math.max(load / M, 1e-12) * 1e-3;
    var Rlre = Float64Array.from(Rre), Rlim = Float64Array.from(Rim);
    for (i = 0; i < M; i++) Rlre[i * M + i] += load;

    var L = cholesky(M, Rlre, Rlim);
    for (i = 0; i < nTheta; i++) {
      var x = cholSolve(M, L.re, L.im, A[i].re, A[i].im);
      // a^H x
      var qr = 0, qi = 0;
      for (var t = 0; t < M; t++) {
        qr += A[i].re[t] * x.re[t] + A[i].im[t] * x.im[t];
        qi += A[i].re[t] * x.im[t] - A[i].im[t] * x.re[t];
      }
      var denom = Math.hypot(qr, qi);
      mvdr[i] = denom > 1e-15 ? 1 / denom : 0;
    }

    // MUSIC：噪声子空间 = 最小的 M-S 个特征向量
    var eig = eigHermitian(M, Rre, Rim);
    // 多径模式下噪声子空间的维度要用「声明的信源个数」，不是物理路径数 ，
    // 不然 MUSIC 会“作弊”把多径当成多个独立信源，就演不出它被骗的样子了。
    var nNoise = M - (cfg.paths ? Math.max(1, Math.round(cfg.sources || 1)) : S);
    if (nNoise >= 1) {
      music = new Float64Array(nTheta);
      for (i = 0; i < nTheta; i++) {
        var acc = 0;
        // 特征值是按从小到大排的，所以噪声子空间是前面 M−S 个
        for (var e = 0; e < nNoise; e++) {
          var vr = 0, vi = 0;
          for (t = 0; t < M; t++) {
            // conj(v_t) · a_t
            var evr = eig.re[t * M + e], evi = eig.im[t * M + e];
            vr += evr * A[i].re[t] + evi * A[i].im[t];
            vi += evr * A[i].im[t] - evi * A[i].re[t];
          }
          acc += vr * vr + vi * vi;
        }
        music[i] = acc > 1e-15 ? 1 / acc : 0;
      }
    }

    /* ---- 5. 归一化到 0 dB ---- */
    function toDb(arr) {
      if (!arr) return null;
      var mx = 0;
      for (var q = 0; q < arr.length; q++) if (arr[q] > mx) mx = arr[q];
      if (mx <= 0) mx = 1;
      var out = new Float64Array(arr.length);
      for (q = 0; q < arr.length; q++) {
        var r = arr[q] / mx;
        out[q] = r > 1e-6 ? 20 * Math.log10(r) : -120;
      }
      return out;
    }

    var bDb = toDb(bartlett), mDb = toDb(mvdr), uDb = toDb(music);

    return {
      theta: theta,
      M: M, d: d, S: S, K: K,
      angles: cfg.paths ? cfg.paths.map(function (q) { return q.angle; }) : angles.slice(),
      nPaths: cfg.paths ? cfg.paths.length : S,
      declared: cfg.paths ? Math.max(1, Math.round(cfg.sources || 1)) : S,
      snrDb: cfg.snrDb,
      bartlett: bDb,
      mvdr: mDb,
      music: uDb,
      hasMusic: nNoise >= 1,
      noiseDim: Math.max(0, nNoise),
      eigenvalues: eig.values,
      peaks: {
        bartlett: findPeaks(theta, bDb),
        mvdr: findPeaks(theta, mDb),
        music: uDb ? findPeaks(theta, uDb) : []
      }
    };
  }

  /* 找谱峰：只算比最高点低 12 dB 以内的局部极大，再把挨得太近的并成一个 */
  function findPeaks(theta, db) {
    if (!db) return [];
    var i, out = [];
    for (i = 1; i < db.length - 1; i++) {
      if (db[i] >= db[i - 1] && db[i] >= db[i + 1] && db[i] > -12) {
        out.push({ deg: theta[i], db: db[i] });
      }
    }
    var merged = [];
    for (i = 0; i < out.length; i++) {
      var last = merged[merged.length - 1];
      if (last && out[i].deg - last.deg <= 2.5) {
        if (out[i].db > last.db) { last.deg = out[i].deg; last.db = out[i].db; }
      } else {
        merged.push({ deg: out[i].deg, db: out[i].db });
      }
    }
    return merged;
  }

  /* ======================================================================
   * 画空间谱
   * ==================================================================== */
  function draw(ctx, W, H, res, opts) {
    opts = opts || {};
    // clean = true 时只画仪器本身能看到的东西，不画真值虚线和峰读数（测验用）
    var clean = !!opts.clean;
    var padL = 46, padR = 12, padT = 14, padB = 26;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var i;

    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);

    function toX(deg) {
      return padL + ((deg + 90) / 180) * plotW;
    }
    function toY(db) {
      var t = (db - DB_FLOOR) / (0 - DB_FLOOR);
      return padT + (1 - Math.max(0, Math.min(1, t))) * plotH;
    }

    // ---- 网格 ----
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (i = 0; i <= 4; i++) {
      var gy = padT + (i * plotH) / 4;
      ctx.moveTo(padL, gy + 0.5);
      ctx.lineTo(W - padR, gy + 0.5);
    }
    for (i = 0; i <= 6; i++) {
      var gx = padL + (i * plotW) / 6;
      ctx.moveTo(gx + 0.5, padT);
      ctx.lineTo(gx + 0.5, H - padB);
    }
    ctx.stroke();

    ctx.strokeStyle = COL.axis;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);

    // ---- 纵轴 ----
    ctx.fillStyle = COL.text;
    ctx.font = '10px "SF Mono", Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (i = 0; i <= 4; i++) ctx.fillText(-(i * 10) + '', padL - 6, toY(-(i * 10)));
    ctx.save();
    ctx.translate(11, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('dB', 0, 0);
    ctx.restore();

    // ---- 横轴 ----
    ctx.textBaseline = 'top';
    for (i = 0; i <= 6; i++) {
      var deg = -90 + i * 30;
      ctx.textAlign = i === 0 ? 'left' : (i === 6 ? 'right' : 'center');
      ctx.fillText((deg > 0 ? '+' : '') + deg + '°', toX(deg), H - padB + 6);
    }

    // ---- 真实来波方向 ----
    if (!clean) {
      ctx.save();
      ctx.strokeStyle = COL.truth;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.75;
      for (i = 0; i < res.angles.length; i++) {
        var tx = toX(res.angles[i]);
        ctx.beginPath();
        ctx.moveTo(tx + 0.5, padT);
        ctx.lineTo(tx + 0.5, H - padB);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- 三条曲线 ----
    var show = opts.show || { bartlett: true, mvdr: true, music: true };
    var curves = [
      { key: 'bartlett', data: res.bartlett, color: COL.bartlett, w: 1.6 },
      { key: 'mvdr', data: res.mvdr, color: COL.mvdr, w: 1.6 },
      { key: 'music', data: res.music, color: COL.music, w: 2.0 }
    ];
    for (var c = 0; c < curves.length; c++) {
      var cv = curves[c];
      if (!cv.data || show[cv.key] === false) continue;
      ctx.save();
      ctx.strokeStyle = cv.color;
      ctx.lineWidth = cv.w;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      var started = false;
      for (i = 0; i < res.theta.length; i++) {
        var db = cv.data[i];
        var x = toX(res.theta[i]);
        var y = db < DB_FLOOR ? padT + plotH : toY(db);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
      ctx.restore();
    }

    // ---- 真值标注：画在曲线之后，压在绘图区底部，不会被曲线挡住 ----
    if (!clean) {
      ctx.font = '10px "SF Mono", Consolas, monospace';
      ctx.fillStyle = COL.truth;
      ctx.textBaseline = 'bottom';
      for (i = 0; i < res.angles.length; i++) {
        var ttx = toX(res.angles[i]);
        if (ttx < padL + 26) { ctx.textAlign = 'left'; ttx = padL + 3; }
        else if (ttx > W - padR - 26) { ctx.textAlign = 'right'; ttx = W - padR - 3; }
        else { ctx.textAlign = 'center'; }
        ctx.fillText(res.angles[i] + '°', ttx, H - padB - 5);
      }
    }

    // ---- 图例 ----
    var legend = [];
    if (show.bartlett !== false) legend.push(['Bartlett', COL.bartlett]);
    if (show.mvdr !== false) legend.push(['MVDR', COL.mvdr]);
    if (res.music && show.music !== false) legend.push(['MUSIC', COL.music]);

    ctx.font = '10px "SF Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';
    var lx = W - padR - 6;
    for (i = legend.length - 1; i >= 0; i--) {
      ctx.textAlign = 'right';
      ctx.fillStyle = legend[i][1];
      ctx.fillText(legend[i][0], lx, padT + 10 + i * 13);
      var tw = ctx.measureText(legend[i][0]).width;
      ctx.fillRect(lx - tw - 12, padT + 10 + i * 13 - 1.5, 8, 3);
    }

    // ---- 峰读数 ----
    // ---- 峰读数 ----
    if (!clean) {
      if (res.peaks && res.peaks.music && res.peaks.music.length) {
        var txt = res.peaks.music.map(function (p) { return p.deg.toFixed(1) + '°'; }).join(' / ');
        ctx.textAlign = 'left';
        ctx.fillStyle = COL.music;
        ctx.fillText('MUSIC 峰：' + txt, padL + 6, padT + 10);
      } else if (!res.hasMusic) {
        ctx.textAlign = 'left';
        ctx.fillStyle = COL.warn;
        ctx.fillText('阵元数 ≤ 信源数，MUSIC 的噪声子空间是空的', padL + 6, padT + 10);
      }
    }
  }

  function fmtDeg(v) {
    return (v > 0 ? '+' : '') + Number(v).toFixed(0) + '°';
  }

  NS.array = {
    simulate: simulate,
    steering: steering,
    draw: draw,
    fmtDeg: fmtDeg,
    findPeaks: findPeaks,
    COL: COL,
    DB_FLOOR: DB_FLOOR,
    THETA_STEP: THETA_STEP
  };
})();
