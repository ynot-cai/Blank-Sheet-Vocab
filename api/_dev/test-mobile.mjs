/**
 * 阶段 05 验收脚本：`npm run test:mobile`
 *
 * 移动端适配大部分是视觉问题，只能在模拟器/真机上看；但**能自动验证的部分**必须自动验证，
 * 尤其是这几条「错了会很难查」的：
 * 1. 右下角按钮区的避让：撒满词之后，按钮区里不能有词；
 * 2. 布点容量在避让后变小（说明避让真的生效了，不是摆设）；
 * 3. 义项序号：1 个义项不显示、多个义项才显示，字号不小于可读下限；
 * 4. 手机上字号放大、输入框字号 ≥16px、按钮热区 ≥44px（CSS 层面检查）；
 * 5. 单词旁边不再有发音按钮、不再有 hover 工具条。
 */
import { readFileSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs';

loadEnvFiles('..');

// device.ts / config.ts 只用到 window.innerWidth 与 resize 事件
const winListeners = new Map();
globalThis.window = globalThis;
globalThis.innerWidth = 390;
globalThis.innerHeight = 844;
globalThis.addEventListener = (type, fn) => {
  const list = winListeners.get(type) ?? [];
  list.push(fn);
  winListeners.set(type, list);
};
globalThis.removeEventListener = (type, fn) => {
  winListeners.set(type, (winListeners.get(type) ?? []).filter((f) => f !== fn));
};

const { DEVICE, getSettings } = await import('../../src/core/config.ts');
const { jitteredGrid } = await import('../../src/core/layout.ts');
const { deviceKind, controlsAvoidRect } = await import('../../src/ui/device.ts');

let passed = 0;
let failed = 0;

/**
 * 一条断言。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 失败时的补充
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/**
 * 设置一个假的视口尺寸。
 * @param {number} w 宽
 * @param {number} h 高
 */
function setViewport(w, h) {
  globalThis.innerWidth = w;
  globalThis.innerHeight = h;
}

console.log('\n=== 阶段 05 验收：移动端适配（可自动验证的部分） ===\n');

// ─────────────────────────────────────────── 1. 设备形态判断
console.log('[1] 断点：手机 < 768 / 平板 768~1024 / 桌面 > 1024');
{
  setViewport(390, 844);
  check('iPhone 尺寸 → phone', deviceKind() === 'phone');
  setViewport(430, 932);
  check('大屏手机 → phone', deviceKind() === 'phone');
  setViewport(767, 1024);
  check('767px → phone（边界）', deviceKind() === 'phone');
  setViewport(768, 1024);
  check('768px → tablet（边界）', deviceKind() === 'tablet');
  setViewport(1024, 768);
  check('1024px → tablet', deviceKind() === 'tablet');
  setViewport(1025, 800);
  check('1025px → desktop', deviceKind() === 'desktop');
  setViewport(1440, 900);
  check('桌面宽度 → desktop', deviceKind() === 'desktop');
}

// ─────────────────────────────────────────── 2. 右下角避让区
console.log('\n[2] 布点避让：按钮区里不能有词');
{
  const cases = [
    { name: '手机', w: 390, h: 844, expected: DEVICE.controlsPhone },
    { name: '平板', w: 834, h: 1112, expected: DEVICE.controlsTablet },
  ];

  for (const c of cases) {
    setViewport(c.w, c.h);
    const rect = controlsAvoidRect();
    check(
      `${c.name}：避让区按设备取尺寸`,
      rect.width === c.expected.width && rect.height === c.expected.height,
      JSON.stringify(rect),
    );
    check(
      `${c.name}：避让区贴右下角`,
      rect.x + rect.width <= c.w && rect.y + rect.height <= c.h && rect.x > c.w / 2,
      JSON.stringify(rect),
    );

    // 撒满一屏词（200 个，远超容量），检查有没有落进按钮区
    const points = jitteredGrid(200, {
      aspect: c.w / c.h,
      seed: 20260501,
      minGapW: (24 * DEVICE.phoneFontScale) / c.w,
      minGapH: (24 * DEVICE.phoneFontScale) / c.h,
      canvas: { width: c.w, height: c.h },
      avoidPx: rect,
    });
    const inside = points.filter(
      (p) =>
        p.x * c.w >= rect.x &&
        p.x * c.w <= rect.x + rect.width &&
        p.y * c.h >= rect.y &&
        p.y * c.h <= rect.y + rect.height,
    );
    check(`${c.name}：撒 ${points.length} 个词，按钮区里 0 个`, inside.length === 0, `${inside.length} 个落进去了`);

    const withoutAvoid = jitteredGrid(200, {
      aspect: c.w / c.h,
      seed: 20260501,
      minGapW: (24 * DEVICE.phoneFontScale) / c.w,
      minGapH: (24 * DEVICE.phoneFontScale) / c.h,
    });
    check(`${c.name}：避让确实让容量变小`, points.length < withoutAvoid.length, `${points.length} vs ${withoutAvoid.length}`);
    check(
      `${c.name}：容量不会小得离谱（≥ 不避让的 70%）`,
      points.length >= withoutAvoid.length * 0.7,
      `${points.length} vs ${withoutAvoid.length}`,
    );
  }
}

// ─────────────────────────────────────────── 3. 布点可复现
console.log('\n[3] 同一个 seed 结果稳定（续跑恢复位置不会乱跳）');
{
  setViewport(390, 844);
  const rect = controlsAvoidRect();
  const opts = { aspect: 390 / 844, seed: 12345, canvas: { width: 390, height: 844 }, avoidPx: rect };
  const a = jitteredGrid(40, opts);
  const b = jitteredGrid(40, opts);
  check('两次结果完全一致', JSON.stringify(a) === JSON.stringify(b));
}

// ─────────────────────────────────────────── 4. 白纸源码：没有 hover 工具条 / 发音按钮
console.log('\n[4] 交互基线：单词旁边不再有发音按钮、不再有 hover 工具条');
{
  const stage = readFileSync(new URL('../../src/ui/pages/paper/PaperStage.ts', import.meta.url), 'utf8');
  check('源码里没有 paper-hover-zone', !stage.includes('paper-hover-zone'));
  check('源码里没有 paper-tools（悬停工具条）', !stage.includes('paper-tools'));
  check('源码里没有 paper-speak（单词旁的喇叭按钮）', !stage.includes('paper-speak'));
  check('义项序号是主动渲染的浅灰数字', stage.includes('paper-badge') && stage.includes('DEVICE.senseBadgeColor'));
  check('只有 1 个义项时不渲染序号', /count > 1/.test(stage), '没找到 count > 1 判断');

  const css = readFileSync(new URL('../../src/styles/paper.css', import.meta.url), 'utf8');
  check('CSS 里也清掉了 hover 工具条', !css.includes('.paper-tools') && !css.includes('.paper-hover-zone'));
  check('CSS 里义项序号是浅灰', /\.paper-badge[\s\S]{0,160}#bbb/.test(css));
}

// ─────────────────────────────────────────── 5. 手机 CSS 检查
console.log('\n[5] 手机样式：字号、热区、安全区');
{
  const css = readFileSync(new URL('../../src/styles/paper.css', import.meta.url), 'utf8');
  const global = readFileSync(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
  const phoneBlock = css.slice(css.indexOf('@media (max-width: 767px)'));
  const gPhone = global.slice(global.indexOf('@media (max-width: 767px)'));

  check('手机上中文意思字号 ≥16px（iOS 不自动放大）', /\.paper-meaning\s*\{[^}]*font-size:\s*16px/.test(phoneBlock));
  check('手机上输入框字号 ≥16px', /\.mem-input\s*\{[^}]*font-size:\s*16px/.test(phoneBlock));
  check('手机上输入框纵向排列', /\.mem-inputs\s*\{[^}]*flex-direction:\s*column/.test(phoneBlock));
  check('手机上主按钮 ≥48px 高', /\.paper-next\s*\{[^}]*min-height:\s*56px/.test(phoneBlock));
  check('按钮避开 iPhone 底部安全区', css.includes('env(safe-area-inset-bottom'));
  check('答案卡在手机上改底部弹出', /\.answer-card\s*\{[^}]*bottom:\s*0/.test(phoneBlock));
  check('首页手机上是 2 列网格', /\.home-grid\s*\{[^}]*repeat\(2,/.test(gPhone));
  check('首页卡片最小高度 ≥56px', /\.home-card\s*\{[^}]*min-height:\s*96px/.test(gPhone));
  check(
    '手机上隐藏表格、显示卡片流',
    /\.list-table[\s\S]{0,80}display:\s*none/.test(gPhone) && /\.list-cards\s*\{\s*display:\s*block/.test(gPhone),
  );
  check('手机上输入框 ≥44px 高', /\.input,[\s\S]{0,140}min-height:\s*44px/.test(gPhone));
  check('顶栏在手机上横向滚动不换行', /\.nav\s*\{[^}]*flex-wrap:\s*nowrap/.test(gPhone));
  check('弹窗在手机上底部弹出', /\.modal-mask\s*\{[^}]*align-items:\s*flex-end/.test(gPhone));
  check('页面高度用 dvh（地址栏收起不跳）', global.includes('100dvh'));
}

// ─────────────────────────────────────────── 6. 义项序号规则
console.log('\n[6] 义项序号的显示规则（用真实配置算一遍）');
{
  const cfg = getSettings();
  void cfg;
  const fontSize = 24;
  const phoneSize = Math.round(fontSize * DEVICE.phoneFontScale);
  const badge = Math.max(DEVICE.senseBadgeMinFontSize, Math.round(phoneSize * DEVICE.senseBadgeScale));
  check('手机上单词字号被放大', phoneSize > fontSize, `${phoneSize} vs ${fontSize}`);
  check('序号字号是单词的一半左右', Math.abs(badge / phoneSize - 0.5) < 0.12, `${badge}/${phoneSize}`);
  check('序号字号不小于 12px', badge >= 12, String(badge));
  check('小字号单词下序号也不会小于 12px', Math.max(DEVICE.senseBadgeMinFontSize, Math.round(12 * 0.5)) === 12);
}

// ─────────────────────────────────────────── 7. iOS 语音解锁
console.log('\n[7] iOS 语音解锁层');
{
  const gate = readFileSync(new URL('../../src/ui/components/SpeechGate.ts', import.meta.url), 'utf8');
  check('有「点击屏幕开始」引导', gate.includes('点击屏幕开始'));
  check('解锁朗读是静音的（volume = 0）', gate.includes('utter.volume = 0'));
  check('解锁在点击回调里同步执行', /button\([\s\S]{0,240}unlockSpeech\(\)/.test(gate));
  check('提醒关闭 iPhone 侧边静音键', gate.includes('静音键'));
  check('桌面不弹（只在 iOS 类设备弹）', gate.includes('isIosLike'));
  check('只提示一次（localStorage 记标记）', gate.includes('wordpaper.speechUnlocked'));
}

console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
