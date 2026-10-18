/* 信号实验室 · 教师端界面
 *
 * 两个页签，对应老师真正会做的两件事：
 *   「出练习」：挑知识点和层次，出一份能直接打印的练习卷加答案页。
 *   「看全班」：把学生交上来的成绩单拖进来，看知识点正确率和逐题错因，
 *                以及最要紧的那个数：前后测能配对的人，平均提了多少分。
 *
 * 所有计算都在 teacher.js 里，这里只管画和收事件。
 */
(function (NS) {
  'use strict';

  var Q = NS.quiz;
  var T = NS.teacher;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function stamp() {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var d = new Date();
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var els = {};
  var st = {
    tab: 'make',
    topics: [],        // 选中的知识点；空数组 = 全都要
    levels: [1, 2],    // 默认基础 + 进阶。挑战层题少，老师要看的时候自己勾
    count: 8,
    seed: null,
    ex: null,          // 当前这份练习
    records: [],       // 收上来的成绩单
    skipped: [],       // 收了但认不出来的
    agg: null
  };

  var TOPIC_ORDER = ['timedomain', 'sampling', 'spectrum', 'instrument', 'array'];

  // ---------------- 开 / 关 ----------------

  function init() {
    els.overlay = $('teacherOverlay');
    els.body = $('tchBody');
    els.btn = $('teacherBtn');
    els.close = $('tchClose');
    els.tabs = $('tchTabs');

    st.topics = Object.keys(Q.TOPICS);

    if (els.btn) els.btn.addEventListener('click', open);
    if (els.close) els.close.addEventListener('click', close);
    if (els.overlay) {
      els.overlay.addEventListener('click', function (ev) {
        if (ev.target === els.overlay) close();
      });
    }
    if (els.tabs) {
      els.tabs.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-tab]');
        if (!b) return;
        st.tab = b.getAttribute('data-tab');
        render();
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && els.overlay && !els.overlay.hidden) close();
    });
  }

  function open() {
    if (!els.overlay) return;
    els.overlay.hidden = false;
    document.body.classList.add('tch-open');
    // 打开时顺便把本机已有的记录捞一遍。老师自己那台机器上做过测试的话，
    // 一进来就能看到东西，不用先去翻文件。
    if (!st.records.length) loadLocal(true);
    render();
  }

  function close() {
    if (!els.overlay) return;
    els.overlay.hidden = true;
    document.body.classList.remove('tch-open');
  }

  // ---------------- 画面分发 ----------------

  function render() {
    if (!els.body) return;
    Array.prototype.forEach.call(
      els.tabs ? els.tabs.querySelectorAll('[data-tab]') : [], function (b) {
        b.classList.toggle('on', b.getAttribute('data-tab') === st.tab);
      });

    if (st.tab === 'make') renderMake();
    else renderClass();
  }

  // ================= 页签一：出练习 =================

  function renderMake() {
    var avail = T.inventory({ topics: st.topics, levels: st.levels });
    var selTopics = st.topics.length === Object.keys(Q.TOPICS).length
      ? '全部知识点' : st.topics.map(function (t) { return Q.TOPICS[t]; }).join('、');
    var selLevels = st.levels.length === T.LEVEL_LIST.length
      ? '全部层次' : st.levels.map(function (l) { return T.LEVEL[l].name; }).join(' + ');

    els.body.innerHTML =
      '<div class="tch-pane">' +
      '  <div class="tch-cols">' +
      '    <div class="tch-set">' +
      '      <div class="tch-field"><label>知识点</label><div class="chips" id="tchTopics">' +
      TOPIC_ORDER.map(function (t) {
        return '<button class="chip' + (st.topics.indexOf(t) >= 0 ? ' on' : '') +
          '" data-topic="' + t + '">' + esc(Q.TOPICS[t]) + '</button>';
      }).join('') +
      '      </div></div>' +
      '      <div class="tch-field"><label>层次</label><div class="chips" id="tchLevels">' +
      T.LEVEL_LIST.map(function (l) {
        return '<button class="chip' + (st.levels.indexOf(l.key) >= 0 ? ' on' : '') +
          '" data-level="' + l.key + '" title="' + esc(l.hint) + '">' + esc(l.name) + '</button>';
      }).join('') +
      '      </div></div>' +
      '      <div class="tch-field"><label>题量</label>' +
      '        <input type="range" id="tchCount" min="3" max="20" step="1" value="' + st.count + '">' +
      '        <output id="tchCountOut">' + st.count + ' 题</output>' +
      '      </div>' +
      '      <p class="tch-note" id="tchAvail">' +
      '        当前条件下最多能出 <b>' + avail + '</b> 道不重样的题。' +
      (avail < st.count ? '<span class="warn">题量超过了这个上限，卷子里会出现重题。</span>' : '') +
      '      </p>' +
      '      <div class="tch-actions">' +
      '        <button class="btn btn--go" id="tchGen">生成练习</button>' +
      '        <button class="btn" id="tchAgain"' + (st.ex ? '' : ' disabled') + '>换一套数字</button>' +
      '        <button class="btn" id="tchPrint"' + (st.ex ? '' : ' disabled') + '>打印 / 存 PDF</button>' +
      '      </div>' +
      '      <p class="tch-note">' + esc(selTopics) + ' · ' + esc(selLevels) + '</p>' +
      '    </div>' +
      '    <div class="tch-preview" id="tchPreview"></div>' +
      '  </div>' +
      '</div>';

    bindMake();
    renderPreview();
  }

  function bindMake() {
    var tp = $('tchTopics'), lv = $('tchLevels'), c = $('tchCount');

    if (tp) tp.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-topic]');
      if (!b) return;
      toggle(st.topics, b.getAttribute('data-topic'));
      if (!st.topics.length) st.topics = Object.keys(Q.TOPICS);  // 一个都不选 = 全选
      renderMake();
    });

    if (lv) lv.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-level]');
      if (!b) return;
      toggle(st.levels, parseInt(b.getAttribute('data-level'), 10));
      if (!st.levels.length) st.levels = T.LEVEL_LIST.map(function (l) { return l.key; });
      renderMake();
    });

    if (c) {
      c.addEventListener('input', function () {
        st.count = parseInt(c.value, 10);
        var out = $('tchCountOut');
        if (out) out.textContent = st.count + ' 题';
        var avail = T.inventory({ topics: st.topics, levels: st.levels });
        var note = $('tchAvail');
        if (note) {
          note.innerHTML = '当前条件下最多能出 <b>' + avail + '</b> 道不重样的题。' +
            (avail < st.count ? '<span class="warn">题量超过了这个上限，卷子里会出现重题。</span>' : '');
        }
      });
    }

    if ($('tchGen')) $('tchGen').addEventListener('click', function () { generate(); });
    if ($('tchAgain')) $('tchAgain').addEventListener('click', function () {
      if (!st.ex) return;
      generate();
    });
    if ($('tchPrint')) $('tchPrint').addEventListener('click', function () {
      if (st.ex) window.print();
    });
  }

  function toggle(arr, v) {
    var i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
  }

  function generate() {
    try {
      st.ex = T.make({
        topics: st.topics, levels: st.levels,
        count: st.count, seed: null
      });
    } catch (e) {
      st.ex = null;
      window.alert(e.message || String(e));
      return;
    }
    renderMake();
  }

  function renderPreview() {
    var box = $('tchPreview');
    if (!box) return;
    if (!st.ex) {
      box.innerHTML = '<p class="tch-empty">左边挑好条件，点「生成练习」。<br>' +
        '卷子里的图和答案都是从实验台同一套代码算出来的。学生做练习时看到的画面，' +
        '和他在仪器面板上看到的完全一致。</p>';
      return;
    }

    var ex = st.ex;
    var head = '信号实验室 · 分层练习　' + stamp() +
      '　（编号 ' + ex.seed + '）';
    var meta = Object.keys(ex.byLevel).sort().map(function (l) {
      return T.LEVEL[l].name + ' ' + ex.byLevel[l] + ' 题';
    }).join('　') + '　|　' + Object.keys(ex.byTopic).map(function (t) {
      return Q.TOPICS[t] + ' ' + ex.byTopic[t];
    }).join('　');

    box.innerHTML =
      '<div class="ex-sheet" id="tchSheet">' +
      '  <div class="ex-head"><h3>' + esc(head) + '</h3><p>' + esc(meta) + '</p>' +
      (ex.short ? '<p class="warn">这个条件下只凑到 ' + ex.count + ' 道不重样的题（想要 ' +
        ex.wanted + ' 道），剩下的位置没有用重复题硬凑。</p>' : '') +
      '  </div>' +
      ex.questions.map(function (q, i) {
        return '<article class="ex-q">' +
          '<div class="ex-stem"><b>' + (i + 1) + '.</b> ' + esc(q.stem) + '</div>' +
          (q.fig ? '<figure class="ex-fig"><canvas id="exfig' + i + '"></canvas>' +
            '<figcaption>' + esc(q.fig.caption || '') + '</figcaption></figure>' : '') +
          '<ol class="ex-choices" type="A">' +
          q.choices.map(function (ch) { return '<li>' + esc(ch) + '</li>'; }).join('') +
          '</ol>' +
          '<div class="ex-blank">答案：__________</div>' +
          '</article>';
      }).join('') +
      '  <section class="ex-key">' +
      '    <h3>答案与讲解（这一页单独印，或者印完撕下来）</h3>' +
      '    <ol>' +
      ex.questions.map(function (q, i) {
        return '<li><b>' + String.fromCharCode(65 + q.answer) + '</b>' +
          '　<span class="ex-tag">' + esc(q.topicName) + ' · ' + esc(q.levelName) + '</span>' +
          '<p>' + esc(q.explain) + '</p></li>';
      }).join('') +
      '    </ol>' +
      '  </section>' +
      '</div>';

    // 图必须等元素进了 DOM 再画
    ex.questions.forEach(function (q, i) {
      if (!q.fig) return;
      var cv = $('exfig' + i);
      if (cv) Q.renderFig(cv, q.fig);
    });
  }

  // ================= 页签二：看全班 =================

  function renderClass() {
    var agg = st.agg;
    els.body.innerHTML =
      '<div class="tch-pane">' +
      '  <div class="tch-drop" id="tchDrop">' +
      '    <input type="file" id="tchFiles" multiple accept=".json,application/json" hidden>' +
      '    <p><b>把学生交上来的成绩单拖到这里</b>，或者 ' +
      '      <button class="btn btn--sm" id="tchPick">选择文件</button>' +
      '      <button class="btn btn--sm" id="tchLocal">读本机记录</button>' +
      '      <button class="btn btn--sm" id="tchClear"' + (st.records.length ? '' : ' disabled') + '>清空</button>' +
      '    </p>' +
      '    <p class="tch-note">学生做完题点「交给老师」会下载一个 .json。一次可以选很多个，重复的会自动去重。</p>' +
      '  </div>' +
      (st.skipped.length ? '<p class="tch-note warn">有 ' + st.skipped.length +
        ' 份没认出来：' + esc(st.skipped.slice(0, 4).map(function (s) {
          return '第 ' + (s.file + 1) + ' 个文件' + (s.index == null ? '' : ' 第 ' + (s.index + 1) + ' 条') + '（' + s.why + '）';
        }).join('；')) + (st.skipped.length > 4 ? ' …' : '') + '</p>' : '') +
      '  <div class="tch-report" id="tchReport"></div>' +
      '</div>';

    bindClass();
    renderReport();
  }

  function bindClass() {
    var drop = $('tchDrop'), files = $('tchFiles');
    if ($('tchPick') && files) $('tchPick').addEventListener('click', function () { files.click(); });
    if (files) files.addEventListener('change', function () { takeFiles(files.files); files.value = ''; });
    if ($('tchLocal')) $('tchLocal').addEventListener('click', function () { loadLocal(false); });
    if ($('tchClear')) $('tchClear').addEventListener('click', function () {
      if (!st.records.length) return;
      if (!window.confirm('把已经收上来的 ' + st.records.length + ' 份成绩单从这次汇总里去掉？\n' +
        '（本机记录不会被删，只是这次不参与统计）')) return;
      st.records = []; st.skipped = []; st.agg = null; st.synth = 0;
      renderClass();
    });
    if ($('tchCsv')) $('tchCsv').addEventListener('click', function () {
      Q.download('signallab-class-' + Date.now() + '.csv', T.summaryCSV(st.agg), 'text/csv');
    });
    if ($('tchDiag')) $('tchDiag').addEventListener('click', function () {
      Q.download('signallab-diagnosis-' + Date.now() + '.txt',
        T.diagnosis(st.agg).join('\n'), 'text/plain');
    });

    if (!drop) return;
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        drop.classList.remove('over');
      });
    });
    drop.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) takeFiles(dt.files);
    });
  }

  function loadLocal(quiet) {
    var recs = (Q.loadAll() || []).filter(function (r) {
      return r && r.score && r.form;
    });
    if (!recs.length) {
      if (!quiet) window.alert('这台机器上还没有做过题目的记录。\n学生在自己电脑上做完的，要用「交给老师」导出的 .json。');
      return;
    }
    ingest(recs, []);
  }

  function takeFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var pending = files.length, texts = new Array(files.length);
    files.forEach(function (f, i) {
      var fr = new FileReader();
      fr.onload = function () { texts[i] = String(fr.result); done(); };
      fr.onerror = function () { texts[i] = ''; done(); };
      fr.readAsText(f);
    });
    function done() {
      if (--pending > 0) return;
      var r = Q.readRecords(texts);
      ingest(r.records, r.skipped, r.synthetic);
    }
  }

  /* synth = 这批文件里有几份自报「合成数据」（pilot/make_cohort.js 生成的）。
     教师端不拦它，但会在报告顶上把这件事说清楚。拿假数据冒充真试点是最容易的翻车方式。 */
  function ingest(records, skipped, synth) {
    var seen = {};
    st.records.forEach(function (r) { seen[keyOf(r)] = 1; });
    var added = 0, dup = 0;
    records.forEach(function (r) {
      var k = keyOf(r);
      if (seen[k]) { dup++; return; }
      seen[k] = 1;
      st.records.push(r);
      added++;
    });
    st.skipped = (skipped || []).slice();
    st.synth = (st.synth || 0) + (synth || 0);
    st.agg = T.aggregate(st.records);
    renderClass();
    if (dup) {
      // 不弹窗，报告里会写清楚。老师连着拖两次同一批文件是常事，不该被打断。
    }
    /* eslint-disable no-unused-vars */
    void added;
  }

  // 同一份成绩单的指纹：同一个人、同一个卷别、同一个完成时刻，就是同一次作答。
  function keyOf(r) {
    return [r.who || '', r.form || '', r.finishedAt || '', (r.score && r.score.correct) + '/' +
      (r.score && r.score.total)].join('|');
  }

  function bar(pct, cls) {
    var w = Math.max(0, Math.min(100, pct));
    return '<span class="tmini ' + (cls || '') + '"><i style="width:' + w + '%"></i></span>';
  }

  function renderReport() {
    var box = $('tchReport');
    if (!box) return;
    var agg = st.agg;
    if (!agg || !agg.n) {
      box.innerHTML = '<p class="tch-empty">还没有成绩单。拖进来几个 .json 就能看到全班报告。<br>' +
        '报告里最重要的不是平均分，是「前后测都做了、能配对的那些人提了多少」。</p>';
      return;
    }

    var pre = agg.forms.pre, post = agg.forms.post;
    var html = '';

    if (st.synth) {
      html += '<p class="tch-warn">注意：这批成绩单里有 <b>' + st.synth +
        ' 份自报「合成数据，非真实学生」</b>。它们可以拿来演练教师端，' +
        '但<b>不能当作教学效果的证据</b>，下面任何一个数字引用出去之前都要先说清这一点。</p>';
    }

    html += '<div class="tch-cards">' +
      card('收到成绩单', agg.n + ' 份') +
      card('参与代号', agg.nStudents + ' 人' + (agg.anonymous ? '（另有 ' + agg.anonymous + ' 份没填代号）' : '')) +
      card('前测', pre ? pre.percent + '%　<span class="dim">' + pre.n + ' 份</span>' : '—') +
      card('后测', post ? post.percent + '%　<span class="dim">' + post.n + ' 份</span>' : '—') +
      card('配对提升', agg.pairStat
        ? (agg.pairStat.delta > 0 ? '+' : '') + agg.pairStat.delta + ' 个百分点' +
          '<span class="dim">' + agg.pairStat.n + ' 人</span>'
        : '—') +
      '</div>';

    if (agg.pairStat) {
      html += '<p class="tch-note">配对的 ' + agg.pairStat.n + ' 个人：平均从 ' +
        agg.pairStat.avgPre + '% 到 ' + agg.pairStat.avgPost + '%。只有这个数说得清「学会了没有」。' +
        '把前测所有人的平均分和后测所有人的平均分直接相减是没有意义的，做题的人根本不是同一批。</p>';
    } else {
      html += '<p class="tch-note warn">还没有人前后测都做过，算不出配对提升。' +
        '让同一批人两卷都做一遍，这份报告才说得出结论。</p>';
    }

    html += '<div class="tch-actions"><button class="btn" id="tchCsv">导出班级汇总 CSV</button>' +
      '<button class="btn" id="tchDiag">导出诊断文字</button></div>';

    html += '<h4>知识点</h4>' + topicTable(agg);

    if (agg.weak.length) {
      html += '<h4>最集中的卡点</h4><ol class="tch-weak">' +
        agg.weak.map(function (d) {
          return '<li><b>' + esc(d.topicName) + '</b>　' +
            '<span class="tch-tag">' + esc((Q.FORMS[d.form] || {}).label || d.form) + ' · ' + esc(d.id) + '</span>　' +
            d.t.correct + '/' + d.t.total + '（' + d.percent + '%）' + bar(d.percent, 'bad') +
            (d.topWrong ? '<br><span class="dim">最常见的错法是选「' + esc(d.topWrong.text) +
              '」，' + d.topWrong.count + ' 个人这么选</span>' : '') +
            '</li>';
        }).join('') + '</ol>';
    }

    html += '<h4>逐题（按题型归并）</h4><table class="tch-table"><thead><tr>' +
      '<th>卷别</th><th>题型</th><th>知识点</th><th>正确率</th><th>题次</th><th>最常见的错法</th>' +
      '</tr></thead><tbody>' +
      agg.typeRows.map(function (d) {
        return '<tr><td>' + esc((Q.FORMS[d.form] || {}).label || d.form) + '</td>' +
          '<td><code>' + esc(d.id) + '</code></td>' +
          '<td>' + esc(d.topicName) + '</td>' +
          '<td>' + d.percent + '%' + bar(d.percent, d.percent < 60 ? 'bad' : (d.percent < 80 ? 'mid' : 'good')) + '</td>' +
          '<td>' + d.t.correct + '/' + d.t.total + '</td>' +
          '<td>' + (d.topWrong ? esc(d.topWrong.text) + '　<i class="dim">' + d.topWrong.count + ' 人选</i>' : '—') + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';

    box.innerHTML = html;
    if ($('tchCsv')) $('tchCsv').addEventListener('click', function () {
      Q.download('signallab-class-' + Date.now() + '.csv', T.summaryCSV(st.agg), 'text/csv');
    });
    if ($('tchDiag')) $('tchDiag').addEventListener('click', function () {
      Q.download('signallab-diagnosis-' + Date.now() + '.txt', T.diagnosis(st.agg).join('\n'), 'text/plain');
    });
  }

  function card(label, value) {
    return '<div class="tch-card"><span class="tch-card-l">' + esc(label) + '</span>' +
      '<span class="tch-card-v">' + value + '</span></div>';
  }

  function topicTable(agg) {
    return '<table class="tch-table"><thead><tr><th>知识点</th><th>前测</th><th>后测</th>' +
      '<th>提升</th><th>题次</th></tr></thead><tbody>' +
      agg.topicRows.map(function (d) {
        var dp = d.delta == null ? '—' :
          (d.delta > 0 ? '+' : '') + d.delta;
        return '<tr><td>' + esc(d.name) + '</td>' +
          '<td>' + (d.pre.total ? d.pre.percent + '%' + bar(d.pre.percent) : '—') + '</td>' +
          '<td>' + (d.post.total ? d.post.percent + '%' + bar(d.post.percent) : '—') + '</td>' +
          '<td>' + dp + '</td>' +
          '<td>' + d.pre.total + ' / ' + d.post.total + '</td></tr>';
      }).join('') +
      '</tbody></table>';
  }

  NS.teacherui = { init: init, open: open, close: close, state: st };
}(window.SignalLab));
