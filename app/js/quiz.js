/* 信号实验室 · 效果验证题库
 *
 * 这里只做三件事：出题、判分、存结果。界面在 quizui.js。
 *
 * 为什么题目是「生成」的而不是「写死」的：
 *   每道题的图都由 NS.signal / NS.fft / NS.array 实时算出来，答案键也是同一次计算
 *   顺手记下来的。所以答案不会抄错，改一个种子就能生成一套难度相同、数字不同的
 *   平行卷，前测和后测用的就是同一份蓝图、两个种子。
 *
 * 题目只在「图 + 题干」能自洽时才算合格：图里不许出现任何直接写出答案的标注
 *   （spectrum / array 的 clean 选项就是干这个的）。
 */
(function (NS) {
  'use strict';

  var STORE_KEY = 'signallab.quiz.v1';

  // 前测 / 后测：同一份蓝图，两个种子。rot 是卷别偏移，保证两套卷子选中不同的参数
  // 组合（两个种子的第一个随机数都小于 0.2，不偏移就会撞在同一组上）。
  var FORMS = {
    pre: { key: 'pre', seed: 731401, rot: 0, label: '前测' },
    post: { key: 'post', seed: 917333, rot: 1, label: '后测' }
  };

  // 锚题：前测后测完全相同的概念题。它们不换数字，用来把两套卷子的难度连起来 ，
  // 只比总分的话，没人分得清「后测考得好」是因为学会了，还是因为后测那套恰好更容易。
  var ANCHORS = ['p2', 'i1', 'i2', 'a2'];

  var TOPICS = {
    timedomain: '时域基本量',
    sampling: '采样定理',
    spectrum: '频谱与谐波',
    instrument: '示波器操作',
    array: '阵列测向'
  };

  // ---------------- 小工具 ----------------

  function fmtHz(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + ' MHz';
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + ' kHz';
    return (Math.round(v * 10) / 10) + ' Hz';
  }

  function fmtT(v) {
    if (v >= 1) return v.toFixed(2) + ' s';
    if (v >= 1e-3) return (v * 1e3).toFixed(2) + ' ms';
    if (v >= 1e-6) return (v * 1e6).toFixed(2) + ' µs';
    return (v * 1e9).toFixed(1) + ' ns';
  }

  function fmtV(v) {
    if (Math.abs(v) >= 1) return v.toFixed(2) + ' V';
    if (Math.abs(v) >= 1e-3) return (v * 1e3).toFixed(0) + ' mV';
    return (v * 1e6).toFixed(0) + ' µV';
  }

  function shuffle(r, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 正确答案固定放 uniq[0]，打乱后返回它在选项里的位置
  function pack(correct, wrongs, r) {
    var uniq = [correct];
    for (var i = 0; i < wrongs.length; i++) {
      if (uniq.indexOf(wrongs[i]) < 0) uniq.push(wrongs[i]);
    }
    // 干扰项跟正确答案撞车时会被去重，偶尔就只剩两个选项。二选一是抛硬币，
    // 不该出现在卷子里，不够三个就补一个永远成立的兜底项。
    var FILLERS = ['以上都不对', '无法判断', '条件不足，算不出来'];
    for (var f = 0; f < FILLERS.length && uniq.length < 3; f++) {
      if (uniq.indexOf(FILLERS[f]) < 0) uniq.push(FILLERS[f]);
    }
    var order = shuffle(r, uniq.map(function (_, k) { return k; }));
    return {
      choices: order.map(function (k) { return uniq[k]; }),
      answer: order.indexOf(0)
    };
  }

  function baseState(over) {
    var p = {
      wave: 'sine', freq: 1000, amp: 1, offset: 0, phase: 0, duty: 0.5,
      noise: 0, bandwidth: 1e6,
      timePerDiv: 200e-6, voltsPerDiv: 0.5, sampleRate: 1e6,
      triggerLevel: 0, coupling: 'DC', probe: 1,
      spanHz: 20000
    };
    for (var k in over) if (over.hasOwnProperty(k)) p[k] = over[k];
    return p;
  }

  // ---------------- 十个题目生成器 ----------------
  // 每个生成器返回 { id, topic, stem, fig, choices, answer, explain }

  // 1. 时域：读周期求频率
  function genT1(r, rot) {
    var combos = [
      { tpd: 200e-6, periods: 2 },  // T = 1 ms   → 1 kHz
      { tpd: 200e-6, periods: 5 },  // T = 400 µs → 2.5 kHz
      { tpd: 500e-6, periods: 4 },  // T = 1.25 ms → 800 Hz
      { tpd: 100e-6, periods: 4 },  // T = 250 µs → 4 kHz
      { tpd: 1e-3, periods: 5 }     // T = 2 ms   → 500 Hz
    ];
    var c = combos[(Math.floor(r() * combos.length) + rot) % combos.length];
    var f = c.periods / (10 * c.tpd);
    var p = baseState({
      freq: f, timePerDiv: c.tpd, voltsPerDiv: 0.5,
      sampleRate: Math.max(f * 200, 1e5)
    });
    var pk = pack(fmtHz(f), [fmtHz(f * 2), fmtHz(f / 2), fmtHz(f * 4)], r);
    return {
      id: 't1', topic: 'timedomain',
      data: { tpd: c.tpd, periods: c.periods, f: f },
      stem: '示波器屏幕上是一个稳定的正弦波。时基（Time/div）是 ' + fmtT(c.tpd) +
        '，屏幕上刚好显示 ' + c.periods + ' 个完整周期。这个信号的频率是多少？',
      fig: { kind: 'scope', state: p, caption: '时基 ' + fmtT(c.tpd) + '/div · 垂直 500 mV/div · 屏幕 10 格宽' },
      choices: pk.choices, answer: pk.answer,
      explain: '一屏宽度 = 10 × 时基 = ' + fmtT(10 * c.tpd) + '。里面装了 ' + c.periods +
        ' 个周期，所以周期 T = ' + fmtT(10 * c.tpd) + ' ÷ ' + c.periods + ' = ' + fmtT(1 / f) +
        '，频率 f = 1/T = ' + fmtHz(f) + '。'
    };
  }

  // 2. 时域：读幅度
  function genT2(r, rot) {
    var combos = [
      { vpd: 0.5, divs: 4 },   // 峰峰 2 V   → 峰值 1 V
      { vpd: 0.5, divs: 6 },   // 峰峰 3 V   → 峰值 1.5 V
      { vpd: 0.2, divs: 5 },   // 峰峰 1 V   → 峰值 0.5 V
      { vpd: 1.0, divs: 4 }    // 峰峰 4 V   → 峰值 2 V
    ];
    var c = combos[(Math.floor(r() * combos.length) + rot) % combos.length];
    var pp = c.vpd * c.divs;
    var amp = pp / 2;
    var p = baseState({ amp: amp, voltsPerDiv: c.vpd, freq: 1000, sampleRate: 2e5 });
    var pk = pack(fmtV(amp), [fmtV(pp), fmtV(amp / 2), fmtV(amp * 2)], r);
    return {
      id: 't2', topic: 'timedomain',
      data: { vpd: c.vpd, divs: c.divs, pp: pp, amp: amp },
      stem: '垂直档位（Volts/div）是 ' + fmtV(c.vpd) + '。屏幕上波形从最低点到最高点一共占了 ' +
        c.divs + ' 格。这个正弦波的峰值（振幅）是多少？',
      fig: { kind: 'scope', state: p, caption: '垂直 ' + fmtV(c.vpd) + '/div · 屏幕 8 格高' },
      choices: pk.choices, answer: pk.answer,
      explain: '占 ' + c.divs + ' 格 × ' + fmtV(c.vpd) + '/格 = 峰峰值 ' + fmtV(pp) +
        '。峰值是峰峰值的一半，即 ' + fmtV(amp) + '。示波器上量到的从来都是峰峰值，振幅要自己除 2。'
    };
  }

  // 3. 采样：折叠频率计算
  function genS1(r, rot) {
    var combos = [
      { f0: 1200, fs: 1000 },  // → 200 Hz
      { f0: 1500, fs: 2000 },  // → 500 Hz
      { f0: 3000, fs: 2000 },  // → 1000 Hz
      { f0: 7000, fs: 4000 },  // → 1000 Hz
      { f0: 2500, fs: 1000 }   // → 500 Hz
    ];
    var c = combos[(Math.floor(r() * combos.length) + rot) % combos.length];
    var fold = Math.abs(c.f0 - Math.round(c.f0 / c.fs) * c.fs);
    var pk = pack(fmtHz(fold), [fmtHz(c.f0), fmtHz(c.fs - c.f0 > 0 ? c.fs - c.f0 : c.fs + c.f0), fmtHz(Math.abs(c.fs - c.f0))], r);
    return {
      id: 's1', topic: 'sampling',
      data: { f0: c.f0, fs: c.fs, fold: fold },
      stem: '信号发生器输出 ' + fmtHz(c.f0) + ' 的正弦波，示波器采样率设成 ' + fmtHz(c.fs) +
        '（本实验台故意关掉了抗混叠滤波器，跟真实示波器不同）。屏幕上会显示多少赫兹的波形？',
      fig: null,
      choices: pk.choices, answer: pk.answer,
      explain: '采样率 ' + fmtHz(c.fs) + ' 能正确表示的最高频率是 fs/2 = ' + fmtHz(c.fs / 2) +
        '。' + fmtHz(c.f0) + ' 超过了它，发生混叠。折叠公式：|f0 − round(f0/fs)·fs| = |' +
        fmtHz(c.f0) + ' − ' + Math.round(c.f0 / c.fs) + ' × ' + fmtHz(c.fs) + '| = ' + fmtHz(fold) + '。'
    };
  }

  // 4. 采样：每周期采样点数
  function genS2(r, rot) {
    var combos = [
      { f0: 1000, fs: 3000 },   // 3 点
      { f0: 1000, fs: 5000 },   // 5 点
      { f0: 2000, fs: 6000 },   // 3 点
      { f0: 500, fs: 4000 }     // 8 点
    ];
    var c = combos[(Math.floor(r() * combos.length) + rot) % combos.length];
    var n = Math.round(c.fs / c.f0);
    var p = baseState({ freq: c.f0, sampleRate: c.fs, timePerDiv: 5 / c.f0, voltsPerDiv: 0.5 });
    var pk = pack(n + ' 个', [(n * 2) + ' 个', Math.max(1, Math.round(n / 2)) + ' 个', (n + 10) + ' 个'], r);
    return {
      id: 's2', topic: 'sampling',
      data: { f0: c.f0, fs: c.fs, n: n },
      stem: '信号是 ' + fmtHz(c.f0) + '，示波器采样率是 ' + fmtHz(c.fs) +
        '。屏幕上每个周期采到几个点？',
      fig: { kind: 'scope', state: p, caption: '时基 ' + fmtT(5 / c.f0) + '/div · 采样率 ' + fmtHz(c.fs) },
      choices: pk.choices, answer: pk.answer,
      explain: '每周期采样点数 = fs / f0 = ' + fmtHz(c.fs) + ' ÷ ' + fmtHz(c.f0) + ' = ' + n +
        '。点太少时，屏幕上的折线已经不是真实波形了，它是把几个孤立点连起来的结果。'
    };
  }

  // 5. 频谱：读基波频率
  function genP1(r, rot) {
    var combos = [
      { f: 1000, wave: 'square' },
      { f: 2000, wave: 'square' },
      { f: 500, wave: 'sawtooth' },
      { f: 1500, wave: 'square' }
    ];
    var c = combos[(Math.floor(r() * combos.length) + rot) % combos.length];
    var span = c.f * 12;
    var p = baseState({
      wave: c.wave, freq: c.f, bandwidth: 1e6,
      spanHz: span, sampleRate: 1e6
    });
    var pk = pack(fmtHz(c.f), [fmtHz(c.f * 2), fmtHz(c.f * 3), fmtHz(c.f / 2)], r);
    return {
      id: 'p1', topic: 'spectrum',
      data: { f: c.f, wave: c.wave, span: span },
      stem: '频谱仪屏幕上是一串等间隔的谱线，扫宽 ' + fmtHz(span) +
        '。这个信号的基波频率是多少？',
      fig: { kind: 'spectrum', state: p, caption: '频谱仪 · 扫宽 ' + fmtHz(span) + ' · 纵轴 dBc' },
      choices: pk.choices, answer: pk.answer,
      explain: '最左边那根谱线就是基波，读横轴得 ' + fmtHz(c.f) + '。后面每一根都是它的整数倍，' +
        '周期信号的频谱永远是「一根一根等间隔的线」，间隔就是基波频率。'
    };
  }

  // 6. 频谱：方波为什么只有奇次谐波
  function genP2(r, rot) {
    var f = [1000, 2000, 500][(Math.floor(r() * 3) + rot) % 3];
    var span = f * 10;
    var p = baseState({ wave: 'square', freq: f, bandwidth: 1e6, spanHz: span, sampleRate: 1e6 });
    var pk = pack(
      '方波只由奇次谐波组成，偶次谐波的幅度本来就是零',
      [
        fmtHz(2 * f) + ' 超出了示波器的带宽',
        '偶次谐波被噪声淹没了，看不见',
        '频谱仪的扫宽不够，' + fmtHz(2 * f) + ' 落在了屏幕外'
      ], r);
    return {
      id: 'p2', topic: 'spectrum',
      data: { f: f, span: span },
      stem: '这是一个 ' + fmtHz(f) + ' 方波的频谱。谱线出现在 ' + fmtHz(f) + '、' + fmtHz(3 * f) +
        '、' + fmtHz(5 * f) + '…… 为什么 ' + fmtHz(2 * f) + ' 那里是空的？',
      fig: { kind: 'spectrum', state: p, caption: '频谱仪 · 扫宽 ' + fmtHz(span) },
      choices: pk.choices, answer: pk.answer,
      explain: '方波的傅里叶级数里只有 sin(2πf t)、sin(6πf t)、sin(10πf t)…… 也就是 1、3、5 次，' +
        '偶次项的系数恒等于零。这不是仪器没测到，是它根本不存在。顺带一提：把带宽限制调低，' +
        '高次谐波被砍掉，方波在时域上就会变成圆角。时域和频域是同一件事。'
    };
  }

  // 7. 示波器操作：触发
  function genI1(r, rot) {
    var pk = pack(
      '触发电平没有落在信号的电压范围之内',
      ['垂直档位设得太小', '耦合方式选成了 AC', '探头倍率设成了 ×10'], r);
    return {
      id: 'i1', topic: 'instrument',
      data: {},
      stem: '波形在屏幕上不停地横向跑动，怎么都停不下来。最可能是哪个环节没设好？',
      fig: null,
      choices: pk.choices, answer: pk.answer,
      explain: '示波器每扫完一屏都要重新找「从哪一点开始画」，这个起点由触发电平决定。' +
        '电平落在信号电压范围之外时，比较器永远等不到穿越，屏幕就只能自由运行，' +
        '波形看起来就是在跑。垂直档位只影响纵向标度，不影响横向稳定性。'
    };
  }

  // 8. 示波器操作：AC 耦合
  function genI2(r, rot) {
    var pk = pack(
      '信号里带着直流偏置',
      ['信号里含有大量高频噪声', '信号的谐波失真很严重', '探头倍率设错了'], r);
    return {
      id: 'i2', topic: 'instrument',
      data: {},
      stem: '把耦合从 DC 切到 AC，波形整体从屏幕偏上的位置落到了正中间，形状没变。这说明原来的信号里有什么？',
      fig: null,
      choices: pk.choices, answer: pk.answer,
      explain: 'AC 耦合在输入端串了一个电容，直流分量过不去，所以波形整体下移到以 0 为中心。' +
        '形状不变说明交流部分被完整保留了。反过来说：量直流电平时必须用 DC 耦合，' +
        '否则你量到的永远只有交流部分。'
    };
  }

  // 9. 阵列：读来波方向
  function genA1(r, rot) {
    var combos = [
      { a: [-40, 20], seed: 11 },
      { a: [-25, 35], seed: 23 },
      { a: [-50, 10], seed: 37 },
      { a: [-15, 45], seed: 53 }
    ];
    var c = combos[(Math.floor(r() * combos.length) + rot) % combos.length];
    var cfg = { M: 8, spacing: 0.5, snrDb: 20, sources: 2, angles: c.a, snapshots: 300, seed: c.seed };
    var right = c.a[0] + '° 和 ' + (c.a[1] > 0 ? '+' : '') + c.a[1] + '°';
    var pk = pack(right, [
      (c.a[1] > 0 ? '+' : '') + c.a[1] + '° 和 ' + c.a[0] + '°',
      '0° 和 ' + (c.a[1] > 0 ? '+' : '') + c.a[1] + '°',
      c.a[0] + '° 和 0°'
    ], r);
    return {
      id: 'a1', topic: 'array',
      data: { angles: c.a.slice(), M: 8, spacing: 0.5, seed: c.seed },
      stem: '8 个阵元的均匀线阵，阵元间距 0.5λ，两个互不相干的信源。三条曲线在同一个方向长出尖峰。来波方向是哪两个？',
      fig: { kind: 'array', cfg: cfg, caption: '均匀线阵 M=8 · d=0.5λ · SNR 20 dB · 横轴 −90°…+90°' },
      choices: pk.choices, answer: pk.answer,
      explain: '谱峰的角度就是来波方向。注意三条曲线是同一个数据的三种算法，峰的位置应该一致，' +
        '如果它们指向不同的地方，那说明算法失效了，不是真有那么多信号源。'
    };
  }

  // 10. 阵列：栅瓣
  function genA2(r, rot) {
    var cfg = { M: 8, spacing: 1.0, snrDb: 20, sources: 1, angles: [30], snapshots: 300, seed: 71 + rot * 13 };
    var pk = pack(
      '那是栅瓣，阵元间距太大，产生了方向上的「假像」',
      ['−30° 那里确实还有第二个信号源', '那是算法没收敛，多算出来一个峰', '那是背景噪声，不是真的峰'], r);
    return {
      id: 'a2', topic: 'array',
      data: { angle: 30, M: 8, spacing: 1.0, seed: 71 + rot * 13 },
      stem: '这个阵列的阵元间距是 1.0λ，只有一个信号源，从 +30° 来。可是谱上 −30° 也长出了一个几乎一样高的峰。怎么解释？',
      fig: { kind: 'array', cfg: cfg, caption: '均匀线阵 M=8 · d=1.0λ · 单个信源 · 横轴 −90°…+90°' },
      choices: pk.choices, answer: pk.answer,
      explain: '阵元间距 d 超过半波长后，相邻阵元的相位差会出现多解，好几个方向都能产生同一组相位差，' +
        '测向结果就不再唯一。不出现栅瓣的条件是 d ≤ λ/2。这和采样定理里的混叠是同一回事：' +
        '「间隔取得太大，就会出现假的复制品」，只不过一个发生在时间轴上，一个发生在空间角度上。'
    };
  }

  // 11. 阵列：MUSIC 把主瓣里的两个源分开了，Bartlett 没有（练习卷专用，见下面的 EXTRAS）
  function genA3(r, rot) {
    var cfg = { M: 8, spacing: 0.5, snrDb: 20, sources: 2, angles: [-1.5, 1.5], snapshots: 300, seed: 119 };
    var pk = pack(
      'MUSIC 是超分辨算法，能分辨到常规波束形成的瑞利限以内。常规波束形成的分辨力上限由阵列孔径决定，跟采多少数据无关',
      [
        'MUSIC 多出来的那个峰是算法没收敛，是假的',
        '说明那个方向上确实还有第三个信号源',
        '说明这组数据的信噪比太低，Bartlett 和 MVDR 都被噪声压住了'
      ], r);
    return {
      id: 'a3', topic: 'array',
      data: { angles: [-1.5, 1.5], sep: 3, M: 8, spacing: 0.5, seed: 119 },
      stem: '8 阵元均匀线阵、d = 0.5λ，主瓣宽度约 14°。两个源分别从 −1.5° 和 +1.5° 来，只差 3°。' +
        '三条曲线里 Bartlett 和 MVDR 都只有一个峰，MUSIC 却长出了两个。该怎么理解这张图？',
      fig: { kind: 'array', cfg: cfg, caption: '均匀线阵 M=8 · d=0.5λ · 两个源只差 3° · 横轴 −90°…+90°' },
      choices: pk.choices, answer: pk.answer,
      explain: '常规波束形成（Bartlett）的分辨力上限是阵列孔径：主瓣宽度约 0.886λ/(Md) ≈ 14°，' +
        '两个源只差 3°，远在这个主瓣以内，采多少快拍都会糊成一个峰，多采数据只降低估计的方差，不改动主瓣宽度。' +
        'MVDR 自适应地压低旁瓣，在这个场景里比 Bartlett 干净，但同样受孔径限制。' +
        'MUSIC 用的是信号子空间和噪声子空间的正交性，理论上能把分辨力推到远小于瑞利限，所以才把两个峰分了出来。' +
        '它是三条曲线里唯一「看得更细」的那个，不是算错了。'
    };
  }

  // 蓝图：顺序就是出题顺序
  var GENERATORS = [genT1, genT2, genS1, genS2, genP1, genP2, genI1, genI2, genA1, genA2];

  // 练习卷专用：只给教师端分层出题用，不进前测/后测（那两份卷子必须一字不变）。
  var EXTRAS = [genA3];

  // 锚题用的生成器：它们不随卷别偏移，两套卷子必须一字不差。
  var ANCHOR_GENS = [genP2, genI1, genI2, genA2];

  // ---------------- 出题 ----------------

  function build(form) {
    var f = FORMS[form];
    if (!f) throw new Error('unknown form: ' + form);
    var r = NS.signal.mulberry32(f.seed);
    return GENERATORS.map(function (gen, i) {
      var q = gen(r, ANCHOR_GENS.indexOf(gen) >= 0 ? 0 : f.rot);
      q.form = form;
      q.index = i;
      q.qid = form + '-' + (i + 1) + '-' + q.id;
      q.topicName = TOPICS[q.topic] || q.topic;
      return q;
    });
  }

  // ---------------- 判分 ----------------

  function grade(questions, answers) {
    var byTopic = {};
    var correct = 0;
    var rows = questions.map(function (q, i) {
      var chosen = answers[i];
      var ok = chosen === q.answer;
      if (ok) correct++;
      var t = byTopic[q.topic] = byTopic[q.topic] || { correct: 0, total: 0 };
      t.total++;
      if (ok) t.correct++;
      return {
        qid: q.qid, topic: q.topic, topicName: q.topicName,
        chosen: chosen, answer: q.answer,
        chosenText: chosen == null ? '（未作答）' : q.choices[chosen],
        answerText: q.choices[q.answer],
        correct: ok
      };
    });
    return {
      correct: correct,
      total: questions.length,
      percent: questions.length ? Math.round((correct / questions.length) * 100) : 0,
      byTopic: byTopic,
      rows: rows
    };
  }

  // ---------------- 存储 ----------------

  function hasLS() {
    try { return typeof localStorage !== 'undefined' && !!localStorage; }
    catch (e) { return false; }
  }

  function loadAll() {
    if (!hasLS()) return [];
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]') || []; }
    catch (e) { return []; }
  }

  function save(rec) {
    var all = loadAll();
    all.push(rec);
    if (hasLS()) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch (e) { /* 配额满了就算了 */ }
    }
    return all;
  }

  function clear() {
    if (hasLS()) { try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ } }
  }

  // ---------------- 汇总（教师端要用） ----------------

  function summarize(records) {
    var byForm = {};
    records.forEach(function (rec) {
      if (!rec || !rec.score) return;
      var f = byForm[rec.form] = byForm[rec.form] || {
        form: rec.form, label: (FORMS[rec.form] || {}).label || rec.form,
        n: 0, correct: 0, total: 0, ms: 0, byTopic: {}
      };
      f.n++;
      f.correct += rec.score.correct;
      f.total += rec.score.total;
      f.ms += rec.ms || 0;
      var bt = rec.score.byTopic || {};
      Object.keys(bt).forEach(function (t) {
        var d = f.byTopic[t] = f.byTopic[t] || { correct: 0, total: 0 };
        d.correct += bt[t].correct;
        d.total += bt[t].total;
      });
    });
    Object.keys(byForm).forEach(function (k) {
      var f = byForm[k];
      f.percent = f.total ? Math.round((f.correct / f.total) * 100) : 0;
      Object.keys(f.byTopic).forEach(function (t) {
        var d = f.byTopic[t];
        d.percent = d.total ? Math.round((d.correct / d.total) * 100) : 0;
      });
    });
    return byForm;
  }

  // ---------------- 导出 ----------------

  function csvCell(s) {
    return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  }

  function recordToCSV(rec) {
    var head = ['题号', '知识点', '知识点名', '你的答案', '正确答案', '是否正确'];
    var lines = [head.join(',')];
    (rec.score.rows || []).forEach(function (row, i) {
      lines.push([
        i + 1,
        csvCell(row.topic),
        csvCell(row.topicName),
        csvCell(row.chosenText),
        csvCell(row.answerText),
        row.correct ? '对' : '错'
      ].join(','));
    });
    lines.push('');
    lines.push(['合计', rec.score.correct + '/' + rec.score.total, rec.score.percent + '%',
      '用时', (rec.ms / 1000).toFixed(1) + ' 秒', rec.form].join(','));
    return lines.join('\n');
  }

  // 多份记录拼成一张宽表：每行一个学生
  function recordsToCSV(records) {
    var topics = Object.keys(TOPICS);
    var head = ['时间', '卷别', '正确数', '总题数', '正确率', '用时(秒)']
      .concat(topics.map(function (t) { return TOPICS[t]; }))
      .concat(records.length ? records[0].score.rows.map(function (_, i) { return '第' + (i + 1) + '题'; }) : []);
    var lines = [head.join(',')];
    records.forEach(function (rec) {
      var row = [
        rec.finishedAt || '', csvCell((FORMS[rec.form] || {}).label || rec.form),
        rec.score.correct, rec.score.total, rec.score.percent,
        ((rec.ms || 0) / 1000).toFixed(1)
      ];
      topics.forEach(function (t) {
        var d = rec.score.byTopic[t];
        row.push(d ? d.correct + '/' + d.total : '-');
      });
      (rec.score.rows || []).forEach(function (r) { row.push(r.correct ? 1 : 0); });
      lines.push(row.join(','));
    });
    return lines.join('\n');
  }
  // ---------------- 交给老师：成绩单打包 / 读回 ----------------

  // 一个学生导出的是一份「成绩单」而不是裸记录：带上类型和版本号，
  // 老师那边一次拖进来一堆文件时，才知道哪些该收、收的是什么。
  function packRecords(records, who) {
    var list = (records || []).filter(Boolean).map(function (rec) {
      return {
        form: rec.form, who: rec.who, ms: rec.ms,
        finishedAt: rec.finishedAt,
        score: {
          correct: rec.score.correct, total: rec.score.total,
          percent: rec.score.percent, byTopic: rec.score.byTopic,
          rows: rec.score.rows
        }
      };
    });
    return JSON.stringify({
      app: 'signallab', kind: 'quiz-records', version: 1,
      exportedAt: new Date().toISOString(),
      who: who || (list[0] && list[0].who) || '',
      records: list
    }, null, 2);
  }

  function validateRecord(rec) {
    if (!rec || typeof rec !== 'object') return '不是一个对象';
    if (!FORMS[rec.form]) return '卷别不是 pre/post：' + rec.form;
    var s = rec.score;
    if (!s || typeof s !== 'object') return '缺 score';
    if (!(s.total > 0)) return 'score.total 不是正数';
    if (!Array.isArray(s.rows) || s.rows.length !== s.total) return 'score.rows 和题数对不上';
    return null;
  }

  // 读回：单个记录、记录数组、正式成绩单，三种都认。
  // 认不出来的逐条说明原因，不静默丢，老师得知道少了谁。
  function readRecords(texts) {
    var out = [], skipped = [], synth = 0;
    (Array.isArray(texts) ? texts : [texts]).forEach(function (t, fi) {
      var data;
      try { data = JSON.parse(t); }
      catch (e) { skipped.push({ file: fi, why: '不是合法的 JSON' }); return; }
      if (data && data.synthetic === true) synth++;
      var list = Array.isArray(data) ? data
        : (data && Array.isArray(data.records)) ? data.records
          : [data];
      list.forEach(function (rec, ri) {
        var bad = validateRecord(rec);
        if (bad) { skipped.push({ file: fi, index: ri, why: bad }); return; }
        out.push(rec);
      });
    });
    return { records: out, skipped: skipped, synthetic: synth };
  }

  function download(filename, text, mime) {
    if (typeof document === 'undefined') return;
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // ---------------- 把题目里的图真的画出来 ----------------
  // 用的就是仪器自己的绘制函数，所以题目里的图和学生在仪器上看到的完全一致。
  // clean: true 保证不出现任何直接写出答案的标注。

  function renderFig(canvas, fig, dpr) {
    if (!canvas || !fig) return;
    var W = canvas.clientWidth || canvas.parentNode && canvas.parentNode.clientWidth || 520;
    var H = canvas.clientHeight || 260;
    var d = dpr || (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = Math.round(W * d);
    canvas.height = Math.round(H * d);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (fig.kind === 'scope') {
      var p = fig.state;
      var model = NS.signal.makeModel(p);
      var path = NS.signal.triggerPath(model, p);
      var trig = NS.signal.findTrigger(path, p.triggerLevel, p.freq);
      var acq = NS.signal.acquire(p, model, 0, trig);
      NS.scope.draw(ctx, W, H, acq, p);
    } else if (fig.kind === 'spectrum') {
      var sp = fig.state;
      var m2 = NS.signal.makeModel(sp);
      var spec = NS.fft.harmonicSpectrum(m2, sp.freq, 1024);
      NS.spectrum.draw(ctx, W, H, spec, {
        spanHz: sp.spanHz, sampleRate: sp.sampleRate,
        bandwidth: sp.bandwidth, freq: sp.freq, clean: true
      });
    } else if (fig.kind === 'array') {
      var res = NS.array.simulate(fig.cfg);
      NS.array.draw(ctx, W, H, res, { clean: true });
    }
  }

  NS.quiz = {
    FORMS: FORMS,
    ANCHORS: ANCHORS,
    TOPICS: TOPICS,
    GENERATORS: GENERATORS,
    EXTRAS: EXTRAS,
    build: build,
    grade: grade,
    loadAll: loadAll,
    save: save,
    clear: clear,
    summarize: summarize,
    recordToCSV: recordToCSV,
    recordsToCSV: recordsToCSV,
    packRecords: packRecords,
    readRecords: readRecords,
    download: download,
    renderFig: renderFig,
    fmtHz: fmtHz,
    fmtT: fmtT,
    fmtV: fmtV,
    STORE_KEY: STORE_KEY
  };
})((window.SignalLab = window.SignalLab || {}));
