/* 教师端冒烟测试：不碰 DOM。
 *
 * 分两块：
 *   出练习，筛选题型、去重、层次与知识点配额是不是真的按说的来。
 *   看全班，拿四个编好的学生成绩单，验证聚合出来的每一个数都能手算出来。
 *
 * 第二块是重点：报告里最容易出错的地方不是「跑不跑得起来」，而是
 * 「配对的平均提升」算成了「前后测所有人的平均分相减」， 那在
 * 做前测和后测的人不一样时会给出完全错误的结论。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = 'D:/srtp/EM-benchmark/em-signal-lab/app/js';
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
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '   ' + detail); }
}

// ---------------------------------------------------------------
console.log('\n[1] 题型目录与层次');
{
  check('三个层次', T.LEVEL_LIST.length === 3,
    T.LEVEL_LIST.map(l => l.key + '=' + l.name).join(' '));
  check('层次字段齐全', T.LEVEL_LIST.every(l => l.key && l.name && l.hint));

  const ids = T.BLUEPRINT.map(b => b.id);
  check('题型 id 唯一', new Set(ids).size === ids.length, 'n=' + ids.length);

  const badTopic = T.BLUEPRINT.filter(b => !Q.TOPICS[b.topic]);
  check('题型的知识点都在 Q.TOPICS 里', badTopic.length === 0,
    badTopic.map(b => b.id + ':' + b.topic).join(','));

  const badLvl = T.BLUEPRINT.filter(b => !T.LEVEL[b.level]);
  check('题型的层次都是 1/2/3', badLvl.length === 0,
    badLvl.map(b => b.id + ':' + b.level).join(','));

  const badName = T.BLUEPRINT.filter(b => !b.topicName);
  check('题型都带中文知识点名', badName.length === 0, badName.map(b => b.id).join(','));

  const badGen = T.BLUEPRINT.filter(b => typeof b.gen !== 'function');
  check('题型都有出题函数', badGen.length === 0, badGen.map(b => b.id).join(','));

  // 三个层次都要有题，否则「分层」是空的
  [1, 2, 3].forEach(l => {
    const n = T.BLUEPRINT.filter(b => b.level === l).length;
    check('层次 ' + l + '（' + T.LEVEL[l].name + '）有题', n > 0, 'n=' + n);
  });
}

console.log('\n[2] 筛选与库存');
{
  check('不筛 = 全部题型', T.select({}).length === T.BLUEPRINT.length);

  const onlyArr = T.select({ topics: ['array'] });
  check('按知识点筛得住', onlyArr.length > 0 && onlyArr.every(b => b.topic === 'array'),
    'n=' + onlyArr.length);

  const only3 = T.select({ levels: [3] });
  check('按层次筛得住', only3.length > 0 && only3.every(b => b.level === 3),
    'n=' + only3.length);

  const both = T.select({ topics: ['sampling'], levels: [2] });
  check('知识点 + 层次是交集', both.every(b => b.topic === 'sampling' && b.level === 2),
    'n=' + both.length);

  const empty = T.select({ topics: ['不存在的知识点'] });
  check('筛不到就是空的', empty.length === 0);
  check('筛不到时库存为 0', T.inventory({ topics: ['不存在的知识点'] }) === 0);

  const all = T.inventory({});
  const sub = T.inventory({ topics: ['array'] });
  check('子集库存不超过全集', sub <= all, sub + ' <= ' + all);
  check('全集能出的题够一份卷子', all >= 8, 'n=' + all);
}

console.log('\n[3] 出练习的基本契约');
{
  const ex = T.make({ count: 8, seed: 20261015 });

  check('题数对', ex.count === 8 && ex.questions.length === 8, 'n=' + ex.count);
  check('没被截短', ex.short === false);
  check('报出了想要的题数', ex.wanted === 8);
  check('qid 唯一', new Set(ex.questions.map(q => q.qid)).size === 8);

  // 同一套数字的题一份卷子里只出一遍，不然学生做两道一模一样的题
  const sigs = ex.questions.map(q => T.sigOf(q));
  check('没有重题（同一套数字只出一遍）', new Set(sigs).size === 8);

  const t = T.LEVEL;
  let structOk = true, why = '';
  for (const q of ex.questions) {
    if (!q.stem || q.stem.length < 8) { structOk = false; why = q.qid + ' 题干太短'; break; }
    if (!Array.isArray(q.choices) || q.choices.length < 3) { structOk = false; why = q.qid + ' 选项不足 3 个'; break; }
    if (!(q.answer >= 0 && q.answer < q.choices.length)) { structOk = false; why = q.qid + ' answer 越界'; break; }
    if (new Set(q.choices).size !== q.choices.length) { structOk = false; why = q.qid + ' 选项有重复'; break; }
    if (!q.explain || q.explain.length < 10) { structOk = false; why = q.qid + ' 缺解析'; break; }
    if (!q.topicName) { structOk = false; why = q.qid + ' 缺知识点名'; break; }
    if (!t[q.level]) { structOk = false; why = q.qid + ' 层次非法 ' + q.level; break; }
    if (q.levelName !== t[q.level].name) { structOk = false; why = q.qid + ' 层次名对不上'; break; }
    if (q.form !== 'ex') { structOk = false; why = q.qid + ' form 不是 ex'; break; }
    if (q.qid.indexOf('ex-') !== 0) { structOk = false; why = q.qid + ' qid 前缀不对'; break; }
  }
  check('每题题干/选项/答案/解析/知识点/层次都齐全', structOk, why);

  check('qid 能从 genIdOf 反解回题型 id',
    ex.questions.every(q => T.BLUEPRINT.some(b => b.id === T.genIdOf(q.qid))),
    ex.questions.map(q => T.genIdOf(q.qid)).join(','));

  const sumTopic = Object.keys(ex.byTopic).reduce((s, k) => s + ex.byTopic[k], 0);
  const sumLevel = Object.keys(ex.byLevel).reduce((s, k) => s + ex.byLevel[k], 0);
  check('byTopic 合计等于题数', sumTopic === 8, JSON.stringify(ex.byTopic));
  check('byLevel 合计等于题数', sumLevel === 8, JSON.stringify(ex.byLevel));

  const tallyTopic = {};
  ex.questions.forEach(q => { tallyTopic[q.topic] = (tallyTopic[q.topic] || 0) + 1; });
  check('byTopic 和实际题目一致', JSON.stringify(tallyTopic) === JSON.stringify(ex.byTopic));

  // 穷举一批 seed：不管掷到哪组数字，每道题都得有至少 3 个选项。
  // （干扰项跟正确答案撞车会被去重，曾经真出过只有两个选项的题。）
  let thin = null, minC = 99;
  for (let s = 1; s <= 60 && !thin; s++) {
    const e2 = T.make({ count: 10, seed: s * 7919 });
    for (const q of e2.questions) {
      minC = Math.min(minC, q.choices.length);
      if (q.choices.length < 3 || new Set(q.choices).size !== q.choices.length) {
        thin = 'seed=' + s + ' ' + q.qid + ' n=' + q.choices.length;
        break;
      }
    }
  }
  check('60 个 seed × 10 题都不出现少于 3 个选项的题', thin === null,
    thin || '最少选项数=' + minC);
}

console.log('\n[4] 出练习尊重筛选');
{
  const arr = T.make({ topics: ['array'], count: 5, seed: 7 });
  check('只要阵列知识点', arr.questions.length > 0 && arr.questions.every(q => q.topic === 'array'),
    arr.questions.map(q => q.topic).join(','));

  const lvl3 = T.make({ levels: [3], count: 4, seed: 8 });
  check('只要挑战层', lvl3.questions.length > 0 && lvl3.questions.every(q => q.level === 3),
    lvl3.questions.map(q => q.levelName).join(','));

  const lvl12 = T.make({ levels: [1, 2], count: 6, seed: 9 });
  check('基础 + 进阶两层', lvl12.questions.every(q => q.level === 1 || q.level === 2),
    lvl12.questions.map(q => q.levelName).join(','));

  let threw = false;
  try { T.make({ topics: ['不存在的知识点'], count: 5 }); } catch (e) { threw = true; }
  check('筛不到题型时明确报错，而不是出空卷', threw);
}

console.log('\n[5] 种子可复现');
{
  const a = T.make({ count: 6, seed: 31415 });
  const b = T.make({ count: 6, seed: 31415 });
  check('同一个 seed 出同一份卷子',
    a.questions.map(q => q.stem).join('|') === b.questions.map(q => q.stem).join('|'),
    'seed=' + a.seed);
  check('同一个 seed 连选项都一样',
    JSON.stringify(a.questions.map(q => q.choices)) === JSON.stringify(b.questions.map(q => q.choices)));

  const c = T.make({ count: 6, seed: 27182 });
  check('换 seed 换卷子',
    a.questions.map(q => q.stem).join('|') !== c.questions.map(q => q.stem).join('|'));

  check('seed 是正整数', Number.isInteger(a.seed) && a.seed > 0, String(a.seed));
}

console.log('\n[6] 题量超过库存时不硬凑');
{
  // 「挑战层」题型少，要 40 道必然凑不满。
  const ex = T.make({ levels: [3], count: 40, seed: 1 });
  check('凑不满时 count 小于 wanted', ex.count < ex.wanted, ex.count + ' < ' + ex.wanted);
  check('凑不满时 short 为真', ex.short === true);
  check('凑不满时仍然没有重题',
    new Set(ex.questions.map(q => T.sigOf(q))).size === ex.count);
  check('凑不满时也没有超过库存',
    ex.count <= T.inventory({ levels: [3] }), ex.count + ' <= ' + T.inventory({ levels: [3] }));
}

console.log('\n[7] 看全班：四个学生的编造成绩单');
{
  const pre = Q.build('pre');
  const post = Q.build('post');

  const allRight = qs => qs.map(q => q.answer);
  const allWrong = qs => qs.map(q => (q.answer + 1) % q.choices.length);
  const halfRight = qs => qs.map((q, i) => (i % 2 === 0 ? q.answer : (q.answer + 1) % q.choices.length));

  function rec(form, who, mk) {
    const qs = form === 'pre' ? pre : post;
    return {
      form, who, ms: 60000,
      startedAt: 1750000000000, finishedAt: '2026-10-15 10:00',
      score: Q.grade(qs, mk(qs))
    };
  }

  const records = [
    rec('pre', '甲', allRight),
    rec('post', '甲', allRight),
    rec('pre', '乙', allWrong),
    rec('post', '乙', allRight),
    rec('pre', '丙', halfRight),
    rec('pre', '', allWrong)
  ];

  check('前置：前测 10 题', pre.length === 10);
  check('前置：后测 10 题', post.length === 10);
  check('前置：五块知识点各 2 题',
    Object.keys(Q.TOPICS).every(t => pre.filter(q => q.topic === t).length === 2),
    JSON.stringify(Object.keys(Q.TOPICS).map(t => t + ':' + pre.filter(q => q.topic === t).length)));

  const agg = T.aggregate(records);

  check('收到 6 份（4 个人，其中 2 人两卷都做了）', agg.n === 6, 'n=' + agg.n);
  check('参与代号 3 人（匿名的那个不算人）', agg.nStudents === 3, 'n=' + agg.nStudents);
  check('匿名份数单独记账', agg.anonymous === 1, 'n=' + agg.anonymous);

  check('前测 4 份', agg.forms.pre.n === 4, 'n=' + agg.forms.pre.n);
  check('后测 2 份', agg.forms.post.n === 2, 'n=' + agg.forms.post.n);
  check('前测平均分 = (10+0+5+0)/40 = 38%', agg.forms.pre.percent === 38, agg.forms.pre.percent + '%');
  check('后测平均分 = 100%', agg.forms.post.percent === 100, agg.forms.post.percent + '%');

  // 这一条是整个教师端最要紧的数
  check('配对人数 = 2（只有甲和乙两卷都做了）', agg.pairStat && agg.pairStat.n === 2,
    agg.pairStat ? 'n=' + agg.pairStat.n : 'null');
  check('配对前测均值 = (100+0)/2 = 50%', agg.pairStat.avgPre === 50, String(agg.pairStat.avgPre));
  check('配对后测均值 = 100%', agg.pairStat.avgPost === 100, String(agg.pairStat.avgPost));
  check('配对提升 = +50 个百分点', agg.pairStat.delta === 50, String(agg.pairStat.delta));
  check('配对提升 ≠ 前后测所有人平均分相减（100-38=62）',
    agg.pairStat.delta !== agg.forms.post.percent - agg.forms.pre.percent,
    agg.pairStat.delta + ' vs ' + (agg.forms.post.percent - agg.forms.pre.percent));

  check('配对明细按提升从小到大排',
    agg.paired.length === 2 && agg.paired[0].delta <= agg.paired[1].delta,
    agg.paired.map(p => p.who + (p.delta >= 0 ? '+' : '') + p.delta).join(' '));

  check('知识点表五块', agg.topicRows.length === 5, 'n=' + agg.topicRows.length);
  check('每块知识点前测 8 题次 / 后测 4 题次',
    agg.topicRows.every(d => d.pre.total === 8 && d.post.total === 4),
    agg.topicRows.map(d => d.name + ':' + d.pre.total + '/' + d.post.total).join(' '));
  check('知识点提升 = 后测 − 前测',
    agg.topicRows.every(d => d.delta === d.post.percent - d.pre.percent));
  check('知识点表按「前后测加起来」从弱到强排',
    agg.topicRows.every((d, i) => i === 0 ||
      (agg.topicRows[i - 1].pre.percent + agg.topicRows[i - 1].post.percent) <=
      (d.pre.percent + d.post.percent)));

  check('逐题表 20 行（前测 10 + 后测 10）', agg.typeRows.length === 20, 'n=' + agg.typeRows.length);
  check('逐题表按正确率从低到高排',
    agg.typeRows.every((d, i) => i === 0 || agg.typeRows[i - 1].percent <= d.percent));
  check('有人做错的题都记下了错法',
    agg.typeRows.filter(d => d.t.correct < d.t.total).every(d => d.topWrong && d.topWrong.count > 0));
  check('全对的题没有错法记录',
    agg.typeRows.filter(d => d.t.correct === d.t.total).every(d => d.topWrong === null));

  check('卡点非空', agg.weak.length > 0, 'n=' + agg.weak.length);
  check('卡点不超过 3 条', agg.weak.length <= 3);
  check('卡点是正确率最低的那几个',
    agg.weak.every(d => d.percent <= 50),
    agg.weak.map(d => d.id + ':' + d.percent + '%').join(' '));
  check('卡点样本量够', agg.weak.every(d => d.t.total >= 2),
    agg.weak.map(d => d.id + ':' + d.t.total).join(' '));

  // 聚合的数字要能对回原始记录：把每一题的 correct 加起来
  const rawCorrect = records.reduce((s, r) => s + r.score.correct, 0);
  const aggCorrect = (agg.forms.pre ? agg.forms.pre.correct : 0) + (agg.forms.post ? agg.forms.post.correct : 0);
  check('聚合的总对题数 = 原始记录加起来', aggCorrect === rawCorrect,
    aggCorrect + ' == ' + rawCorrect);

  const rawRows = records.reduce((s, r) => s + r.score.rows.length, 0);
  const aggRows = agg.typeRows.reduce((s, d) => s + d.t.total, 0);
  check('聚合的题次总数 = 原始记录加起来', aggRows === rawRows, aggRows + ' == ' + rawRows);
}

console.log('\n[8] 看全班：边界');
{
  const empty = T.aggregate([]);
  check('空输入 n=0', empty.n === 0);
  check('空输入配对为 null', empty.pairStat === null);
  check('空输入知识点头为空', empty.topicRows.length === 0);
  check('空输入卡点为空', empty.weak.length === 0);

  check('null 也不炸', T.aggregate(null).n === 0);
  check('乱数据被筛掉',
    T.aggregate([null, {}, { score: {} }, { form: 'pre' }]).n === 0);

  const pre = Q.build('pre');
  const one = {
    form: 'pre', who: '独苗', ms: 1000, finishedAt: 'x',
    score: Q.grade(pre, pre.map(q => q.answer))
  };
  const a1 = T.aggregate([one]);
  check('只做了一份 → 不产生配对', a1.pairStat === null);
  check('只做了一份 → 人数还是 1', a1.nStudents === 1);

  const anon = Object.assign({}, one, { who: '' });
  const a2 = T.aggregate([anon, anon]);
  check('全匿名时人数为 0', a2.nStudents === 0, 'n=' + a2.nStudents);
  check('全匿名时匿名计数为 2', a2.anonymous === 2);
  check('匿名的不参与配对', a2.pairStat === null);
}

console.log('\n[9] 诊断文字与导出');
{
  const pre = Q.build('pre');
  const post = Q.build('post');
  const mk = (form, who, right) => ({
    form, who, ms: 45000, finishedAt: '2026-10-15 09:30',
    score: Q.grade(form === 'pre' ? pre : post,
      (form === 'pre' ? pre : post).map((q, i) => (right || i % 2 === 0) ? q.answer : (q.answer + 1) % q.choices.length))
  });
  const records = [
    mk('pre', 'A', false), mk('post', 'A', true),
    mk('pre', 'B', true), mk('post', 'B', true)
  ];
  const agg = T.aggregate(records);

  const lines = T.diagnosis(agg);
  check('诊断是字符串数组', Array.isArray(lines) && lines.every(l => typeof l === 'string'));
  check('诊断非空', lines.length > 0, 'n=' + lines.length);
  check('诊断里没有 undefined / NaN / Infinity',
    !/undefined|NaN|Infinity/.test(lines.join('\n')),
    lines.join(' | ').slice(0, 160));
  check('诊断提到了配对与提升', lines.some(l => l.indexOf('配对') >= 0 || l.indexOf('提升') >= 0),
    lines.filter(l => l.indexOf('配对') >= 0 || l.indexOf('提升') >= 0).join(' '));

  const csv = T.summaryCSV(agg);
  const rows = csv.split('\n');
  const nonEmpty = rows.filter(r => r.trim().length > 0);
  check('CSV 有表头', rows.length > 1);
  check('CSV 非空行数 ≥ 概览 + 两段表头 + 知识点 + 逐题',
    nonEmpty.length >= 3 + agg.topicRows.length + agg.typeRows.length,
    'nonEmpty=' + nonEmpty.length + ' topics=' + agg.topicRows.length + ' types=' + agg.typeRows.length);
  check('CSV 用空行把三段分开（直接从 Excel 看更清楚）',
    rows.some(r => r.trim() === ''));
  check('CSV 里没有 undefined / NaN', !/undefined|NaN/.test(csv));
  check('CSV 不以空行结尾', csv.trim() === csv && !csv.endsWith('\n\n'));

  // 老师收卷的实际路径：学生导出 → 老师读回来 → 聚合
  const packed = Q.packRecords(records, 'A');
  check('打包出来是合法 JSON', (() => { try { JSON.parse(packed); return true; } catch (e) { return false; } })());

  const back = Q.readRecords([packed]);
  check('读回来 4 份', back.records.length === 4, 'n=' + back.records.length);
  check('读回来没有丢件', back.skipped.length === 0,
    back.skipped.map(s => s.why).join(','));

  // 「合成数据」标记：pilot/make_cohort.js 会往每个文件的顶层写 synthetic: true。
  // 教师端不拦它，但要在报告顶上把这件事说清楚，所以这个数必须能读回来。
  const tagged = (() => {
    const o = JSON.parse(packed);
    o.synthetic = true;
    o.note = '合成数据，非真实学生';
    return JSON.stringify(o);
  })();
  const back2 = Q.readRecords([tagged]);
  check('带「合成」标记的文件照样能读进来',
    back2.records.length === 4 && back2.skipped.length === 0);
  check('标记被单独数出来（synthetic = 1）', back2.synthetic === 1,
    'synthetic=' + back2.synthetic);
  check('普通文件不算合成数据', back.synthetic === 0, 'synthetic=' + back.synthetic);
  check('多份文件里的合成份数会累加',
    Q.readRecords([tagged, tagged, packed]).synthetic === 2);

  const agg2 = T.aggregate(back.records);
  check('读回来聚合出的数字和原来一模一样',
    agg2.n === agg.n && agg2.pairStat.delta === agg.pairStat.delta &&
    agg2.forms.pre.percent === agg.forms.pre.percent,
    JSON.stringify(agg2.pairStat));
}

// ---------------------------------------------------------------
console.log('\n' + (fail ? '✗' : '✓') + ' teacher_smoke: ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
