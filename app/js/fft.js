/* ==========================================================================
 * fft.js — 频谱分析
 *
 * 这里的信号是严格周期的（基频 f），所以用「整周期同步采样 + DFT」求谐波谱：
 * 采一个完整周期，N 点，则第 k 根谱线正好是第 k 次谐波，频率 = k·f。
 * 这不是近似，是精确的傅里叶系数。
 * ========================================================================== */
(function (NS) {
  'use strict';

  var TWO_PI = Math.PI * 2;

  /* 原地 radix-2 FFT */
  function fft(re, im) {
    var n = re.length;
    var i, j, k, m, half, step, wRe, wIm, tRe, tIm, ang, c, s;

    // 位反转
    for (i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        tRe = re[i]; re[i] = re[j]; re[j] = tRe;
        tIm = im[i]; im[i] = im[j]; im[j] = tIm;
      }
    }

    // 蝶形
    for (step = 2; step <= n; step <<= 1) {
      half = step >> 1;
      ang = -TWO_PI / step;
      wRe = Math.cos(ang);
      wIm = Math.sin(ang);
      for (m = 0; m < n; m += step) {
        var curRe = 1, curIm = 0;
        for (k = 0; k < half; k++) {
          var a = m + k;
          var b = a + half;
          tRe = re[b] * curRe - im[b] * curIm;
          tIm = re[b] * curIm + im[b] * curRe;
          re[b] = re[a] - tRe;
          im[b] = im[a] - tIm;
          re[a] += tRe;
          im[a] += tIm;
          var nRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nRe;
        }
      }
    }
  }

  /* 谐波谱：采一个完整周期，返回各次谐波的幅度（V，单边） */
  function harmonicSpectrum(model, freq, N) {
    N = N || 1024;
    var re = new Float64Array(N);
    var im = new Float64Array(N);
    var T = 1 / Math.max(freq, 1e-9);
    var i;

    for (i = 0; i < N; i++) {
      re[i] = model.value((i * T) / N);
      im[i] = 0;
    }

    fft(re, im);

    var half = N >> 1;
    var out = new Array(half + 1);
    for (i = 0; i <= half; i++) {
      // 单边谱：正频率分量幅度 = 2|X|/N；DC 与奈奎斯特 bin 不乘 2
      var mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      mag = (i === 0 || i === half) ? mag / N : mag / half;
      out[i] = {
        k: i,
        freq: i * freq,
        amp: mag,
        dbfs: mag > 1e-12 ? 20 * Math.log10(mag) : -240
      };
    }
    return { bins: out, freq: freq, N: N };
  }

  /* 从谐波谱里挑出有意义的谱线（用于画 stem 图和读数） */
  function significantLines(spectrum, floorDb) {
    floorDb = floorDb === undefined ? -80 : floorDb;
    var out = [];
    var bins = spectrum.bins;
    for (var i = 0; i < bins.length; i++) {
      if (bins[i].dbfs > floorDb) out.push(bins[i]);
    }
    return out;
  }

  /* 总谐波失真 THD（相对基波，%） */
  function thd(spectrum) {
    var bins = spectrum.bins;
    var fundamental = 0, rest = 0;
    for (var i = 1; i < bins.length; i++) {
      if (i === 1) fundamental = bins[i].amp;
      else rest += bins[i].amp * bins[i].amp;
    }
    if (fundamental <= 1e-12) return 0;
    return (Math.sqrt(rest) / fundamental) * 100;
  }

  NS.fft = {
    fft: fft,
    harmonicSpectrum: harmonicSpectrum,
    significantLines: significantLines,
    thd: thd
  };
})((window.SignalLab = window.SignalLab || {}));
