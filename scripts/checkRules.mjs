#!/usr/bin/env node
/**
 * checkRules.mjs —— AI_RULES.md 铁律自检脚本
 *
 * 用法：npm run rules:check   （或 node scripts/checkRules.mjs）
 *
 * 目的：防止编码 AI（dsh 等）在多次对话后遗忘项目铁律。
 * 规则住在 AI_RULES.md 里，本脚本负责机器化验证"规则是否真的落地到代码"。
 *
 * 退出码：0 = 全绿；1 = 有违规或警告未处理
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const RULES_FILE = join(ROOT, 'AI_RULES.md');

// 需要扫描的源码目录
const SCAN_DIRS = ['src', 'api'];

// 收集所有 .ts/.tsx 文件
function collectFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectFiles(p));
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap(collectFiles);
const results = [];
let hasError = false;

function fail(rule, msg, detail = '') {
  hasError = true;
  results.push({ level: 'ERROR', rule, msg, detail });
}
function warn(rule, msg, detail = '') {
  results.push({ level: 'WARN', rule, msg, detail });
}
function pass(rule, msg) {
  results.push({ level: 'PASS', rule, msg });
}

// ─────────────────────────────────────────────
// 0. 前置：AI_RULES.md 必须存在
// ─────────────────────────────────────────────
if (!existsSync(RULES_FILE)) {
  console.error('✗ 找不到 AI_RULES.md —— 铁律文件缺失，先创建它');
  process.exit(1);
}
const rulesText = readFileSync(RULES_FILE, 'utf8');

// ─────────────────────────────────────────────
// R1 · 禁止强制时间限制
// ─────────────────────────────────────────────
{
  // 可疑模式：答题/考察语境里的计时
  const suspicious = [
    { re: /\bsetTimeout\s*\(/g, name: 'setTimeout' },
    { re: /\bsetInterval\s*\(/g, name: 'setInterval' },
    { re: /\b(?:timeLimit|deadline|countdown|remainingTime|timeLeft|expireAt)\b/g, name: '计时变量' },
  ];

  // 合法用途关键词（出现这些就不算答题计时）
  const LEGIT = [
    'debounce', 'throttle', '防抖', '节流',
    'abort', 'timeoutMs', 'AbortController', '网络超时',
    'scheduleSync', '同步调度', 'toast', 'Toast',
    'animation', 'transition', '动画',
  ];

  const hits = [];
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    const rel = relative(ROOT, f);
    for (const { re, name } of suspicious) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code)) !== null) {
        // 取该行上下文
        const lineStart = code.lastIndexOf('\n', m.index) + 1;
        const lineEnd = code.indexOf('\n', m.index);
        const line = code.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        const context = code.slice(Math.max(0, m.index - 200), m.index + 200);

        const isLegit = LEGIT.some(k => context.includes(k));
        if (!isLegit) {
          hits.push({ file: rel, name, line: line.trim().slice(0, 120) });
        }
      }
    }
  }

  if (hits.length > 0) {
    warn(
      'R1',
      `发现 ${hits.length} 处可疑计时代码，请人工确认是否为"答题超时限制"`,
      hits.slice(0, 20).map(h => `  ${h.file}  [${h.name}]  ${h.line}`).join('\n')
    );
  } else {
    pass('R1', '未发现可疑的答题计时代码');
  }

  // 检查答题相关文件是否有 R1 注释标记
  const examFiles = files.filter(f => {
    const rel = relative(ROOT, f).toLowerCase();
    return /exam|memory|spell|study|review|quiz|grade/i.test(rel);
  });
  const missingMark = examFiles.filter(f => !readFileSync(f, 'utf8').includes('RULES-R1'));
  if (examFiles.length > 0 && missingMark.length > 0) {
    fail(
      'R1',
      `${missingMark.length} 个考察/答题相关文件缺少 "RULES-R1" 注释标记`,
      missingMark.map(f => '  ' + relative(ROOT, f)).join('\n')
    );
  } else if (examFiles.length > 0) {
    pass('R1', `${examFiles.length} 个考察相关文件均有 R1 注释标记`);
  }
}

// ─────────────────────────────────────────────
// R2 · 义项系统
// ─────────────────────────────────────────────
{
  // 4.1 录入提示词必含片段（取前 30 字做指纹）
  const IMPORT_SNIPPET = '含义相近的中文意思合并为一个义项';
  // 4.2 出题提示词必含片段
  const EXAM_SNIPPET = '不得设置任何时间限制';

  // 在所有疑似提示词模板文件里找
  const promptFiles = files.filter(f => /prompt|ai|reparse|kcAi/i.test(relative(ROOT, f)));

  const hasImport = promptFiles.some(f => readFileSync(f, 'utf8').includes(IMPORT_SNIPPET));
  const hasExam = promptFiles.some(f => readFileSync(f, 'utf8').includes(EXAM_SNIPPET));

  if (!hasImport) {
    fail('R2', `录入提示词缺少必含片段：「${IMPORT_SNIPPET}」（AI_RULES.md 第 4.1 节）`);
  } else {
    pass('R2', '录入提示词已包含义项规则片段');
  }

  if (!hasExam) {
    fail('R2', `出题提示词缺少必含片段：「${EXAM_SNIPPET}」（AI_RULES.md 第 4.2 节）`);
  } else {
    pass('R2', '出题提示词已包含"无时间限制"片段');
  }

  // AI_RULES.md 本身必须包含这两段
  if (!rulesText.includes(IMPORT_SNIPPET) || !rulesText.includes(EXAM_SNIPPET)) {
    fail('R2', 'AI_RULES.md 第 4 节自身内容不完整');
  }
}

// ─────────────────────────────────────────────
// R3 · 斩：不确认 + 可撤销
// ─────────────────────────────────────────────
{
  const chopFiles = files.filter(f => {
    const code = readFileSync(f, 'utf8');
    return /\bchop\b|斩/.test(code);
  });

  // 不应再出现 confirm 对话框式的斩确认
  const badConfirm = chopFiles.filter(f => {
    const code = readFileSync(f, 'utf8');
    const hasChop = /\bchop\b|斩/.test(code);
    const hasConfirm = /confirm\s*\(\s*[^)]*斩|confirm\s*\([^)]*确定斩/.test(code);
    return hasChop && hasConfirm;
  });

  if (badConfirm.length > 0) {
    fail(
      'R3',
      `${badConfirm.length} 个文件仍存在"斩 + 确认框"的写法，应改为无确认 + 撤销 Toast`,
      badConfirm.map(f => '  ' + relative(ROOT, f)).join('\n')
    );
  } else {
    pass('R3', '斩操作未发现 confirm 确认框');
  }

  // 撤销 Toast 至少要有一处实现（撤销/undo 相关）
  const hasUndo = chopFiles.some(f => {
    const code = readFileSync(f, 'utf8');
    return /撤销|undo|Undo/.test(code);
  });
  if (!hasUndo && chopFiles.length > 0) {
    fail('R3', '未找到"斩后撤销"的实现（Toast 撤销或列表页复活入口）');
  } else if (chopFiles.length > 0) {
    pass('R3', '存在斩后撤销/复活入口');
  }

  // 注释标记（宽松：只要整体有 RULES-R3 即可）
  const hasMark = files.some(f => readFileSync(f, 'utf8').includes('RULES-R3'));
  if (!hasMark) {
    warn('R3', '建议在与斩相关的文件加注释标记：// RULES-R3: 斩不弹确认，但必须提供 ≥8 秒撤销');
  }
}

// ─────────────────────────────────────────────
// R4 · 安全底线
// ─────────────────────────────────────────────
{
  // 4.1 不得有存密钥的逻辑/表
  const badKeyTable = files.filter(f => {
    const code = readFileSync(f, 'utf8');
    return /CREATE TABLE[\s\S]{0,400}?(api_?key|keyCipher|UserAiConfig)/i.test(code);
  });
  if (badKeyTable.length > 0) {
    fail(
      'R4',
      '发现疑似"存储 AI 密钥"的表定义，违反方案 B',
      badKeyTable.map(f => '  ' + relative(ROOT, f)).join('\n')
    );
  } else {
    pass('R4', '未发现存储 AI 密钥的表');
  }

  // 4.2 SQL 是否都带 space_key（粗查：有 SQL 但没 space_key 的文件）
  const sqlFiles = files.filter(f => {
    const code = readFileSync(f, 'utf8');
    return /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(code) && /\bFROM\s+words\b|\bFROM\s+knowledge_cards\b/i.test(code);
  });
  const noSpaceKey = sqlFiles.filter(f => !/space_key/i.test(readFileSync(f, 'utf8')));
  if (noSpaceKey.length > 0) {
    fail(
      'R4',
      `${noSpaceKey.length} 个文件有业务表 SQL 但未出现 space_key 过滤`,
      noSpaceKey.map(f => '  ' + relative(ROOT, f)).join('\n')
    );
  } else if (sqlFiles.length > 0) {
    pass('R4', `${sqlFiles.length} 个含业务表 SQL 的文件均带 space_key`);
  }

  // 4.3 禁止 innerHTML 拼 AI 内容（块渲染）
  const blockRender = files.filter(f => /blockRender/i.test(relative(ROOT, f)));
  for (const f of blockRender) {
    const code = readFileSync(f, 'utf8');
    if (/innerHTML\s*=/.test(code)) {
      fail('R4', `块渲染文件使用了 innerHTML（应改用 textContent）：${relative(ROOT, f)}`);
    }
  }
  if (blockRender.length > 0) pass('R4', '块渲染文件检查完成');
}

// ─────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────
console.log('\n=== AI_RULES 自检 ===\n');
for (const r of results) {
  const icon = r.level === 'PASS' ? '✓' : r.level === 'WARN' ? '!' : '✗';
  console.log(`${icon} [${r.level}] ${r.rule}  ${r.msg}`);
  if (r.detail) console.log(r.detail);
}

const errCount = results.filter(r => r.level === 'ERROR').length;
const warnCount = results.filter(r => r.level === 'WARN').length;

console.log(`\n结果：${results.filter(r => r.level === 'PASS').length} 通过 / ${warnCount} 警告 / ${errCount} 错误\n`);

if (errCount > 0) {
  console.log('存在 ERROR，请修复后重跑。参考 AI_RULES.md。');
  process.exit(1);
}
if (warnCount > 0) {
  console.log('存在 WARN，请人工确认后处理（不计入失败）。');
}
process.exit(0);
