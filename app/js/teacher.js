/* 信号实验室 · 教师端
 *
 * 这个文件管两件跟「一个班」有关的事：
 *
 *   1. 出练习，按 知识点 × 层次 从题库里抽题，拼成一份能打印的练习卷和答案页。
 *      学生端的前测/后测只有固定两份卷子（要配对比较，两套必须一模一样），
 *      练习卷不一样：它不需要配对，所以每次可以换一套数字，人人不同。
 *
 *   2. 看全班，把学生交上来的成绩单合起来，算知识点正确率、逐题错因分布，
 *      自动挑出最集中的几个卡点。
 *
 * 数据怎么从学生手上到老师这里：学生端导出 JSON 成绩单，老师那边一次拖进来一堆。
 * 刻意不走服务器，一个班几十份文件，教学平台或者聊天工具传一下就完了，谁也不用配后端。
 * 哪天真要接后端，POST 上去的也是同一份 JSON，格式不用动。
 */
(function (NS) {
  'use strict';

  var Q = NS.quiz;

  // ---------------- 层次 ----------------

  var LEVEL_LIST = [
    { key: 1, name: '基础', hint: '看刻度读数、套一个公式就能出答案' },
    { key: 2, name: '进阶', hint: '要转一个弯，或者要先想清楚仪器在做什么' },
    { key: 3, name: '挑战', hint: '要把两个知识点连起来才想得通' }
  ];

  var LEVEL = {};
  LEVEL_LIST.forEach(function (l) { LEVEL[l.key] = l; });

  // 每个题型归哪一层。这是人给的判断，不是算出来的，所以写在一起，改的时候一眼看全。
  var LEVEL_OF = {
    t1: 1, t2: 1, s2: 1, p1: 1,
    s1: 2, p2: 2, i1: 2, i2: 2, a1: 2,
    a2: 3, a3: 3
  };

  // 蓝图：id 和 topic 直接从生成器自己问出来，不另外维护一份表，免得跟 GENERATORS 漂移。
  // 用固定种子掷一次骰子探测；生成器是纯函数，这一下不改动任何状态。
  var BLUEPRINT = (Q.GENERATORS || []).concat(Q.EXTRAS || []).map(function (gen) {
    var probe = gen(NS.signal.mulberry32(20261015), 0);
    return {
      id: probe.id,
      topic: probe.topic,
      topicName: Q.TOPICS[probe.topic] || probe.topic,
      level: LEVEL_OF[probe.id] || 1,
      gen: gen
    };
  });

  // ---------------- 小工具 ----------------

  function shuffle(r, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 一道题的「同一套数字」指纹。用题干而不是 data：data 里可能带着只影响图、
  // 不影响问题的字段（比如阵列仿真的随机种子），拿它去重会把同一道题算成两道。
  function sigOf(q) {
    return q.id + '|' + q.stem;
  }

  function formLabel(form) {
    return (Q.FORMS[form] || {}).label || form;
  }

  // 从 qid 里把题型抠出来：pre-3-p2 → p2，ex-1-a3 → a3
  function genIdOf(qid) {
    return String(qid || '').replace(/^(pre|post|ex)-\d+-/, '');
  }

  // ---------------- 出练习 ----------------

  // 按知识点 × 层次筛题型。两个参数都传空数组 = 全都要。
  function select(opts) {
    opts = opts || {};
    var topicOn = null, lvlOn = null;
    if (opts.topics && opts.topics.length) {
      topicOn = {};
      opts.topics.forEach(function (t) { topicOn[t] = 1; });
    }
    if (opts.levels && opts.levels.length) {
      lvlOn = {};
      opts.levels.forEach(function (l) { lvlOn[l] = 1; });
    }
    return BLUEPRINT.filter(function (b) {
      return (!topicOn || topicOn[b.topic]) && (!lvlOn || lvlOn[b.level]);
    });
  }

  // 这个筛选条件下到底能出多少道「数字不一样」的题。
  // 老师说「出 12 题」时界面得先说清楚这一条够不够，不然卷子里会混进重题。
  // 穷举掷骰子估一个数就够了，不用精确，它是给人看的提示，不是判据。
  function inventory(opts) {
    var cands = select(opts);
    if (!cands.length) return 0;
    var r = NS.signal.mulberry32(424242);
    var seen = {}, n = 0, i, b, q, sig;
    for (i = 0; i < 3000; i++) {
      b = cands[i % cands.length];
      q = b.gen(r, 0);
      sig = sigOf(q);
      if (!seen[sig]) { seen[sig] = 1; n++; }
    }
    return n;
  }

  function make(opts) {
    opts = opts || {};
    var want = Math.max(1, Math.min(40, Math.round(opts.count || 8)));
    var cands = select(opts);
    if (!cands.length) throw new Error('没有符合「知识点 × 层次」的题型，换个条件再试');

    var seed = opts.seed == null
      ? (Math.floor(Math.random() * 4294967296) >>> 0)
      : (opts.seed >>> 0);
    var r = NS.signal.mulberry32(seed);

    var out = [], seen = {}, queue = [];
    function refill() { queue = shuffle(r, cands.slice()); }
    refill();

    var guard = 0;
    while (out.length < want && guard < want * 80) {
      guard++;
      if (!queue.length) refill();
      var b = queue.shift();
      var q = b.gen(r, 0);
      var sig = sigOf(q);
      if (seen[sig]) continue;          // 同一套数字，一份练习里只出一遍
      seen[sig] = 1;
      q.form = 'ex';
      q.index = out.length;
      q.qid = 'ex-' + (out.length + 1) + '-' + q.id;
      q.level = b.level;
      q.levelName = LEVEL[b.level].name;
      q.topicName = b.topicName;
      out.push(q);
    }

    var byTopic = {}, byLevel = {};
    out.forEach(function (q) {
      byTopic[q.topic] = (byTopic[q.topic] || 0) + 1;
      byLevel[q.level] = (byLevel[q.level] || 0) + 1;
    });

    return {
      seed: seed,
      wanted: want,
      count: out.length,
      short: out.length < want,
      available: inventory(opts),
      byTopic: byTopic,
      byLevel: byLevel,
      questions: out
    };
  }

  // ---------------- 看全班 ----------------

  function tally() { return { n: 0, correct: 0, total: 0 }; }

  function addTo(t, ok) {
    t.n += 1; t.total += 1;
    if (ok) t.correct += 1;
    return t;
  }

  function pctOf(t) {
    return t && t.total ? Math.round((t.correct / t.total) * 100) : 0;
  }

  function bump(obj, key) {
    obj[key] = (obj[key] || 0) + 1;
    return obj;
  }

  // 把一堆成绩单揉成一份班级报告。records 就是 NS.quiz.loadAll() 或者
  // NS.quiz.readRecords(...).records 给的那种原始记录。
  function aggregate(records) {
    var list = (records || []).filter(function (r) { return r && r.score && r.score.rows; });

    var byForm = {}, byTopic = {}, byType = {}, byQid = {}, byWho = {};
    var anonymous = 0;

    list.forEach(function (rec) {
      var form = rec.form;
      var who = rec.who || '';
      if (!who) anonymous++;

      var f = byForm[form] || (byForm[form] = {
        form: form, label: formLabel(form),
        n: 0, correct: 0, total: 0, ms: 0, students: {}
      });
      f.n++;
      f.correct += rec.score.correct;
      f.total += rec.score.total;
      f.ms += rec.ms || 0;
      if (who) f.students[who] = 1;

      // 没填代号的全归一个桶，并且不当作「一个人」计数，不然收上来五份匿名卷，
      // 报告里会凭空多出五个人。
      var key = who || '';
      var w = byWho[key] || (byWho[key] = { who: who, records: {} });
      w.records[form] = rec;

      (rec.score.rows || []).forEach(function (row, i) {
        var ok = !!row.correct;

        var t = byTopic[row.topic] || (byTopic[row.topic] = {
          topic: row.topic, name: row.topicName || row.topic,
          pre: tally(), post: tally()
        });
        addTo(form === 'post' ? t.post : t.pre, ok);

        var gid = genIdOf(row.qid);
        var tk = form + '/' + gid;
        var ty = byType[tk] || (byType[tk] = {
          key: tk, form: form, id: gid,
          topic: row.topic, topicName: row.topicName || row.topic,
          t: tally(), wrong: {}
        });
        addTo(ty.t, ok);
        if (!ok) bump(ty.wrong, row.chosenText || '（未作答）');

        var qq = byQid[row.qid] || (byQid[row.qid] = {
          qid: row.qid, form: form, index: i, id: gid,
          topic: row.topic, topicName: row.topicName || row.topic,
          answerText: row.answerText, t: tally(), picked: {}
        });
        addTo(qq.t, ok);
        bump(qq.picked, row.chosenText || '（未作答）');
      });
    });

    Object.keys(byForm).forEach(function (k) {
      var f = byForm[k];
      f.percent = pctOf(f);
      f.nStudents = Object.keys(f.students).length;
      f.avgMs = f.n ? Math.round(f.ms / f.n) : 0;
    });

    var topicRows = Object.keys(byTopic).map(function (k) {
      var d = byTopic[k];
      d.pre.percent = pctOf(d.pre);
      d.post.percent = pctOf(d.post);
      d.delta = (d.pre.total && d.post.total) ? d.post.percent - d.pre.percent : null;
      return d;
    });
    topicRows.sort(function (a, b) { return (a.pre.percent + a.post.percent) - (b.pre.percent + b.post.percent); });

    function wrongList(wrong) {
      return Object.keys(wrong)
        .map(function (text) { return { text: text, count: wrong[text] }; })
        .sort(function (a, b) { return b.count - a.count; });
    }

    var typeRows = Object.keys(byType).map(function (k) {
      var d = byType[k];
      d.percent = pctOf(d.t);
      d.wrongList = wrongList(d.wrong);
      d.topWrong = d.wrongList.length ? d.wrongList[0] : null;
      return d;
    });
    typeRows.sort(function (a, b) { return a.percent - b.percent || a.t.total - b.t.total; });

    var qRows = Object.keys(byQid).map(function (k) {
      var d = byQid[k];
      d.percent = pctOf(d.t);
      d.pickedList = Object.keys(d.picked)
        .map(function (text) {
          return { text: text, count: d.picked[text], isAnswer: text === d.answerText };
        })
        .sort(function (a, b) { return b.count - a.count; });
      d.nWrong = d.t.total - d.t.correct;
      return d;
    });
    qRows.sort(function (a, b) { return a.form.localeCompare(b.form) || a.index - b.index; });

    // 配对：同一个代号前后测都做了的，才谈得上「学会了没有」。
    // 只做了一份的人不掺进来，不然平均分会被「谁做了哪份」搅乱。
    var paired = [];
    Object.keys(byWho).forEach(function (k) {
      var w = byWho[k];
      if (w.who && w.records.pre && w.records.post) {
        paired.push({
          who: w.who,
          pre: w.records.pre.score.percent,
          post: w.records.post.score.percent,
          delta: w.records.post.score.percent - w.records.pre.score.percent
        });
      }
    });
    paired.sort(function (a, b) { return a.delta - b.delta; });

    var pairStat = null;
    if (paired.length) {
      var sp = 0, sq = 0;
      paired.forEach(function (p) { sp += p.pre; sq += p.post; });
      pairStat = {
        n: paired.length,
        // 保留一位小数。取整会让报告自相矛盾，「平均从 48% 到 60%，
        // 提高 11 个百分点」看着就像算错了（60-48=12）。一位小数时
        // 48.2 → 59.5、+11.3 三者互相能对上。
        avgPre: Math.round(sp / paired.length * 10) / 10,
        avgPost: Math.round(sq / paired.length * 10) / 10,
        delta: Math.round((sq - sp) / paired.length * 10) / 10
      };
    }

    // 卡点：样本够、正确率最低的那几个题型。样本太少的排掉 ，
    // 三个人做错和三十个人做错，不是一回事。
    var floor = Math.max(2, Math.ceil(list.length * 0.4));
    var weak = typeRows.filter(function (d) { return d.t.total >= floor; }).slice(0, 3);

    return {
      n: list.length,
      nStudents: Object.keys(byWho).filter(function (k) { return k; }).length,
      anonymous: anonymous,
      forms: byForm,
      topicRows: topicRows,
      typeRows: typeRows,
      qRows: qRows,
      byWho: byWho,
      paired: paired,
      pairStat: pairStat,
      weak: weak
    };
  }

  // 把卡点写成人话，一块可以直接粘到群里或者写进教学日志的文字。
  function diagnosis(agg) {
    var out = [];
    if (!agg || !agg.n) return ['还没有收到成绩单。'];

    out.push('收到 ' + agg.n + ' 份成绩单，涉及 ' + agg.nStudents + ' 个代号' +
      (agg.anonymous ? '（其中 ' + agg.anonymous + ' 份没填代号）' : '') + '。');

    var pre = agg.forms.pre, post = agg.forms.post;
    if (pre && post) {
      out.push('前测 ' + pre.n + ' 份，平均正确率 ' + pre.percent + '%；后测 ' + post.n +
        ' 份，平均正确率 ' + post.percent + '%。这两个数不能直接减，做题的人不一样。');
    }
    if (agg.pairStat) {
      var d = agg.pairStat.delta;
      out.push('前后测都做了、能配对的 ' + agg.pairStat.n + ' 个人：平均从 ' + agg.pairStat.avgPre +
        '% 到 ' + agg.pairStat.avgPost + '%，' + (d > 0 ? '提高 ' : (d < 0 ? '下降 ' : '持平 ')) +
        Math.abs(d) + ' 个百分点。这个数才说得清「学会了没有」。');
    } else if (pre || post) {
      out.push('还没有人前后测都做过，暂时算不出配对提升。让同一批人两卷都做一遍，报告才有意义。');
    }

    if (agg.weak.length) {
      out.push('');
      out.push('全班最集中的三个卡点：');
      agg.weak.forEach(function (d, i) {
        var line = (i + 1) + '. ' + d.topicName + '（' + formLabel(d.form) + '的 ' + d.id +
          ' 类题型）正确率 ' + d.percent + '%（' +
          d.t.correct + '/' + d.t.total + '）';
        if (d.topWrong) {
          line += '；最常见的错法是选「' + d.topWrong.text + '」，' + d.topWrong.count + ' 个人这么选';
        }
        out.push(line);
      });
    }
    return out;
  }

  // 班级汇总表：先概览，再知识点，再逐题。一次导出，交给教研组也够看。
  function csvCell(s) {
    return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  }

  function summaryCSV(agg) {
    var L = [];
    L.push(['班级汇总'].map(csvCell).join(','));
    L.push(['收到份数', agg.n, '人数', agg.nStudents, '没填代号', agg.anonymous].join(','));
    Object.keys(agg.forms).forEach(function (k) {
      var f = agg.forms[k];
      L.push([formLabel(k) + '份数', f.n, '平均正确率', f.percent + '%',
        '平均用时(秒)', (f.avgMs / 1000).toFixed(1)].join(','));
    });
    if (agg.pairStat) {
      L.push(['配对人数', agg.pairStat.n, '前测均值', agg.pairStat.avgPre + '%',
        '后测均值', agg.pairStat.avgPost + '%', '提升(百分点)', agg.pairStat.delta].join(','));
    } else {
      L.push(['配对人数', 0, '（没有人前后测都做过，算不出配对提升）'].join(','));
    }

    L.push('');
    L.push(['知识点', '前测', '后测', '提升', '前测题次', '后测题次'].join(','));
    agg.topicRows.forEach(function (d) {
      L.push([csvCell(d.name),
        d.pre.total ? d.pre.percent + '%' : '-',
        d.post.total ? d.post.percent + '%' : '-',
        d.delta == null ? '-' : d.delta,
        d.pre.total, d.post.total].join(','));
    });

    L.push('');
    L.push(['卷别', '题型', '知识点', '题次', '正确', '正确率', '最常见的错法', '人数'].join(','));
    agg.typeRows.forEach(function (d) {
      L.push([csvCell(formLabel(d.form)), csvCell(d.id), csvCell(d.topicName),
        d.t.total, d.t.correct, d.percent + '%',
        csvCell(d.topWrong ? d.topWrong.text : ''), d.topWrong ? d.topWrong.count : 0].join(','));
    });
    return L.join('\n');
  }

  NS.teacher = {
    LEVEL_LIST: LEVEL_LIST,
    LEVEL: LEVEL,
    LEVEL_OF: LEVEL_OF,
    BLUEPRINT: BLUEPRINT,
    select: select,
    inventory: inventory,
    make: make,
    aggregate: aggregate,
    diagnosis: diagnosis,
    summaryCSV: summaryCSV,
    genIdOf: genIdOf,
    sigOf: sigOf
  };
}(window.SignalLab));
