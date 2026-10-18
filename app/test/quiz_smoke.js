/* 题库冒烟测试：不碰 DOM，只验证「答案键是不是真的对」。
 *
 * 这个测试的核心不是「代码能跑」，而是「每道题的正确答案，能不能从题目自己的参数
 * 独立重算出来」。所以每一题都重新算一遍，再和 answer 字段比。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = 'D:/srtp/EM-benchmark/em-signal-lab/app/js';
const sandbox = {
  window: {}, Math, console, Float64Array, Array, isFinite, isNaN,
  Number, Object, JSON, String, Error, Date
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['signal.js', 'fft.js', 'spectrum.js', 'array.js', 'quiz.js']) {
  vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), sandbox, { filename: f });
}
const NS = sandbox.window.SignalLab;
const Q = NS.quiz;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '   ' + detail); }
}

const pre = Q.build('pre');
const post = Q.build('post');

// ---------------------------------------------------------------
console.log('\n[1] 卷子结构');
{
  check('前测 10 题', pre.length === 10, 'n=' + pre.length);
  check('后测 10 题', post.length === 10, 'n=' + post.length);
  const idsPre = pre.map(q => q.id).join(',');
  const idsPost = post.map(q => q.id).join(',');
  check('平行卷：题目类型与顺序完全一致', idsPre === idsPost, idsPre);
  check('qid 唯一', new Set(pre.concat(post).map(q => q.qid)).size === 20);

  let structOk = true, detail = '';
  for (const q of pre.concat(post)) {
    if (!q.stem || q.stem.length < 8) { structOk = false; detail = q.qid + ' 题干太短'; break; }
    if (!q.explain || q.explain.length < 10) { structOk = false; detail = q.qid + ' 缺解析'; break; }
    if (!Array.isArray(q.choices) || q.choices.length < 3) { structOk = false; detail = q.qid + ' 选项不足 3 个'; break; }
    if (!(q.answer >= 0 && q.answer < q.choices.length)) { structOk = false; detail = q.qid + ' answer 越界'; break; }
    if (new Set(q.choices).size !== q.choices.length) { structOk = false; detail = q.qid + ' 选项有重复'; break; }
    if (q.choices[q.answer].indexOf('（未作答）') >= 0) { structOk = false; detail = q.qid + ' 正确答案是占位符'; break; }
    if (!Q.TOPICS[q.topic]) { structOk = false; detail = q.qid + ' 未知知识点 ' + q.topic; break; }
  }
  check('每题都有题干 / 解析 / ≥3 个不重复选项 / answer 合法', structOk, detail);

  const topicsPre = pre.map(q => q.topic).join(',');
  const topicsPost = post.map(q => q.topic).join(',');
  check('平行卷：知识点序列一致', topicsPre === topicsPost, topicsPre);
}

// ---------------------------------------------------------------
console.log('\n[2] 答案键：从题目自己的参数独立重算');
{
  // t1，一屏 = 10 × 时基，里面装 periods 个周期
  const t1 = pre.find(q => q.id === 't1');
  const wantT1 = Q.fmtHz(t1.data.periods / (10 * t1.data.tpd));
  check('t1 频率 = periods / (10 × 时基)', t1.choices[t1.answer] === wantT1,
    '答=' + t1.choices[t1.answer] + ' 期望=' + wantT1);
  check('t1 图上的信号频率和答案一致',
    Math.abs(t1.fig.state.freq - t1.data.f) / t1.data.f < 1e-12,
    'fig.freq=' + t1.fig.state.freq);

  // t2，峰峰值 = 格数 × 档位，峰值 = 一半
  const t2 = pre.find(q => q.id === 't2');
  const wantT2 = Q.fmtV(t2.data.vpd * t2.data.divs / 2);
  check('t2 峰值 = 格数 × 档位 ÷ 2', t2.choices[t2.answer] === wantT2,
    '答=' + t2.choices[t2.answer] + ' 期望=' + wantT2);
  check('t2 图上的振幅和答案一致',
    Math.abs(t2.fig.state.amp - t2.data.amp) < 1e-12, 'fig.amp=' + t2.fig.state.amp);

  // s1，折叠公式
  const s1 = pre.find(q => q.id === 's1');
  const fold = Math.abs(s1.data.f0 - Math.round(s1.data.f0 / s1.data.fs) * s1.data.fs);
  check('s1 折叠频率 = |f0 − round(f0/fs)·fs|', s1.choices[s1.answer] === Q.fmtHz(fold),
    '答=' + s1.choices[s1.answer] + ' 期望=' + Q.fmtHz(fold));
  check('s1 确实发生了混叠（f0 > fs/2）', s1.data.f0 > s1.data.fs / 2,
    'f0=' + s1.data.f0 + ' fs/2=' + s1.data.fs / 2);

  // s2，每周期采样点数
  const s2 = pre.find(q => q.id === 's2');
  const n = Math.round(s2.data.fs / s2.data.f0);
  check('s2 每周期采样点 = fs / f0', s2.choices[s2.answer] === n + ' 个',
    '答=' + s2.choices[s2.answer] + ' 期望=' + n + ' 个');
}

// ---------------------------------------------------------------
console.log('\n[3] 答案键：频谱题，用真算出来的谱去对');
{
  // p1，谱上最左边那根线必须落在答案写的频率上
  const p1 = pre.find(q => q.id === 'p1');
  const model = NS.signal.makeModel(p1.fig.state);
  const spec = NS.fft.harmonicSpectrum(model, p1.fig.state.freq, 1024);
  const lines = spec.bins.filter(b => b.freq > 0 && b.amp > 1e-9).sort((a, b) => a.freq - b.freq);
  const firstFreq = lines.length ? lines[0].freq : 0;
  check('p1 答案 = 谱上第一根线的频率', p1.choices[p1.answer] === Q.fmtHz(firstFreq),
    '答=' + p1.choices[p1.answer] + ' 谱上=' + Q.fmtHz(firstFreq));

  // p2，方波在 2f 处必须真的没有谱线（这才是「偶次谐波为零」）
  const p2 = pre.find(q => q.id === 'p2');
  const m2 = NS.signal.makeModel(p2.fig.state);
  const sp2 = NS.fft.harmonicSpectrum(m2, p2.fig.state.freq, 1024);
  const at2f = sp2.bins.filter(b => Math.abs(b.freq - 2 * p2.data.f) / (2 * p2.data.f) < 0.01);
  const peak = Math.max(...sp2.bins.map(b => b.amp));
  const evenAmp = at2f.length ? Math.max(...at2f.map(b => b.amp)) : 0;
  check('p2 方波在 2f 处的幅度确实是零', evenAmp / peak < 1e-9,
    '2f 幅度=' + evenAmp.toExponential(2) + ' 基波=' + peak.toExponential(2));
  check('p2 正确答案就是「奇次谐波」那条', p2.choices[p2.answer].indexOf('奇次谐波') >= 0,
    p2.choices[p2.answer]);
  // 顺带确认 3f 是有的
  const at3f = sp2.bins.filter(b => Math.abs(b.freq - 3 * p2.data.f) / (3 * p2.data.f) < 0.01);
  const amp3 = at3f.length ? Math.max(...at3f.map(b => b.amp)) : 0;
  check('p2 3f 处确实有谱线', amp3 / peak > 0.2, '3f/基波=' + (amp3 / peak).toFixed(3));
}

// ---------------------------------------------------------------
console.log('\n[4] 答案键：阵列题，用真算出来的谱去对');
{
  // a1，MUSIC 的峰必须落在题目给出的来波方向上
  const a1 = pre.find(q => q.id === 'a1');
  const res = NS.array.simulate({
    M: a1.data.M, spacing: a1.data.spacing, snrDb: 20, sources: a1.data.angles.length,
    angles: a1.data.angles, snapshots: 300, seed: a1.data.seed
  });
  const peaks = res.peaks.music.map(p => p.deg).sort((x, y) => x - y);
  const truth = a1.data.angles.slice().sort((x, y) => x - y);
  const close = peaks.length === truth.length && peaks.every((p, i) => Math.abs(p - truth[i]) < 2.5);
  check('a1 MUSIC 峰位与题目给的方向一致', close,
    '谱峰=[' + peaks.map(v => v.toFixed(1)).join(', ') + '] 真值=[' + truth.join(', ') + ']');

  // 答案文本必须就是那两个方向
  const wantA1 = truth[0] + '° 和 ' + (truth[1] > 0 ? '+' : '') + truth[1] + '°';
  check('a1 答案文本 = 两个来波方向', a1.choices[a1.answer] === wantA1,
    '答=' + a1.choices[a1.answer] + ' 期望=' + wantA1);

  // a2，d=1.0λ 时 −30° 必须真的出现栅瓣
  const a2 = pre.find(q => q.id === 'a2');
  const res2 = NS.array.simulate({
    M: a2.data.M, spacing: a2.data.spacing, snrDb: 20, sources: 1,
    angles: [a2.data.angle], snapshots: 300, seed: a2.data.seed
  });
  const pk2 = res2.peaks.music.map(p => p.deg);
  const hasTrue = pk2.some(d => Math.abs(d - 30) < 2.5);
  const hasGrating = pk2.some(d => Math.abs(d + 30) < 2.5);
  check('a2 +30° 有峰（真值）', hasTrue, '峰=[' + pk2.map(v => v.toFixed(1)).join(', ') + ']');
  check('a2 −30° 也有峰（栅瓣）', hasGrating);
  check('a2 正确答案是「栅瓣」那条', a2.choices[a2.answer].indexOf('栅瓣') >= 0, a2.choices[a2.answer]);

  // 反过来：d=0.5λ 时不该有栅瓣
  const res3 = NS.array.simulate({ M: 8, spacing: 0.5, snrDb: 20, sources: 1, angles: [30], snapshots: 300, seed: 71 });
  const pk3 = res3.peaks.music.map(p => p.deg);
  check('对照：d=0.5λ 时没有栅瓣', !pk3.some(d => Math.abs(d + 30) < 2.5),
    '峰=[' + pk3.map(v => v.toFixed(1)).join(', ') + ']');
}

// ---------------------------------------------------------------
console.log('\n[5] 平行卷：同难度、不同数字');
{
  const anchorIds = Q.ANCHORS;
  const parallelIds = pre.map(q => q.id).filter(id => anchorIds.indexOf(id) < 0);

  const identical = parallelIds.filter(id => {
    const a = pre.find(q => q.id === id), b = post.find(q => q.id === id);
    return a.stem === b.stem &&
           a.choices.join('|') === b.choices.join('|') &&
           a.answer === b.answer;
  });
  check('平行题（' + parallelIds.length + ' 题）前后测没有任何一题完全相同', identical.length === 0,
    identical.length ? '完全相同：' + identical.join(',') : parallelIds.join(','));

  const stemDiffers = parallelIds.filter(id => {
    const a = pre.find(q => q.id === id), b = post.find(q => q.id === id);
    return a.stem !== b.stem;
  });
  check('其中题干换过数字的题 ≥ 4 道（图形题题干本来就一样）', stemDiffers.length >= 4,
    '换过题干的=' + stemDiffers.length + '，图形题=' + (parallelIds.length - stemDiffers.length));

  const diffAnsParallel = parallelIds.filter(id => {
    const a = pre.find(q => q.id === id), b = post.find(q => q.id === id);
    return a.choices[a.answer] !== b.choices[b.answer];
  });
  check('平行题的正确答案文本都不同', diffAnsParallel.length === parallelIds.length,
    diffAnsParallel.length + '/' + parallelIds.length);

  const anchorSame = anchorIds.every(id => {
    const a = pre.find(q => q.id === id), b = post.find(q => q.id === id);
    return !!a && !!b && a.stem === b.stem && a.choices[a.answer] === b.choices[b.answer];
  });
  check('锚题（' + anchorIds.join('/') + '）前后测完全相同', anchorSame);

  check('锚题 4 题 + 平行题 6 题 = 10 题', anchorIds.length === 4 && parallelIds.length === 6,
    '锚题=' + anchorIds.length + ' 平行=' + parallelIds.length);
}

// ---------------------------------------------------------------
console.log('\n[6] 可复现');
{
  const again = Q.build('pre');
  check('同一个 form 两次生成完全一致',
    JSON.stringify(again.map(q => [q.qid, q.choices, q.answer])) ===
    JSON.stringify(pre.map(q => [q.qid, q.choices, q.answer])));
  const bad = (() => { try { Q.build('nope'); return false; } catch (e) { return true; } })();
  check('未知卷别会抛错', bad);
}

// ---------------------------------------------------------------
console.log('\n[7] 判分');
{
  const allRight = Q.grade(pre, pre.map(q => q.answer));
  check('全对 = 10/10', allRight.correct === 10 && allRight.percent === 100,
    allRight.correct + '/' + allRight.total);
  check('全对时每个知识点都是满分',
    Object.keys(allRight.byTopic).every(t => allRight.byTopic[t].correct === allRight.byTopic[t].total));

  const allWrong = Q.grade(pre, pre.map(q => (q.answer + 1) % q.choices.length));
  check('全错 = 0/10', allWrong.correct === 0 && allWrong.percent === 0);

  const blank = Q.grade(pre, pre.map(() => null));
  check('全空 = 0/10 且标为未作答', blank.correct === 0 && blank.rows[0].chosenText === '（未作答）',
    blank.rows[0].chosenText);

  const half = Q.grade(pre, pre.map((q, i) => (i < 5 ? q.answer : (q.answer + 1) % q.choices.length)));
  check('对 5 题 = 50%', half.percent === 50, half.percent + '%');
  check('byTopic 覆盖全部 5 个知识点', Object.keys(half.byTopic).length === 5,
    Object.keys(half.byTopic).join(','));
  check('byTopic 总题数 = 10',
    Object.keys(half.byTopic).reduce((s, t) => s + half.byTopic[t].total, 0) === 10);
  check('rows 长度 = 题数', half.rows.length === 10);
  check('rows 里带上了选项原文',
    typeof half.rows[0].chosenText === 'string' && half.rows[0].chosenText.length > 0,
    half.rows[0].chosenText);
}

// ---------------------------------------------------------------
console.log('\n[8] 汇总与导出');
{
  const mk = (form, rightCount, ms) => {
    const qs = Q.build(form);
    const ans = qs.map((q, i) => (i < rightCount ? q.answer : (q.answer + 1) % q.choices.length));
    return { form, ms, finishedAt: '2026-10-17T10:00:00', score: Q.grade(qs, ans) };
  };
  const recs = [mk('pre', 3, 300000), mk('pre', 5, 320000), mk('post', 8, 200000)];
  const sum = Q.summarize(recs);
  check('前测 2 份记录', sum.pre && sum.pre.n === 2, sum.pre && 'n=' + sum.pre.n);
  check('前测总正确率 = (3+5)/20 = 40%', sum.pre.percent === 40, sum.pre.percent + '%');
  check('后测 1 份记录，80%', sum.post && sum.post.n === 1 && sum.post.percent === 80,
    sum.post && sum.post.percent + '%');
  check('平均用时被累计', sum.pre.ms === 620000, sum.pre.ms);
  check('知识点维度被累计',
    Object.keys(sum.pre.byTopic).length === 5 &&
    Object.keys(sum.pre.byTopic).every(t => sum.pre.byTopic[t].total === 4),
    Object.keys(sum.pre.byTopic).map(t => t + ':' + sum.pre.byTopic[t].total).join(' '));

  const csv1 = Q.recordToCSV(recs[0]);
  const lines1 = csv1.split('\n');
  check('单份 CSV 有表头 + 10 行 + 空行 + 合计', lines1.length === 13, 'lines=' + lines1.length);
  check('单份 CSV 表头正确', lines1[0] === '题号,知识点,知识点名,你的答案,正确答案,是否正确', lines1[0]);
  check('单份 CSV 含合计行', lines1[12].indexOf('合计') === 0, lines1[12]);

  const csvAll = Q.recordsToCSV(recs);
  const linesAll = csvAll.split('\n');
  check('宽表 = 表头 + 3 行', linesAll.length === 4, 'lines=' + linesAll.length);
  check('宽表表头含 5 个知识点列',
    linesAll[0].indexOf('时域基本量') > 0 && linesAll[0].indexOf('阵列测向') > 0, linesAll[0]);
  check('宽表每行字段数一致', linesAll.every(l => l.split(',').length === linesAll[0].split(',').length),
    linesAll.map(l => l.split(',').length).join('/'));
}

// ---------------------------------------------------------------
console.log('\n[9] 存储（无 localStorage 时不能崩）');
{
  let ok = true;
  try {
    check('无 localStorage 时 loadAll 返回空数组', Q.loadAll().length === 0);
    Q.save({ form: 'pre', score: { correct: 1, total: 10 } });
    Q.clear();
  } catch (e) { ok = false; console.log('   ' + e.message); }
  check('无 localStorage 时读写不抛异常', ok);
}

console.log('\n========== ' + pass + ' passed, ' + fail + ' failed ==========');
process.exit(fail ? 1 : 0);
