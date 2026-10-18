/* ==========================================================================
 * main.js — 界面装配与渲染循环
 *
 * 结构很简单：
 *   参数 state  →  信号模型  →  示波器采集  →  画屏幕 + 更新知识面板
 * 参数一变就重建模型；如果触发没锁上，波形要一直跑，所以每帧重新采集。
 * ========================================================================== */
(function () {
  'use strict';

  var NS = window.SignalLab;

  /* ======================================================================
   * 参数默认值
   * ==================================================================== */
  var DEFAULTS = {
    wave: 'sine',
    freq: 1000,
    amp: 1,
    offset: 0,
    phase: 0,
    duty: 0.5,
    noise: 0,
    bandwidth: 100000,

    timePerDiv: 200e-6,
    voltsPerDiv: 0.5,
    sampleRate: 1000000,
    triggerLevel: 0,
    coupling: 'DC',
    probe: 1,

    spanHz: 20000,

    arrayM: 8,
    arrayD: 0.5,
    arraySnr: 20,
    arraySources: 1,
    arrayA1: -20,
    arrayA2: 25,
    arrayA3: 60,
    arrayK: 200,
    arraySeed: 1,

    tfScenario: 'burst',
    tfFs: 10000,
    tfWin: 64,
    tfOverlap: 0.75,
    tfF1: 800,
    tfF2: 2500,

    conMod: 'qpsk',
    conSnr: 14,
    conN: 400,

    sbScene: 'canyon',
    sbOrder: 2,
    sbFreq: 2400e6,
    sbM: 8,
    sbSnr: 20
  };

  /* ======================================================================
   * 控件定义，界面从这里长出来，加一个旋钮只要加一行
   * ==================================================================== */
  var GROUPS = [
    {
      title: '信号发生器',
      hint: '决定"送进电路的是什么"',
      items: [
        { id: 'wave', type: 'select', label: '波形', def: 'sine', options: [
          ['sine', '正弦波'], ['square', '方波'], ['triangle', '三角波'],
          ['sawtooth', '锯齿波'], ['pulse', '脉冲']] },
        { id: 'freq', type: 'log', label: '频率', min: 1, max: 100000, def: 1000, fmt: 'hz' },
        { id: 'amp', type: 'lin', label: '幅度（峰值）', min: 0, max: 5, step: 0.01, def: 1, fmt: 'v' },
        { id: 'offset', type: 'lin', label: '直流偏置', min: -5, max: 5, step: 0.01, def: 0, fmt: 'v' },
        { id: 'phase', type: 'lin', label: '初相', min: 0, max: 360, step: 1, def: 0, fmt: 'deg' },
        { id: 'duty', type: 'lin', label: '占空比', min: 0.02, max: 0.98, step: 0.01, def: 0.5, fmt: 'pct',
          showIf: function (p) { return p.wave === 'square' || p.wave === 'pulse'; } },
        { id: 'noise', type: 'lin', label: '噪声（RMS）', min: 0, max: 0.5, step: 0.005, def: 0, fmt: 'v' },
        { id: 'bandwidth', type: 'log', label: '带宽限制', min: 10, max: 1000000, def: 100000, fmt: 'hz' }
      ]
    },
    {
      title: '示波器',
      hint: '决定"你看到的是什么"',
      items: [
        { id: 'timePerDiv', type: 'log', label: '时基', min: 1e-6, max: 1, def: 200e-6, fmt: 'time' },
        { id: 'voltsPerDiv', type: 'log', label: '垂直档位', min: 1e-3, max: 5, def: 0.5, fmt: 'v' },
        { id: 'sampleRate', type: 'log', label: '采样率', min: 100, max: 10000000, def: 1000000, fmt: 'hz' },
        { id: 'triggerLevel', type: 'lin', label: '触发电平', min: -5, max: 5, step: 0.01, def: 0, fmt: 'v' },
        { id: 'coupling', type: 'select', label: '耦合', def: 'DC', options: [['DC', 'DC 直流'], ['AC', 'AC 交流']] },
        { id: 'probe', type: 'select', label: '探头', def: 1, numeric: true, options: [[1, '×1'], [10, '×10']] }
      ]
    },
    {
      title: '频谱仪',
      hint: '同一时刻，它在频域里长什么样',
      items: [
        { id: 'spanHz', type: 'log', label: '扫宽', min: 100, max: 1000000, def: 20000, fmt: 'hz' }
      ]
    },
    {
      title: '阵列测向',
      hint: '一个阵元只知道"有信号"，摆成一排才知道"从哪来"',
      items: [
        { id: 'arrayM', type: 'lin', label: '阵元数 M', min: 1, max: 16, step: 1, def: 8, fmt: 'int' },
        { id: 'arrayD', type: 'lin', label: '阵元间距 d/λ', min: 0.1, max: 1.5, step: 0.01, def: 0.5, fmt: 'lam' },
        { id: 'arraySnr', type: 'lin', label: '信噪比', min: -10, max: 40, step: 1, def: 20, fmt: 'db' },
        { id: 'arraySources', type: 'lin', label: '信源数', min: 1, max: 3, step: 1, def: 1, fmt: 'int' },
        { id: 'arrayA1', type: 'lin', label: '来波方向 θ₁', min: -90, max: 90, step: 1, def: -20, fmt: 'deg' },
        { id: 'arrayA2', type: 'lin', label: 'θ₂', min: -90, max: 90, step: 1, def: 25, fmt: 'deg',
          showIf: function (p) { return p.arraySources >= 2; } },
        { id: 'arrayA3', type: 'lin', label: 'θ₃', min: -90, max: 90, step: 1, def: 60, fmt: 'deg',
          showIf: function (p) { return p.arraySources >= 3; } },
        { id: 'arrayK', type: 'log', label: '快拍数', min: 10, max: 2000, def: 200, fmt: 'int' }
      ]
    },
    {
      title: '时频图',
      hint: '横轴时间、纵轴频率，才能看出“频率在变”',
      items: [
        { id: 'tfScenario', type: 'select', label: '场景', def: 'burst', options: [
          ['steady', '单音持续'], ['chirp', '线性调频'], ['burst', '突发脉冲'],
          ['seq', '双音先后'], ['sim', '双音同时']] },
        { id: 'tfFs', type: 'log', label: '采样率', min: 1000, max: 48000, def: 10000, fmt: 'hz' },
        { id: 'tfWin', type: 'select', label: '窗长', def: 64, numeric: true, options: [
          [32, '32 点（时间最细）'], [64, '64 点'], [128, '128 点'],
          [256, '256 点'], [512, '512 点（频率最细）']] },
        { id: 'tfOverlap', type: 'lin', label: '重叠', min: 0, max: 0.9, step: 0.05, def: 0.75, fmt: 'pct' },
        { id: 'tfF1', type: 'log', label: '频率 f₁', min: 100, max: 4000, def: 800, fmt: 'hz' },
        { id: 'tfF2', type: 'log', label: '频率 f₂', min: 100, max: 4000, def: 1000, fmt: 'hz',
          showIf: function (p) { return p.tfScenario === 'seq' || p.tfScenario === 'sim'; } }
      ]
    },
    {
      title: '星座图',
      hint: '把比特摆到 I/Q 平面上，抗噪能力就是「点距 vs 噪声圆圈」',
      items: [
        { id: 'conMod', type: 'select', label: '调制方式', def: 'qpsk', options: [
          ['bpsk', 'BPSK（1 bit）'], ['qpsk', 'QPSK（2 bit）'], ['psk8', '8PSK（3 bit）'],
          ['qam16', '16QAM（4 bit）'], ['qam64', '64QAM（6 bit）']] },
        { id: 'conSnr', type: 'lin', label: 'Es/N0', min: 0, max: 30, step: 1, def: 14, fmt: 'db' },
        { id: 'conN', type: 'log', label: '符号数', min: 50, max: 4000, def: 400, fmt: 'int' }
      ]
    },
    {
      title: '多径沙盒',
      hint: '自己摆楼、拖发射机，看多径怎么把测向带偏',
      items: [
        { id: 'sbScene', type: 'select', label: '场景', def: 'canyon', options: [
          ['open', '开阔地'], ['canyon', '城市峡谷'], ['corner', '街角（挡住了）'], ['dense', '密集楼群']] },
        { id: 'sbOrder', type: 'select', label: '反射阶数', def: 2, numeric: true, options: [
          [0, '只算直达'], [1, '一次反射'], [2, '两次反射']] },
        { id: 'sbFreq', type: 'log', label: '频率', min: 400e6, max: 6000e6, def: 2400e6, fmt: 'hz' },
        { id: 'sbM', type: 'select', label: '阵元数', def: 8, numeric: true, options: [
          [4, '4 阵元'], [8, '8 阵元'], [16, '16 阵元']] },
        { id: 'sbSnr', type: 'lin', label: '信噪比', min: 0, max: 30, step: 1, def: 20, fmt: 'db' }
      ]
    }
  ];

  /* ======================================================================
   * 预设：每个预设就是一个"你会撞上的现象"
   * ==================================================================== */
  var PRESETS = [
    { name: '干净正弦', hint: '一切正常的样子', set: {} },
    { name: '混叠', hint: '采样率不够，屏幕在骗你',
      set: { wave: 'sine', freq: 1000, sampleRate: 1500, timePerDiv: 2e-3, voltsPerDiv: 0.5, triggerLevel: 0 } },
    { name: '触发丢失', hint: '波形为什么一直在跑',
      set: { wave: 'sine', freq: 1000, sampleRate: 1e6, timePerDiv: 200e-6, triggerLevel: 4, voltsPerDiv: 0.5 } },
    { name: '方波与谐波', hint: '看频谱里的奇次谐波',
      set: { wave: 'square', freq: 1000, bandwidth: 100000, sampleRate: 1e6, timePerDiv: 200e-6, spanHz: 20000, triggerLevel: 0, voltsPerDiv: 0.5 } },
    { name: '带宽限制', hint: '谐波被砍，方波变圆角',
      set: { wave: 'square', freq: 1000, bandwidth: 4000, sampleRate: 1e6, timePerDiv: 200e-6, spanHz: 20000, voltsPerDiv: 0.5 } },
    { name: '时基太快', hint: '一屏装不下一个周期',
      set: { wave: 'sine', freq: 1000, timePerDiv: 20e-6, sampleRate: 1e6, voltsPerDiv: 0.5 } },
    { name: '超量程', hint: '波形冲出屏幕了',
      set: { wave: 'sine', freq: 1000, amp: 3, voltsPerDiv: 0.5, timePerDiv: 200e-6, sampleRate: 1e6 } },
    { name: 'AC 耦合', hint: '直流分量被吃掉',
      set: { wave: 'sine', freq: 1000, amp: 1, offset: 2, coupling: 'AC', voltsPerDiv: 0.5, timePerDiv: 200e-6, sampleRate: 1e6 } },
    { name: '阵列测向', hint: '摆成一排，才知道方向',
      set: { wave: 'sine', freq: 1000, sampleRate: 1e6, timePerDiv: 200e-6, voltsPerDiv: 0.5, triggerLevel: 0,
        arrayM: 8, arrayD: 0.5, arraySnr: 20, arraySources: 2, arrayA1: -20, arrayA2: 25, arrayK: 200 } },
    { name: '只有一个阵元', hint: '知道有信号，不知道从哪来',
      set: { wave: 'sine', freq: 1000, sampleRate: 1e6, timePerDiv: 200e-6, voltsPerDiv: 0.5, triggerLevel: 0,
        arrayM: 1, arrayD: 0.5, arraySnr: 20, arraySources: 1, arrayA1: 20, arrayK: 200 } },
    { name: '栅瓣', hint: '间距超过半波长，凭空多出一个方向',
      set: { wave: 'sine', freq: 1000, sampleRate: 1e6, timePerDiv: 200e-6, voltsPerDiv: 0.5, triggerLevel: 0,
        arrayM: 8, arrayD: 1, arraySnr: 20, arraySources: 1, arrayA1: 30, arrayK: 200 } },
    { name: '分不开的两个方向', hint: 'Bartlett 看不到，MUSIC 看得到',
      set: { wave: 'sine', freq: 1000, sampleRate: 1e6, timePerDiv: 200e-6, voltsPerDiv: 0.5, triggerLevel: 0,
        arrayM: 8, arrayD: 0.5, arraySnr: 20, arraySources: 2, arrayA1: -6, arrayA2: 6, arrayK: 200 } },
    { name: '时频图', hint: '时间上一小段，频率上一根线',
      set: { tfScenario: 'burst', tfFs: 10000, tfWin: 128, tfOverlap: 0.75, tfF1: 800, tfF2: 2500 } },
    { name: '频率在爬', hint: '一根斜线，频率随时间线性变化',
      set: { tfScenario: 'chirp', tfFs: 10000, tfWin: 256, tfOverlap: 0.75, tfF1: 600, tfF2: 3000 } },
    { name: '窗长换一换', hint: '同一段信号，短窗和长窗看到的不一样',
      set: { tfScenario: 'seq', tfFs: 10000, tfWin: 64, tfOverlap: 0.75, tfF1: 800, tfF2: 2500 } },
    { name: '两个音被糊成一个', hint: '先后分开的两个音，长窗下看着像同时的',
      set: { tfScenario: 'seq', tfFs: 10000, tfWin: 512, tfOverlap: 0.75, tfF1: 800, tfF2: 2500 } },
    { name: '真的同时', hint: '和上一张比一比，长窗下两张图几乎一样',
      set: { tfScenario: 'sim', tfFs: 10000, tfWin: 512, tfOverlap: 0.75, tfF1: 800, tfF2: 2500 } },

    { name: 'QPSK 星座图', hint: '四个点，噪声小圈离判决边界还远',
      set: { conMod: 'qpsk', conSnr: 16, conN: 400 } },
    { name: '升到 64QAM', hint: '同样 16 dB，点挤成一片，快是有代价的',
      set: { conMod: 'qam64', conSnr: 16, conN: 400 } },
    { name: '给 64QAM 补 9 dB', hint: '信噪比补回来它才干净。这就是那笔交易',
      set: { conMod: 'qam64', conSnr: 25, conN: 400 } },
    { name: 'BPSK 为什么抗造', hint: '同样的 16 dB，两个点离得最远，一个都不错',
      set: { conMod: 'bpsk', conSnr: 16, conN: 400 } },

    { name: '一台发射机，三个方向', hint: '楼把信号弹回来，阵列看到的不止一个方向',
      set: { sbScene: 'canyon', sbOrder: 2, sbFreq: 2400e6, sbM: 8, sbSnr: 20 } },
    { name: '楼把直达挡死了', hint: '只剩一条反射，测出来的方向是墙的方向',
      set: { sbScene: 'corner', sbOrder: 2, sbFreq: 2400e6, sbM: 8, sbSnr: 20 } },
    { name: '把反射关掉', hint: '只看直达，回到开阔地做对照',
      set: { sbScene: 'open', sbOrder: 0, sbFreq: 2400e6, sbM: 8, sbSnr: 20 } },
    { name: '密集楼群', hint: '两个反射角度差得很开，时延扩展也上去了',
      set: { sbScene: 'dense', sbOrder: 2, sbFreq: 2400e6, sbM: 8, sbSnr: 20 } }
  ];

  /* 预设分三组，分别在顶栏里用一条竖线隔开，方便按仪器找。 */
  var PRESET_GROUPS = [
    { at: 0, name: '示波器与频谱', instr: 'wave' },
    { at: 8, name: '阵列测向', instr: 'arr' },
    { at: 12, name: '时频图', instr: 'tf' },
    { at: 17, name: '星座图', instr: 'con' },
    { at: 21, name: '多径沙盒', instr: 'sb' }
  ];

  /* ======================================================================
   * 状态
   * ==================================================================== */
  var state = {};
  var cache = { model: null, trigPath: null, range: null, spec: null, acq: null, trigger: undefined, arr: null, tf: null, con: null, sb: null, sbArr: null, clipped: false };
  var arrSig = '';
  var tfSig = '';
  var conSig = '';
  var sbSig = '';
  var sbScene = null;          // 当前场景的可编辑副本（楼 / 收发机都能拖）
  var sbDirty = false;         // 刚拖过东西，下一帧要重算
  var dirty = true;
  var frame = 0;
  var lastAdviceSig = '';
  var recent = [];             // 学生最近动过的旋钮，给 AI 助教当上下文
  var prevState = {};
  var lastCards = [];          // 面板当前在提示什么
  var els = {};

  /* --- 数值格式化 ------------------------------------------------------ */
  function fmtValue(item, v) {
    var A = NS.advisor;
    switch (item.fmt) {
      case 'hz': return A.fmtHz(v);
      case 'time': return A.fmtT(v);
      case 'v': return A.fmtV(v);
      case 'deg': return v.toFixed(0) + '°';
      case 'pct': return (v * 100).toFixed(0) + '%';
      case 'int': return String(Math.round(v));
      case 'lam': return v.toFixed(2) + ' λ';
      case 'db': return v.toFixed(0) + ' dB';
      default: return String(v);
    }
  }

  /* --- 对数滑条映射 ---------------------------------------------------- */
  function fromSlider(pos, min, max) { return min * Math.pow(max / min, pos / 1000); }
  function toSlider(v, min, max) { return Math.round(1000 * Math.log(v / min) / Math.log(max / min)); }

  /* ======================================================================
   * 构建界面
   * ==================================================================== */
  /* ======================================================================
   * 分栏：一次只展开一台仪器
   *
   * 真实的示波器面板就那么几个旋钮，因为别的功能都在别的键底下。这里照做：
   * 顶部五个页签对应五台仪器，左侧旋钮栏只留当前这台的那一组，其余收起。
   * ==================================================================== */
  var INSTR = ['wave', 'arr', 'tf', 'con', 'sb'];

  /* 旋钮分组属于哪台仪器。分组标题是给人看的，这里按标题归类。 */
  var GROUP_INSTR = {
    '信号发生器': 'wave',
    '示波器': 'wave',
    '频谱仪': 'wave',
    '阵列测向': 'arr',
    '时频图': 'tf',
    '星座图': 'con',
    '多径沙盒': 'sb'
  };
  var instr = null;

  function instrOfPreset(idx) {
    var id = 'wave', k;
    for (k = 0; k < PRESET_GROUPS.length; k++) {
      if (PRESET_GROUPS[k].at <= idx) id = PRESET_GROUPS[k].instr || id;
    }
    return id;
  }

  function setTab(id) {
    if (INSTR.indexOf(id) < 0) id = 'wave';
    instr = id;
    if (els.screens) els.screens.dataset.instr = id;
    if (els.tabs) {
      els.tabs.querySelectorAll('.tab').forEach(function (b) {
        var on = b.dataset.instr === id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    // 顶栏的预设也只留这台仪器的，二十六个摆一排谁也找不到自己要看的那几个
    if (els.presets) {
      els.presets.querySelectorAll('.preset').forEach(function (b) {
        b.hidden = b.dataset.instr !== id;
      });
      els.presets.querySelectorAll('.preset-group').forEach(function (g) {
        g.hidden = g.dataset.instr !== id;
      });
      els.presets.scrollLeft = 0;
    }
    if (els.controls) {
      els.controls.querySelectorAll('.group').forEach(function (g) {
        g.hidden = g.dataset.instr !== id;
      });
    }
    dirty = true;
  }

  function buildControls() {
    var host = els.controls;
    host.innerHTML = '';

    GROUPS.forEach(function (g) {
      var sec = document.createElement('section');
      sec.className = 'group';
      sec.dataset.instr = GROUP_INSTR[g.title] || 'wave';

      var h = document.createElement('h2');
      h.className = 'group-title';
      h.innerHTML = g.title + '<span>' + g.hint + '</span>';
      sec.appendChild(h);

      var body = document.createElement('div');
      body.className = 'group-body';

      g.items.forEach(function (item) {
        var row = document.createElement('label');
        row.className = 'ctl';
        row.dataset.ctl = item.id;

        var name = document.createElement('span');
        name.className = 'ctl-name';
        name.textContent = item.label;
        row.appendChild(name);

        var input;
        if (item.type === 'select') {
          input = document.createElement('select');
          item.options.forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = String(o[0]);
            opt.textContent = o[1];
            input.appendChild(opt);
          });
          input.className = 'ctl-select';
          input.value = String(state[item.id]);
          input.addEventListener('change', function () {
            state[item.id] = item.numeric ? Number(input.value) : input.value;
            onChange();
          });
        } else {
          input = document.createElement('input');
          input.type = 'range';
          if (item.type === 'log') {
            input.min = 0; input.max = 1000; input.step = 1;
            input.value = toSlider(state[item.id], item.min, item.max);
          } else {
            input.min = item.min; input.max = item.max; input.step = item.step;
            input.value = state[item.id];
          }
          input.className = 'ctl-range';
          input.addEventListener('input', function () {
            state[item.id] = item.type === 'log'
              ? fromSlider(Number(input.value), item.min, item.max)
              : Number(input.value);
            onChange();
          });
        }
        input.dataset.param = item.id;

        // 读数放在第一行右侧、滑条下方；下拉框本身已经显示了名字，不再重复读数
        var out = document.createElement('output');
        out.className = 'ctl-val';
        out.dataset.out = item.id;
        if (item.type === 'select') out.style.display = 'none';
        row.appendChild(out);

        row.appendChild(input);

        body.appendChild(row);
      });

      sec.appendChild(body);
      host.appendChild(sec);
    });

    syncControls();
  }

  /* 把 state 写回控件（预设切换时用） */
  function syncControls() {
    GROUPS.forEach(function (g) {
      g.items.forEach(function (item) {
        var input = els.controls.querySelector('[data-param="' + item.id + '"]');
        if (!input) return;
        if (item.type === 'select') {
          input.value = String(state[item.id]);
        } else if (item.type === 'log') {
          input.value = toSlider(state[item.id], item.min, item.max);
        } else {
          input.value = state[item.id];
        }
        var out = els.controls.querySelector('[data-out="' + item.id + '"]');
        if (out) out.textContent = fmtValue(item, state[item.id]);

        // showIf：不相关的旋钮直接收起来，免得干扰
        var row = els.controls.querySelector('[data-ctl="' + item.id + '"]');
        if (row && item.showIf) row.style.display = item.showIf(state) ? '' : 'none';
      });
    });
  }

  /* ======================================================================
   * 画布
   * ==================================================================== */
  function fitCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, W: w, H: h };
  }

  /* ======================================================================
   * 渲染
   * ==================================================================== */
  function arrayConfig() {
    var angles = [state.arrayA1];
    if (state.arraySources >= 2) angles.push(state.arrayA2);
    if (state.arraySources >= 3) angles.push(state.arrayA3);
    return {
      M: state.arrayM,
      spacing: state.arrayD,
      snrDb: state.arraySnr,
      sources: state.arraySources,
      angles: angles,
      snapshots: state.arrayK,
      seed: state.arraySeed
    };
  }

  /* 时频图自带一套参数（跟时域、阵列都不共享），同样按签名缓存 */
  function tfConfig() {
    return {
      scenario: state.tfScenario,
      sampleRate: state.tfFs,
      win: state.tfWin,
      overlap: state.tfOverlap * 100,
      f1: state.tfF1,
      f2: state.tfF2,
      amp: 1
    };
  }

  /* 星座图：调制方式和信噪比自成一套，跟别的屏幕无关 */
  function conConfig() {
    return {
      mod: state.conMod,
      snrDb: state.conSnr,
      nSym: Math.round(state.conN)
    };
  }

  /* 多径沙盒：几何参数自成一套 */
  function sbConfig() {
    return {
      maxOrder: Math.round(state.sbOrder),
      freqHz: state.sbFreq,
      arrayM: Math.round(state.sbM),
      snrDb: state.sbSnr
    };
  }

  /* 场景的可编辑副本；换了场景就重新拿一份干净的 */
  function sbSceneNow() {
    if (!sbScene || sbScene.id !== state.sbScene) {
      sbScene = NS.sandbox.cloneScene(NS.sandbox.scenById(state.sbScene));
      sbDirty = true;
    }
    return sbScene;
  }

  function rebuild() {
    cache.model = NS.signal.makeModel(state);
    // 触发比较器看到的是耦合与探头衰减之后的信号，跟屏幕上是同一条
    cache.trigPath = NS.signal.triggerPath(cache.model, state);
    cache.range = NS.signal.signalRange(cache.trigPath, state.freq);
    cache.trigger = NS.signal.findTrigger(cache.trigPath, state.triggerLevel, state.freq);
    cache.spec = NS.fft.harmonicSpectrum(cache.model, state.freq, 1024);

    // 阵列那一屏跟时域参数无关，签名没变就不重算，拖滑条时才不会卡
    var ac = arrayConfig();
    var sig = ac.M + '|' + ac.spacing + '|' + ac.snrDb + '|' + ac.sources + '|'
      + ac.angles.join(',') + '|' + ac.snapshots + '|' + ac.seed;
    if (sig !== arrSig) {
      arrSig = sig;
      cache.arr = NS.array.simulate(ac);
    }

    // 时频图同理：它有自己的场景与窗长，跟上面那些旋钮完全无关
    var tc = tfConfig();
    var tsig = tc.scenario + '|' + tc.sampleRate + '|' + tc.win + '|' + tc.overlap + '|'
      + tc.f1 + '|' + tc.f2 + '|' + tc.amp;
    if (tsig !== tfSig) {
      tfSig = tsig;
      cache.tf = NS.timefreq.analyze(tc);
    }

    // 星座图也只看自己的三个旋钮
    var cc = conConfig();
    var csig = cc.mod + '|' + cc.snrDb + '|' + cc.nSym;
    if (csig !== conSig) {
      conSig = csig;
      cache.con = NS.constellation.analyze(cc);
    }
    // 多径沙盒：镜像法几何 + 反射，只看它自己的五个旋钮；拖过东西也强制重算
    var sc0 = sbSceneNow();
    var bc = sbConfig();
    var bsg = sc0.id + '|' + bc.maxOrder + '|' + bc.freqHz + '|' + bc.arrayM + '|' + bc.snrDb;
    if (bsg !== sbSig || sbDirty) {
      sbSig = bsg;
      sbDirty = false;
      cache.sb = NS.sandbox.analyze({
        scene: sc0, buildings: sc0.buildings, tx: sc0.tx, rx: sc0.rx,
        maxOrder: bc.maxOrder, freqHz: bc.freqHz, arrayM: bc.arrayM
      });
      // 把几何路径当成「同一路信号的相干副本」喂给阵列，多径骗测向就骗在这里
      cache.sbArr = null;
      if (cache.sb.arrPaths.length && NS.array) {
        var g0 = cache.sb.arrPaths[0].gain || 1;
        cache.sbArr = NS.array.simulate({
          M: bc.arrayM, spacing: 0.5, snrDb: bc.snrDb, snapshots: 400, sources: 1, seed: 7,
          paths: cache.sb.arrPaths.map(function (q) {
            return { angle: q.angle, gain: q.gain / g0, phase: q.phase };
          })
        });
      }
    }
  }

  function acquireAndDraw() {
    cache.acq = NS.signal.acquire(state, cache.model, frame, cache.trigger);

    var c = fitCanvas(els.scope);
    var drawn = NS.scope.draw(c.ctx, c.W, c.H, cache.acq, state);
    cache.clipped = !!(drawn && drawn.clipped);
    NS.scope.drawReadouts(c.ctx, c.W, c.H, cache.acq, state);

    updateAdvisor();
  }

  function drawSpectrum() {
    var c = fitCanvas(els.spectrum);
    NS.spectrum.draw(c.ctx, c.W, c.H, cache.spec, {
      spanHz: state.spanHz,
      sampleRate: state.sampleRate,
      bandwidth: state.bandwidth,
      freq: state.freq
    });
  }

  function drawArray() {
    if (!cache.arr) return;
    var c = fitCanvas(els.array);
    NS.array.draw(c.ctx, c.W, c.H, cache.arr, {});
  }

  function drawTimefreq() {
    if (!cache.tf) return;
    var c = fitCanvas(els.tf);
    NS.timefreq.draw(c.ctx, c.W, c.H, cache.tf, {});
  }

  function drawConstellation() {
    if (!cache.con) return;
    var c = fitCanvas(els.con);
    NS.constellation.draw(c.ctx, c.W, c.H, cache.con, {});
  }

  /* 沙盒画两样：地图，以及顶上那条「真实到达角 vs 阵列报出的峰」 */
  function sbTopPad(h) {
    return Math.min(66, Math.max(42, Math.round(h * 0.24)));
  }
  function drawSandbox() {
    if (!cache.sb) return;
    var c = fitCanvas(els.sb);
    var pad = sbTopPad(c.H);
    NS.sandbox.draw(c.ctx, c.W, c.H, cache.sb, { topPad: pad });
    NS.sandbox.drawDoaStrip(c.ctx, 8, 6, c.W - 16, pad - 12, cache.sb, cache.sbArr);
  }

  /* --- 拖动：抓住发射机 / 接收机 / 一栋楼 ------------------------------- */
  var sbGrab = null;
  function sbPt(ev) {
    var r = els.sb.getBoundingClientRect();
    var v = NS.sandbox.viewOf(r.width, r.height - sbTopPad(r.height), sbTopPad(r.height));
    return { x: v.mx(ev.clientX - r.left), y: v.my(ev.clientY - r.top) };
  }
  function onSbDown(ev) {
    if (!cache.sb) return;
    var p = sbPt(ev);
    var hit = NS.sandbox.hitTest(cache.sb, p.x, p.y, 20);
    if (!hit) return;
    sbGrab = hit;
    els.sb.setPointerCapture(ev.pointerId);
    els.sb.classList.add('grabbing');
  }
  function onSbMove(ev) {
    if (!cache.sb) return;
    var p = sbPt(ev);
    if (!sbGrab) {
      els.sb.style.cursor = NS.sandbox.hitTest(cache.sb, p.x, p.y, 20) ? 'grab' : 'default';
      return;
    }
    var M = NS.sandbox, sc = sbSceneNow();
    if (sbGrab.kind === 'tx') sc.tx = M.clampToMap({ x: p.x, y: p.y }, 0);
    else if (sbGrab.kind === 'rx') sc.rx = M.clampToMap({ x: p.x, y: p.y }, 0);
    else if (sbGrab.kind === 'bld') {
      var b = sc.buildings[sbGrab.index];
      var np = M.clampToMap({ x: p.x - sbGrab.dx, y: p.y - sbGrab.dy }, 0);
      b.x = Math.max(0, Math.min(M.MAP_W - b.w, np.x));
      b.y = Math.max(0, Math.min(M.MAP_H - b.h, np.y));
    }
    sbDirty = true;
    dirty = true;
  }
  function onSbUp() {
    sbGrab = null;
    els.sb.classList.remove('grabbing');
  }

  /* ======================================================================
   * 知识面板
   * ==================================================================== */
  function updateAdvisor() {
    var cards = NS.advisor.advise({
      instr: instr,
      p: state,
      acq: cache.acq,
      kMax: cache.model.kMax,
      range: cache.range,
      arr: cache.arr,
      tf: cache.tf,
      con: cache.con,
      sb: cache.sb,
      sbArr: cache.sbArr
    });

    lastCards = cards;

    var sig = cards.map(function (c) { return c.id + '|' + c.title; }).join('~');
    if (sig === lastAdviceSig) return;
    lastAdviceSig = sig;

    els.advisor.innerHTML = '';
    cards.slice(0, 3).forEach(function (card) {
      var el = document.createElement('article');
      el.className = 'card card--' + card.level;

      var h = document.createElement('h3');
      h.textContent = card.title;
      el.appendChild(h);

      [
        ['现在看到的', card.what],
        ['为什么', card.why],
        ['哪门课讲过', card.course],
        ['再试试', card.tryIt]
      ].forEach(function (pair) {
        var row = document.createElement('div');
        row.className = 'card-row';
        var dt = document.createElement('span');
        dt.className = 'card-key';
        dt.textContent = pair[0];
        var dd = document.createElement('p');
        dd.className = 'card-text';
        dd.textContent = pair[1];
        row.appendChild(dt);
        row.appendChild(dd);
        el.appendChild(row);
      });

      var askBtn = document.createElement('button');
      askBtn.className = 'card-ask';
      askBtn.textContent = '让 AI 细讲';
      askBtn.addEventListener('click', function () {
        NS.tutor.ask(
          '知识面板上这张卡片叫「' + card.title + '」。请结合我现在的仪器状态，'
          + '把「为什么」讲得比卡片上更深一层：先从屏幕上的数字讲起，'
          + '再讲背后的原理，最后给我一个能亲手验证它的操作。'
          + '卡片上已经写过的话不要重复。');
      });
      el.appendChild(askBtn);

      els.advisor.appendChild(el);
    });
  }

  /* ======================================================================
   * 循环
   * ==================================================================== */
  function onChange() {
    // 记下学生刚动了哪个旋钮，助教靠这个才知道"你刚才把时基拧到 20 μs/div 了"
    var t = Date.now();
    Object.keys(state).forEach(function (k) {
      if (prevState[k] !== undefined && prevState[k] !== state[k]) {
        recent.push({ id: k, from: prevState[k], to: state[k], at: t });
      }
    });
    if (recent.length > 12) recent = recent.slice(-12);
    prevState = Object.assign({}, state);

    dirty = true;
    syncControls();
  }

  function loop() {
    if (dirty) {
      rebuild();
      frame = 0;
      acquireAndDraw();
      drawSpectrum();
      drawArray();
      drawTimefreq();
      drawConstellation();
      drawSandbox();
      dirty = false;
    } else if (cache.acq && !cache.acq.triggered) {
      // 触发没锁上 → 波形要一直跑，每帧重新采集
      frame++;
      acquireAndDraw();
    }
    requestAnimationFrame(loop);
  }

  /* ======================================================================
   * 预设按钮
   * ==================================================================== */
  function applyPreset(idx) {
    if (!(idx >= 0 && idx < PRESETS.length)) idx = 0;
    state = Object.assign({}, DEFAULTS, PRESETS[idx].set);
    // 换预设等于重新开始一次实验，之前的操作历史不再相关
    prevState = Object.assign({}, state);
    recent = [{ id: 'preset', from: '—', to: PRESETS[idx].name, at: Date.now() }];
    els.presets.querySelectorAll('.preset').forEach(function (x, i) {
      x.classList.toggle('active', i === idx);
    });
    // 切到这台仪器所在的页签：预设挑的仪器跟眼前看的那台可能不是同一台
    setTab(instrOfPreset(idx));
    // 预设栏放不下时会横向滚动；从直链或窄屏进来时，把当前那个滚到看得见的地方
    var act = els.presets.querySelector('.preset.active');
    if (act) {
      var strip = els.presets;
      var left = act.offsetLeft, right = left + act.offsetWidth;
      if (left < strip.scrollLeft) strip.scrollLeft = left - 8;
      else if (right > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = right - strip.clientWidth + 8;
      }
    }
    onChange();
  }

  function buildPresets() {
    els.presets.innerHTML = '';
    PRESETS.forEach(function (pre, idx) {
      PRESET_GROUPS.forEach(function (g) {
        if (g.at !== idx) return;
        var lab = document.createElement('span');
        lab.className = 'preset-group' + (g.at === 0 ? ' preset-group--first' : '');
        lab.textContent = g.name;
        lab.dataset.instr = g.instr || 'wave';
        els.presets.appendChild(lab);
      });
      var b = document.createElement('button');
      b.className = 'preset';
      b.dataset.instr = instrOfPreset(idx);
      b.innerHTML = '<b>' + pre.name + '</b><i>' + pre.hint + '</i>';
      b.addEventListener('click', function () { applyPreset(idx); });
      els.presets.appendChild(b);
    });
    applyPreset(0);
  }

  /* ======================================================================
   * 启动
   * ==================================================================== */
  function init() {
    els.controls = document.getElementById('controls');
    els.scope = document.getElementById('scope');
    els.spectrum = document.getElementById('spectrum');
    els.array = document.getElementById('array');
    els.tf = document.getElementById('tf');
    els.con = document.getElementById('con');
    els.sb = document.getElementById('sb');
    els.advisor = document.getElementById('advisor');
    els.presets = document.getElementById('presets');
    els.tabs = document.getElementById('tabs');
    els.screens = document.getElementById('screens');

    state = Object.assign({}, DEFAULTS);

    buildControls();
    buildPresets();

    // 顶部页签：点哪台仪器就只展开哪台
    els.tabs.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.tab') : null;
      if (b) setTab(b.dataset.instr);
    });

    // 重置按钮
    document.getElementById('reset').addEventListener('click', function () {
      applyPreset(0);
    });

    // 支持 ?preset=混叠 这种直链，课堂上可以直接跳到某个现象
    var want = new URLSearchParams(location.search).get('preset');
    if (want !== null) {
      var idx = -1;
      PRESETS.forEach(function (x, i) { if (x.name === want) idx = i; });
      if (idx < 0 && /^\d+$/.test(want)) idx = Number(want);
      if (idx >= 0) applyPreset(idx);
    }

    // AI 助教面板（右侧第二个标签页）
    if (NS.tutor) NS.tutor.init();

    // 效果验证（前测 / 后测）覆盖层
    if (NS.quizui) NS.quizui.init();

    // 教师端（分层出练习 / 看全班）覆盖层
    if (NS.teacherui) NS.teacherui.init();

    // 沙盒：拖发射机 / 接收机 / 摆楼
    els.sb.addEventListener('pointerdown', onSbDown);
    els.sb.addEventListener('pointermove', onSbMove);
    els.sb.addEventListener('pointerup', onSbUp);
    els.sb.addEventListener('pointercancel', onSbUp);

    // 参数变了就重画（拖动滑条时也生效）
    window.addEventListener('resize', function () {
      lastAdviceSig = '';
      dirty = true;
    });

    requestAnimationFrame(loop);
  }

  /* ======================================================================
   * 给 AI 助教的状态快照
   *
   * 助教能说人话，靠的就是这里。它拿到的不是"一个正弦波"，
   * 而是屏幕上的真值，加上学生刚才动过哪些旋钮。
   * ==================================================================== */
  function context() {
    if (!cache.acq) return null;
    return {
      p: Object.assign({}, state),
      acq: cache.acq,
      kMax: cache.model ? cache.model.kMax : 1,
      range: cache.range,
      clipped: !!cache.clipped,
      arr: cache.arr,
      tf: cache.tf,
      con: cache.con,
      sb: cache.sb,
      cards: lastCards,
      history: recent
    };
  }

  window.SignalLab.lab = { context: context };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
