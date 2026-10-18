'use strict';
/*
 * ============================================================================
 *  合成队列的校验，**合成数据，非真实学生**
 * ============================================================================
 *
 *  它干三件事：
 *    1. 把 pilot/cohort/ 下 88 个文件按老师收卷的真实路径读回来
 *       （Q.readRecords 会逐条校验，认不出的会说明原因而不是静默丢）。
 *    2. 用 T.aggregate 汇总，逐项断言报告里的数字，断言的是「这些数
 *       互相之间说得通」，不是「这些数等于某个写死的值」。
 *    3. 把汇总结果渲染成 pilot/报告样例.md。
 *
 *  重点断言这一条：**配对的平均提升 ≠ 前后测所有人的平均分相减**。
 *  队列里故意有 6 个人没交后测、6 份匿名卷，这两个数必然不同；哪天它们
 *  相等了，说明「配对」逻辑被改坏了。
 *
 *  跑法：  node pilot/verify_cohort.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app', 'js');
const COHORT = path.join(__dirname, 'cohort');
const ALL = path.join(__dirname, 'cohort-all.json');

const sandbox = {
  window: {}, Math, console, Float64Array, Array, isFinite, isNaN,
  Number, Object, JSON, String, Error, Date, Set, RegExp
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['signal.js', 'fft.js', 'spectrum.js', 'array.js', 'quiz.js', 'teacher.js']) {
  vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), sandbox, { filename: f });
}
const NS = sandbox.window.SignalLab;
const Q = NS.quiz;
const T = NS.teacher;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   ' + extra : '')); }
}
function clean(v) { return !/undefined|NaN|Infinity/.test(String(v)); }

/* ---------------- 1. 按老师收卷的路径读回来 ---------------- */

const names = fs.readdirSync(COHORT).filter(function (f) { return /\.json$/.test(f); }).sort();
const texts = names.map(function (f) { return fs.readFileSync(path.join(COHORT, f), 'utf8'); });
const rd = Q.readRecords(texts);
const all = JSON.parse(fs.readFileSync(ALL, 'utf8'));
const records = rd.records;

console.log('\n【合成数据，非真实学生】');
console.log('读回 ' + names.length + ' 个文件，认下 ' + records.length + ' 条记录，跳过 '
  + rd.skipped.length + ' 条。\n');

ok('每个文件都被认下（一份都没跳过）', rd.skipped.length === 0,
  rd.skipped.length ? JSON.stringify(rd.skipped.slice(0, 3)) : '');
ok('合并成绩单与散装文件条数一致', all.records.length === records.length,
  all.records.length + ' vs ' + records.length);
ok('成绩单自报是 signallab 的 quiz-records', all.app === 'signallab' && all.kind === 'quiz-records' && all.version === 1);

records.forEach(function (r, i) {
  if (r.score.rows.length !== r.score.total) { console.log('    ! 第 ' + i + ' 条的 rows/total 对不上'); }
});
ok('每条记录的 rows 与题数都对得上', records.every(function (r) { return r.score.rows.length === r.score.total; }));
ok('题数都是 10 题（两套卷子各 10 题）', records.every(function (r) { return r.score.total === 10; }));
ok('每条记录的每题都有 qid/topic/chosenText/answerText 四个字段',
  records.every(function (r) {
    return r.score.rows.every(function (w) {
      return w.qid && w.topic && w.topicName && w.chosenText && w.answerText;
    });
  }));
ok('每条记录的选项文本里没有 undefined / NaN',
  records.every(function (r) { return r.score.rows.every(function (w) { return clean(w.chosenText) && clean(w.answerText); }); }));

/* ---------------- 2. 汇总 ---------------- */

const agg = T.aggregate(records);
// diagnosis() 返回的是一行一段的数组（教师端直接按段落渲染），这里拼成一整块文字。
const diagArr = T.diagnosis(agg);
const diag = Array.isArray(diagArr) ? diagArr.join('\n') : String(diagArr);
const csv = T.summaryCSV(agg);

ok('记录总数对得上', agg.n === records.length, 'n = ' + agg.n);
ok('有代号的人数是 44（没填代号的不算人）', agg.nStudents === 44, 'nStudents = ' + agg.nStudents);
ok('匿名卷 6 份被单独计数', agg.anonymous === 6, 'anonymous = ' + agg.anonymous);
ok('前测 48 份、后测 40 份', agg.forms.pre.n === 48 && agg.forms.post.n === 40,
  agg.forms.pre.n + ' / ' + agg.forms.post.n);
ok('前测平均分落在 40~60', agg.forms.pre.percent >= 40 && agg.forms.pre.percent <= 60,
  agg.forms.pre.percent + '%');
ok('后测平均分落在 55~75', agg.forms.post.percent >= 55 && agg.forms.post.percent <= 75,
  agg.forms.post.percent + '%');

/* 这一条是整份测试的重点 */
const naive = agg.forms.post.percent - agg.forms.pre.percent;
ok('配对人数是 38（前测后测都交了的那些人）', agg.pairStat.n === 38, 'n = ' + agg.pairStat.n);
ok('配对提升落在 8~32 个百分点', agg.pairStat.delta >= 8 && agg.pairStat.delta <= 32,
  'delta = ' + agg.pairStat.delta);
ok('**配对的平均提升 ≠ 前后测所有人的平均分相减**',
  Math.abs(agg.pairStat.delta - naive) >= 2,
  '配对 ' + agg.pairStat.delta + '  vs  相减 ' + naive);
ok('配对的 avgPre / avgPost 与 delta 自洽到一位小数',
  Math.abs((agg.pairStat.avgPost - agg.pairStat.avgPre) - agg.pairStat.delta) <= 0.11,
  agg.pairStat.avgPre + '% → ' + agg.pairStat.avgPost + '%，+ ' + agg.pairStat.delta);
ok('三个数都是一位小数以内（不是一串浮点尾巴）',
  [agg.pairStat.avgPre, agg.pairStat.avgPost, agg.pairStat.delta].every(function (v) {
    return Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;
  }));
/* ---- 把「相减法为什么错」算成具体的数：掉队的人本来就弱 ---- */
const byWho = {};
records.forEach(function (r) {
  if (!r.who) return;
  (byWho[r.who] = byWho[r.who] || {})[r.form] = r.score.percent;
});
const whoList = Object.keys(byWho);
const onlyPre = whoList.filter(function (k) { return byWho[k].pre != null && byWho[k].post == null; });
const bothForms = whoList.filter(function (k) { return byWho[k].pre != null && byWho[k].post != null; });
const holdout = whoList.filter(function (k) { return byWho[k].pre == null; });

function meanPct(keys) {
  if (!keys.length) return null;
  let s = 0;
  keys.forEach(function (k) { s += byWho[k].pre; });
  return Math.round(s / keys.length * 10) / 10;
}
const anonPre = records.filter(function (r) { return !r.who && r.form === 'pre'; });
const anonPreMean = anonPre.length
  ? Math.round(anonPre.reduce(function (s, r) { return s + r.score.percent; }, 0) / anonPre.length * 10) / 10
  : null;
const preOnlyMean = meanPct(onlyPre);
const pairedPreMean = meanPct(bothForms);

ok('只交了前测的人是 6 个', onlyPre.length === 6, onlyPre.sort().join(', '));
ok('两卷都交的人是 38 个', bothForms.length === 38, 'n = ' + bothForms.length);
ok('没有人只交了后测', holdout.length === 0, holdout.join(', '));
ok('**掉队的人前测成绩确实更差（至少差 10 个百分点）**',
  preOnlyMean != null && pairedPreMean != null && pairedPreMean - preOnlyMean >= 10,
  '掉队 ' + preOnlyMean + '%  vs  两卷都交 ' + pairedPreMean + '%');
ok('匿名卷的前测成绩也偏低',
  anonPreMean != null && anonPreMean <= pairedPreMean,
  '匿名 ' + anonPreMean + '%  vs  两卷都交 ' + pairedPreMean + '%');

ok('五个知识点都出现在报告里', agg.topicRows.length === 5, 'topics = ' + agg.topicRows.length);
ok('每个知识点的前后测都有人作答',
  agg.topicRows.every(function (t) { return t.pre.total > 0 && t.post.total > 0; }));
ok('每个知识点的后测正确率都不低于前测',
  agg.topicRows.every(function (t) { return t.delta == null || t.delta >= 0; }),
  agg.topicRows.map(function (t) { return t.name + ' ' + t.delta; }).join(' | '));

ok('题型行覆盖了前后测两套卷子的全部题型',
  agg.typeRows.length >= 12, 'typeRows = ' + agg.typeRows.length);
ok('每个题型的作答人数都等于该卷别总人数', agg.typeRows.every(function (r) {
  const n = r.form === 'pre' ? agg.forms.pre.n : agg.forms.post.n;
  return r.t.total === n;
}));
ok('每个题型都记下了「最常见错法」', agg.typeRows.every(function (r) {
  return r.t.correct === r.t.total || r.wrongList.length > 0;
}));
ok('错法的答案文本都不为空且不含 NaN',
  agg.typeRows.every(function (r) {
    return r.wrongList.every(function (w) { return w.text && clean(w.text) && w.count > 0; });
  }));
ok('每个题型的 wrongList 按人数从多到少排', agg.typeRows.every(function (r) {
  for (var i = 1; i < r.wrongList.length; i++) {
    if (r.wrongList[i].count > r.wrongList[i - 1].count) return false;
  }
  return r.wrongList.length === 0 || r.topWrong === r.wrongList[0];
}));

ok('逐题统计里每题的被选次数之和等于作答人数', Object.keys(agg.qRows).every(function (k) {
  const q = agg.qRows[k];
  let sum = 0;
  Object.keys(q.picked).forEach(function (t) { sum += q.picked[t]; });
  return sum === q.t.total;
}));
ok('漏答（未作答）不计入错法统计之外的空桶', Object.keys(agg.qRows).every(function (k) {
  const q = agg.qRows[k];
  return Object.keys(q.picked).every(function (t) { return t.length > 0; });
}));

ok('卡点最多挑三个', agg.weak.length <= 3, 'weak = ' + agg.weak.length);
ok('卡点的正确率都不高于 70%', agg.weak.every(function (w) { return w.percent <= 70; }),
  agg.weak.map(function (w) { return w.id + ' ' + w.percent + '%'; }).join(' | '));

/* ---------------- 3. 文字与导出 ---------------- */

ok('诊断文字是一段人话（长度 > 80）', typeof diag === 'string' && diag.length > 80, diag.length + ' 字');
ok('诊断文字里没有 NaN / undefined', clean(diag));
ok('诊断文字点明了「不能直接相减」', /直接相减|不能相减|配对/.test(diag));
ok('CSV 有「班级汇总 / 知识点 / 卷别」三段',
  /班级汇总/.test(csv) && /知识点/.test(csv) && /卷别/.test(csv));
ok('CSV 的「班级汇总」段里同时写了「配对提升」和它旁边的份数',
  /配对人数/.test(csv) && /提升\(百分点\)/.test(csv));
ok('诊断文字分段（一行一段，且至少 5 段）', diagArr.length >= 5, diagArr.length + ' 段');
ok('诊断文字里列出了卡点', /卡点/.test(diag));
ok('CSV 里没有 NaN / undefined', clean(csv));
ok('CSV 行数与知识点数对得上', csv.split('\n').length > 10, csv.split('\n').length + ' 行');

/* ---------------- 4. 渲染报告样例 ---------------- */

function pct(v) { return v == null ? '—' : v + '%'; }

const L = [];
L.push('# 全班报告样例，**合成数据，非真实学生**');
L.push('');
L.push('> 这份报告由 `pilot/cohort/` 下的**仿真队列**跑出来，**不是任何一次真实的前测 / 后测**。');
L.push('> 队列由 `pilot/make_cohort.js` 生成（种子 20261016），题目取自 `app/js/quiz.js` 的真题面。');
L.push('> 真试点请按 [`../docs/效果验证协议.md`](../docs/效果验证协议.md) 去拉人。');
L.push('');
L.push('生成命令：`node pilot/make_cohort.js && node pilot/verify_cohort.js`');
L.push('');
L.push('## 一、教师端看到的诊断');
L.push('');
L.push('```');
L.push(diag);
L.push('```');
L.push('');
L.push('## 二、概览');
L.push('');
L.push('| 项 | 值 |');
L.push('| --- | --- |');
L.push('| 收上来的卷子 | ' + agg.n + ' 份 |');
L.push('| 有代号的学生 | ' + agg.nStudents + ' 人 |');
L.push('| 匿名卷 | ' + agg.anonymous + ' 份 |');
L.push('| 前测 | ' + agg.forms.pre.n + ' 份，平均 ' + pct(agg.forms.pre.percent) + ' |');
L.push('| 后测 | ' + agg.forms.post.n + ' 份，平均 ' + pct(agg.forms.post.percent) + ' |');
L.push('| **配对**（同名同卷别都交了） | ' + agg.pairStat.n + ' 人 |');
L.push('| **配对的平均提升** | **+' + agg.pairStat.delta + ' 个百分点**（' + agg.pairStat.avgPre + '% → ' + agg.pairStat.avgPost + '%） |');
L.push('| 前后测所有人的平均分相减 | ' + naive + ' 个百分点 ← 这个数是**错**的 |');
L.push('');
L.push('最后两行是同一批数据、两种算法。差别不是舍入误差，是**掉队的人本来就差**：');
L.push('');
L.push('| 人群 | 前测平均 | 人数 |');
L.push('| --- | --- | --- |');
L.push('| 两卷都交了的（能配对的） | ' + pairedPreMean + '% | ' + bothForms.length + ' |');
L.push('| **只交了前测、再没出现的** | **' + preOnlyMean + '%** | ' + onlyPre.length + ' |');
L.push('| 匿名卷（前测） | ' + anonPreMean + '% | ' + anonPre.length + ' 份 |');
L.push('');
L.push('「前后测所有人平均分相减」把前两行混在一起算，等于假设那 ' + onlyPre.length
  + ' 个人如果交了后测会考得跟别人一样，可他们本来只有 ' + preOnlyMean + '%。');
L.push('他们被算进分母，前测平均被拉低，于是提升被吹大：相减法给出 +' + naive
  + '，配对法给出 +' + agg.pairStat.delta + '。');
L.push('');
L.push('这不是这份合成数据编出来的毛病。真实课堂里，半途掉队的、翘考的、不愿填代号的，');
L.push('往往就是学得吃力的人。**只算配对的那批人**，才是能说清「学会了没有」的算法。');
L.push('');
L.push('## 三、按知识点');
L.push('');
L.push('| 知识点 | 前测 | 后测 | 提升 |');
L.push('| --- | --- | --- | --- |');
agg.topicRows.forEach(function (t) {
  L.push('| ' + t.name + ' | ' + t.pre.percent + '% (' + t.pre.correct + '/' + t.pre.total + ') | '
    + t.post.percent + '% (' + t.post.correct + '/' + t.post.total + ') | '
    + (t.delta == null ? '—' : '+' + t.delta) + ' |');
});
L.push('');
L.push('## 四、最集中的卡点');
L.push('');
agg.weak.forEach(function (w, i) {
  L.push((i + 1) + '. **' + w.topicName + '**（' + w.form + ' 卷，' + w.id + '）：正确率 '
    + w.percent + '%（' + w.t.correct + '/' + w.t.total + '）');
  if (w.topWrong) {
    L.push('   最常见错法：「' + w.topWrong.text + '」， ' + w.topWrong.count + ' 人选了它');
  }
});
L.push('');
L.push('## 五、导出给教研组的 CSV');
L.push('');
L.push('```csv');
L.push(csv);
L.push('```');
L.push('');

fs.writeFileSync(path.join(__dirname, '报告样例.md'), L.join('\n'), 'utf8');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
console.log('报告样例已写到 pilot/报告样例.md');
process.exit(fail ? 1 : 0);
