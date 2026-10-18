/* ==========================================================================
 * signal.js — 信号模型层
 *
 * 这里是整个实验台的"物理真相"：给定参数，算出真实信号 s(t)。
 *
 * 两个关键设计：
 *   1. 波形用「截断傅里叶级数」实现，不是画出来的假图。
 *      方波 = 奇次谐波叠加。把带宽限制调低，谐波被砍掉，方波就真的变圆角。
 *      这是"时域↔频域"能被学生看见的物理基础。
 *   2. 采样是真实的。示波器以 fs 对 s(t) 采样，fs < 2f 时屏幕上出现的就是
 *      混叠后的假波形，不是我们画上去的动画，是算出来的。
 * ========================================================================== */
(function (NS) {
  'use strict';

  var TWO_PI = Math.PI * 2;

  /* --- 确定性伪随机：同一次采集内噪声稳定，方便读数 --------------------- */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 标准正态（Box-Muller），用给定随机源 */
  function gauss(rnd) {
    var u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
  }

  /* --- 理想波形：theta 为弧度相位 ---------------------------------------
   * kMax = 保留的最高谐波次数（由带宽限制决定）。
   * 正弦/三角用闭式；方波/锯齿/脉冲用级数，这样带宽限制才有物理意义。
   * 返回值统一在 [-1, 1] 附近（脉冲为 [0, 1]）。
   * -------------------------------------------------------------------- */
  function idealValue(wave, theta, duty, kMax) {
    var n, s;

    switch (wave) {
      case 'sine':
        return Math.sin(theta);

      case 'triangle': {
        // 闭式三角波：p=0 处 -1，p=0.5 处 +1
        var p = theta / TWO_PI;
        p = p - Math.floor(p);
        return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
      }

      case 'square': {
        // 占空比 d 的方波：DC = 2d-1，n 次谐波幅度 4/(nπ)·sin(nπd)
        s = 2 * duty - 1;
        for (n = 1; n <= kMax; n++) {
          s += (4 / (n * Math.PI)) * Math.sin(n * Math.PI * duty) * Math.cos(n * theta);
        }
        return s;
      }

      case 'sawtooth': {
        // 锯齿：(2/π)·Σ (-1)^(n+1) sin(nθ)/n
        s = 0;
        for (n = 1; n <= kMax; n++) {
          s += (2 / (n * Math.PI)) * (n % 2 === 1 ? 1 : -1) * Math.sin(n * theta);
        }
        return s;
      }

      case 'pulse': {
        // 单极性脉冲（占空比 d）：DC = d，n 次谐波幅度 2/(nπ)·sin(nπd)
        s = duty;
        for (n = 1; n <= kMax; n++) {
          s += (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty) * Math.cos(n * theta);
        }
        return s;
      }

      default:
        return Math.sin(theta);
    }
  }

  /* 由带宽限制推出保留多少次谐波 */
  var KMAX_CAP = 199;
  function harmonicCount(bandwidth, freq) {
    if (!isFinite(bandwidth) || bandwidth <= 0) return KMAX_CAP;
    return Math.max(1, Math.min(KMAX_CAP, Math.floor(bandwidth / Math.max(freq, 1e-9))));
  }

  /* --- 信号模型 --------------------------------------------------------- */
  function makeModel(p) {
    var omega = TWO_PI * p.freq;
    var phi = (p.phase * Math.PI) / 180;
    var kMax = harmonicCount(p.bandwidth, p.freq);

    return {
      kMax: kMax,
      /* 无噪理想电压（V） */
      value: function (t) {
        return p.amp * idealValue(p.wave, omega * t + phi, p.duty, kMax) + p.offset;
      }
    };
  }

  /* --- 触发 -------------------------------------------------------------
   * 在信号的一个周期内找"上升沿穿过触发电平"的时刻。
   * 找不到（电平超出信号范围）返回 null，真实示波器这时波形就会乱跑。
   * 用无噪信号搜索，避免噪声把触发点抖得到处都是。
   * -------------------------------------------------------------------- */
  function findTrigger(model, level, freq) {
    if (!(freq > 0)) return null;

    var T = 1 / freq;
    var r = signalRange(model, freq);
    var span = Math.max(r.max - r.min, 1e-12);

    // 电平落在信号范围之外 → 示波器真的找不到触发点
    if (level > r.max || level < r.min) return null;

    // 电平贴着边界时（比如正好在峰值上）往内收一点，保证真的存在交点；
    // 否则在浮点误差下会永远找不到那个“恰好等于”的时刻。
    var guard = span * 1e-3;
    var lv = Math.min(Math.max(level, r.min + guard), r.max - guard);
    var tol = span * 1e-9;   // 只为绕开 sin(2πn) 这类浮点噪声

    var steps = 1200;        // 分辨率 = T/1200，对教学足够，且不卡手
    var prev = model.value(0);
    var i, t, cur, frac, denom;

    for (i = 1; i <= steps; i++) {
      t = (i * T) / steps;
      cur = model.value(t);
      if (prev < lv && cur >= lv - tol) {
        denom = cur - prev;
        frac = Math.abs(denom) > 1e-15 ? (lv - prev) / denom : 0;
        if (frac < 0) frac = 0;
        if (frac > 1) frac = 1;
        return ((i - 1 + frac) * T) / steps;
      }
      prev = cur;
    }
    return null;
  }


  /* 信号的实际取值区间（用于判断触发电平是否在范围内） */
  function signalRange(model, freq) {
    var T = 1 / Math.max(freq, 1e-9);
    var steps = 600;
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < steps; i++) {
      var v = model.value((i * T) / steps);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return { min: lo, max: hi };
  }

  /* --- 触发比较器看到的信号 --------------------------------------------
   * 真实示波器的触发支路在耦合与探头衰减之后，所以它看到的不是原始信号，
   * 而是和屏幕上同一条：AC 耦合先隔直流，×10 探头再衰减 10 倍。
   * 触发电平是“屏幕上的读数”，所以比较时也用同一条信号。
   * -------------------------------------------------------------------- */
  function triggerPath(model, p) {
    var atten = 1 / Math.max(p.probe, 1);

    if (p.coupling !== 'AC') {
      return { kMax: model.kMax, value: function (t) { return model.value(t) * atten; } };
    }

    // 隔掉的直流 = 一个周期内的均值
    var T = 1 / Math.max(p.freq, 1e-9);
    var steps = 256;
    var mean = 0;
    for (var i = 0; i < steps; i++) mean += model.value((i * T) / steps);
    mean /= steps;

    return {
      kMax: model.kMax,
      value: function (t) { return (model.value(t) - mean) * atten; }
    };
  }


  /* --- 采集：示波器真正做的事 -------------------------------------------
   * 屏幕 10 格水平，时基 timePerDiv 秒/格 → 显示窗 Tdisp = 10·timePerDiv
   * 采样点数 N = Tdisp · fs     ← 采样率低的时候，一屏就只有几个点
   * 触发决定时间原点 t0
   * -------------------------------------------------------------------- */
  function acquire(p, model, frame, cachedTrigger) {
    var Tdisp = 10 * p.timePerDiv;
    var N = Math.round(Tdisp * p.sampleRate);
    N = Math.max(2, Math.min(5000, N));
    var dt = 1 / p.sampleRate;

    // 触发时刻只跟参数有关，主程序会缓存它（拖动时不必每帧重算）
    var trig = cachedTrigger !== undefined ? cachedTrigger : findTrigger(model, p.triggerLevel, p.freq);
    var triggered = trig !== null;
    var t0;

    if (triggered) {
      t0 = trig;
    } else {
      // 自由运行：时间原点每帧往前跑一点，屏幕上就是波形在"跑"
      t0 = ((frame || 0) * 0.03) / Math.max(p.freq, 1e-9);
    }

    var rnd = mulberry32(0x9e3779b9); // 固定种子 → 噪声稳定，便于读数
    var samples = new Float64Array(N);
    for (var k = 0; k < N; k++) {
      var v = model.value(t0 + k * dt);
      if (p.noise > 0) v += p.noise * gauss(rnd);
      samples[k] = v;
    }

    // 探头衰减：×10 探头把电压压到 1/10 送进示波器
    var atten = 1 / Math.max(p.probe, 1);

    // 耦合：AC 隔掉直流（按本屏记录的均值估）
    var displayed;
    var removedDC = 0;
    if (p.coupling === 'AC') {
      var mean = 0;
      for (var m = 0; m < N; m++) mean += samples[m];
      mean /= N;
      removedDC = mean;
      displayed = new Float64Array(N);
      for (var q = 0; q < N; q++) displayed[q] = (samples[q] - mean) * atten;
    } else {
      displayed = new Float64Array(N);
      for (var r = 0; r < N; r++) displayed[r] = samples[r] * atten;
    }

    return {
      samples: displayed,
      N: N,
      dt: dt,
      t0: t0,
      triggered: triggered,
      removedDC: removedDC,
      Tdisp: Tdisp,
      // 每屏显示多少个信号周期
      periods: Tdisp * p.freq,
      // 每周期采到几个点
      samplesPerPeriod: p.sampleRate / Math.max(p.freq, 1e-9)
    };
  }

  NS.signal = {
    makeModel: makeModel,
    findTrigger: findTrigger,
    signalRange: signalRange,
    triggerPath: triggerPath,
    acquire: acquire,
    idealValue: idealValue,
    harmonicCount: harmonicCount,
    mulberry32: mulberry32,
    KMAX_CAP: KMAX_CAP
  };
})((window.SignalLab = window.SignalLab || {}));
