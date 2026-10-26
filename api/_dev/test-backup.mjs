/**
 * 存档文件（备份）自检（版本 1.0.0）：`npm run test:backup`
 *
 * 用户：「调整已保存的单词数据格式，使其成为可直接导入的存档文件；缺失字段按合理默认值补充。」
 *
 * 测的是**纯逻辑**：
 *   [1] normalizeWordForBackup：空对象 / 半截数据都能补齐成完整词条
 *   [2] normalizeSourceForBackup：缺 id/名称也补齐
 *   [3] parseBackupText：缺字段的文件能导入；只有缺 en 才算格式错
 *
 * 用法：node --import ./api/_dev/loader-register.mjs api/_dev/test-backup.mjs
 */
import { normalizeSourceForBackup, normalizeWordForBackup, parseBackupText } from '../../src/services/backup.ts';
import { WORD_PRIORITY_DEFAULT, WORD_PRIORITY_MAX, WORD_PRIORITY_MIN } from '../../src/core/types.ts';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

// ─────────────────────────── [1] 词条补齐
console.log('\n[1] 词条：任何缺口都补成完整形态');
{
  const w = normalizeWordForBackup({ en: 'abandon' });
  check('★ 只有英文也能补成完整词条', typeof w.id === 'string' && w.id !== '' && w.senses.length === 0);
  check('音标 / 例句默认空串', w.phonetic === '' && w.example === '');
  check('★ attrs 九项全部有值', ['needSpell', 'failCount', 'failCountTotal', 'reviewCount', 'reviewPriority', 'examCount'].every((k) => typeof w.attrs[k] === 'number' || typeof w.attrs[k] === 'boolean'), JSON.stringify(w.attrs));
  check('两个时间戳字段默认 null', w.attrs.lastReviewAt === null && w.attrs.learnedAt === null);
  check('examScore 默认 null', w.attrs.examScore === null);
  check('状态默认未背', w.status === 'unlearned');
  check('★ 词级优先级落在合法区间', w.priority >= WORD_PRIORITY_MIN && w.priority <= WORD_PRIORITY_MAX, String(w.priority));
  check('默认优先级就是默认值 3', w.priority === WORD_PRIORITY_DEFAULT, String(w.priority));
  check('来源有兜底值（不会出现空 sourceId）', w.sourceId !== '');
  check('时间戳是数字', typeof w.createdAt === 'number' && typeof w.updatedAt === 'number');

  const half = normalizeWordForBackup({
    id: 'x1',
    en: 'benefit',
    senses: [{ text: 'n. 好处' }, { aliases: ['益处'] }, null],
    attrs: { failCount: 3 },
    status: 'learning',
    priority: 99,
    spellOnly: true,
  });
  check('★ 半截义项补齐 id / aliases / example / enabled', half.senses.length === 3 && half.senses.every((s) => typeof s.id === 'string' && Array.isArray(s.aliases) && typeof s.example === 'string' && typeof s.enabled === 'boolean'), JSON.stringify(half.senses));
  check('attrs 只给了 failCount，其余仍补齐', half.attrs.failCount === 3 && half.attrs.reviewCount === 0 && half.attrs.failCountTotal === 0);
  check('状态保留合法值', half.status === 'learning');
  check('越界优先级被夹回 1~5', half.priority === WORD_PRIORITY_MAX, String(half.priority));
  check('spellOnly 只在为真时出现', half.spellOnly === true);
}

// ─────────────────────────── [2] 来源补齐
console.log('\n[2] 来源：缺 id / 名称也补齐');
{
  const s = normalizeSourceForBackup({}, 2);
  check('★ 缺字段的来源有 id、名称与时间戳', typeof s.id === 'string' && s.name === '未命名来源' && typeof s.createdAt === 'number');
  const s2 = normalizeSourceForBackup({ id: 's1', name: '四级' });
  check('已有字段不动', s2.id === 's1' && s2.name === '四级');
}

// ─────────────────────────── [3] 解析：缺字段的文件也能导入
console.log('\n[3] 备份文件：缺字段能导入，缺英文才报错');
{
  const text = JSON.stringify({
    version: 1,
    words: [{ en: 'alpha' }, { en: 'bravo', senses: [{ text: 'v. 喝彩' }] }],
    sources: [{ name: '默认' }],
  });
  const file = parseBackupText(text);
  check('★ 缺 settings / exportedAt 也能解析', file.settings !== undefined && typeof file.exportedAt === 'number');
  check('★ 词条被补成完整形态', file.words.length === 2 && file.words.every((w) => Array.isArray(w.senses) && typeof w.attrs?.failCount === 'number'));
  check('来源被补成完整形态', file.sources.length === 1 && typeof file.sources[0].id === 'string');

  let err = '';
  try {
    parseBackupText(JSON.stringify({ version: 1, words: [{ id: 'a' }], sources: [] }));
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  check('★ 缺英文（en）仍然拒绝导入', err.includes('缺少英文'), err);

  let err2 = '';
  try {
    parseBackupText('不是 JSON');
  } catch (e) {
    err2 = e instanceof Error ? e.message : String(e);
  }
  check('非法 JSON 仍然报错', err2.includes('格式不正确'), err2);
}

console.log(`\n存档文件自检：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
