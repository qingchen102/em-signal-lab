/* ==========================================================================
 * spectrum.js — 频谱仪
 *
 * 画的是谐波谱（线谱），因为信号是严格周期的：谱线在 f, 2f, 3f …
 * 纵轴 dBc（相对基波），横轴频率。
 *
 * 屏上叠两条标记线，把三件事串起来：
 *   - 红色虚线 = 示波器采样率的一半（奈奎斯特）→ 超过它的谱线会被折叠回来
 *   - 蓝色虚线 = 当前设置的带宽限制 → 决定了保留多少次谐波
 * ========================================================================== */
(function (NS) {
  'use strict';

  var COL = {
    bg: '#16202c',
    grid: '#1e2c3d',
    axis: '#3a5a78',
    stem: '#79c0ff',
    stemTop: '#a5d6ff',
    nyquist: '#ff7b72',
    bandwidth: '#d2a8ff',
    text: '#a9b6c6',
    textBright: '#e3ebf5'
  };

  var DB_FLOOR = -80;

  function fmtHz(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(v / 1e6 < 10 ? 2 : 1) + ' MHz';
    if (v >= 1e3) return (v / 1e3).toFixed(v / 1e3 < 10 ? 2 : 1) + ' kHz';
    return v.toFixed(v < 10 ? 1 : 0) + ' Hz';
  }

  /* spectrum: fft.harmonicSpectrum() 的返回值
   * opts: { spanHz, sampleRate, bandwidth, freq }
   */
  function draw(ctx, W, H, spectrum, opts) {
    var padL = 46, padR = 12, padT = 14, padB = 26;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var spanHz = opts.spanHz;
    var bins = spectrum.bins;
    // clean = true 时只画仪器本身能看到的东西，不画任何会泄露答案的标注（测验用）
    var clean = !!(opts && opts.clean);

    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);

    function toX(f) {
      return padL + Math.max(0, Math.min(1, f / spanHz)) * plotW;
    }
    function toY(db) {
      var t = (db - DB_FLOOR) / (0 - DB_FLOOR); // -80 → 0, 0 → 1
      return padT + (1 - t) * plotH;
    }

    // ---- 网格 ----
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var i;
    for (i = 0; i <= 8; i++) {
      var gy = padT + (i * plotH) / 8;
      ctx.moveTo(padL, gy + 0.5);
      ctx.lineTo(W - padR, gy + 0.5);
    }
    for (i = 0; i <= 10; i++) {
      var gx = padL + (i * plotW) / 10;
      ctx.moveTo(gx + 0.5, padT);
      ctx.lineTo(gx + 0.5, H - padB);
    }
    ctx.stroke();

    // 边框
    ctx.strokeStyle = COL.axis;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);

    // ---- 纵轴刻度 ----
    ctx.fillStyle = COL.text;
    ctx.font = '10px "SF Mono", Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (i = 0; i <= 4; i++) {
      var db = -(i * 20);
      ctx.fillText(db + '', padL - 6, toY(db));
    }
    ctx.save();
    ctx.translate(11, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('dBc', 0, 0);
    ctx.restore();

    // ---- 横轴刻度 ----
    // 面板宽度是变的（频谱与阵列并排），所以刻度数量得跟着算，
    // 否则扫宽标签会挤成一团。先按可用宽度定"最多几个刻度"，再取一个整数步长。
    ctx.textBaseline = 'top';
    var axisW = toX(spanHz) - toX(0);
    var maxTicks = Math.max(2, Math.floor(axisW / 78));
    var rawStep = spanHz / maxTicks;
    var mag = Math.pow(10, Math.floor(Math.log(rawStep) / Math.LN10));
    var norm = rawStep / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    var nTick = Math.floor(spanHz / step + 1e-9);
    var lastTick = nTick * step;
    // 末尾离最后一个整刻度还很远的话，把扫宽上限也标出来
    var addEdge = (spanHz - lastTick) > step * 0.55;
    var count = addEdge ? nTick + 1 : nTick;
    for (i = 0; i <= count; i++) {
      var f = (addEdge && i === count) ? spanHz : i * step;
      ctx.textAlign = i === 0 ? 'left' : (i === count ? 'right' : 'center');
      ctx.fillText(fmtHz(f), toX(f), H - padB + 6);
    }

    // ---- 奈奎斯特标记（采样率/2）----
    var nyq = opts.sampleRate / 2;
    if (nyq > 0 && nyq <= spanHz) {
      ctx.save();
      ctx.strokeStyle = COL.nyquist;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(toX(nyq) + 0.5, padT);
      ctx.lineTo(toX(nyq) + 0.5, H - padB);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = COL.nyquist;
      ctx.font = '10px "SF Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      // 靠右时下移一行，免得和右上角的谱线读数撞在一起
      var nyqY = toX(nyq) > W - padR - 86 ? padT + 15 : padT + 3;
      ctx.fillText('fs/2', toX(nyq), nyqY);
    }

    // ---- 带宽限制标记 ----
    var bw = opts.bandwidth;
    if (bw > 0 && bw <= spanHz) {
      ctx.save();
      ctx.strokeStyle = COL.bandwidth;
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(toX(bw) + 0.5, padT);
      ctx.lineTo(toX(bw) + 0.5, H - padB);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = COL.bandwidth;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      if (!clean) ctx.fillText('带宽限制', toX(bw), padT + plotH - 3);
    }

    // ---- 找基波做 0 dB 参考 ----
    var ref = 0;
    for (i = 1; i < bins.length; i++) {
      if (bins[i].amp > ref) ref = bins[i].amp;
    }
    if (ref <= 1e-12) ref = 1;

    // ---- 画谱线 ----
    var baseY = H - padB;
    var drawn = 0;
    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = COL.stem;

    // 批量画竖线
    ctx.beginPath();
    var marks = [];
    for (i = 0; i < bins.length; i++) {
      var b = bins[i];
      if (b.freq > spanHz) break;
      var dbv = b.amp > 1e-12 ? 20 * Math.log10(b.amp / ref) : -240;
      if (dbv < DB_FLOOR) continue;
      var x = toX(b.freq);
      ctx.moveTo(x, baseY);
      ctx.lineTo(x, toY(dbv));
      marks.push({ x: x, y: toY(dbv), db: dbv, freq: b.freq, amp: b.amp });
      drawn++;
    }
    ctx.stroke();

    // 顶点小圆
    ctx.fillStyle = COL.stemTop;
    for (i = 0; i < marks.length; i++) {
      ctx.beginPath();
      ctx.arc(marks[i].x, marks[i].y, marks[i].freq === spectrum.freq ? 2.6 : 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // ---- 基波标注 ----
    if (!clean && marks.length && marks[0].db > -3) {
      ctx.fillStyle = COL.textBright;
      ctx.font = '10px "SF Mono", Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmtHz(marks[0].freq) + ' 基波', Math.min(marks[0].x + 5, W - padR - 70), marks[0].y - 2);
    }

    // ---- 谱线数读数（放右上角，左上角留给基波标注）----
    if (!clean) {
      ctx.fillStyle = COL.text;
      ctx.font = '10px "SF Mono", Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('谱线 ' + drawn + ' 条   扫宽 ' + fmtHz(spanHz), W - padR - 4, padT + 3);
    }

    return { ref: ref, lines: marks.length };
  }

  NS.spectrum = {
    draw: draw,
    DB_FLOOR: DB_FLOOR,
    fmtHz: fmtHz,
    COL: COL
  };
})((window.SignalLab = window.SignalLab || {}));
