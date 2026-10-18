/* ==========================================================================
 * llm.js — 把「屏幕上正在发生的事」交给大模型
 *
 * 三件事：
 *   1. 存配置（接口地址 / Key / 模型名），存在 localStorage
 *   2. 找到本机代理 server.py（找不到就直接连，连不上会明确报错）
 *   3. 把仪器状态拼成一段文字，连同学生的问题一起发出去，流式收回答案
 *
 * 关键点：发给模型的**不是截图**，是仿真器算出来的真值。
 * 所以它嘴里的每个数字都能在屏幕上对上，不会瞎猜。
 * ========================================================================== */
(function (NS) {
  'use strict';

  const LS_KEY = 'signallab.llm.v1';
  const PROBE_PORTS = [8770, 8771, 8772, 8773, 8774, 8775, 8776, 8777, 8778];

  const DEFAULTS = {
    proxy: '',                                       // '' = 自动找；也可手填 http://127.0.0.1:8770
    baseUrl: 'http://127.0.0.1:7863/v1',
    apiKey: '',
    model: 'cn:deepseek-v4.1-flash',
    temperature: 0.3
  };

  /* ======================================================================
   * 系统提示词
   *
   * 这段是整个功能成不成立的地方。模型的全部事实来源就是下面那份状态，
   * 所以这里最重要的是把它按住：不许编数字、不许编章节号。
   * ==================================================================== */
  const SYSTEM_PROMPT = [
    '你是「信号实验室」里的实验课助教，面对的是电子信息类本科生（大一到大三）。',
    '',
    '每条消息里都会附一份【仪器状态】。那是仿真器算出来的真值，不是估计值，',
    '它记录了信号发生器实际送出的波形、示波器实际的采集设置、以及这次采集的真实结果。',
    '',
    '几条铁律：',
    '1. 只用【仪器状态】里给出的数字。需要某个量而它不在里面，就直接说“这个我现在算不出来”，绝不要编。',
    '2. 先讲屏幕上正在发生什么，再讲为什么，最后才落到课程。不要一上来就背结论。',
    '3. 提到课本时只写课程名和知识点（例如《信号与系统》采样定理），不要编章节号或页码。',
    '4. 学生问“为什么”时，用他屏幕上的具体数字把推理走一遍，让他看见数字怎么来的。',
    '5. 别直接甩最终答案。先指出该盯哪个量，再给结论，他自己判出来的才记得住。',
    '6. 中文，简洁。一两句话能讲清就别写五段。确实需要分点时才用短列表。',
    '7. 不要提“仪器状态”这四个字，就像你真的站在示波器旁边看着屏幕说话。'
  ].join('\n');

  /* ======================================================================
   * 配置读写
   * ==================================================================== */
  function load() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
    } catch (e) {
      saved = {};
    }
    return Object.assign({}, DEFAULTS, saved);
  }

  let cfg = load();

  function config() {
    return Object.assign({}, cfg);
  }

  function save(patch) {
    cfg = Object.assign({}, cfg, patch || {});
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    } catch (e) {
      /* 隐私模式下写不进去，忽略，这次会话仍然能用 */
    }
    proxyUrl = null;      // 地址可能变了，重新探测
    probePromise = null;
    probeCache = null;
    return config();
  }

  function reset() {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* 同上 */ }
    cfg = Object.assign({}, DEFAULTS);
    proxyUrl = null;
    probePromise = null;
    probeCache = null;
    return config();
  }

  /* ======================================================================
   * 找本机代理
   *
   * 为什么需要它：上游中转站不响应 CORS 预检（OPTIONS 回 405），
   * 浏览器从 file:// 打开时源是 null，带 Authorization 的请求会被直接拦掉。
   * 本机 server.py 转发一下就没这回事了。
   * ==================================================================== */
  let proxyUrl = null;        // null = 还没探测；'' = 确认没有代理
  let probeCache = null;      // 整个探测结果都缓存下来：{url, health}
  let probePromise = null;

  function getJSON(url, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .finally(() => clearTimeout(timer));
  }

  function probe() {
    if (probeCache) return Promise.resolve(probeCache);
    if (probePromise) return probePromise;

    const candidates = [];
    if (cfg.proxy) {
      candidates.push(String(cfg.proxy).replace(/\/+$/, ''));
    } else {
      // 页面本身就是代理发出来的？那同源即可，最省事
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        candidates.push(location.origin);
      }
      PROBE_PORTS.forEach((p) => candidates.push('http://127.0.0.1:' + p));
    }

    probePromise = (async () => {
      for (const base of candidates) {
        try {
          const health = await getJSON(base + '/api/health', 1200);
          if (health && health.ok && health.service === 'signal-lab') {
            proxyUrl = base;
            probeCache = { url: base, health: health };
            return probeCache;
          }
        } catch (e) {
          /* 这个候选不在，试下一个 */
        }
      }
      proxyUrl = '';
      probeCache = { url: '', health: null };
      return probeCache;
    })();

    return probePromise;
  }

  /* ======================================================================
   * 把仪器状态拼成一段文字
   *
   * 这份文字就是模型的全部事实来源。写得越具体，它答得越像真的在旁边看。
   * ==================================================================== */
  function fmt(fn, v, fallback) {
    const A = NS.advisor;
    if (A && typeof A[fn] === 'function' && typeof v === 'number' && isFinite(v)) {
      return A[fn](v);
    }
    return fallback === undefined ? String(v) : fallback;
  }

  const WAVE_CN = {
    sine: '正弦波', square: '方波', triangle: '三角波',
    sawtooth: '锯齿波', pulse: '脉冲'
  };

  function brief(ctx) {
    if (!ctx || !ctx.p) return '（仪器还没准备好）';

    const p = ctx.p;
    const acq = ctx.acq;
    const lines = [];

    lines.push('【信号发生器】'
      + '波形 ' + (WAVE_CN[p.wave] || p.wave)
      + ' · 频率 ' + fmt('fmtHz', p.freq)
      + ' · 幅度 ' + fmt('fmtV', p.amp) + '（峰值）'
      + ' · 直流偏置 ' + fmt('fmtV', p.offset)
      + ' · 初相 ' + Number(p.phase).toFixed(0) + '°'
      + (p.wave === 'square' || p.wave === 'pulse'
        ? ' · 占空比 ' + (p.duty * 100).toFixed(0) + '%' : '')
      + ' · 噪声 ' + fmt('fmtV', p.noise) + '（RMS）'
      + ' · 带宽限制 ' + fmt('fmtHz', p.bandwidth));

    lines.push('【示波器】'
      + '时基 ' + fmt('fmtT', p.timePerDiv) + '/div'
      + ' · 垂直档位 ' + fmt('fmtV', p.voltsPerDiv) + '/div'
      + ' · 采样率 ' + fmt('fmtHz', p.sampleRate)
      + ' · 触发电平 ' + fmt('fmtV', p.triggerLevel)
      + ' · 耦合 ' + (p.coupling === 'AC' ? 'AC（隔直）' : 'DC（直通）')
      + ' · 探头 ×' + p.probe);

    if (acq) {
      lines.push('【这次采集的真实结果】'
        + '一屏时长 ' + fmt('fmtT', acq.Tdisp)
        + ' · 实际采样点 ' + acq.N + ' 个'
        + ' · 采样间隔 ' + fmt('fmtT', acq.dt)
        + ' · 屏上 ' + Number(acq.periods).toFixed(2) + ' 个周期'
        + ' · 每周期约 ' + Number(acq.samplesPerPeriod).toFixed(2) + ' 个采样点'
        + ' · 触发 ' + (acq.triggered ? '已锁定' : '没锁上（波形在跑）')
        + ' · 削顶 ' + (ctx.clipped ? '是，波形顶到屏幕外了' : '否')
        + ' · 直流被 AC 耦合去掉 ' + (acq.removedDC ? '是' : '否'));
    }

    // 混叠是这个实验室里最重要的一件事，单独把数算给模型看
    const nyq = p.sampleRate / 2;
    if (p.freq > nyq) {
      const fold = Math.abs(p.freq - Math.round(p.freq / p.sampleRate) * p.sampleRate);
      lines.push('【关键推导】奈奎斯特频率 fs/2 = ' + fmt('fmtHz', nyq)
        + '，而基波是 ' + fmt('fmtHz', p.freq) + '，已经高出去了 → 发生混叠。'
        + '按折叠公式 |f0 − round(f0/fs)·fs| 算，屏幕上那个假波形的频率是 '
        + fmt('fmtHz', fold) + '。');
    } else {
      lines.push('【关键推导】奈奎斯特频率 fs/2 = ' + fmt('fmtHz', nyq)
        + '，基波 ' + fmt('fmtHz', p.freq) + ' 在它之内，采样是够的。');
    }

    // 采样点太少，波形就是几个点连出来的折线，这件事也得让它知道
    if (acq && acq.samplesPerPeriod < 8) {
      lines.push('【注意】每周期只有 ' + Number(acq.samplesPerPeriod).toFixed(2)
        + ' 个采样点，屏幕上那条线其实是很少几个点直连出来的，不代表信号的真实形状。');
    }

    if (ctx.kMax) {
      lines.push('【频谱】带宽限制允许的最高谐波次数 kMax = ' + ctx.kMax
        + '（' + fmt('fmtHz', ctx.kMax * p.freq) + ' 以上被砍掉）');
    }

    // 阵列那一屏跟时域参数完全独立，所以单独一段
    if (ctx.arr) {
      const a = ctx.arr;
      lines.push('【阵列】M = ' + a.M + ' 个阵元，间距 d = ' + Number(a.d).toFixed(2)
        + ' λ，信噪比 ' + a.snrDb + ' dB，快拍数 ' + a.K + '，信源数 ' + a.S);
      lines.push('【阵列真实来波方向】' + a.angles.map((t) => t + '°').join('、'));
      const pkLine = (arr, name) => (arr && arr.length)
        ? name + ' 检出 ' + arr.map((q) => q.deg.toFixed(1) + '°（' + q.db.toFixed(1) + ' dB）').join('、')
        : name + ' 没检出峰';
      lines.push('【阵列空间谱】' + pkLine(a.peaks.bartlett, 'Bartlett') + '；'
        + pkLine(a.peaks.mvdr, 'MVDR') + '；'
        + (a.hasMusic ? pkLine(a.peaks.music, 'MUSIC') : 'MUSIC 不可用（阵元数 ≤ 信源数）'));
      const beam = 0.886 / (a.M * a.d) * 180 / Math.PI;
      lines.push('【阵列关键推导】相邻阵元相位差 = 2π(d/λ)·sinθ；主瓣宽度约 0.886λ/(M·d) = '
        + beam.toFixed(1) + '°；不出现栅瓣要求 d ≤ 0.5 λ');
      if (a.d > 0.55) {
        lines.push('【阵列注意】d/λ = ' + Number(a.d).toFixed(2) + ' 已经超过 0.5，'
          + '谱上离真实来波方向 6° 以外的峰都是栅瓣，不是真的信号源。');
      }
      if (!a.hasMusic) {
        lines.push('【阵列注意】M ≤ S，噪声子空间是空的，MUSIC 这一路没有意义。');
      }
    }

    // 时频那一屏也是一块独立的仪器
    if (ctx.tf) {
      const t = ctx.tf;
      const TF = NS.timefreq;
      const segs = (t.truth && t.truth.segments) || [];
      lines.push('【时频】场景 = ' + (t.scen ? t.scen.name : t.scenario)
        + '，窗长 ' + t.N + ' 点 = ' + TF.fmtMs(t.dt)
        + '，Δf = ' + TF.fmtHz(t.df)
        + '，Δt·Δf = ' + t.product.toFixed(2)
        + '，共 ' + t.nFrames + ' 帧，每 ' + TF.fmtMs(t.step / t.fs) + ' 出一帧。');
      if (segs.length) {
        lines.push('【时频真实时间结构】' + segs.map(function (g) {
          return TF.fmtMs(g.t0) + '–' + TF.fmtMs(g.t1) + ' 是 ' + TF.fmtHz(g.f0)
            + (Math.abs(g.f1 - g.f0) > 1e-9 ? '→' + TF.fmtHz(g.f1) : '');
        }).join('；') + (t.truth.overlap ? '（两段是同时响的）' : '（两段是一前一后的）'));
      }
      if (t.mergesInTime && segs.length) {
        lines.push('【时频注意】每个音只响 ' + TF.fmtMs(segs[0].t1 - segs[0].t0)
          + '，比一个窗（' + TF.fmtMs(t.dt) + '）还短，屏幕上一前一后已经糊成了同时。');
      }
      if (t.smeared) {
        lines.push('【时频注意】信号本身只有 ' + TF.fmtMs(t.featureSec)
          + '，比窗还短，时间轴上一定会被拖到一个窗那么宽。');
      }
      if (t.resolvesFreq === false) {
        lines.push('【时频注意】两个音只差 ' + TF.fmtHz(t.sepHz)
          + '，小于 Δf = ' + TF.fmtHz(t.df) + '，频率上分不开。');
      }
      lines.push('【时频关键推导】Δf = fs/N；Δt = N/fs；两者相乘恒等于 1，'
        + '时间和频率的分辨率此消彼长。');
    }

    // 星座图那一屏
    if (ctx.con) {
      const c = ctx.con;
      const CO = NS.constellation;
      lines.push('【星座】' + c.modName + '，一个符号 ' + c.bits + ' 个比特，'
        + '共 ' + c.M + ' 个理想点，判决边界按' + c.region + '划分；'
        + 'Es/N0 = ' + c.snrDb + ' dB，噪声 σ = ' + c.sigma.toFixed(4)
        + '，点距 d_min = ' + c.dmin.toFixed(3)
        + '，d_min/(2σ) = ' + c.margin.toFixed(2) + '。');
      lines.push('【星座实测】仿了 ' + c.nSym + ' 个符号，判错 ' + c.nSymErr
        + ' 个，SER = ' + CO.fmtPct(c.ser) + '（理论 ' + CO.fmtPct(c.serTheory) + '），'
        + 'BER = ' + CO.fmtPct(c.ber) + '。');
      if (c.margin < 3) {
        lines.push('【星座注意】d_min/(2σ) = ' + c.margin.toFixed(2)
          + '，已经小于工程上常用的 3，噪声圆快蹭到判决边界了。');
      }
      if (c.ser > 0.02) {
        lines.push('【星座注意】已经在判错了：图上画红圈的那些点，发的是隔壁那一格，'
          + '相邻星座点之间往往只差 1～2 个比特，不是整串全错。');
      }
      lines.push('【星座关键推导】判决规则是“离哪个理想点近就判成哪个”，'
        + '高斯白噪声下这是最优判决；点距越挤、σ 越大越容易越界，'
        + '所以 M-QAM 阶数越高，想维持同样的误码率就得成倍地加信噪比。');
    }

    // 多径沙盒那一屏
    if (ctx.sb) {
      const b = ctx.sb;
      lines.push('【多径】场景 = ' + b.sceneName
        + '，频率 ' + (b.freqHz / 1e6).toFixed(0) + ' MHz（λ = ' + (b.lambda * 100).toFixed(1) + ' cm）'
        + '，反射算到 ' + b.maxOrder + ' 阶；'
        + '发射机在 (' + b.tx.x.toFixed(0) + ', ' + b.tx.y.toFixed(0) + ') m，'
        + '阵列在 (' + b.rx.x.toFixed(0) + ', ' + b.rx.y.toFixed(0) + ') m。');
      if (b.losBlocked) {
        lines.push('【多径注意】发射机到阵列的直线被楼挡住了，只剩绕楼过来的反射波。');
      }
      lines.push('【多径路径】共 ' + b.nPaths + ' 条：直达 ' + b.nLos
        + ' 条、一次反射 ' + b.nOrder1 + ' 条、两次反射 ' + b.nOrder2 + ' 条，'
        + b.paths.map(function (p) {
          return (p.order === 0 ? '直达' : p.order + ' 次反射')
            + ' ' + p.angle.toFixed(1) + '° 多走 ' + (p.deltaTau * 1e9).toFixed(0) + ' ns '
            + p.gainDb.toFixed(1) + ' dB';
        }).join('；'));
      lines.push('【多径信道】时延扩展 σ = ' + (b.spreadRms * 1e9).toFixed(0) + ' ns，'
        + '相干带宽 ' + (b.coherenceBw === Infinity ? '无限（只有一条路）'
          : (b.coherenceBw / 1e6).toFixed(2) + ' MHz')
        + (b.freqSelective ? '，已经窄到会让宽带信号挑频率了。' : '。'));
      lines.push('【多径关键推导】阵列量的是“信号从哪个方向来”，不是“发射机在哪”；'
        + '楼面是镜子，同一台发射机的信号可以走好几条路进来，所以谱上的峰数不等于发射机个数。'
        + '而且这几条路是同一路信号的相干拷贝（信源协方差严格秩 1），几个方向被合成了一个'
        + '不在阵列流形上的等效方向，MUSIC 会连一条路径都没有的方向一起报出来，'
        + '相干多径下不要按 MUSIC 的峰位置读数，Bartlett 的峰位置才跟着真实来波走。'
        + '直线被挡住时，报出的方向会指到墙上去。');
    }

    if (ctx.cards && ctx.cards.length) {
      lines.push('【面板正在提示】' + ctx.cards.slice(0, 3)
        .map((c) => c.title).join('；'));
    }

    if (ctx.history && ctx.history.length) {
      lines.push('【学生最近动过的旋钮】' + ctx.history.slice(-6).map((h) => {
        const name = PARAM_CN[h.id] || h.id;
        return name + ' ' + shortVal(h.from, h.id) + ' → ' + shortVal(h.to, h.id);
      }).join('；'));
    }

    return lines.join('\n');
  }

  const PARAM_CN = {
    wave: '波形', freq: '频率', amp: '幅度', offset: '直流偏置', phase: '初相',
    duty: '占空比', noise: '噪声', bandwidth: '带宽限制',
    timePerDiv: '时基', voltsPerDiv: '垂直档位', sampleRate: '采样率',
    triggerLevel: '触发电平', coupling: '耦合', probe: '探头', spanHz: '扫宽',
    preset: '预设',
    arrayM: '阵元数 M', arrayD: '阵元间距 d/λ', arraySnr: '信噪比',
    arraySources: '信源数', arrayA1: '来波方向 θ₁', arrayA2: '来波方向 θ₂',
    arrayA3: '来波方向 θ₃', arrayK: '快拍数',
    tfScenario: '时频场景', tfFs: '时频采样率', tfWin: '时频窗长',
    tfOverlap: '时频重叠', tfF1: '时频音 1 频率', tfF2: '时频音 2 频率',
    conMod: '调制方式', conSnr: 'Es/N0', conN: '符号数',
    sbScene: '沙盒场景', sbOrder: '反射阶数', sbFreq: '频率', sbM: '阵元数 M', sbSnr: '信噪比'
  };

  function shortVal(v, id) {
    if (typeof v === 'number') {
      // 阵列那一组不是频率，别用 Hz 去格式化它
      if (id && id.indexOf('array') === 0) {
        if (id === 'arrayD') return Number(v).toFixed(2) + ' λ';
        if (id === 'arraySnr') return Number(v).toFixed(0) + ' dB';
        if (id === 'arrayA1' || id === 'arrayA2' || id === 'arrayA3') return Number(v).toFixed(0) + '°';
        return String(Math.round(v));
      }
      if (id && id.indexOf('sb') === 0) {
        if (id === 'sbSnr') return Number(v).toFixed(0) + ' dB';
        if (id === 'sbFreq') return fmt('fmtHz', v, String(v));
        return String(Math.round(v));
      }
      return fmt('fmtHz', v, String(v));
    }
    return WAVE_CN[v] || String(v);
  }

  /* ======================================================================
   * 发请求
   * ==================================================================== */
  async function chat(opts) {
    const o = opts || {};
    const probeResult = await probe();

    // 有代理走代理；没有就直接连上游（多数情况下会被 CORS 拦，错误信息会说明）
    const url = probeResult.url ? probeResult.url + '/api/chat' : cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';

    const body = {
      model: cfg.model,
      messages: o.messages || [],
      stream: true,
      temperature: o.temperature !== undefined ? o.temperature : cfg.temperature
    };
    if (o.maxTokens) body.max_tokens = o.maxTokens;

    // 走代理时把地址和 Key 一起带上，代理优先用浏览器填的这份，
    // 这样别人 clone 下来只填自己的 Key 就能用，不必改服务端文件
    if (probeResult.url) {
      body.baseUrl = cfg.baseUrl;
      if (cfg.apiKey) body.apiKey = cfg.apiKey;
    } else if (cfg.apiKey) {
      body.apiKey = cfg.apiKey;   // 直连时给下面拼 Authorization 用
    }

    const headers = { 'Content-Type': 'application/json' };
    if (!probeResult.url && cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: o.signal
      });
    } catch (e) {
      throw new Error(probeResult.url
        ? '连不上本机服务 ' + probeResult.url + '，它还在跑吗？'
        : '浏览器直连被拦下了（多半是 CORS）。启动本机服务就能用：python app/server.py');
    }

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        const e = j && j.error;
        if (typeof e === 'string') detail = e;
        else if (e && typeof e === 'object') detail = e.message || JSON.stringify(e);
        if (j && j.hint) detail += '　' + j.hint;
        if (j && j.detail) {
          detail += '　' + (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail));
        }
      } catch (e) {
        detail = 'HTTP ' + res.status;
      }
      throw new Error(detail || ('HTTP ' + res.status));
    }

    // 代理可能因为上游不支持流式而回了整包 JSON，这里两种都接住
    const ctype = res.headers.get('Content-Type') || '';
    if (ctype.indexOf('application/json') >= 0) {
      const j = await res.json();
      const msg = j.choices && j.choices[0] && j.choices[0].message;
      const text = (msg && msg.content) || '';
      if (o.onDelta) o.onDelta(text);
      return text;
    }

    return await readStream(res, o);
  }

  async function readStream(res, o) {
    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let full = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line || line.charAt(0) === ':') continue;          // 心跳
        if (line.indexOf('data:') !== 0) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return full;

        let json;
        try {
          json = JSON.parse(payload);
        } catch (e) {
          continue;                                            // 半行，丢掉
        }
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;
        if (delta.reasoning_content && o.onReasoning) o.onReasoning(delta.reasoning_content);
        if (delta.content) {
          full += delta.content;
          if (o.onDelta) o.onDelta(delta.content);
        }
      }
    }
    return full;
  }

  /* ======================================================================
   * 对外
   * ==================================================================== */
  NS.llm = {
    config, save, reset, probe, chat, brief,
    SYSTEM_PROMPT,
    DEFAULTS,
    get proxy() { return proxyUrl; }
  };
})(window.SignalLab = window.SignalLab || {});
