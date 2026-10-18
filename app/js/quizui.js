/* 效果验证：前测 / 后测。出题引擎在 quiz.js，这里只做界面与流程。
   前测和后测是同一份蓝图的两个平行卷：6 道平行题换数字，4 道锚题一字不差。
   锚题的作用是把两套卷子的难度钉在一起，只比总分的话，
   没人分得清「后测考得好」是因为学会了，还是因为后测那套恰好更容易。 */
(function (NS) {
  'use strict';

  var Q = NS.quiz;

  var els = {};
  var st = {
    view: 'cover',
    form: 'pre',
    who: '',
    qs: [],
    answers: [],
    idx: 0,
    startedAt: 0,
    elapsedMs: 0,
    timer: null,
    score: null
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtClock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function topics() { return Object.keys(Q.TOPICS); }

  // ---------------- 视图分发 ----------------

  function render() {
    if (st.view === 'cover') renderCover();
    else if (st.view === 'quiz') renderQuiz();
    else if (st.view === 'result') renderResult();
    else if (st.view === 'summary') renderSummary();
  }

  function setView(v) {
    st.view = v;
    render();
    if (els.body) els.body.scrollTop = 0;
  }

  // ---------------- 封面 ----------------

  function renderCover() {
    els.title.textContent = '效果验证';
    els.meta.textContent = '';
    els.foot.innerHTML = '';

    var hasRec = Q.loadAll().length;

    els.body.innerHTML =
      '<p class="quiz-lede">这套卷子用来量一量：学生在实验台里自己摸过一阵之后，' +
      '对时域、采样、频谱、示波器操作和阵列测向这五块的把握有没有变化。</p>' +
      '<ul class="quiz-facts">' +
        '<li><b>10 道题</b>，选择题，约 6 分钟</li>' +
        '<li>每道题的图都是用<b>实验台自己的绘图函数</b>画出来的，和学生在仪器上看到的一模一样</li>' +
        '<li>交卷后立刻给分数、逐题解析，并指出哪一块最薄弱</li>' +
        '<li>记录只存在<b>这台电脑的浏览器里</b>，不会上传</li>' +
      '</ul>' +
      '<div class="quiz-row">' +
        '<label class="quiz-field">' +
          '<span>代号（可选）</span>' +
          '<input id="quizWho" type="text" maxlength="16" placeholder="同一人前后测填一样的，才能配对比较" value="' + esc(st.who) + '">' +
        '</label>' +
        '<div class="quiz-field">' +
          '<span>卷别</span>' +
          '<div class="quiz-seg" id="quizForm">' +
            '<button data-form="pre" class="' + (st.form === 'pre' ? 'on' : '') + '">前测</button>' +
            '<button data-form="post" class="' + (st.form === 'post' ? 'on' : '') + '">后测</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="quiz-note">前测和后测是<b>同难度的两套卷子</b>：6 道题换了数字，4 道概念题一模一样。' +
      '那 4 道相同的题是锚，用来确认两套卷子的难度没有偏。</div>';

    els.foot.innerHTML =
      '<button class="btn-ghost" id="quizSummary">看汇总' + (hasRec ? '（' + hasRec + ' 份记录）' : '') + '</button>' +
      '<span class="quiz-spacer"></span>' +
      '<button class="btn-primary" id="quizStart">开始答题</button>';

    els.body.querySelectorAll('#quizForm button').forEach(function (b) {
      b.onclick = function () {
        st.form = b.getAttribute('data-form');
        renderCover();
      };
    });

    $('quizStart').onclick = function () {
      st.who = ($('quizWho').value || '').trim();
      start(st.form);
    };
    $('quizSummary').onclick = function () { setView('summary'); };
  }

  // ---------------- 答题 ----------------

  function start(form) {
    st.form = form;
    st.qs = Q.build(form);
    st.answers = st.qs.map(function () { return null; });
    st.idx = 0;
    st.startedAt = Date.now();
    st.elapsedMs = 0;
    st.score = null;
    if (st.timer) clearInterval(st.timer);
    st.timer = setInterval(function () {
      st.elapsedMs = Date.now() - st.startedAt;
      if (st.view === 'quiz' && els.meta) els.meta.textContent = fmtClock(st.elapsedMs);
    }, 500);
    setView('quiz');
  }

  function renderQuiz() {
    var q = st.qs[st.idx];
    var label = Q.FORMS[st.form].label;

    els.title.textContent = label;
    els.meta.textContent = fmtClock(st.elapsedMs);

    var answered = st.answers.filter(function (a) { return a != null; }).length;

    var strip = st.qs.map(function (_, i) {
      var cls = 'qdot';
      if (st.answers[i] != null) cls += ' done';
      if (i === st.idx) cls += ' now';
      return '<button class="' + cls + '" data-go="' + i + '">' + (i + 1) + '</button>';
    }).join('');

    var choices = q.choices.map(function (c, i) {
      var on = st.answers[st.idx] === i;
      return '<button class="qchoice' + (on ? ' on' : '') + '" data-pick="' + i + '">' +
        '<i>' + 'ABCD'[i] + '</i><span>' + esc(c) + '</span></button>';
    }).join('');

    els.body.innerHTML =
      '<div class="qstrip">' + strip + '</div>' +
      '<div class="qhead">' +
        '<span class="qtag">' + esc(q.topicName) + '</span>' +
        '<span class="qnum">第 ' + (st.idx + 1) + ' / ' + st.qs.length + ' 题</span>' +
        '<span class="qdone">已答 ' + answered + '</span>' +
      '</div>' +
      '<p class="qstem">' + esc(q.stem) + '</p>' +
      (q.fig ? '<div class="qfig"><canvas id="qfig"></canvas>' +
               (q.fig.caption ? '<div class="qfig-cap">' + esc(q.fig.caption) + '</div>' : '') +
               '</div>' : '') +
      '<div class="qchoices">' + choices + '</div>';

    if (q.fig) {
      var cv = $('qfig');
      if (cv) {
        cv.parentNode.style.height = (q.fig.kind === 'scope' ? 240 : 250) + 'px';
        Q.renderFig(cv, q.fig);
      }
    }

    els.body.querySelectorAll('[data-pick]').forEach(function (b) {
      b.onclick = function () {
        st.answers[st.idx] = parseInt(b.getAttribute('data-pick'), 10);
        renderQuiz();
      };
    });
    els.body.querySelectorAll('[data-go]').forEach(function (b) {
      b.onclick = function () { st.idx = parseInt(b.getAttribute('data-go'), 10); renderQuiz(); };
    });

    var last = st.idx === st.qs.length - 1;
    var left = st.qs.length - answered;

    els.foot.innerHTML =
      '<button class="btn-ghost" id="qPrev"' + (st.idx === 0 ? ' disabled' : '') + '>上一题</button>' +
      '<span class="quiz-spacer"></span>' +
      '<button class="btn-ghost" id="qQuit">放弃</button>' +
      (last
        ? '<button class="btn-primary" id="qDone">交卷' + (left ? '（还有 ' + left + ' 题没答）' : '') + '</button>'
        : '<button class="btn-primary" id="qNext">下一题</button>');

    if ($('qPrev')) $('qPrev').onclick = function () { st.idx--; renderQuiz(); };
    if ($('qNext')) $('qNext').onclick = function () { st.idx++; renderQuiz(); };
    $('qQuit').onclick = function () {
      if (st.timer) clearInterval(st.timer);
      st.timer = null;
      setView('cover');
    };
    if ($('qDone')) $('qDone').onclick = submit;
  }

  function submit() {
    if (st.timer) clearInterval(st.timer);
    st.timer = null;
    st.elapsedMs = st.elapsedMs || (Date.now() - st.startedAt);
    st.score = Q.grade(st.qs, st.answers);
    var rec = {
      form: st.form,
      who: st.who,
      ms: st.elapsedMs,
      startedAt: st.startedAt,
      finishedAt: stamp(),
      score: st.score
    };
    st.lastRec = rec;
    try { Q.save(rec); } catch (e) { /* 配额满了不该拦住出分 */ }
    setView('result');
  }

  // ---------------- 结果 ----------------

  function topicBars(byTopic) {
    return topics().map(function (t) {
      var d = byTopic[t];
      if (!d) return '';
      var pct = d.total ? Math.round((d.correct / d.total) * 100) : 0;
      var cls = pct >= 80 ? 'good' : (pct >= 50 ? 'mid' : 'bad');
      return '<div class="tb-row">' +
        '<span class="tb-name">' + esc(Q.TOPICS[t]) + '</span>' +
        '<span class="tb-track"><i class="' + cls + '" style="width:' + pct + '%"></i></span>' +
        '<span class="tb-val">' + d.correct + '/' + d.total + '</span>' +
        '</div>';
    }).join('');
  }

  function renderResult() {
    var s = st.score;
    var label = Q.FORMS[st.form].label;

    els.title.textContent = label + ' · 成绩';
    els.meta.textContent = '用时 ' + fmtClock(st.elapsedMs);

    var weakest = null;
    topics().forEach(function (t) {
      var d = s.byTopic[t];
      if (!d) return;
      var pct = d.total ? d.correct / d.total : 1;
      if (!weakest || pct < weakest.pct) weakest = { t: t, pct: pct, d: d };
    });

    var review = s.rows.map(function (row, i) {
      var q = st.qs[i];
      return '<details class="qrev' + (row.correct ? ' ok' : ' bad') + '">' +
        '<summary><b>' + (i + 1) + '</b><span class="qrev-topic">' + esc(row.topicName) + '</span>' +
        '<span class="qrev-mark">' + (row.correct ? '✓' : '✗') + '</span></summary>' +
        '<p class="qrev-stem">' + esc(q.stem) + '</p>' +
        '<p class="qrev-line">你选：<b class="' + (row.correct ? 'yes' : 'no') + '">' + esc(row.chosenText) + '</b></p>' +
        (row.correct ? '' : '<p class="qrev-line">正确：<b class="yes">' + esc(row.answerText) + '</b></p>') +
        '<p class="qrev-exp">' + esc(q.explain) + '</p>' +
        '</details>';
    }).join('');

    els.body.innerHTML =
      '<div class="qscore">' +
        '<div class="qscore-num">' + s.correct + '<span>/' + s.total + '</span></div>' +
        '<div class="qscore-side">' +
          '<div class="qscore-pct">' + s.percent + '%</div>' +
          '<div class="qscore-sub">' + (weakest && weakest.pct < 1
            ? '最薄弱：<b>' + esc(Q.TOPICS[weakest.t]) + '</b>（' + weakest.d.correct + '/' + weakest.d.total + '）'
            : '五块全对。') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="tbar">' + topicBars(s.byTopic) + '</div>' +
      '<div class="quiz-note">别急着关。下面每一题都写清了<b>为什么</b>，' +
      '做错的题点开看解析，比再刷十道有用。</div>' +
      '<div class="qrevs">' + review + '</div>';

    els.foot.innerHTML =
      '<button class="btn-ghost" id="qAgain">再考一次</button>' +
      '<button class="btn-ghost" id="qCsv">下载这份记录（CSV）</button>' +
      '<button class="btn-ghost" id="qGive">交给老师</button>' +
      '<span class="quiz-spacer"></span>' +
      '<button class="btn-ghost" id="qSum">看汇总</button>' +
      '<button class="btn-primary" id="qClose">回到实验台</button>';

    $('qAgain').onclick = function () { setView('cover'); };
    $('qCsv').onclick = function () {
      var name = 'signallab-' + st.form + '-' + Date.now() + '.csv';
      Q.download(name, Q.recordToCSV({ form: st.form, score: st.score, ms: st.elapsedMs }), 'text/csv');
    };
    $('qGive').onclick = function () {
      if (!st.lastRec) return;
      var who = (st.who || '').trim() || '匿名';
      Q.download('signallab-' + who + '-' + st.form + '.json',
        Q.packRecords([st.lastRec], who), 'application/json');
    };
    $('qSum').onclick = function () { setView('summary'); };
    $('qClose').onclick = close;
  }

  // ---------------- 汇总（教师端雏形） ----------------

  function renderSummary() {
    var recs = Q.loadAll();

    els.title.textContent = '汇总';
    els.meta.textContent = recs.length ? recs.length + ' 份记录' : '';

    if (!recs.length) {
      els.body.innerHTML =
        '<p class="quiz-lede">这台电脑上还没有记录。</p>' +
        '<div class="quiz-note">让学生用同一台电脑（或同一浏览器）做完前测和后测，' +
        '记录会攒在这里。前测、后测各来一批之后，这张表就能看出五块知识点各变了多少。</div>';
      els.foot.innerHTML =
        '<span class="quiz-spacer"></span><button class="btn-primary" id="qBack">返回</button>';
      $('qBack').onclick = function () { setView('cover'); };
      return;
    }

    var sum = Q.summarize(recs);
    var pre = sum.pre, post = sum.post;

    // 知识点对比：前测 vs 后测
    var cmp = topics().map(function (t) {
      var a = pre && pre.byTopic[t], b = post && post.byTopic[t];
      var pa = a && a.total ? Math.round(a.correct / a.total * 100) : null;
      var pb = b && b.total ? Math.round(b.correct / b.total * 100) : null;
      var delta = (pa != null && pb != null) ? (pb - pa) : null;
      var dTxt = delta == null ? '—' : (delta > 0 ? '+' : '') + delta + ' pp';
      var dCls = delta == null ? '' : (delta > 0 ? 'up' : (delta < 0 ? 'down' : ''));
      return '<tr><td>' + esc(Q.TOPICS[t]) + '</td>' +
        '<td>' + (pa == null ? '—' : pa + '%') + '</td>' +
        '<td>' + (pb == null ? '—' : pb + '%') + '</td>' +
        '<td class="' + dCls + '">' + dTxt + '</td></tr>';
    }).join('');

    // 配对样本：同一个代号既做了前测又做了后测
    var byWho = {};
    recs.forEach(function (r) {
      if (!r.who) return;
      byWho[r.who] = byWho[r.who] || {};
      if (!byWho[r.who][r.form]) byWho[r.who][r.form] = r;
    });
    var pairWho = Object.keys(byWho).filter(function (w) {
      return byWho[w].pre && byWho[w].post;
    });
    var pairRows = pairWho.map(function (w) {
      var a = byWho[w].pre.score.percent, b = byWho[w].post.score.percent;
      var d = b - a;
      return '<tr><td>' + esc(w) + '</td><td>' + a + '%</td><td>' + b + '%</td>' +
        '<td class="' + (d > 0 ? 'up' : (d < 0 ? 'down' : '')) + '">' +
        (d > 0 ? '+' : '') + d + ' pp</td></tr>';
    }).join('');
    var pairMean = pairWho.length
      ? Math.round(pairWho.reduce(function (s2, w) {
          return s2 + (byWho[w].post.score.percent - byWho[w].pre.score.percent);
        }, 0) / pairWho.length)
      : null;

    els.body.innerHTML =
      '<div class="qstats">' +
        '<div class="qstat"><b>' + (pre ? pre.n : 0) + '</b><span>前测份数</span>' +
          '<em>' + (pre ? pre.percent + '%' : '—') + '</em></div>' +
        '<div class="qstat"><b>' + (post ? post.n : 0) + '</b><span>后测份数</span>' +
          '<em>' + (post ? post.percent + '%' : '—') + '</em></div>' +
        '<div class="qstat"><b>' + pairWho.length + '</b><span>配对（同一代号）</span>' +
          '<em>' + (pairMean == null ? '—' : (pairMean > 0 ? '+' : '') + pairMean + ' pp') + '</em></div>' +
      '</div>' +
      '<h4 class="qsub">按知识点</h4>' +
      '<table class="qtable"><thead><tr><th>知识点</th><th>前测</th><th>后测</th><th>变化</th></tr></thead>' +
      '<tbody>' + cmp + '</tbody></table>' +
      (pairWho.length
        ? '<h4 class="qsub">配对明细（' + pairWho.length + ' 人）</h4>' +
          '<table class="qtable"><thead><tr><th>代号</th><th>前测</th><th>后测</th><th>变化</th></tr></thead>' +
          '<tbody>' + pairRows + '</tbody></table>'
        : '<div class="quiz-note">还没有人同时做过前测和后测。' +
          '如果在封面填了同样的<b>代号</b>，这里会把同一个人的两次成绩配起来，' +
          '配对比较比「前测平均 vs 后测平均」可信得多，因为它消掉了「这批人本来就强」的干扰。</div>') +
      '<div class="quiz-note">注意：<b>「前测平均 vs 后测平均」是独立样本</b>，' +
      '如果做前测和后测的不是同一批人，这两个数的差不能直接算作教学效果。' +
      '要看效果，请认上面那张<b>配对明细</b>。</div>';

    els.foot.innerHTML =
      '<button class="btn-ghost" id="qWide">导出全部记录（宽表 CSV）</button>' +
      '<button class="btn-ghost" id="qGiveAll">全部交给老师</button>' +
      '<button class="btn-ghost danger" id="qClear">清空本机记录</button>' +
      '<span class="quiz-spacer"></span>' +
      '<button class="btn-primary" id="qBack">返回</button>';

    $('qWide').onclick = function () {
      Q.download('signallab-quiz-all-' + Date.now() + '.csv', Q.recordsToCSV(recs), 'text/csv');
    };
    $('qGiveAll').onclick = function () {
      Q.download('signallab-交给老师-' + recs.length + '份-' + Date.now() + '.json',
        Q.packRecords(recs, ''), 'application/json');
    };
    $('qClear').onclick = function () {
      if (typeof confirm === 'function' && !confirm('清空这台电脑上全部 ' + recs.length + ' 份答题记录？')) return;
      Q.clear();
      setView('summary');
    };
    $('qBack').onclick = function () { setView('cover'); };
  }

  // ---------------- 生命周期 ----------------

  function open(form) {
    if (form) st.form = form;
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    st.view = 'cover';
    render();
    if (els.overlay) els.overlay.hidden = false;
  }

  function close() {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    if (els.overlay) els.overlay.hidden = true;
  }

  function init() {
    els.overlay = $('quizOverlay');
    if (!els.overlay) return;
    els.body = $('quizBody');
    els.foot = $('quizFoot');
    els.title = $('quizTitle');
    els.meta = $('quizMeta');

    $('quizClose').onclick = close;
    els.overlay.addEventListener('click', function (e) {
      if (e.target === els.overlay) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !els.overlay.hidden) close();
    });

    var btn = $('quizBtn');
    if (btn) btn.onclick = function () { open(); };

    // 演示直链：?quiz=pre / ?quiz=post 直接打开卷子（?quiz=1 等同前测）
    var m = /[?&]quiz=([a-z0-9]+)/.exec(location.search);
    if (m) {
      var f = m[1] === '1' ? 'pre' : m[1];
      if (Q.FORMS[f]) setTimeout(function () { open(f); }, 0);
    }
  }

  NS.quizui = { init: init, open: open, close: close };
})(window.SignalLab = window.SignalLab || {});
