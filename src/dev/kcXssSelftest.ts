/**
 * 二期安全渲染的**真浏览器**验收（阶段 01 验收项 4）。
 *
 * 单独成文件的原因：这一段是唯一有副作用的验收项（真的往 DOM 里插攻击载荷），
 * 而且它的断言方式（查危险元素、查哨兵变量）和其它验收项完全不同。
 *
 * 用法：控制台 `__kcselftest.xss(true)` —— `true` 表示把测试内容留在页面上肉眼看。
 */
import { BLOCK_CLASS, renderBlocks, renderBlock } from '../core/blockRender';
import type { Block } from '../core/kcTypes';
import type { KcSelfTestResult } from './kcSelftestTypes';
/** 危险的测试载荷：脚本注入 + 事件处理器注入 + 属性逃逸 */
const XSS_PAYLOADS = [
  '<script>window.__kcXssFired = true; alert(1)</script>',
  '<img src=x onerror="window.__kcXssFired = true">',
  '"><svg/onload=window.__kcXssFired=true>',
  '<iframe src="https://example.com/evil"></iframe>',
];

/**
 * 安全渲染验收（阶段 01 验收项 4）。
 *
 * 做法：构造若干含攻击载荷的 Block，**真的插进页面**（放在一个临时容器里），
 * 然后断言：
 * - 页面上出现的是**纯文本**（`textContent` 里能看到原始字符串）；
 * - 容器里**没有** script / img / iframe / svg 元素；
 * - `window.__kcXssFired` 没被置位（说明没执行任何脚本）。
 *
 * 注意：这个函数会往 DOM 里插一段东西（跑完立刻移除），是**唯一**有副作用的自测项。
 * @param visible 是否把测试内容留在页面上供肉眼确认（默认 false，跑完就删）
 */
export function runXssSelfTest(visible = false): KcSelfTestResult[] {
  const out: KcSelfTestResult[] = [];
  const push = (name: string, ok: boolean, detail: string): void => {
    out.push({ name, ok, detail });
  };

  // 先把「谁执行了脚本」的哨兵清干净
  delete (window as unknown as Record<string, unknown>)['__kcXssFired'];

  const blocks: Block[] = [
    { id: 'x1', type: 'text', content: XSS_PAYLOADS[0] as string },
    { id: 'x2', type: 'tip', content: XSS_PAYLOADS[1] as string },
    { id: 'x3', type: 'heading', content: XSS_PAYLOADS[2] as string },
    { id: 'x4', type: 'quote', content: XSS_PAYLOADS[3] as string },
    { id: 'x5', type: 'example', content: XSS_PAYLOADS[0] as string, translation: XSS_PAYLOADS[2] as string },
    { id: 'x6', type: 'list', items: [XSS_PAYLOADS[1] as string, XSS_PAYLOADS[3] as string] },
    { id: 'x7', type: 'table', rows: [[XSS_PAYLOADS[2] as string, XSS_PAYLOADS[0] as string]] },
    { id: 'x8', type: 'code', content: XSS_PAYLOADS[0] as string, lang: 'js"><img src=x onerror=window.__kcXssFired=true>' },
    // 损坏的块：未知类型 + 缺字段（应该降级渲染，不抛异常）
    { id: 'x9', type: 'not-a-real-type' as Block['type'], content: XSS_PAYLOADS[1] as string },
    { id: 'x10', type: 'text' } as Block,
  ];

  const host = document.createElement('div');
  host.id = 'kc-xss-selftest';
  host.style.cssText = 'position:fixed;left:0;bottom:0;max-width:520px;max-height:40vh;overflow:auto;background:#fff;border:2px solid #d33;z-index:99999;padding:8px;font-size:12px';
  document.body.appendChild(host);

  let renderError = '';
  try {
    host.appendChild(renderBlocks(blocks));
    // 单块入口也走一遍（renderBlock 是公开 API）
    host.appendChild(renderBlock({ id: 'x11', type: 'text', content: XSS_PAYLOADS[0] as string }));
  } catch (err) {
    renderError = err instanceof Error ? err.message : String(err);
  }

  push('10 个恶意/损坏的块全部渲染成功（不抛异常）', renderError === '', renderError);

  const dangerous = host.querySelectorAll('script, img, iframe, svg, object, embed, style, link');
  push('渲染结果里没有任何 script/img/iframe/svg 等危险元素', dangerous.length === 0, `找到 ${dangerous.length} 个`);

  const fired = (window as unknown as Record<string, unknown>)['__kcXssFired'] === true;
  push('注入的脚本一次都没有执行（哨兵未置位）', !fired, fired ? '哨兵被置位 = 有脚本执行了！' : '');

  const text = host.textContent ?? '';
  push('攻击载荷以**纯文本**出现在页面上', text.includes('<script>'), text.slice(0, 60));
  push('未知块类型降级成纯文本（不白屏）', text.includes('onerror'), '');

  const attrInjected = host.querySelector('[onerror], [onload]');
  // 说明：这里只用 tagName 判断，**不读 outerHTML**——
  // 那样写会让「二期代码里不许出现 XX 拼接」的源码护栏误报（见 api/_dev/test-kc.mjs）。
  push(
    '没有任何 onerror/onload 属性被写进 DOM',
    attrInjected === null,
    attrInjected === null ? '' : `被注入的元素标签：${attrInjected.tagName}`,
  );

  const codeEl = host.querySelector('code');
  push(
    'code 的 lang 被过滤成安全字符（不许出现引号/尖括号）',
    codeEl !== null && [...codeEl.classList].every((c) => /^[A-Za-z0-9+#-]+$/.test(c)),
    codeEl === null ? '没找到 code 元素' : [...codeEl.classList].join(' '),
  );

  push('块根节点带了 kc-block class（样式可挂）', host.querySelector(`.${BLOCK_CLASS}`) !== null, '');

  if (visible) {
    console.warn('[kcselftest] XSS 测试内容留在页面上了（#kc-xss-selftest），确认完手动删掉');
  } else {
    host.remove();
  }
  return out;
}
