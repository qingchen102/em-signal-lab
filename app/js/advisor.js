/* ==========================================================================
 * advisor.js — 知识伴随面板
 *
 * 这一版是纯规则驱动（不依赖大模型），先把最要紧的事做对：
 * 面板上说的每一句话，都必须能从屏幕上当前的波形推出来。
 *
 * 每条卡片四段：
 *   现在看到的 → 为什么 → 哪门课讲过 → 再试试
 * 这四段就是"把知识串起来"的骨架。后面接大模型时，它读的也是同一份状态。
 * ========================================================================== */
(function (NS) {
  'use strict';

  function fmtHz(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(v / 1e6 < 10 ? 2 : 1) + ' MHz';
    if (v >= 1e3) return (v / 1e3).toFixed(v / 1e3 < 10 ? 2 : 1) + ' kHz';
    return v.toFixed(v < 10 ? 1 : 0) + ' Hz';
  }
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

  /* 星座图卡片的百分比格式化：误符号率从 10⁻¹ 到 10⁻⁷ 都可能，
     一律 toFixed(2) 的话全都会变成 0.00% */
  function conPct(v) {
    if (!(v > 0)) return '0';
    var p = v * 100;
    if (p >= 10) return p.toFixed(1) + '%';
    if (p >= 0.1) return p.toFixed(2) + '%';
    if (p >= 1e-4) return p.toFixed(4) + '%';
    return p.toExponential(1) + '%';
  }

  var WAVE_NAME = {
    sine: '正弦波',
    square: '方波',
    triangle: '三角波',
    sawtooth: '锯齿波',
    pulse: '脉冲'
  };

  /* 单频分量 f0 以 fs 采样后落到哪个频率上 */
  function aliasOf(f0, fs) {
    var k = Math.round(f0 / fs);
    return Math.abs(f0 - k * fs);
  }

  /* ======================================================================
   * 规则表：每条返回一个卡片或 null
   * priority 越小越靠前
   * ==================================================================== */
  var RULES = [

    /* ---- 1. 混叠：这是整个实验台最想让学生撞上的事 ---- */
    function (s) {
      var p = s.p, acq = s.acq;
      // 信号里实际存在的最高频率分量：第 kMax 次谐波
      var topFreq = s.kMax * p.freq;
      var nyq = p.sampleRate / 2;
      if (nyq >= topFreq) return null;   // 没混叠，交给别的规则

      var aliasF = aliasOf(p.freq, p.sampleRate);
      var isTone = p.wave === 'sine';

      return {
        id: 'aliasing',
        level: 'warn',
        priority: 1,
        title: '屏幕上这个波，是假的',
        what: isTone
          ? '你把 ' + fmtHz(p.freq) + ' 的正弦波送进去，采样率只有 ' + fmtHz(p.sampleRate) +
            '/s，屏幕上却出现了一个约 ' + fmtHz(aliasF) + ' 的波形。频率对不上。'
          : '信号里 ' + fmtHz(topFreq) + ' 以内的谐波，采样率只有 ' + fmtHz(p.sampleRate) +
            '/s，屏幕上的形状已经跟真实波形没关系了。',
        why: '采样定理要求采样率至少是信号最高频率的两倍（' + fmtHz(2 * topFreq) +
          '），现在只有 ' + fmtHz(p.sampleRate) + '/s。每周期才采到 ' +
          acq.samplesPerPeriod.toFixed(1) + ' 个点，高频分量被折叠到低频，这叫混叠（aliasing）。' +
          (isTone
            ? '折叠公式：|f − round(f/fs)·fs| = |' + fmtHz(p.freq) + ' − ' +
              fmtHz(Math.round(p.freq / p.sampleRate) * p.sampleRate) + '| = ' + fmtHz(aliasF) + '。'
            : ''),
        course: '《信号与系统》采样定理 · 《数字信号处理》第 1 章 · 《通信原理》模拟信号数字化',
        tryIt: '把采样率往上推到 ' + fmtHz(2.5 * topFreq) + ' 以上，波形会突然"归位"。注意：真实示波器通常有抗混叠滤波器会先滤掉高频，本实验台故意关掉了它，就是为了让你看见混叠本身。',
        key: 'aliasing'
      };
    },

    /* ---- 2. 触发没锁上 ---- */
    function (s) {
      var p = s.p, acq = s.acq;
      if (acq.triggered) return null;
      var r = s.range;
      return {
        id: 'no-trigger',
        level: 'warn',
        priority: 2,
        title: '波形在跑，因为触发没锁上',
        what: '触发电平设在 ' + fmtV(p.triggerLevel) + '，但信号的幅度只在 ' +
          fmtV(r.min) + ' ~ ' + fmtV(r.max) + ' 之间。波形一直在左右滑动，读不出任何东西。',
        why: '示波器的稳定显示靠触发：它每次都在"信号上升沿穿过触发电平"的那一刻开始画。' +
          '现在触发电平落在信号范围之外，找不到这个时刻，示波器只能自由运行，每次画的时间起点都不一样，所以看起来在跑。',
        course: '《电子测量技术》示波器原理 · 大学物理实验',
        tryIt: '把触发电平拖回信号范围中间（大约 ' + fmtV((r.min + r.max) / 2) + '），波形会立刻"钉"在屏幕上。',
        key: 'trigger'
      };
    },

    /* ---- 3. 一屏不到一个周期 ---- */
    function (s) {
      var p = s.p, acq = s.acq;
      if (acq.periods >= 0.8 || p.freq <= 0) return null;
      return {
        id: 'timebase-fast',
        level: 'info',
        priority: 3,
        title: '一屏还装不下一个周期',
        what: '信号周期是 ' + fmtT(1 / p.freq) + '，但当前时基 ' + fmtT(p.timePerDiv) +
          '/div 只覆盖 ' + fmtT(acq.Tdisp) + '，一屏才 ' + acq.periods.toFixed(2) + ' 个周期。',
        why: '时基决定了横轴每格代表多少时间，总共 10 格。一屏显示的时间 = 10 × 时基。' +
          '想看清一个完整的周期，一屏至少要放 2~5 个周期，也就是时基大约取周期的 1/20 ~ 1/50。',
        course: '《电子测量技术》示波器时基与扫描',
        tryIt: '把时基调到 ' + fmtT(1 / p.freq / 5) + '/div 左右，一屏就会出现约 5 个完整周期。',
        key: 'timebase'
      };
    },

    /* ---- 4. 波形挤成一团 ---- */
    function (s) {
      var p = s.p, acq = s.acq;
      if (acq.periods <= 60) return null;
      return {
        id: 'timebase-slow',
        level: 'info',
        priority: 6,
        title: '周期太多，波形挤成一团',
        what: '一屏塞进了 ' + acq.periods.toFixed(0) + ' 个周期，每个周期只有 ' +
          (100 / acq.periods).toFixed(1) + '% 的屏幕宽度，看上去就是一片亮带。',
        why: '时基太大，横轴每格代表的时间太长。波形细节被压缩到了像素以下，' +
          '这也是为什么示波器上看到"一坨绿色"时要先调时基。',
        course: '《电子测量技术》示波器时基',
        tryIt: '把时基调小到 ' + fmtT(1 / p.freq / 3) + '/div 左右。',
        key: 'timebase'
      };
    },

    /* ---- 5. 采样点太少（还没到混叠，但已经看不出形状）---- */
    function (s) {
      var p = s.p, acq = s.acq;
      if (acq.samplesPerPeriod >= 4 || acq.samplesPerPeriod < 2) return null;
      return {
        id: 'few-samples',
        level: 'info',
        priority: 5,
        title: '每个周期只有 ' + acq.samplesPerPeriod.toFixed(1) + ' 个采样点',
        what: '屏幕上的折线就是这些采样点直接连起来的。点这么少，' +
          '你看到的"波形"其实是连接方式画出来的，不是信号本身。',
        why: '屏幕宽度只有这么多像素，采样点太少时，示波器只能用直线把相邻点连起来。' +
          '点越少，连线离真实曲线越远。这就是为什么提高采样率能改善波形质量。但注意，采样率不够高时会直接混叠，那是另一个问题。',
        course: '《信号与系统》采样定理 · 《数字信号处理》',
        tryIt: '提高采样率看看波形如何变得平滑，然后再往下调，看看它什么时候开始"骗你"。',
        key: 'sampling'
      };
    },

    /* ---- 6. 超出屏幕 ---- */
    function (s) {
      var p = s.p, acq = s.acq;
      var peak = 0;
      for (var i = 0; i < acq.N; i++) {
        var a = Math.abs(acq.samples[i]);
        if (a > peak) peak = a;
      }
      var half = 4 * p.voltsPerDiv; // 屏幕中心到顶边 = 4 格
      if (peak <= half) return null;
      return {
        id: 'overrange',
        level: 'warn',
        priority: 4,
        title: '波形顶到屏幕外面去了',
        what: '当前垂直档位 ' + fmtV(p.voltsPerDiv) + '/div，屏幕上下各 4 格，能显示 ±' +
          fmtV(half) + '。但信号峰值到了 ' + fmtV(peak) + '。',
        why: '垂直档位决定纵轴每格代表多少电压。档位太小，信号就冲出屏幕，' +
          '你看到的"平顶"是屏幕边缘，不是信号被削平了。这两件事很容易混。',
        course: '《电子测量技术》示波器垂直系统',
        tryIt: '把垂直档位调到 ' + fmtV(peak / 3) + '/div 左右，波形会完整落在屏幕里。',
        key: 'vertical'
      };
    },

    /* ---- 7. AC 耦合隔掉了直流 ---- */
    function (s) {
      var p = s.p, acq = s.acq;
      if (p.coupling !== 'AC') return null;
      if (Math.abs(acq.removedDC) < 0.02) return null;
      return {
        id: 'ac-coupling',
        level: 'info',
        priority: 7,
        title: '直流分量被吃掉了',
        what: '信号本来有 ' + fmtV(acq.removedDC) + ' 的直流偏置，切到 AC 耦合之后，' +
          '波形整体移到了屏幕中间，偏置不见了。',
        why: 'AC 耦合在输入端串了一个电容，直流过不去，交流能过。' +
          '所以看纹波、看交流成分的时候用 AC，量真实电平时必须用 DC，用 AC 量出来的值会少掉直流那一块。',
        course: '《电路分析》一阶 RC 电路 · 《模拟电子技术》',
        tryIt: '切回 DC 耦合对比一下，再想想：如果要测电源的纹波，应该用哪种耦合？',
        key: 'coupling'
      };
    },

    /* ---- 8. 探头衰减 ---- */
    function (s) {
      var p = s.p;
      if (p.probe !== 10) return null;
      return {
        id: 'probe',
        level: 'info',
        priority: 9,
        title: '探头 ×10，屏幕上的电压要乘 10',
        what: '现在用的是 ×10 探头，示波器输入端看到的电压只有真实电压的十分之一。' +
          '屏幕上 1 V 实际上代表 10 V。',
        why: '×10 探头里有一个 9 MΩ 串联电阻，和示波器的 1 MΩ 输入分压。' +
          '它换来的是更高的输入阻抗和更小的负载效应，代价是信号被衰减 10 倍，读数要乘回去。',
        course: '大学物理实验 · 《电子测量技术》探头与输入阻抗',
        tryIt: '切成 ×1 看看波形怎么变高。再想想：测一个高阻抗电路时，为什么必须用 ×10？',
        key: 'probe'
      };
    },

    /* ---- 9. 带宽限制让方波变圆角 ---- */
    function (s) {
      var p = s.p;
      if (p.wave === 'sine' || p.wave === 'triangle') return null;
      if (s.kMax >= 25) return null;
      return {
        id: 'bandwidth-limit',
        level: 'good',
        priority: 8,
        title: '谐波被砍掉之后，' + (WAVE_NAME[p.wave] || '波形') + '就变成这样了',
        what: '带宽限制设在 ' + fmtHz(p.bandwidth) + '，基频 ' + fmtHz(p.freq) +
          '，所以只保留了前 ' + s.kMax + ' 次谐波。方波的棱角没了，变成了圆角。',
        why: '理想的方波需要无穷多次谐波才能拼出来（1f、3f、5f…幅度按 1/n 衰减）。' +
          '带宽一限制，高次谐波被砍，边沿就"爬"不上去，上升时间 ≈ 0.35 / 带宽。' +
          '这就是为什么示波器的带宽指标直接决定了它能不能看清快速边沿。',
        course: '《信号与系统》傅里叶级数 · 《电子测量技术》示波器带宽',
        tryIt: '慢慢把带宽限制推大，看方波的角是怎么一点点变尖的。注意边沿上那些小振荡，那是吉布斯现象，不是噪声。',
        key: 'bandwidth'
      };
    },

    /* ==================================================================
     * 阵列测向的卡片
     *
     * 这几条只在「屏幕上真的能看到那个现象」时才出现，比如阵元间距
     * 超过半波长、谱上确实多出一个峰。没证据就不说话。
     * ================================================================ */

    /* ---- 阵列 1. 只有一个阵元：方向信息根本不存在 ---- */
    function (s) {
      var a = s.arr;
      if (!a || a.M > 1) return null;
      return {
        id: 'array-single',
        level: 'info',
        priority: 11,
        array: true,
        title: '只有一个阵元：知道有信号，不知道从哪来',
        what: 'M = 1 时三条空间谱都是平的，屏幕上唯一有用的东西是那条紫色虚线（真实来波方向）。',
        why: '单个阵元只能回答"有没有信号"，回答不了"从哪来"。方向信息藏在平面波到达相邻阵元的时间差里，' +
          '只有一个阵元就没有"相邻"。把阵元摆成一排，相邻阵元的波程差 = d·sinθ，相位差 = 2π(d/λ)·sinθ，' +
          '方向才第一次变成可测量的东西。',
        course: '《电磁场与波》平面波的相位 · 《天线原理》阵列天线与阵因子',
        tryIt: '把阵元数 M 往上加，看主瓣是怎么一点点变窄的。M 每翻一倍，主瓣宽度大约减半。这就是"天线阵列有啥用"最直接的回答。',
        key: 'array'
      };
    },

    /* ---- 阵列 2. 栅瓣：间距太大，方向出现歧义 ---- */
    function (s) {
      var a = s.arr;
      if (!a || a.M <= 1 || a.d <= 0.55) return null;
      var peaks = (a.peaks.music && a.peaks.music.length) ? a.peaks.music : a.peaks.bartlett;
      var ghosts = peaks.filter(function (pk) {
        return pk.db > -6 && !a.angles.some(function (t) { return Math.abs(t - pk.deg) < 6; });
      });
      if (!ghosts.length) return null;
      var g = ghosts.map(function (pk) { return pk.deg.toFixed(0) + '°'; }).join('、');
      var truth = a.angles.map(function (t) { return t + '°'; }).join('、');
      return {
        id: 'array-grating',
        level: 'warn',
        priority: 13,
        array: true,
        title: '多出来一个方向，但那里没有信号源',
        what: '真实来波在 ' + truth + '，可是谱上在 ' + g + ' 也冒出了一个差不多高的峰。',
        why: '阵元间距 d = ' + a.d.toFixed(2) + ' λ，超过了半个波长。间距一大，两个不同方向的来波' +
          '就会产生同一组阵元间相位差，阵列分不清它们，于是凭空多出一个"栅瓣"。' +
          '数学上：sinθ 每差 λ/d 就重复一次，要不重复就必须 d ≤ λ/2。',
        course: '《天线原理》栅瓣与阵元间距 · 《信号与系统》采样定理（同一个道理）',
        tryIt: '把 d/λ 拖回 0.5 以下，栅瓣会消失。想想看：这跟采样定理要求 fs ≥ 2f 是不是同一件事？' +
          '空间上的"采样"就是阵元，角度的"混叠"就是栅瓣。',
        key: 'array'
      };
    },

    /* ---- 阵列 3. 阵元数不够，MUSIC 用不了 ---- */
    function (s) {
      var a = s.arr;
      if (!a || a.hasMusic || a.M <= 1) return null;
      return {
        id: 'array-music-fail',
        level: 'warn',
        priority: 12,
        array: true,
        title: '阵元数不够，MUSIC 这一路算不出来',
        what: '现在 M = ' + a.M + '，信源数 = ' + a.S + '。噪声子空间的维数是 M − S = ' +
          a.noiseDim + '，没有空间留给"噪声"，MUSIC 就失效了。',
        why: 'MUSIC 的原理是把协方差矩阵分成信号子空间和噪声子空间，靠噪声子空间来找方向。' +
          '这要求 M > S，阵元数必须严格大于信源数，否则两个子空间挤在一起，分不开。',
        course: '《数字信号处理》特征分解 · 《阵列信号处理》子空间法',
        tryIt: '把阵元数 M 加到 ' + (a.S + 1) + ' 以上，MUSIC 的曲线会立刻"站起来"。',
        key: 'array'
      };
    },

    /* ---- 阵列 4. 两个方向靠得太近 ---- */
    function (s) {
      var a = s.arr;
      if (!a || a.angles.length < 2) return null;
      var nTruth = a.angles.length;
      // 判“Bartlett 分不开”不能用峰个数：两个源挨得近时，主瓣顶部会微微
      // 起伏，峰检测会把它切成两个峰。直接和瑞利限比，既准确又讲得清楚。
      var sep = Math.abs(a.angles[0] - a.angles[1]);
      var rayleigh = 0.886 / (a.M * a.d) * 180 / Math.PI;
      if (sep >= rayleigh) return null;
      if (!a.peaks.music || a.peaks.music.length < nTruth) return null;
      return {
        id: 'array-resolution',
        level: 'good',
        priority: 14,
        array: true,
        title: '两个方向只差 ' + sep.toFixed(0) + '°：Bartlett 分不开，MUSIC 分得开',
        what: '真实来波有 ' + nTruth + ' 个，间隔只有 ' + sep.toFixed(0) + '°；而 M = ' + a.M +
          '、d = ' + a.d.toFixed(2) + 'λ 的阵列，瑞利限是 0.886λ/(M·d) = ' + rayleigh.toFixed(1) +
          '°，比这个间隔还大，所以 Bartlett（蓝）把两个方向糊成了一个包。' +
          'MUSIC（绿）却清清楚楚地立起 ' + a.peaks.music.length + ' 根尖峰。',
        why: 'Bartlett 是把各阵元按某个方向对齐相加，它的分辨率被阵列孔径卡死（瑞利限）：' +
          'M 个阵元、间距 d 的阵列，主瓣宽度约 0.886λ/(M·d) 弧度。两个方向比这个还近，就并成一个包。' +
          'MUSIC 换了个思路，它不看"哪个方向能量最大"，而是看"哪个方向的导向矢量与噪声子空间最正交"，' +
          '所以能突破瑞利限。代价是：必须知道信源个数，而且信噪比不能太低。',
        course: '《阵列信号处理》波束形成与子空间法 · 《天线原理》阵列分辨率',
        tryIt: '把两个方向慢慢拉开，看 Bartlett 从什么时候开始能分出两个峰；再拉回去，看 MUSIC 撑到多近才塌。然后降信噪比，看谁先扛不住。',
        key: 'array'
      };
    },

    /* ---- 阵列 5. 快拍数太少 ---- */
    function (s) {
      var a = s.arr;
      if (!a || a.K >= 2 * a.M) return null;
      return {
        id: 'array-snapshots',
        level: 'info',
        priority: 15,
        array: true,
        title: '快拍数太少，协方差矩阵还没"平均"出来',
        what: '现在只有 ' + a.K + ' 次快拍，而阵元有 ' + a.M + ' 个。谱线抖得厉害，峰值位置也不太准。',
        why: '空间谱算法的输入是样本协方差矩阵 R = X·Xᴴ/K，它是用 K 次快拍平均出来的。' +
          'K 太小，平均不够，R 里噪声那部分没被压下去，谱就会毛躁。经验上 K 至少要是阵元数的两三倍，谱才稳。',
        course: '《数字信号处理》功率谱估计 · 《随机信号分析》估计的方差',
        tryIt: '把快拍数从 10 慢慢往上推，看谱线是怎么一点点变光滑的。',
        key: 'array'
      };
    },

    /* ---- 阵列 6. 一切正常，讲讲原理 ---- */
    function (s) {
      var a = s.arr;
      if (!a || a.M < 2) return null;
      var nTruth = a.angles.length;
      // 两个方向超出瑞利限，Bartlett 才真的分得开；否则这张卡片的说法不成立
      if (nTruth >= 2) {
        var sepN = Math.abs(a.angles[0] - a.angles[1]);
        if (sepN < 0.886 / (a.M * a.d) * 180 / Math.PI) return null;
      }
      if (a.peaks.bartlett.length < nTruth) return null;
      if (a.hasMusic && a.peaks.music.length < nTruth) return null;
      var beam = 0.886 / (a.M * a.d) * 180 / Math.PI;
      var truth = a.angles.map(function (t) { return t + '°'; }).join('、');
      var found = a.peaks.music.length
        ? a.peaks.music.map(function (pk) { return pk.deg.toFixed(1) + '°'; }).join('、')
        : '—';
      return {
        id: 'array-normal',
        level: 'good',
        priority: 16,
        array: true,
        title: 'M = ' + a.M + ' 的阵列，把方向测出来了',
        what: '真实来波在 ' + truth + '，MUSIC 的峰落在 ' + found + '，跟真值对得上。',
        why: '阵元间距 ' + a.d.toFixed(2) + ' λ，相邻阵元的相位差是 2π(d/λ)·sinθ。' +
          '测出这个相位差，就能反解出 θ。这就是阵列测向的全部原理。' +
          '主瓣宽度大约是 0.886λ/(M·d) = ' + beam.toFixed(1) + '°，两个方向比这个还近就分不开了。',
        course: '《电磁场与波》平面波 · 《天线原理》阵列与波束形成 · 《阵列信号处理》MUSIC',
        tryIt: '把 M 从 ' + a.M + ' 减到 2，看主瓣怎么变胖；再把 d/λ 拖到 1 以上，看栅瓣怎么冒出来。',
        key: 'array'
      };
    },

    /* ---- 时频 1. 两个音一前一后，窗一长就糊成了同时 ---- */
    function (s) {
      var t = s.tf;
      if (!t || !t.mergesInTime) return null;
      var HM = NS.timefreq.fmtMs;
      var seg = t.truth.segments[0];
      var toneSec = seg.t1 - seg.t0;
      return {
        id: 'tf-merge',
        level: 'warn',
        priority: 12,
        title: '两个音明明一前一后，现在看着却像同时响的',
        what: '每个音只响 ' + HM(toneSec) + '，而一帧要吃掉 ' + HM(t.dt) + ' 的信号。'
          + '屏幕上那两个台阶被抹平了，先后的界线没了。',
        why: '一帧，就是“用这么长一段信号做一次傅里叶变换”。它算出来的是这一段时间里的平均频率成分，'
          + '并不告诉你这些成分各自出现在哪一刻。窗比单个音还长的时候，一帧里同时装得下两个音，'
          + '于是“先后”被平均成了“同时”，四个字母看着一模一样。'
          + '要把先后重新分开，窗必须缩到比单个音还短。',
        course: '《信号与系统》短时傅里叶变换 · 《数字信号处理》时频分辨率的测不准关系',
        tryIt: '把窗长从 512 点往下拖到 64 点，先后的两个台阶会重新出现；'
          + '再拖回 512 点，它们又糊到一起。这就是“窗长换一换，看到的东西不一样”。',
        key: 'tf'
      };
    },

    /* ---- 时频 2. 比窗还短的东西，时间上一定会被拖宽 ---- */
    function (s) {
      var t = s.tf;
      if (!t || !t.smeared || t.mergesInTime || t.scenario === 'sim') return null;
      var HM = NS.timefreq.fmtMs;
      return {
        id: 'tf-smear',
        level: 'warn',
        priority: 13,
        title: '信号只响了 ' + HM(t.featureSec) + '，屏幕上却拖到了 ' + HM(t.dt),
        what: '这一帧的长度是 ' + HM(t.dt) + '，比信号本身（' + HM(t.featureSec) + '）还长。'
          + '时间轴上那个亮区的宽度是窗宽，不是信号的真实长度。',
        why: '窗比事件长的时候，事件落在窗里的哪个位置都能被检出，只是幅度不同。'
          + '结果是这件事在时间轴上被“涂”成了一个窗那么宽的亮斑。'
          + '想量准一个短脉冲的到达时刻，只有把窗缩短，代价是频率分辨率变差（Δf = fs/N 变大）。',
        course: '《数字信号处理》STFT 的时间分辨率 · 《信号与系统》时宽带宽积',
        tryIt: '把窗长从 128 点降到 32 点，看亮区是怎么收紧到真实脉冲宽度的；'
          + '同时注意频谱方向那根线变粗了多少。',
        key: 'tf'
      };
    },

    /* ---- 时频 2b. 真同时：时间上完全重叠，频率上却是两条清楚的线 ---- */
    function (s) {
      var t = s.tf;
      if (!t || t.scenario !== 'sim') return null;
      var HM = NS.timefreq.fmtMs;
      var a = t.truth.segments[0], b = t.truth.segments[1];
      return {
        id: 'tf-simultaneous',
        level: 'info',
        priority: 14,
        title: '两个音一直同时响着：时间上分不开，频率上却分得清清楚楚',
        what: '两个音都是从 ' + HM(a.t0) + ' 响到 ' + HM(a.t1) + '，整段完全重叠；'
          + '频率上它们是 ' + fmtHz(a.f0) + ' 和 ' + fmtHz(b.f0) + ' 两根平行的亮线。'
          + '这一帧长 ' + HM(t.dt) + '，Δf = ' + fmtHz(t.df) + '，'
          + '两音相距 ' + fmtHz(t.sepHz) + '，比 Δf 宽 ' + (t.sepHz / t.df).toFixed(1) + ' 倍。',
        why: '这里没有“被糊掉”这回事。两个音本来就重叠，窗再长也不会让它们更重叠。'
          + '“一前一后”和“同时”在图上的区别，本来只该出现在时间轴上；'
          + '频率轴上两根线一直都在，因为它们相距 ' + fmtHz(t.sepHz) + '，远大于 Δf。'
          + '时间分辨率和频率分辨率是一对跷跷板（时宽带宽积）：窗越长，Δf 越细，但时间上越糊。',
        course: '《数字信号处理》STFT 的频率分辨率 · 《信号与系统》时宽带宽积',
        tryIt: '盯住 Δf = fs/N 这根杠杆：把窗长一路降下去，时间轴上的亮区会收紧，'
          + '但 Δf 跟着变大（32 点时已经是 ' + fmtHz(t.fs / 32) + '）；反过来加窗长，'
          + '频率分得更细、时间上更糊。两音相距 ' + fmtHz(t.sepHz) + '，'
          + '想看到它们并成一根，就得把 Δf 顶到这个数以上（或者把第二个音拖近）。',
        key: 'tf'
      };
    },

    /* ---- 时频 3. 两个音离得比 Δf 还近，频率上分不开 ---- */
    function (s) {
      var t = s.tf;
      if (!t || t.resolvesFreq !== false) return null;
      var HF = NS.timefreq.fmtHz;
      return {
        id: 'tf-freq-narrow',
        level: 'warn',
        priority: 15,
        title: '两个音只差 ' + HF(t.sepHz) + '，比这个窗的 Δf = ' + HF(t.df) + ' 还小',
        what: '窗长 ' + t.N + ' 点，Δf = fs/N = ' + HF(t.df) + '。两个音的间隔比 Δf 还小，'
          + '屏幕上只会看到一根粗线，看不出这其实是两个音。',
        why: 'Δf = fs/N 是一个窗能分辨的最小频率间隔，频率差比它小的两个分量，'
          + '在一次变换里会被合成一个峰。N 越大 Δf 越小、辨得越细；'
          + '可是 N 大也意味着 Δt = N/fs 大，时间上就更糊。这两个要求直接对立：Δt · Δf = 1。',
        course: '《数字信号处理》频率分辨率 · 《信号与系统》时频不确定性',
        tryIt: '把窗长往上加，直到两根线分开为止；记下这时的 Δf，'
          + '再看看时间轴上的亮区被拉宽了多少。',
        key: 'tf'
      };
    },

    /* ---- 时频 4. 一根斜线 = 频率在变，只看频谱是看不出来的 ---- */
    function (s) {
      var t = s.tf;
      if (!t || t.scenario !== 'chirp') return null;
      var HF = NS.timefreq.fmtHz;
      var seg2 = t.truth.segments[0];
      return {
        id: 'tf-chirp',
        level: 'info',
        priority: 16,
        title: '一根斜线：频率在随时间变化',
        what: '从 ' + HF(seg2.f0) + ' 一路扫到 ' + HF(seg2.f1) + '，没有一个“频率”是不变的。',
        why: '这是一段非平稳信号：它的频率成分本身就在变。'
          + '对整段做一次傅里叶变换，只能得到一条从低频铺到高频的宽包，看不出“先低后高”这个过程，'
          + '因为傅里叶变换把时间信息丢掉了。'
          + '时频图的做法是逐段做变换，把“哪一刻有哪些频率”同时保留下来，斜线就是这个信息本身。',
        course: '《信号与系统》非平稳信号与傅里叶变换的局限 · 《数字信号处理》STFT',
        tryIt: '先把窗长调大，斜线会变粗变短（时间上糊了、频率上细了）；'
          + '再调小，斜线变细但频率方向上变胖。亲眼看看它们是此消彼长的。',
        key: 'tf'
      };
    },

    /* ---- 时频 5. 这块屏幕还没撞上任何坑 ---- */
    function (s) {
      var t = s.tf;
      if (!t) return null;
      var HF = NS.timefreq.fmtHz, HM = NS.timefreq.fmtMs;
      return {
        id: 'tf-normal',
        level: 'good',
        priority: 20,
        title: '窗长 ' + t.N + ' 点，时间和频率各让一步',
        what: 'Δt = ' + HM(t.dt) + '，Δf = ' + HF(t.df) + '，两者相乘 Δt·Δf = '
          + t.product.toFixed(2) + ' ≈ 1。屏幕上一共 ' + t.nFrames + ' 帧。',
        why: '时频分析里没有免费的分辨率：窗长了频率看得细、时间看得糊；窗短了反过来。'
          + 'Δt·Δf ≥ 1 是个下限，任何窗函数都绕不过去，能做的只是选一个适合当前问题的折中。'
          + '所以要养成习惯：先问“我这次是想看清哪一刻，还是想分清哪个频率”。',
        course: '《数字信号处理》时频分析 · 《信号与系统》时宽带宽积',
        tryIt: '把窗长拖到两端各看一次，记住同一段信号在两种窗下长相的区别；'
          + '然后换到“两个音被糊成一个”和“真的同时”两个预设，对比它们到底差在哪。',
        key: 'tf'
      };
    },

    /* ---- 星座 1. 已经在判错了 ---- */
    function (s) {
      var t = s.con;
      if (!t || t.ser <= 0.02) return null;
      return {
        id: 'con-errors',
        level: 'warn',
        priority: 11,
        title: '红圈里的点，其实发的是蓝圈',
        what: '误符号率 SER = ' + conPct(t.ser) + '，误比特率 BER = ' + conPct(t.ber)
          + '。σ = ' + t.sigma.toFixed(3) + '，点距 d_min = ' + t.dmin.toFixed(2)
          + '，比值 d_min/(2σ) = ' + t.margin.toFixed(2) + '。',
        why: '接收端只拿到“收到的是哪个点”，能用的规则就是离谁近算谁，'
          + '在高斯白噪声下这是最优判决，没有更聪明的办法。'
          + '样本被噪声推过了两条中垂线，就判成了隔壁那一格。'
          + '注意丢的是“认错了”，不是“信号没了”：能量一点没少，只是分不清是哪一个；'
          + '而且挪到隔壁往往只错一两个比特，不是六个比特全翻。',
        course: '《通信原理》AWGN 信道误码率 · 数字调制的判决与误码',
        tryIt: '把 Es/N0 一格格往上抬，看红圈怎么一个个消失；'
          + '再把调制方式换成 BPSK，同一个信噪比下它一个都不错。',
        key: 'con'
      };
    },

    /* ---- 星座 2. 还没判错，但快撑不住了 ---- */
    function (s) {
      var t = s.con;
      if (!t || t.margin >= 3 || t.ser > 0.02) return null;
      return {
        id: 'con-crowded',
        level: 'warn',
        priority: 12,
        title: '噪声圆快蹭到判决边界了',
        what: 'σ = ' + t.sigma.toFixed(3) + '，判决边界离理想点还有 d_min/2 = '
          + (t.dmin / 2).toFixed(2) + '，比值 d_min/(2σ) = ' + t.margin.toFixed(2) + '。',
        why: '画在一个理想点上的那个圆半径就是 σ，约七成样本落在里面。'
          + '判决边界在 d_min/2 处，圆还没碰到它，所以现在还能全判对。'
          + '但“撑不撑得住”不看波形好不好看，只看这个比值。工程上一般要求它大于 3，'
          + '也就是噪声圆离边界还留三倍半径的余量。',
        course: '《通信原理》误码率与信噪比的关系',
        tryIt: '把 Es/N0 往下调 1～2 dB，看红圈什么时候开始冒出来；'
          + '然后切成 16QAM，同一个信噪比下它已经撑不住了。',
        key: 'con'
      };
    },

    /* ---- 星座 3. 高阶星座：拿功率效率换带宽效率 ---- */
    function (s) {
      var t = s.con;
      if (!t || t.M < 16) return null;
      return {
        id: 'con-tradeoff',
        level: 'info',
        priority: 15,
        title: '同样一份功率，塞的点越多，点距越挤',
        what: '这是 ' + t.modName + '，一个符号一口气搬 ' + t.bits + ' 个比特，'
          + '代价是最近的亮点之间只剩 d_min = ' + t.dmin.toFixed(2) + '，'
          + 'BPSK 只有两个点、点距是 2.00，现在这个是它的 '
          + (t.dmin / 2).toFixed(2) + ' 倍窄。当前 d_min/(2σ) = '
          + t.margin.toFixed(2) + '，误符号率 ' + conPct(t.ser) + '。',
        why: '每个符号的平均能量已经归一化成 1，这是公平比较的前提。'
          + '在这份功率里点越多、排得越密，判决边界离每个点就越近，'
          + '所以想维持同样的误码率，就得成倍地加信噪比。'
          + '这笔“带宽效率换功率效率”的账每个通信系统都要付：'
          + '香农公式给的是上限，星座图给的是一次具体的报价。',
        course: '《通信原理》M-QAM 星座图 · 功率效率与带宽效率 · 香农信道容量',
        tryIt: '先切到“给 64QAM 补 9 dB”看它变干净，再切回 BPSK 对比，'
          + '同样的信噪比，BPSK 一个都不错，但它一个符号只搬 1 个比特。',
        key: 'con'
      };
    },

    /* ---- 星座 4. 一切正常 ---- */
    function (s) {
      var t = s.con;
      if (!t || t.M >= 16) return null;
      var orth = t.M <= 4;
      return {
        id: 'con-normal',
        level: 'good',
        priority: 20,
        title: orth ? 'I 和 Q 为什么能同时各搬一个数'
                    : t.modName + ' 判决裕量 ' + t.margin.toFixed(2) + '，够用',
        what: orth
          ? '这是 ' + t.modName + '，一个符号 ' + t.bits + ' 个比特，也就是 ' + t.M
            + ' 个点。判决边界是按' + t.region + '划的：落进哪一格就判成哪一点，'
            + '误符号率 ' + conPct(t.ser) + '。'
          : 'd_min = ' + t.dmin.toFixed(2) + '，σ = ' + t.sigma.toFixed(3)
            + '，比值 d_min/(2σ) = ' + t.margin.toFixed(2) + '。这 ' + t.M
            + ' 个点目前一个都没判错，误符号率 ' + conPct(t.ser) + '。',
        why: orth
          ? 'I 和 Q 是同一路载波的两个相位，相差 90°。两个频率相同、相位差 90° 的正弦'
            + '在整整一个周期上积分等于零。这就是正交。所以它们互不干扰，可以各自独立地'
            + '搬一个数，接收端用两个相关器就能把它们分开。'
            + '“复数点”这个抽象说法，在物理上对应的就是这一对正交载波，'
            + '复基带、IQ 调制、OFDM 这一路概念都从这儿起步。'
          : '每个理想点周围的圆是噪声散布，半径就是 σ；判决边界在中垂线上。'
            + '只要圆离边界还有足够余量，判决就是可靠的。所以评估一个星座好不好，'
            + '看的是 d_min/(2σ) 这个比值，不是波形好不好看。',
        course: orth
          ? '《通信原理》正交调制与相干解调 · 《信号与系统》正交函数集'
          : '《通信原理》星座图与判决 · 误码率与信噪比',
        tryIt: orth
          ? '换成 8PSK，看八个点挤在同一圈上之后判决边界变成了什么样；'
            + '再换 16QAM，看它开始用幅度传信息之后，边界怎么从扇形变成方格。'
          : '把 Es/N0 往下慢慢拖，看 d_min/(2σ) 掉到多少时第一个红圈出现；'
            + '再换一种调制方式，比较它们在同一个信噪比下的处境。',
        key: 'con'
      };
    },

    /* ---- 沙盒 1. 直达被挡死：报出来的方向是墙的方向 ---- */
    function (s) {
      var t = s.sb;
      if (!t || !t.losBlocked || !t.nPaths || !t.strongest) return null;
      var dx = t.tx.x - t.rx.x, dy = t.tx.y - t.rx.y;
      var bear = -Math.asin(Math.max(-1, Math.min(1, dx / Math.sqrt(dx * dx + dy * dy)))) * 180 / Math.PI;
      return {
        id: 'sb-nlos',
        level: 'warn',
        priority: 9,
        title: '直线被挡住了，阵列量出来的是墙的方向',
        what: '发射机在 ' + bear.toFixed(0) + '° 方向，但它和阵列之间那栋楼把直线遮死了。'
          + '现在到阵列的只有 ' + t.nPaths + ' 条来波，全部是反射，'
          + '最强的一条从 ' + t.strongest.angle.toFixed(1) + '° 过来，'
          + '跟发射机真正的方位差了 ' + Math.abs(t.strongest.angle - bear).toFixed(0) + '°。',
        why: '阵列量的不是“发射机在哪里”，而是“信号从哪个方向来”。'
          + '直线被遮住时，能绕到你这里的只剩楼面弹过来的波，它指的就是那个反射点，不是发射机。'
          + '这就是城市里的非直视传播误差：室外基站定位、室内 Wi-Fi 定位都栽在这里。'
          + '麻烦在于要修正它先得知道哪一条是直达，而那正是此刻不知道的事。',
        course: '《天线原理》电磁波传播与阴影 · 《无线定位》非直视误差',
        tryIt: '把发射机拖到楼边上的空当里，让直线重新变通，方向会立刻跳回真值；'
          + '再切到“开阔地”看没有楼时的样子。',
        key: 'sb'
      };
    },

    /* ---- 沙盒 2. 一台发射机，好几个方向 ---- */
    function (s) {
      var t = s.sb;
      if (!t || !t.nPaths || t.nPaths < 3 || !t.nLos) return null;
      var lo = Math.min.apply(null, t.angles), hi = Math.max.apply(null, t.angles);
      return {
        id: 'sb-multipath',
        level: 'warn',
        priority: 10,
        title: '只有一台发射机，阵列却看到好几个方向',
        what: '一共 ' + t.nPaths + ' 条来波：直达 1 条，一次反射 ' + t.nOrder1
          + ' 条，两次反射 ' + t.nOrder2 + ' 条；方向散布在 ' + lo.toFixed(0)
          + '° 到 ' + hi.toFixed(0) + '° 之间。',
        why: '楼面是很好的镜子。同一段信号可以走直达、可以从墙上弹一次、弹两次再进来，'
          + '它们到达的时刻和方向都不一样。阵列看到“好几个方向”不是它坏了，而是它老实：'
          + '这几个方向上确实有能量进来。'
          + '再往上加一层，这一层沙盒里看得见：这几条来波是同一路信号的相干拷贝，'
          + '信源协方差严格秩 1，阵列把它们合成了一个“等效方向”，而这个等效方向并不落在阵列流形上。'
          + '所以 MUSIC 的谱不能按峰读数，它报出的峰可能比真实路径还多，'
          + '而多出来的那几个方向上一条路都没有。把“峰个数”当成“信号源个数”，在这里一定会翻车。',
        course: '《天线原理》多径传播 · 《阵列信号处理》相干源与解相干',
        tryIt: '把反射阶数从“两次反射”降到“只算直达”，看方向怎么塌回一根；'
          + '再对照上面阵列屏里 MUSIC 报出的峰，看它们和真实来波方向对得上几个。',
        key: 'sb'
      };
    },

    /* ---- 沙盒 3. 时延扩展与相干带宽 ---- */
    function (s) {
      var t = s.sb;
      if (!t || !t.nPaths || t.nPaths < 2 || !(t.spreadRms > 0)) return null;
      var late = t.lastArrival;
      var extra = t.strongest ? (t.strongest.len - Math.sqrt(
        Math.pow(t.tx.x - t.rx.x, 2) + Math.pow(t.tx.y - t.rx.y, 2))) : 0;
      return {
        id: 'sb-delay',
        level: 'info',
        priority: 15,
        title: '先到和后到差了 ' + (late * 1e9).toFixed(0) + ' ns',
        what: '发射机到阵列的直线距离 ' + Math.sqrt(
          Math.pow(t.tx.x - t.rx.x, 2) + Math.pow(t.tx.y - t.rx.y, 2)).toFixed(0)
          + ' 米，绕楼走的那一条要多走 ' + extra.toFixed(0) + ' 米。'
          + '最晚到的比最早到的晚 ' + (late * 1e9).toFixed(0) + ' ns，'
          + '时延扩展 σ = ' + (t.spreadRms * 1e9).toFixed(0) + ' ns，'
          + '相干带宽 ' + (t.coherenceBw === Infinity ? '—' : (t.coherenceBw / 1e6).toFixed(2) + ' MHz') + '。',
        why: '同一段信号走了不同的路，到达时间就不同。'
          + '这几个副本在接收端一叠加：有的频率同相相加、有的反相抵消，'
          + '于是信道对不同频率的待遇不一样，这叫频率选择性衰落。'
          + '判据就是相干带宽：信号带宽比它窄，整个信号一起起伏，补个增益就行；'
          + '比它宽，波形就被拧歪了，得靠均衡器一格格拉回来。',
        course: '《通信原理》多径衰落 · 时延扩展与相干带宽 · 均衡',
        tryIt: '切到“密集楼群”，反射路更绕、时延扩展更大，看相干带宽怎么被压下去；'
          + '再把频率加高，同样的路长对应更多个波长，多径的相位关系就完全换了一套。',
        key: 'sb'
      };
    },

    /* ---- 沙盒 4. 开阔地对照 ---- */
    function (s) {
      var t = s.sb;
      if (!t || !t.nPaths || t.nLos !== 1 || t.nPaths !== 1) return null;
      return {
        id: 'sb-normal',
        level: 'good',
        priority: 20,
        sb: true,
        title: '没有楼的时候，方向就是方向',
        what: '开阔地，只有一条直达路径，从 ' + t.strongest.angle.toFixed(1)
          + '° 过来，单程 ' + t.strongest.len.toFixed(0) + ' 米，'
          + '自由空间损耗 ' + t.strongest.gainDb.toFixed(1) + ' dB。',
        why: '没有反射就没有多径，阵列报出的方向直接就是发射机的方位。'
          + '把这张图和“城市峡谷”放一起看，就能把责任分清楚：'
          + '不是阵列不行，是环境往里加了东西。',
        course: '《天线原理》自由空间传播 · 《阵列信号处理》波达方向估计',
        tryIt: '切到“城市峡谷”，同一副阵列、同一台发射机，只把楼加上去，看它报出什么。',
        key: 'sb'
      };
    },

    /* ---- 10. 默认：一切正常，讲讲原理 ---- */
    function (s) {
      var p = s.p;
      var isSine = p.wave === 'sine';
      return {
        id: 'normal',
        level: 'good',
        priority: 20,
        title: '一个稳定的' + (WAVE_NAME[p.wave] || '波形'),
        what: '幅度 ' + fmtV(p.amp) + '，频率 ' + fmtHz(p.freq) + '，周期 ' + fmtT(1 / p.freq) +
          '。一屏 ' + s.acq.periods.toFixed(2) + ' 个周期，每周期采到 ' +
          s.acq.samplesPerPeriod.toFixed(0) + ' 个点。波形已经稳定触发。',
        why: isSine
          ? '正弦波只有一个频率分量，所以在频谱仪上只有一根谱线。它是唯一"带宽限制不影响形状"的波形，因为它本来就没有高次谐波。'
          : '这个波形在频谱仪上有一串谱线，位置在 f、2f、3f… 上，幅度按一定规律衰减。时域看到的形状，就是这些谱线叠加的结果。',
        course: '《信号与系统》周期信号的傅里叶级数',
        tryIt: '把频谱仪打开，对照着看：时域上的这个形状，在频域上长什么样？' +
          (isSine ? '然后换成方波，看看谱线有什么不同。' : '试着把带宽限制调低，观察时域和频域同时发生的变化。'),
        key: 'normal'
      };
    }
  ];

  /* ======================================================================
   * 主入口
   * ==================================================================== */
  /* 每张卡片只属于一台仪器：只给眼前这台仪器出主意，免得五台仪器的话挤在一起。 */
  function cardInstr(c) {
    if (c.key === 'array' || c.key === 'arr' || c.array) return 'arr';
    if (c.key === 'tf') return 'tf';
    if (c.key === 'con') return 'con';
    if (c.key === 'sb' || c.sb) return 'sb';
    return 'wave';
  }

  function advise(state) {
    var cards = [];
    var want = state && state.instr;
    for (var i = 0; i < RULES.length; i++) {
      var c = RULES[i](state);
      if (!c) continue;
      if (want && cardInstr(c) !== want) continue;
      cards.push(c);
    }
    // “一切正常”那条只在没别的可说的时候才出现，免得抢了真正的问题。
    // 阵列那几张卡片不算"问题"，所以它们不会把 normal 挤掉。
    var hasSpecific = cards.some(function (c) { return c.priority < 20 && !c.array && !c.sb; });
    if (hasSpecific) cards = cards.filter(function (c) { return c.priority < 20 || c.array || c.sb; });
    cards.sort(function (a, b) { return a.priority - b.priority; });
    return cards;
  }

  NS.advisor = {
    advise: advise,
    aliasOf: aliasOf,
    fmtHz: fmtHz,
    fmtT: fmtT,
    fmtV: fmtV,
    WAVE_NAME: WAVE_NAME
  };
})((window.SignalLab = window.SignalLab || {}));
