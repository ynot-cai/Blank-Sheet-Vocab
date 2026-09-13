/**
 * 阶段 02 验收用的**假 AI 返回**（Node 自检与无头浏览器冒烟共用同一份）。
 *
 * 为什么要共用：验收标准 4（XSS）和 9（非法 JSON）都要用「特定形状的 AI 返回」，
 * 两个测试各自写一份的话，改了一处忘了另一处，就会出现「Node 测过了、浏览器没测到」。
 *
 * 这份内容刻意包含：
 * - 全部 8 种块类型（验收标准 3 要求逐一试一遍）；
 * - `<script>` / `<img onerror>` 载荷（验收标准 4）；
 * - 一个**不合法的块**（缺 type 的对象、null）——应该被丢掉而其它块保留；
 * - `estMinutes: 12` —— **超出 3~5**，应该被钳到 5（验收标准 6）；
 * - 一个未知题型标签 `essay` —— 应该被过滤掉（题型表是白名单）。
 */

/** 正常返回：2 张卡，块类型齐全，含 XSS 载荷与越界耗时 */
export const FAKE_IMPORT_REPLY = JSON.stringify({
  cards: [
    {
      title: '定语从句：关系代词 vs 关系副词',
      summary: '关系代词在从句中作主语/宾语；关系副词作状语',
      blocks: [
        { type: 'heading', content: '核心区别' },
        { type: 'text', content: '关系代词在从句中作主语/宾语；关系副词作状语。<script>alert(1)</script>' },
        { type: 'example', content: 'This is the house where I lived.', translation: '这是我住过的房子。' },
        {
          type: 'list',
          items: ['先行词是地点且从句完整 → where', '先行词是地点但从句缺主语 → which/that'],
        },
        {
          type: 'table',
          rows: [
            ['关系词', '先行词', '从句成分'],
            ['where', '地点', '状语'],
            ['which', '物', '主语/宾语'],
          ],
        },
        { type: 'quote', content: 'The book which I bought yesterday is interesting.' },
        { type: 'code', content: 'The house {where} I lived', lang: 'text' },
        { type: 'tip', content: '易错：先行词是地点不一定用 where，要看从句缺什么成分。' },
        // 下面两个是**故意写坏**的：应该被丢掉，但不影响上面的块
        { content: '<img src=x onerror="window.__kcXssFired=true">' },
        null,
      ],
      examTags: ['fill', 'choice', 'essay'],
      examLoad: { types: ['fill', 'choice'], estMinutes: 12 },
    },
    {
      title: '关系副词的三种情况',
      summary: 'where / when / why 的适用条件',
      blocks: [
        { type: 'heading', content: '三种关系副词' },
        { type: 'list', items: ['where → 地点', 'when → 时间', 'why → 原因（先行词只有 reason）'] },
        { type: 'tip', content: 'why 的先行词只能是 reason。' },
      ],
      examTags: ['judge'],
      examLoad: { types: ['judge'], estMinutes: 3 },
    },
  ],
});

/** 非法 JSON：模型返回了一段解释文字，中间夹着 JSON（验收标准 9 + 抠 JSON 的降级路径） */
export const FAKE_BAD_REPLY =
  '好的，我来帮你整理一下：\n{"cards":[{"title":"非谓语动词","summary":"doing vs done","blocks":[{"type":"text","content":"doing 表主动进行，done 表被动完成"}],"examTags":["fill"],"examLoad":{"types":["fill"],"estMinutes":4}}]}\n希望有帮助！';

/** 完全不是 JSON（应该给出明确错误提示） */
export const FAKE_GARBAGE_REPLY = '抱歉，我不太明白你的意思，能再说得具体一点吗？';

/** markdown 围栏包裹（模型最常见的不听话方式） */
export const FAKE_FENCED_REPLY = `\`\`\`json
{"cards":[{"title":"虚拟语气","summary":"should 的省略","blocks":[{"type":"tip","content":"suggest 后的 that 从句用 (should) + 动词原形"}],"examTags":["choice"],"examLoad":{"types":["choice"],"estMinutes":4}}]}
\`\`\``;

/** 一张卡都不生成（全部与已有知识点重合） */
export const FAKE_EMPTY_REPLY = '{"cards":[]}';
