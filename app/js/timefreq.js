/* ==========================================================================
 * timefreq.js — 时频图（语谱图 / spectrogram）
 *
 * 前面几块屏幕各自只看一个侧面：
 *   示波器 = 电压随时间  → 看不出有哪些频率
 *   频谱仪 = 频率分布    → 看不出频率什么时候出现
 * 时频图把两根轴同时摆出来：横轴时间、纵轴频率、亮度是能量。
 * 只有非平稳信号在这里才露出真面目，频率其实是会变的。
 *
 * 这个屏幕真正要教的只有一句话：
 *   短时傅里叶变换给一个窗，窗里假设"信号是平稳的"。
 *   窗长 N 点、采样率 fs 时，时间分辨 Δt = N/fs，频率分辨 Δf = fs/N，
 *   两者乘积恒等于 1。想要时间准就得牺牲频率准，反之亦然。
 *
 * 「双音先后」和「双音同时」是一对专门摆出来的对照：
 *   窗比两个音的间隔还长时，两个音落进同一个窗，被糊成一模一样。
 *   这不是画错了，这是时频分辨率的物理下限。
 * ========================================================================== */
(function (NS) {
  'use strict';

  var TWO_PI = Math.PI * 2;

  var COL = {
    bg: '#16202c',
    grid: '#1e2c3d',
    axis: '#3a5a78',
    text: '#a9b6c6',
    textBright: '#e3ebf5',
    curve: '#79c0ff',
    warn: '#ff7b72',
    good: '#7ee787'
  };

  var DB_FLOOR = -50;          // 相对峰值的显示下限，dB
  var DURATION = 0.2;          // 每次分析的固定时长，秒（刻意短：音也短，长窗必然糊）
  var MAX_COLS = 220;          // 时间方向最多画多少列，多了就抽稀

  /* 每个场景自己的结构：真实的频率—时间轨迹。
   * 面板、知识卡片、测试都从这里读，避免各写一份。 */
  var SCENARIOS = [
    {
      id: 'steady', name: '单音持续', freqLabel: '频率 f',
      hint: '从头到尾一个频率，时频图是一条水平线',
      blurb: '平稳信号。时频图上一条水平亮线，高度就是频率，亮度就是幅度。'
    },
    {
      id: 'chirp', name: '线性调频', freqLabel: '起频 f₁ / 止频 f₂',
      hint: '频率一路往上爬，时频图上是一条斜线',
      blurb: '频率随时间线性变化（雷达 chirp、扫频仪都是它）。斜线的斜率就是调频速率，单位 Hz/s。'
    },
    {
      id: 'burst', name: '突发脉冲', freqLabel: '载频 f',
      hint: '只有一小段时间里有信号，其余时间是空的',
      blurb: '时间上一小段、频率上一根线，时频图上的一个"点"。它有多短，取决于你的窗有多短。'
    },
    {
      id: 'seq', name: '双音先后', freqLabel: '第一音 f₁ / 第二音 f₂',
      hint: '两个频率一前一后，从不重叠',
      blurb: '先响 f₁、再响 f₂，两个音在时间上没有交集。短窗能把这"一前一后"分开；窗一长就分不开了。'
    },
    {
      id: 'sim', name: '双音同时', freqLabel: '音 1 f₁ / 音 2 f₂',
      hint: '两个频率同时存在，占同样长的时间',
      blurb: '两个音真正同时存在。这是「双音先后」长窗下会退化成的那张图，拿它当参照物。'
    }
  ];

  function scenById(id) {
    for (var i = 0; i < SCENARIOS.length; i++) {
      if (SCENARIOS[i].id === id) return SCENARIOS[i];
    }
    return SCENARIOS[0];
  }

  /* 每个场景的时间结构，单位是**秒**（绝对时间，不是比例）。
   * burst / seq / sim 都挤在 0.08–0.12 s 这同一段 40 ms 里，只在“两个音怎么排”上不同：
   *   burst = 一个 10 ms 的短音，居中
   *   seq   = 两个 20 ms 的音，一前一后首尾相接，时间上没有交集
   *   sim   = 两个音同时压在 40 ms 里
   * 三个场景占的时间总宽度刻意一样，这样长窗下它们才真的会长得像。 */
  var SPANS = {
    burst: [[0.095, 0.105]],
    seq: [[0.080, 0.100], [0.100, 0.120]],
    sim: [[0.080, 0.120], [0.080, 0.120]]
  };

  function spansOf(sc, T) {
    var raw = SPANS[sc];
    if (!raw) return [];
    var out = [], i;
    for (i = 0; i < raw.length; i++) {
      out.push({ t0: raw[i][0], t1: raw[i][1] });
    }
    return out;
  }

  function inSpan(t, s) { return t >= s.t0 && t < s.t1; }

  /* ======================================================================
   * 解析用的数学量
   * ==================================================================== */

  /* 时间分辨：一个窗占多长时间 */
  function dtOf(N, fs) { return N / fs; }
  /* 频率分辨：一个窗在频域的一个格子有多宽 */
  function dfOf(N, fs) { return fs / N; }

  /* 窗长 N 点、采样率 fs 下，时频图里那个"信号最短能有多短"：
   * 比一个窗还短的东西，在时间轴上一定会被拖到一个窗那么宽。 */
  function scenarioFeatureSec(sc, T, N, fs) {
    var sp = spansOf(sc, T);
    if (!sp.length) return Infinity;              // steady / chirp 一直在
    var m = Infinity, i, len;
    for (i = 0; i < sp.length; i++) {
      len = sp[i].t1 - sp[i].t0;                  // 最短的那一段决定会不会被拖宽
      if (len < m) m = len;
    }
    return m;
  }

  /* ======================================================================
   * 窗函数
   * ==================================================================== */
  function makeWindow(kind, N) {
    var w = new Float64Array(N);
    var i, n;
    for (i = 0; i < N; i++) {
      if (kind === 'rect') { w[i] = 1; continue; }
      if (kind === 'blackman') {
        w[i] = 0.42 - 0.5 * Math.cos(TWO_PI * i / (N - 1)) + 0.08 * Math.cos(2 * TWO_PI * i / (N - 1));
        continue;
      }
      w[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / (N - 1));   // hann
    }
    /* 归一化到"相干增益为 1"：单频信号做 FFT 后幅度不随窗长乱变 */
    var sum = 0;
    for (i = 0; i < N; i++) sum += w[i];
    if (sum > 1e-12) for (i = 0; i < N; i++) w[i] *= 2 / sum;
    return w;
  }

  /* ======================================================================
   * 造信号
   * ==================================================================== */
  function lcg(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* 返回长度为 n 的时域样本。真实频率轨迹见 truth()。 */
  function genSignal(sc, cfg, n, fs) {
    var x = new Float64Array(n);
    var T = n / fs;
    var sp = spansOf(sc, T);
    var f1 = cfg.f1, f2 = cfg.f2;
    var i, t, u;
    for (i = 0; i < n; i++) {
      t = i / fs;
      switch (sc) {
        case 'steady':
          x[i] = Math.sin(TWO_PI * f1 * t);
          break;
        case 'chirp':
          /* 瞬时频率 f(t) = f1 + (f2-f1)·t/T
           * 相位是它的积分：2π(f1·t + (f2-f1)·t²/(2T)) */
          x[i] = Math.sin(TWO_PI * (f1 * t + (f2 - f1) * t * t / (2 * T)));
          break;
        case 'burst':
          x[i] = inSpan(t, sp[0]) ? Math.sin(TWO_PI * f1 * t) : 0;
          break;
        case 'seq':
          if (inSpan(t, sp[0])) x[i] = Math.sin(TWO_PI * f1 * t);
          else if (inSpan(t, sp[1])) x[i] = Math.sin(TWO_PI * f2 * t);
          else x[i] = 0;
          break;
        case 'sim':
          x[i] = inSpan(t, sp[0])
            ? 0.6 * (Math.sin(TWO_PI * f1 * t) + Math.sin(TWO_PI * f2 * t)) : 0;
          break;
        default:
          x[i] = 0;
      }
    }
    var rms = cfg.noise || 0;
    if (rms > 0) {
      var rnd = lcg(20261015);
      var g, v;
      for (i = 0; i < n; i++) {
        /* Box–Muller：两个均匀数造一个高斯数 */
        g = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(TWO_PI * rnd());
        x[i] += g * rms;
      }
    }
    return x;
  }

  /* 真实的频率—时间轨迹，给知识面板和测试当答案键。
   * segments: [{ t0, t1, f0, f1 }]，f0==f1 表示这段是单频。 */
  function truth(sc, cfg, fs) {
    var T = DURATION;
    var sp = spansOf(sc, T);
    var f1 = cfg.f1, f2 = cfg.f2;
    switch (sc) {
      case 'steady':
        return { segments: [{ t0: 0, t1: T, f0: f1, f1: f1 }], timeStructure: false };
      case 'chirp':
        return { segments: [{ t0: 0, t1: T, f0: f1, f1: f2 }], timeStructure: true };
      case 'burst':
        return { segments: [{ t0: sp[0].t0, t1: sp[0].t1, f0: f1, f1: f1 }], timeStructure: true };
      case 'seq':
        return { segments: [
          { t0: sp[0].t0, t1: sp[0].t1, f0: f1, f1: f1 },
          { t0: sp[1].t0, t1: sp[1].t1, f0: f2, f1: f2 }
        ], timeStructure: true, overlap: false };
      case 'sim':
        return { segments: [
          { t0: sp[0].t0, t1: sp[0].t1, f0: f1, f1: f1 },
          { t0: sp[1].t0, t1: sp[1].t1, f0: f2, f1: f2 }
        ], timeStructure: true, overlap: true };
      default:
        return { segments: [], timeStructure: false };
    }
  }

  /* ======================================================================
   * 短时傅里叶变换
   * ==================================================================== */
  function analyze(cfg) {
    var fs = Math.max(100, cfg.sampleRate || 10000);
    var N = Math.max(8, Math.round(cfg.win || 128));
    var n = Math.round(DURATION * fs);
    var x = genSignal(cfg.scenario, cfg, n, fs);

    var ov = Math.max(0, Math.min(90, cfg.overlap || 0)) / 100;
    var step = Math.max(1, Math.round(N * (1 - ov)));
    var win = makeWindow(cfg.winType || 'hann', N);

    var nFrames = Math.max(1, Math.floor((n - N) / step) + 1);
    var stride = Math.max(1, Math.ceil(nFrames / MAX_COLS));
    var cols = Math.max(1, Math.ceil(nFrames / stride));
    var half = N >> 1;
    var rows = Math.max(1, half);

    var S = new Float64Array(cols * rows);
    var re = new Float64Array(N);
    var im = new Float64Array(N);
    var c, k, i, base, mag2, db, maxDb = -Infinity;

    for (c = 0; c < cols; c++) {
      base = Math.min(n - N, c * stride * step);
      if (base < 0) base = 0;
      for (i = 0; i < N; i++) { re[i] = x[base + i] * win[i]; im[i] = 0; }
      NS.fft.fft(re, im);
      for (k = 0; k < rows; k++) {
        mag2 = re[k] * re[k] + im[k] * im[k];
        db = 10 * Math.log10(mag2 + 1e-30);
        S[c * rows + k] = db;
        if (db > maxDb) maxDb = db;
      }
    }

    /* 相对峰值归一化，再压到地板上 */
    if (!isFinite(maxDb)) maxDb = 0;
    for (i = 0; i < S.length; i++) {
      db = S[i] - maxDb;
      S[i] = db < DB_FLOOR ? DB_FLOOR : db;
    }

    var dt = dtOf(N, fs);
    var df = dfOf(N, fs);
    var sep = Math.abs((cfg.f2 || 0) - (cfg.f1 || 0));
    var feat = scenarioFeatureSec(cfg.scenario, DURATION, N, fs);

    return {
      scenario: cfg.scenario,
      scen: scenById(cfg.scenario),
      cols: cols, rows: rows, S: S,
      N: N, fs: fs, n: n, nFrames: nFrames, stride: stride, step: step,
      fMax: fs / 2, tMax: DURATION,
      dt: dt, df: df, winSec: dt, product: dt * df,
      sepHz: sep,
      resolvesFreq: sep > df,
      featureSec: feat,
      /* 比窗还短的东西，时间轴上一定会被拖到一个窗那么宽 */
      smeared: isFinite(feat) && feat < dt,
      /* 两个音能不能在时间上分开：每个音的长度比窗长还短，就分不开了 */
      mergesInTime: cfg.scenario === 'seq'
        && (SPANS.seq[0][1] - SPANS.seq[0][0]) < dt,
      truth: truth(cfg.scenario, cfg, fs),
      at: function (col, row) {
        col = Math.max(0, Math.min(cols - 1, col | 0));
        row = Math.max(0, Math.min(rows - 1, row | 0));
        return S[col * rows + row];
      },
      /* 某一列里峰值落在哪个频率上，Hz */
      peakFreqOf: function (col) {
        col = Math.max(0, Math.min(cols - 1, col | 0));
        var best = 0, bv = -Infinity;
        for (var r = 0; r < rows; r++) {
          var v = S[col * rows + r];
          if (v > bv) { bv = v; best = r; }
        }
        return best * df;
      },
      /* 某一列在某频率附近的能量（dB），用来判断"这个音在不在这一帧里" */
      energyNear: function (col, hz) {
        var k = Math.round(hz / df);
        var best = DB_FLOOR;
        for (var d = -1; d <= 1; d++) {
          var v = this.at(col, k + d);
          if (v > best) best = v;
        }
        return best;
      }
    };
  }

  /* ======================================================================
   * 画
   * ==================================================================== */

  /* 深底 → 蓝 → 青 → 绿 → 黄 → 白，够看出强弱又不像彩虹那样骗人 */
  var LUT = (function () {
    var stops = [
      [0.00, 8, 11, 16],
      [0.08, 16, 30, 54],
      [0.22, 22, 66, 104],
      [0.38, 24, 110, 138],
      [0.54, 38, 156, 140],
      [0.70, 104, 192, 112],
      [0.86, 208, 214, 92],
      [1.00, 245, 248, 236]
    ];
    var lut = new Uint8Array(256 * 3);
    var i, j, t, a, b;
    for (i = 0; i < 256; i++) {
      t = i / 255;
      for (j = 0; j < stops.length - 1; j++) {
        if (t <= stops[j + 1][0] || j === stops.length - 2) break;
      }
      a = stops[j]; b = stops[j + 1];
      var f = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
      f = f < 0 ? 0 : (f > 1 ? 1 : f);
      lut[i * 3] = Math.round(a[1] + (b[1] - a[1]) * f);
      lut[i * 3 + 1] = Math.round(a[2] + (b[2] - a[2]) * f);
      lut[i * 3 + 2] = Math.round(a[3] + (b[3] - a[3]) * f);
    }
    return lut;
  })();

  var off = null, offCtx = null, offW = 0, offH = 0;
  function getOff(c, r) {
    if (!off) {
      off = document.createElement('canvas');
      offCtx = off.getContext('2d');
    }
    if (offW !== c || offH !== r) {
      off.width = c; off.height = r; offW = c; offH = r;
    }
    return offCtx;
  }

  function fmtHz(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(v / 1e6 < 10 ? 2 : 1) + ' MHz';
    if (v >= 1e3) return (v / 1e3).toFixed(v / 1e3 < 10 ? 2 : 1) + ' kHz';
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' Hz';
  }
  function fmtMs(sec) {
    if (sec >= 1) return sec.toFixed(2) + ' s';
    if (sec >= 1e-3) return (sec * 1e3).toFixed(sec * 1e3 < 10 ? 2 : 1) + ' ms';
    return (sec * 1e6).toFixed(0) + ' µs';
  }

  function draw(ctx, W, H, res, opts) {
    var clean = !!(opts && opts.clean);
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);
    if (!res || typeof document === 'undefined') return;

    var padL = 50, padR = 10, padT = clean ? 14 : 30, padB = 24;
    var infoW = clean ? 0 : Math.min(184, Math.max(0, W * 0.22));
    var plotW = W - padL - padR - infoW;
    var plotH = H - padT - padB;
    if (plotW < 40 || plotH < 30) return;

    var i, x, y;
    function toX(t) { return padL + (t / res.tMax) * plotW; }
    function toY(f) { return padT + plotH - (f / res.fMax) * plotH; }

    /* ---- 网格 ---- */
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (i = 0; i <= 4; i++) {
      y = padT + (i * plotH) / 4;
      ctx.moveTo(padL, y + 0.5); ctx.lineTo(padL + plotW, y + 0.5);
    }
    for (i = 0; i <= 8; i++) {
      x = padL + (i * plotW) / 8;
      ctx.moveTo(x + 0.5, padT); ctx.lineTo(x + 0.5, padT + plotH);
    }
    ctx.stroke();

    /* ---- 语谱图本体：先在离屏画布上按"一列一像素"点出来，再整块贴上去 ----
     * 直接在主画布上逐格 fillRect 的话，窗长 512 时一屏要画几万个小方块。 */
    var octx = getOff(res.cols, res.rows);
    var img = octx.createImageData(res.cols, res.rows);
    var px = img.data;
    var span = 0 - DB_FLOOR;
    /* 注意两边的存储顺序不一样：ImageData 是「行优先」（y 在外、x 在内），
     * 而 S 是「列优先」（S[col*rows + row]）。必须显式换算下标 ，
     * 照同一个下标直接填会把语谱图转置，看上去就像频率全错了。 */
    var c, k, v, ci, o;
    for (c = 0; c < res.cols; c++) {
      for (k = 0; k < res.rows; k++) {
        v = (res.S[c * res.rows + k] - DB_FLOOR) / span;   // 地板→0，峰值→1
        if (v < 0) v = 0; else if (v > 1) v = 1;
        ci = (v * 255) | 0;
        o = (k * res.cols + c) * 4;
        px[o] = LUT[ci * 3];
        px[o + 1] = LUT[ci * 3 + 1];
        px[o + 2] = LUT[ci * 3 + 2];
        px[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);

    ctx.save();
    /* 频率轴 0 在下面，而图像第 0 行在上面，竖直翻一下就对上了 */
    ctx.translate(padL, padT + plotH);
    ctx.scale(1, -1);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, plotW, plotH);
    ctx.restore();

    /* ---- 边框 ---- */
    ctx.strokeStyle = COL.axis;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);

    /* ---- 纵轴：频率 ---- */
    ctx.fillStyle = COL.text;
    ctx.font = '10px "SF Mono", Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (i = 0; i <= 4; i++) {
      var fv = (res.fMax * i) / 4;
      ctx.fillText(fmtHz(fv), padL - 6, toY(fv));
    }
    ctx.save();
    ctx.translate(11, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('频率', 0, 0);
    ctx.restore();

    /* ---- 横轴：时间 ---- */
    ctx.textBaseline = 'top';
    for (i = 0; i <= 5; i++) {
      var tv = (res.tMax * i) / 5;
      ctx.textAlign = i === 0 ? 'left' : (i === 5 ? 'right' : 'center');
      ctx.fillText(fmtMs(tv), toX(tv), padT + plotH + 6);
    }

    /* ---- 奈奎斯特标记 ---- */
    if (!clean) {
      ctx.fillStyle = COL.warn;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('fs/2', padL + plotW - 4, padT + 3);
    }

    /* ---- 顶部一行：场景 + 窗长 ---- */
    if (!clean) {
      ctx.fillStyle = COL.textBright;
      ctx.font = '11px "SF Mono", Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(res.scen.name + '　窗长 ' + res.N + ' 点 = ' + fmtMs(res.winSec),
        padL, 8);
    }

    if (clean || infoW <= 0) return;

    /* ---- 右栏：Δτ / Δf 与色标 ----
     * 这一栏是这个屏幕的教学重点：窗长一动，两边一涨一落，乘积恒定。 */
    var ix = padL + plotW + 14;
    var iy = padT + 2;
    var iw = W - ix - 8;
    if (iw < 80) return;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    ctx.fillStyle = COL.text;
    ctx.font = '10px "SF Mono", Consolas, monospace';
    ctx.fillText('这个窗的分辨能力', ix, iy);
    iy += 16;

    ctx.font = '11px "SF Mono", Consolas, monospace';
    ctx.fillStyle = COL.curve;
    ctx.fillText('时间 Δt = ' + fmtMs(res.dt), ix, iy);
    iy += 15;
    ctx.fillText('频率 Δf = ' + fmtHz(res.df), ix, iy);
    iy += 15;

    ctx.fillStyle = COL.textBright;
    ctx.fillText('Δt · Δf = ' + res.product.toFixed(2), ix, iy);
    iy += 18;

    ctx.fillStyle = COL.text;
    ctx.font = '10px "SF Mono", Consolas, monospace';
    ctx.fillText('窗长 ' + res.N + ' 点 @ ' + fmtHz(res.fs), ix, iy);
    iy += 13;
    ctx.fillText('每 ' + fmtMs(res.step / res.fs) + ' 出一帧', ix, iy);
    iy += 13;
    ctx.fillText('共 ' + res.nFrames + ' 帧', ix, iy);
    iy += 18;

    /* 色标 */
    var barH = Math.max(28, Math.min(72, H - iy - padB - 34));
    var barW = 10;
    for (i = 0; i < barH; i++) {
      var frac = 1 - i / (barH - 1);
      ci = (frac * 255) | 0;
      ctx.fillStyle = 'rgb(' + LUT[ci * 3] + ',' + LUT[ci * 3 + 1] + ',' + LUT[ci * 3 + 2] + ')';
      ctx.fillRect(ix, iy + i, barW, 1);
    }
    ctx.strokeStyle = COL.axis;
    ctx.strokeRect(ix + 0.5, iy + 0.5, barW, barH);
    ctx.fillStyle = COL.text;
    ctx.fillText('0 dB', ix + barW + 4, iy - 1);
    ctx.fillText(DB_FLOOR + '', ix + barW + 4, iy + barH - 9);

    return { cols: res.cols, rows: res.rows };
  }

  NS.timefreq = {
    analyze: analyze,
    draw: draw,
    spansOf: spansOf,
    SCENARIOS: SCENARIOS,
    scenById: scenById,
    truth: truth,
    genSignal: genSignal,
    makeWindow: makeWindow,
    dtOf: dtOf,
    dfOf: dfOf,
    fmtHz: fmtHz,
    fmtMs: fmtMs,
    DURATION: DURATION,
    DB_FLOOR: DB_FLOOR,
    COL: COL
  };
})((window.SignalLab = window.SignalLab || {}));
