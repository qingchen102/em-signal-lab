/* ==========================================================================
 * scope.js — 示波器
 *
 * 屏幕按真实示波器画：水平 10 格、垂直 8 格。
 * 每格的时间由「时基」决定，每格的电压由「垂直档位」决定。
 * 波形就是采集到的点按这两个比例映射上去，没有任何美化。
 * ========================================================================== */
(function (NS) {
  'use strict';

  var DIV_X = 10; // 水平格数
  var DIV_Y = 8;  // 垂直格数

  var COL = {
    screenBg: '#16202c',
    grid: '#1e2c3d',
    gridMajor: '#28405a',
    axis: '#3a5a78',
    trace: '#7ee787',
    traceGlow: 'rgba(126, 231, 135, 0.35)',
    dots: '#b7f7bd',
    trigger: '#ffa657',
    warn: '#ff7b72',
    text: '#a9b6c6',
    textBright: '#e3ebf5'
  };

  function drawGrid(ctx, W, H) {
    var px = W / DIV_X;
    var py = H / DIV_Y;
    var i;

    ctx.fillStyle = COL.screenBg;
    ctx.fillRect(0, 0, W, H);

    // 细格：每格再分 5 小格
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (i = 0; i <= DIV_X * 5; i++) {
      var x = Math.round((i * W) / (DIV_X * 5)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (i = 0; i <= DIV_Y * 5; i++) {
      var y = Math.round((i * H) / (DIV_Y * 5)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    // 主格
    ctx.strokeStyle = COL.gridMajor;
    ctx.beginPath();
    for (i = 0; i <= DIV_X; i++) {
      var mx = Math.round((i * W) / DIV_X) + 0.5;
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, H);
    }
    for (i = 0; i <= DIV_Y; i++) {
      var my = Math.round((i * H) / DIV_Y) + 0.5;
      ctx.moveTo(0, my);
      ctx.lineTo(W, my);
    }
    ctx.stroke();

    // 中央十字轴
    ctx.strokeStyle = COL.axis;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(H / 2) + 0.5);
    ctx.lineTo(W, Math.round(H / 2) + 0.5);
    ctx.moveTo(Math.round(W / 2) + 0.5, 0);
    ctx.lineTo(Math.round(W / 2) + 0.5, H);
    ctx.stroke();

    // 格线刻度短标（屏幕边缘）
    ctx.strokeStyle = COL.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (i = 1; i < DIV_X; i++) {
      var tx = (i * W) / DIV_X;
      ctx.moveTo(tx, 0); ctx.lineTo(tx, 5);
      ctx.moveTo(tx, H - 5); ctx.lineTo(tx, H);
    }
    for (i = 1; i < DIV_Y; i++) {
      var ty = (i * H) / DIV_Y;
      ctx.moveTo(0, ty); ctx.lineTo(5, ty);
      ctx.moveTo(W - 5, ty); ctx.lineTo(W, ty);
    }
    ctx.stroke();
  }

  /* 主绘制
   * acq: signal.acquire() 的返回值
   * p:   参数
   */
  function draw(ctx, W, H, acq, p) {
    drawGrid(ctx, W, H);

    var pxX = W / DIV_X;
    var pxY = H / DIV_Y;
    var mid = H / 2;
    var N = acq.N;
    var s = acq.samples;
    var vpd = p.voltsPerDiv;

    // 电压 → 像素
    function toY(v) {
      return mid - (v / vpd) * pxY;
    }
    function toX(k) {
      return N <= 1 ? 0 : (k / (N - 1)) * W;
    }

    // ---- 触发电平标记 ----
    var trigY = toY(p.triggerLevel / Math.max(p.probe, 1));
    if (trigY >= -20 && trigY <= H + 20) {
      ctx.save();
      ctx.strokeStyle = COL.trigger;
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(0, trigY + 0.5);
      ctx.lineTo(W, trigY + 0.5);
      ctx.stroke();
      ctx.restore();

      // 左边缘的触发箭头
      ctx.fillStyle = COL.trigger;
      var ay = Math.max(6, Math.min(H - 6, trigY));
      ctx.beginPath();
      ctx.moveTo(0, ay - 6);
      ctx.lineTo(7, ay);
      ctx.lineTo(0, ay + 6);
      ctx.closePath();
      ctx.fill();
    }

    // ---- 波形 ----
    // 超出屏幕的部分单独统计，用来提示"超量程"
    var clipped = 0;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 荧光辉光（画粗一点、半透明，模拟余辉）
    ctx.strokeStyle = COL.traceGlow;
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (var k = 0; k < N; k++) {
      var y = toY(s[k]);
      if (y < -H || y > 2 * H) clipped++;
      var x = toX(k);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 主迹线
    ctx.strokeStyle = COL.trace;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (var j = 0; j < N; j++) {
      var yy = toY(s[j]);
      var xx = toX(j);
      if (j === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();

    // 采样点：点少的时候画出来，让学生看见"示波器其实只拿到了这几个点"
    if (N <= 120) {
      ctx.fillStyle = COL.dots;
      var rr = N <= 40 ? 3 : 2;
      for (var d = 0; d < N; d++) {
        ctx.beginPath();
        ctx.arc(toX(d), toY(s[d]), rr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();

    return { clipped: clipped };
  }

  /* 屏幕四角的读数，跟真实示波器一样 */
  function drawReadouts(ctx, W, H, acq, p) {
    ctx.save();
    ctx.font = '11px "SF Mono", "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = 'top';

    function fmtT(v) {
      if (v >= 1) return v.toFixed(2) + ' s';
      if (v >= 1e-3) return (v * 1e3).toFixed(v * 1e3 < 10 ? 2 : 1) + ' ms';
      if (v >= 1e-6) return (v * 1e6).toFixed(v * 1e6 < 10 ? 2 : 1) + ' µs';
      return (v * 1e9).toFixed(0) + ' ns';
    }
    function fmtV(v) {
      var a = Math.abs(v);
      if (a >= 1) return v.toFixed(2) + ' V';
      if (a >= 1e-3) return (v * 1e3).toFixed(v * 1e3 < 10 ? 2 : 1) + ' mV';
      return (v * 1e6).toFixed(0) + ' µV';
    }
    function fmtF(v) {
      if (v >= 1e6) return (v / 1e6).toFixed(2) + ' MHz';
      if (v >= 1e3) return (v / 1e3).toFixed(v / 1e3 < 10 ? 2 : 1) + ' kHz';
      return v.toFixed(0) + ' Hz';
    }

    ctx.fillStyle = COL.textBright;
    // 左上：时基
    ctx.textAlign = 'left';
    ctx.fillText('M ' + fmtT(p.timePerDiv) + '/div', 8, 8);
    // 右上：采样率 + 点数
    ctx.textAlign = 'right';
    ctx.fillStyle = acq.samplesPerPeriod < 2 ? COL.warn : COL.textBright;
    ctx.fillText(fmtF(p.sampleRate) + '/s  N=' + acq.N, W - 8, 8);

    // 左下：垂直档位 + 探头
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.text;
    ctx.fillText(fmtV(p.voltsPerDiv) + '/div   CH1 ' + p.coupling + '   ' + p.probe + '×', 8, H - 20);

    // 右下：触发状态
    ctx.textAlign = 'right';
    ctx.fillStyle = acq.triggered ? COL.text : COL.warn;
    ctx.fillText(acq.triggered ? 'Trig: 已锁定' : 'Trig: 未触发 · 自由运行', W - 8, H - 20);

    // 中上：频率与周期读数（教学用，真实示波器有 MEASURE 菜单）
    ctx.textAlign = 'center';
    ctx.fillStyle = COL.text;
    var per = 1 / Math.max(p.freq, 1e-9);
    ctx.fillText(fmtF(p.freq) + '   T=' + fmtT(per) + '   一屏 ' + acq.periods.toFixed(2) + ' 个周期', W / 2, 8);

    ctx.restore();
  }

  NS.scope = {
    draw: draw,
    drawReadouts: drawReadouts,
    DIV_X: DIV_X,
    DIV_Y: DIV_Y,
    COL: COL
  };
})((window.SignalLab = window.SignalLab || {}));
