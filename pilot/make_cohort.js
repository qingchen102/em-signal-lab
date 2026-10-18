'use strict';
/*
 * ============================================================================
 *  合成学生队列生成器，**合成数据，非真实学生**
 * ============================================================================
 *
 *  这是一份用来「把教师端的报告页演示得像真的」的假数据。
 *  它不来自任何一次真实的前测 / 后测，**不能当成试点结果引用**。
 *  真试点要按 docs/效果验证协议.md 去拉人跑。
 *
 *  怎么造得像：
 *    · 题干从 app/js/quiz.js 真的 build('pre') / build('post') 跑出来，不手写。
 *    · 每个人有一个基线能力 + 五个知识点各自的偏差，所以没人全对也没人全错。
 *    · 后测提升按「回归均值」给：弱项提得多，强项封顶。
 *    · 每道题预先定一个「最诱人的错项」，七成错答落在它上面 ，
 *      真实的班级就是这样，大家爱往同一个坑里掉。教师端的「最常见错法」
 *      统计只有在这种分布下才有东西可看。
 *    · 每道题有一个按生成器 id 共享的难度偏移。锚题在前后测里是同一个 id，
 *      于是它们在两套卷子上拿到同一个偏移，这正是「锚题把难度连起来」的意思。
 *
 *  故意留的边界情况（教师端不处理这些就会得出错误结论）：
 *    · 6 个人只做了前测、没交后测（而且这 6 个人本来就偏弱，掉队不是随机的）
 *    · 4 份匿名卷（没填代号）
 *    · 2 个人前后测同分
 *  有了这些，「配对的平均提升」和「前后测所有人的平均分相减」才会给出
 *  两个不同的数，后者会把掉队者的低分算进前测，把提升吹大。
 *
 *  跑法：  node pilot/make_cohort.js
 *  产物：  pilot/cohort/<代号>-<卷别>.json   一人一卷一个文件（模拟学生一个个交上来）
 *          pilot/cohort-all.json            合并成一份（模拟老师收了整个班）
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app', 'js');
const OUT = path.join(__dirname, 'cohort');

const SEED = 20261016;
const TOPICS = ['timedomain', 'sampling', 'spectrum', 'instrument', 'array'];

/* ---- 把 app/js 里的模块装进 vm（和 app/test 里一样的做法，不碰 DOM）---- */
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

/* ---- 随机数：用 app 自己的 mulberry32，保证同一颗种子永远长出同一批人 ---- */
const rnd = NS.signal.mulberry32(SEED);
function uniform() { return rnd(); }
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = uniform();
  while (v === 0) v = uniform();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pick(arr) { return arr[Math.floor(uniform() * arr.length)]; }

/* ---- 两套卷子 ---- */
const PAPERS = { pre: Q.build('pre'), post: Q.build('post') };

/* 每题一个难度偏移，按生成器 id 共享（锚题的 id 在两卷里相同，所以值也相同） */
const DIFF = {};
['pre', 'post'].forEach(function (form) {
  PAPERS[form].forEach(function (q) {
    const gid = T.genIdOf(q.qid);
    if (DIFF[gid] === undefined) DIFF[gid] = clamp(gauss() * 0.13, -0.35, 0.35);
  });
});

/* 每道题的「最诱人的错项」 */
const POPULAR = {};
['pre', 'post'].forEach(function (form) {
  PAPERS[form].forEach(function (q) {
    POPULAR[q.qid] = (q.answer + 1) % q.choices.length;
  });
});

/* ---- 一个人 ----
 *  idx 给这个人一条独立的随机流。必须这样：只要全班共用一条流，调一下
 *  某个人的参数（比如给掉队者加个能力平移），后面所有人的抽样次序就被
 *  搅乱了，整个队列重洗，那样就没法把「掉队者偏弱」和「抽样噪声」
 *  分开看。
 *
 *  bias 是「这个人本来就弱一些」的平移量。交作业半路掉队的人、连代号
 *  都懒得填的人，平均而言是吃力的人，让他们跟全班同分布，
 *  「前后测所有人平均分相减」就不会偏，那个演示也就没意思了。
 */
function makeStudent(idx, bias) {
  const rnd = NS.signal.mulberry32((SEED ^ ((idx + 1) * 2654435761)) >>> 0);
  function u() { return rnd(); }
  function g() {
    let a = 0, b = 0;
    while (a === 0) a = u();
    while (b === 0) b = u();
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
  }
  function pickOf(arr) { return arr[Math.floor(u() * arr.length)]; }

  const base = clamp(0.50 + (bias || 0) + g() * 0.15, 0.15, 0.88);
  const topicOff = {};
  TOPICS.forEach(function (t) { topicOff[t] = g() * 0.17; });
  const k = clamp(0.32 + g() * 0.11, 0.05, 0.60);   // 学习增益系数

  const aPre = {}, aPost = {};
  TOPICS.forEach(function (t) {
    aPre[t] = clamp(base + topicOff[t], 0.05, 0.97);
    aPost[t] = clamp(aPre[t] + (1 - aPre[t]) * k, 0.05, 0.995);
  });

  function answer(form) {
    const qs = PAPERS[form];
    const ability = form === 'post' ? aPost : aPre;
    return qs.map(function (q) {
      const gid = T.genIdOf(q.qid);
      const p = clamp(ability[q.topic] + (DIFF[gid] || 0), 0.02, 0.98);
      if (u() < p) return q.answer;
      if (u() < 0.7) return POPULAR[q.qid];          // 七成落进那个坑
      const others = [];
      for (let i = 0; i < q.choices.length; i++) if (i !== q.answer) others.push(i);
      return pickOf(others);
    });
  }

  return { base, aPre, aPost, answer };
}

/* 把一份答案硬掰成指定的正确题数（用来造「前后测同分」） */
function forceScore(form, answers, target) {
  const qs = PAPERS[form];
  const a = answers.slice();
  let cur = 0;
  qs.forEach(function (q, i) { if (a[i] === q.answer) cur++; });
  let guard = 0;
  while (cur > target && guard++ < 200) {
    for (let i = 0; i < qs.length && cur > target; i++) {
      if (a[i] === qs[i].answer) {
        const pop = POPULAR[qs[i].qid];
        a[i] = pop !== qs[i].answer ? pop : (qs[i].answer + 1) % qs[i].choices.length;
        cur--;
      }
    }
  }
  while (cur < target && guard++ < 400) {
    for (let i = 0; i < qs.length && cur < target; i++) {
      if (a[i] !== qs[i].answer) { a[i] = qs[i].answer; cur++; }
    }
  }
  return a;
}

/* ---- 排课表：前测 10-17 下午，后测 10-20 下午 ---- */
const PRE_DAY = Date.UTC(2026, 9, 17, 6, 0, 0);    // 2026-10-17 14:00 +08:00
const POST_DAY = Date.UTC(2026, 9, 20, 6, 0, 0);   // 2026-10-20 14:00 +08:00

const RECORDS = [];

function addRecord(who, form, answers, when) {
  const ms = Math.round(3.5 * 60000 + uniform() * 8.5 * 60000);   // 3.5 ~ 12 分钟
  const score = Q.grade(PAPERS[form], answers);
  RECORDS.push({
    form: form,
    who: who,
    ms: ms,
    startedAt: new Date(when).toISOString(),
    finishedAt: new Date(when + ms).toISOString(),
    score: score
  });
}

/* ---- 44 个有代号的人：38 个交了两卷，6 个只交了前测 ---- */
const NAMED = 44;
const PRETEST_ONLY = 6;
// 掉队者和匿名者本来就偏弱。这两个数是整份演示的「劲度」：
// 它们越大，「前后测所有人平均分相减」就把提升吹得越狠。
const DROPOUT_BIAS = -0.28;
const ANON_WEAK_BIAS = -0.18;
const SAME_SCORE = [7, 23];        // 这两个人前后测同分（下标从 0 起）

function pad2(n) { return (n < 10 ? '0' : '') + n; }

for (let i = 0; i < NAMED; i++) {
  // 前 PRETEST_ONLY 个人就是那批掉队的，本来就是吃力的学生。
  // 这正是真实队列里的幸存者偏差：掉队不是抛硬币，是有原因的。
  const stu = makeStudent(i, i < PRETEST_ONLY ? DROPOUT_BIAS : 0);
  const who = 'S' + pad2(i + 1);
  const preAns = stu.answer('pre');
  addRecord(who, 'pre', preAns, PRE_DAY + i * 47000 + Math.round(uniform() * 900000));

  if (i < PRETEST_ONLY) continue;          // 这 6 个人没交后测

  let postAns = stu.answer('post');
  if (SAME_SCORE.indexOf(i) >= 0) {
    let preCorrect = 0;
    PAPERS.pre.forEach(function (q, k) { if (preAns[k] === q.answer) preCorrect++; });
    postAns = forceScore('post', postAns, preCorrect);
  }
  addRecord(who, 'post', postAns, POST_DAY + i * 41000 + Math.round(uniform() * 900000));
}

/* ---- 4 份匿名卷：2 份只有前测，2 份前后测都交了 ---- */
for (let i = 0; i < 4; i++) {
  // 前两份是匿名且只交了前测的人，同样偏弱。
  const stu = makeStudent(1000 + i, i < 2 ? ANON_WEAK_BIAS : 0);
  const preAns = stu.answer('pre');
  addRecord('', 'pre', preAns, PRE_DAY + (NAMED + i) * 53000 + Math.round(uniform() * 900000));
  if (i >= 2) addRecord('', 'post', stu.answer('post'), POST_DAY + (NAMED + i) * 61000 + Math.round(uniform() * 900000));
}

/* ---- 落盘 ---- */
RECORDS.sort(function (a, b) { return a.finishedAt < b.finishedAt ? -1 : 1; });

fs.mkdirSync(OUT, { recursive: true });
fs.readdirSync(OUT).forEach(function (f) { fs.unlinkSync(path.join(OUT, f)); });

/* 每个文件都打上「合成」标签。
 * 教师端读入时只用 records 数组，多出来的顶层字段会被忽略，但任何
 * 人用记事本打开一个文件，第一眼就知道这不是真学生。
 */
const SYNTH_TAG = '合成数据，非真实学生（pilot/make_cohort.js 生成）';
function tagged(packed) {
  const o = JSON.parse(packed);
  o.synthetic = true;
  o.note = SYNTH_TAG;
  return JSON.stringify(o, null, 2);
}

const anonSeen = {};
RECORDS.forEach(function (rec) {
  let stem;
  if (rec.who) {
    stem = '合成-' + rec.who + '-' + rec.form;
  } else {
    anonSeen.pre = anonSeen.pre || 0;
    anonSeen.post = anonSeen.post || 0;
    anonSeen[rec.form]++;
    stem = '合成-anon' + anonSeen[rec.form] + '-' + rec.form;
  }
  fs.writeFileSync(path.join(OUT, stem + '.json'), tagged(Q.packRecords([rec], rec.who)), 'utf8');
});

fs.writeFileSync(path.join(__dirname, 'cohort-all.json'), tagged(Q.packRecords(RECORDS, '')), 'utf8');

/* ---- 报个数 ---- */
const pre = RECORDS.filter(function (r) { return r.form === 'pre'; });
const post = RECORDS.filter(function (r) { return r.form === 'post'; });
function avg(rs) {
  if (!rs.length) return 0;
  return Math.round(rs.reduce(function (s, r) { return s + r.score.correct; }, 0) / rs.length / 10 * 1000) / 10;
}

console.log('【合成数据，非真实学生】');
console.log('  文件落盘：' + OUT);
console.log('  记录数 ' + RECORDS.length + '（前测 ' + pre.length + ' / 后测 ' + post.length + '）');
console.log('  有代号的人 ' + NAMED + ' 个，匿名卷 ' + RECORDS.filter(function (r) { return !r.who; }).length + " 份");
console.log('  前测平均正确率 ' + avg(pre) + '%   后测平均正确率 ' + avg(post) + '%');
console.log('  合并成绩单 pilot/cohort-all.json');
