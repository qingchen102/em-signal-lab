/* ==========================================================================
 * tutor.js — AI 助教面板
 *
 * 它负责：右侧的标签页、聊天界面、「接入模型」设置弹窗。
 *
 * 设计上只有一条规矩：每问一次，都把当前仪器状态原样带上。
 * 所以学生可以直接问「这个波为什么长这样」，不需要先描述屏幕。
 * ========================================================================== */
(function (NS) {
  'use strict';

  const els = {};
  let messages = [];          // 对话历史，只留最近的，省 token
  let busy = false;
  let controller = null;

  const MAX_TURNS = 12;

  /* ======================================================================
   * 小工具
   * ==================================================================== */
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }

  /* 极轻量的排版：粗体、行内代码、短横线列表。够用就行，不引 Markdown 库。 */
  function rich(s) {
    let h = esc(s);
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/^[ \t]*[-•][ \t]+(.+)$/gm, '<span class="li">$1</span>');
    h = h.replace(/\n/g, '<br>');
    return h;
  }

  function scrollDown() {
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  /* ======================================================================
   * 右侧标签页：知识伴随 / AI 助教
   * ==================================================================== */
  function initTabs() {
    const tabs = Array.from(document.querySelectorAll('.ptab'));
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    });
  }

  function selectTab(name) {
    document.querySelectorAll('.ptab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    document.querySelectorAll('.tabpane').forEach((p) => {
      p.hidden = p.dataset.pane !== name;
    });
    if (name === 'ai') {
      scrollDown();
      setTimeout(() => els.ask && els.ask.focus(), 30);
    }
  }

  /* ======================================================================
   * 连接状态
   * ==================================================================== */
  function setChip(level, text) {
    if (!els.status) return;
    els.status.className = 'ai-status ai-status--' + level;
    els.status.querySelector('.ai-status-text').textContent = text;
  }

  async function refreshStatus() {
    const c = NS.llm.config();
    setChip('checking', '正在找本机服务…');
    const r = await NS.llm.probe();
    const hasKey = (r.health && r.health.hasKey) || !!c.apiKey;

    if (!r.url) {
      setChip('warn', '未接入 · 点这里配置');
    } else if (!hasKey) {
      setChip('warn', '缺 API Key · 点这里填');
    } else {
      setChip('ok', '已接入 · ' + c.model);
    }
    return r;
  }

  /* ======================================================================
   * 聊天
   * ==================================================================== */
  function addMsg(role, text) {
    const el = document.createElement('div');
    el.className = 'msg msg--' + role;

    const body = document.createElement('div');
    body.className = 'msg-body';
    if (text) body.innerHTML = rich(text);

    el.appendChild(body);
    els.chat.appendChild(el);
    scrollDown();
    return { el, body };
  }

  function welcome() {
    els.chat.innerHTML = '';
    const c = NS.llm.config();
    addMsg('ai',
      '我是这门实验课的助教。屏幕上的每个数字我都能看到，所以你可以直接问，'
      + '不用先跟我描述波形。\n\n'
      + '比如：「这个波为什么长这样？」「我刚拧的这个旋钮到底改变了什么？」'
      + '「为什么采样率一降，波形就变了个频率？」\n\n'
      + '也可以点下面的 **考考我**，我出题你答，我来判。');
    els.modelTag.textContent = c.model || '';
  }

  async function send(text) {
    if (busy) return;
    const question = String(text || '').trim();
    if (!question) return;

    busy = true;
    els.send.disabled = true;
    els.ask.disabled = true;

    addMsg('user', question);

    const ai = addMsg('ai', '');
    ai.body.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';

    // 每轮都把当前仪器状态重新拼一遍，学生可能刚拧过旋钮
    const ctx = (NS.lab && NS.lab.context) ? NS.lab.context() : null;
    const system = NS.llm.SYSTEM_PROMPT
      + '\n\n===== 当前仪器状态（真值，请以此为准）=====\n'
      + NS.llm.brief(ctx);

    const turns = messages.slice(-MAX_TURNS).concat([{ role: 'user', content: question }]);
    const payload = [{ role: 'system', content: system }].concat(turns);

    let reasonEl = null;
    let reasonText = '';
    let out = '';

    controller = new AbortController();

    try {
      await NS.llm.chat({
        messages: payload,
        signal: controller.signal,

        onReasoning(chunk) {
          reasonText += chunk;
          if (!reasonEl) {
            reasonEl = document.createElement('details');
            reasonEl.className = 'reasoning';
            reasonEl.innerHTML = '<summary>它正在推演…</summary><div class="reasoning-body"></div>';
            ai.el.insertBefore(reasonEl, ai.body);
          }
          reasonEl.querySelector('.reasoning-body').textContent = reasonText;
          scrollDown();
        },

        onDelta(chunk) {
          out += chunk;
          ai.body.innerHTML = rich(out);
          scrollDown();
        }
      });

      if (!out) out = '（模型这次没返回内容，再问一次试试）';
      ai.body.innerHTML = rich(out);

      // 成功了才记进历史；失败的那轮不污染上下文
      messages.push({ role: 'user', content: question });
      messages.push({ role: 'assistant', content: out });

      refreshStatus();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        ai.body.innerHTML = rich('（已取消）');
      } else {
        ai.el.classList.add('msg--error');
        ai.body.innerHTML = rich('出错了：' + err.message
          + '\n\n如果提示连不上或 CORS，先跑一下 `python app/server.py`。');
      }
    } finally {
      busy = false;
      els.send.disabled = false;
      els.ask.disabled = false;
      controller = null;
      els.ask.focus();
      scrollDown();
    }
  }

  /* ======================================================================
   * 设置弹窗
   * ==================================================================== */
  function fillSettings() {
    const c = NS.llm.config();
    els.cfgBaseUrl.value = c.baseUrl || '';
    els.cfgModel.value = c.model || '';
    els.cfgKey.value = c.apiKey || '';
    els.cfgProxy.value = c.proxy || '';
    els.cfgTemp.value = c.temperature;

    NS.llm.probe().then((r) => {
      if (r.url) {
        els.cfgFound.textContent = '已找到本机服务：' + r.url
          + (r.health && r.health.hasKey ? '（服务端已配 Key）' : '（服务端没配 Key）');
      } else {
        els.cfgFound.textContent = '没找到本机服务，直连上游多半会被 CORS 拦下。'
          + '在 em-signal-lab 目录里跑 python app/server.py 就能解决。';
      }
    });
  }

  function openSettings() {
    fillSettings();
    els.cfgResult.textContent = '';
    els.cfgResult.className = 'dlg-result';
    if (typeof els.dlg.showModal === 'function') els.dlg.showModal();
    else els.dlg.setAttribute('open', '');
  }

  function closeSettings() {
    if (typeof els.dlg.close === 'function') els.dlg.close();
    else els.dlg.removeAttribute('open');
  }

  function saveSettings() {
    NS.llm.save({
      baseUrl: els.cfgBaseUrl.value.trim(),
      model: els.cfgModel.value.trim(),
      apiKey: els.cfgKey.value.trim(),
      proxy: els.cfgProxy.value.trim(),
      temperature: Number(els.cfgTemp.value) || 0.3
    });
    els.cfgResult.className = 'dlg-result dlg-result--ok';
    els.cfgResult.textContent = '已保存。';
    refreshStatus();
  }

  async function testConnection() {
    els.cfgResult.className = 'dlg-result';
    els.cfgResult.textContent = '正在测试…';

    // 先把当前表单里的值用上，免得测的是旧配置
    NS.llm.save({
      baseUrl: els.cfgBaseUrl.value.trim(),
      model: els.cfgModel.value.trim(),
      apiKey: els.cfgKey.value.trim(),
      proxy: els.cfgProxy.value.trim(),
      temperature: Number(els.cfgTemp.value) || 0.3
    });

    const r = await NS.llm.probe();
    try {
      const t0 = performance.now();
      let got = '';
      await NS.llm.chat({
        messages: [{ role: 'user', content: '只回两个字：收到' }],
        maxTokens: 64,
        onDelta(c) { got += c; }
      });
      const ms = Math.round(performance.now() - t0);
      els.cfgResult.className = 'dlg-result dlg-result--ok';
      els.cfgResult.textContent = '通了（' + ms + ' ms）'
        + (got ? '，模型回了：' + got.trim() : '')
        + (r.url ? '　经本机服务转发' : '　浏览器直连');
      refreshStatus();
    } catch (err) {
      els.cfgResult.className = 'dlg-result dlg-result--bad';
      els.cfgResult.textContent = '没通：' + err.message;
    }
  }

  /* ======================================================================
   * 初始化
   * ==================================================================== */
  function init() {
    els.chat = document.getElementById('chat');
    els.ask = document.getElementById('ask');
    els.send = document.getElementById('sendBtn');
    els.clear = document.getElementById('clearChat');
    els.status = document.getElementById('aiStatus');
    els.modelTag = document.getElementById('tutorModel');
    els.quick = document.getElementById('quickAsks');

    els.dlg = document.getElementById('settings');
    els.cfgBaseUrl = document.getElementById('cfgBaseUrl');
    els.cfgModel = document.getElementById('cfgModel');
    els.cfgKey = document.getElementById('cfgKey');
    els.cfgProxy = document.getElementById('cfgProxy');
    els.cfgTemp = document.getElementById('cfgTemp');
    els.cfgFound = document.getElementById('cfgFound');
    els.cfgResult = document.getElementById('cfgResult');

    if (!els.chat) return;

    initTabs();
    welcome();

    els.send.addEventListener('click', () => {
      const t = els.ask.value;
      els.ask.value = '';
      send(t);
    });

    els.ask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const t = els.ask.value;
        els.ask.value = '';
        send(t);
      }
    });

    els.clear.addEventListener('click', () => {
      messages = [];
      welcome();
    });

    els.quick.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ask]');
      if (!btn) return;
      send(btn.dataset.ask);
    });

    els.status.addEventListener('click', openSettings);
    document.getElementById('openSettings').addEventListener('click', openSettings);

    document.getElementById('cfgSave').addEventListener('click', (e) => { e.preventDefault(); saveSettings(); });
    document.getElementById('cfgTest').addEventListener('click', (e) => { e.preventDefault(); testConnection(); });
    document.getElementById('cfgReset').addEventListener('click', (e) => {
      e.preventDefault();
      NS.llm.reset();
      fillSettings();
      els.cfgResult.className = 'dlg-result dlg-result--ok';
      els.cfgResult.textContent = '已恢复默认。';
      refreshStatus();
    });
    document.getElementById('cfgClose').addEventListener('click', (e) => { e.preventDefault(); closeSettings(); });

    refreshStatus();

    // 演示用直链：?tab=ai 直接打开助教，?settings=1 直接打开接入设置，
    // ?ask=xxx 直接替学生把问题问出去（课堂上一个链接就跳到某个现象的解释）
    var q = new URLSearchParams(location.search);
    if (q.get('tab') === 'ai') selectTab('ai');
    if (q.get('settings') === '1') openSettings();
    var autoAsk = q.get('ask');
    if (autoAsk) setTimeout(function () { ask(autoAsk); }, 150);
  }

  /* ======================================================================
   * 对外：给知识卡片上的「让 AI 细讲」用
   * ==================================================================== */
  function ask(text) {
    selectTab('ai');
    send(text);
  }

  NS.tutor = {
    init,
    ask,
    open: () => selectTab('ai'),
    openSettings,
    refreshStatus
  };
})(window.SignalLab = window.SignalLab || {});
