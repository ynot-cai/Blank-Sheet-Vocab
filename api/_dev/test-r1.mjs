/**
 * R1 的**界面端到端验收测试**：`npm run test:r1`（需要本机有 Chrome / Edge，且先跑过 `npm run build`）
 *
 * 覆盖 R1 提示词「验收标准」里的每一条能自动验的项：
 *   · 录入支持 .txt / .docx / .pdf，多选逐个解析，各自显示状态；
 *   · **扫描件 PDF 明确报错**（不崩溃、不静默入库空数据）；
 *   · 解析出的文本进编辑框 → 能继续走解析链路；
 *   · **动态加载**：打开录入页时没有加载 mammoth / pdfjs，选了 docx / pdf 才加载；
 *   · 优先级写入 `word.priority`、冲突询问框、全部覆盖 / 全部保留；
 *   · 数据库迁移：老库（v5，没有 priority）升到 v6 后老词 priority = 3 且数据不丢。
 *
 * 测试夹具（test.txt / test.docx / test.pdf / scanned.pdf）在运行时生成到 `.tmp/r1-fixtures/`，
 * 不往仓库里塞二进制文件——docx 与 pdf 都是按最小合法结构手写的（见 buildDocx / buildPdf 的注释）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4181;
const CDP_PORT = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FIXTURE_DIR = join(ROOT, '.tmp', 'r1-fixtures');

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
 * 等服务器起来。
 * @param {string} url 健康检查地址
 */
async function waitForServer(url) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 等页面里某个条件成立。
 * @param {any} session CDP 会话
 * @param {string} expression 返回布尔值的表达式
 * @param {number} tries 最多尝试次数
 */
async function waitFor(session, expression, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    if (await session.evaluate(expression)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 捕获页面上的**未处理异常**（R1 踩过的坑，所以留成常驻检查）。
 *
 * 背景：`InputPanel.ts` 里有一行被意外压成
 * `if (fileRows.length === 0) return;    for (const row of fileRows) {`，
 * 语法依然是合法的（`return` 后面直接跟语句），**tsc 也通过**——
 * 但 `drawFileList()` 从此永远提前返回，文件列表一个都不画。
 * 这类「代码合法、行为静默错掉」的问题只能靠「页面里有没有报错 + 行为断言」一起兜住。
 *
 * @param {any} session CDP 会话
 */
async function collectPageErrors(session) {
  return session.evaluate(`window.__r1Errors ?? []`);
}

/**
 * 把本地文件塞进页面的 `<input type=file>` 并**触发 change 事件**（模拟用户选文件）。
 *
 * ★ 为什么走「页面内构造 DataTransfer」而不是 CDP 的 `DOM.setFileInputFiles`：
 *   实测（见提交记录）headless Chrome 上 `DOM.setFileInputFiles` 返回成功，
 *   但 `input.files.length` 仍然是 0，change 事件也没到——测试会假绿。
 *
 * ★ 赋值与派发**必须在同一次 evaluate 里**完成：分两次调用时，
 *   第二次 evaluate 读到的 `input.files` 又变回 0（FileList 与执行上下文绑定，
 *   跨 CDP 求值边界不保留）。合成一次就没有这个窗口，也让断言拿到的是真实值。
 *
 * @param {any} session CDP 会话
 * @param {{name: string, base64: string, type: string}[]} files 文件（内容是 base64）
 * @returns 文件输入框在派发事件前实际收到的文件数
 */
async function injectFiles(session, files) {
  return session.evaluate(`(() => {
    const payload = ${JSON.stringify(files)};
    const input = document.querySelector('input[type=file]');
    if (!input) return -1;
    const dt = new DataTransfer();
    for (const item of payload) {
      const bin = atob(item.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], item.name, { type: item.type }));
    }
    input.files = dt.files;
    const received = input.files.length;
    try {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
      window.__r1InjectError = String(err && err.stack ? err.stack : err);
    }
    return received;
  })()`);
}

/**
 * 读上一次注入时页面里抛出的异常（如果有）。
 * @param {any} session CDP 会话
 */
async function injectError(session) {
  return session.evaluate(`window.__r1InjectError ?? null`);
}

/**
 * 把一个本地文件读成注入用的描述对象。
 * @param {string} path 文件路径
 * @param {string} type MIME 类型
 */
function filePayload(path, type) {
  return { name: path.split(/[\\/]/).pop(), base64: readFileSync(path).toString('base64'), type };
}

/**
 * 切到录入页的「上传文件」页签。
 * @param {any} session CDP 会话
 */
async function openUploadTab(session) {
  await session.evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '上传文件')?.click()`,
  );
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * 在录入页粘贴文本、选解析方式与优先级，然后点「开始解析」。
 *
 * 说明：优先级单选框用 `.seg-item input` 定位（那是 PrioritySelect 渲染出来的结构）。
 *
 * @param {any} session CDP 会话
 * @param {string} text 要粘贴的文本（**真制表符**，不是字面的 \t）
 * @param {number} priority 词级优先级
 * @param {string} [mode] 'rule'（默认，不联网）或 'ai'
 */
async function pasteAndParse(session, text, priority, mode = 'rule') {
  await session.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const radios = [...document.querySelectorAll('input[type=radio]')];
    const wanted = radios.find((r) => r.name === 'parsemode' && r.parentElement.textContent.includes(${JSON.stringify(mode === 'rule' ? '规则解析' : 'AI 智能解析')}));
    if (wanted) { wanted.checked = true; wanted.dispatchEvent(new Event('change', { bubbles: true })); }
    const p = [...document.querySelectorAll('.seg-item input[type=radio]')].find((r) => r.value === ${JSON.stringify(String(priority))});
    if (p) { p.checked = true; p.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  })()`);
  await session.evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '开始解析')?.click()`,
  );
}

/**
 * 在合并页点「确认入库」。
 * @param {any} session CDP 会话
 */
async function confirmImport(session) {
  await session.evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('确认入库'))?.click()`,
  );
}

/**
 * 从 IndexedDB 里读词（按英文过滤）。
 * @param {any} session CDP 会话
 * @param {string} filterRe 英文过滤用的正则源码（字符串）
 */
async function readWords(session, filterRe) {
  return session.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const all = req.result.transaction('words').objectStore('words').getAll();
      all.onsuccess = () => {
        const re = new RegExp(${JSON.stringify(filterRe)});
        resolve(all.result.filter((w) => re.test(w.en)).map((w) => ({ en: w.en, priority: w.priority, status: w.status, senses: w.senses.length })));
      };
    };
  }))()`);
}

// ══════════════════════════════════════════ 夹具生成

/** 测试用的 10 个单词（每行「单词 + 释义」） */
const TEST_WORDS = [
  ['abandon', 'v. 放弃；抛弃'],
  ['benefit', 'n. 好处；利益'],
  ['capture', 'v. 捕获；夺得'],
  ['decline', 'v. 下降；拒绝'],
  ['efficient', 'adj. 高效的'],
  ['fragile', 'adj. 易碎的'],
  ['generate', 'v. 产生；生成'],
  ['hostile', 'adj. 敌对的'],
  ['impose', 'v. 强加；征收'],
  ['justify', 'v. 证明…正当'],
];

/** 夹具里各词出现的顺序（用来验 pdf 的页码顺序） */
const PAGE1_WORDS = TEST_WORDS.slice(0, 5);
const PAGE2_WORDS = TEST_WORDS.slice(5);

/**
 * 生成 test.txt。
 */
function buildTxt() {
  return TEST_WORDS.map(([en, zh]) => `${en}\t${zh}`).join('\n');
}

/**
 * 生成一个最小但**完全合法**的 .docx。
 *
 * 为什么手写而不是引 docx 生成库：docx 就是一个 zip，而 zip 有 **stored（不压缩）** 模式，
 * 于是可以完全不依赖压缩库就写出一个能被 Word / mammoth 正常打开的文件。
 * 结构按 ECMA-376 的最小集：`[Content_Types].xml` + `_rels/.rels` + `word/document.xml`。
 *
 * 刻意包含：**一个表格 + 一个列表 + 普通段落**，正好对上验收标准里
 * 「docx → 解析出文本，单词和释义没有糊成一团」这条。
 *
 * @returns {Buffer} docx 文件内容
 */
function buildDocx() {
  const rows = PAGE1_WORDS.map(
    ([en, zh]) => `<w:tr><w:tc><w:p><w:r><w:t>${en}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>${zh}</w:t></w:r></w:p></w:tc></w:tr>`,
  ).join('');
  const paras = PAGE2_WORDS.map(([en, zh]) => `<w:p><w:r><w:t>${en}</w:t></w:r><w:r><w:t xml:space="preserve"> ${zh}</w:t></w:r></w:p>`).join('');
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    // 一个居中的标题段落
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Word List</w:t></w:r></w:p>` +
    // 表格（前 5 个词）
    `<w:tbl>${rows}</w:tbl>` +
    // 普通段落（后 5 个词，中间夹一个真正的空段落）
    paras +
    `<w:p/>` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>` +
    `</w:body></w:document>`;

  return buildZip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `</Types>`,
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
        'utf8',
      ),
    },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

/**
 * 生成一个最小但**能被 pdfjs 正常解析**的 PDF。
 *
 * 手写而不引 pdf 生成库：一个只含「标准字体 + 文本绘制」的 PDF 结构很简单，
 * 而且这样能精确控制**每一页放哪些词**，用来验「页码顺序正确」。
 *
 * @param {string[][]} pages 每页的文本行
 * @param {{ image?: boolean }} [opts] image=true 时改成「只有一张图片、没有文本层」的扫描件形态
 * @returns {Buffer} PDF 文件内容
 */
function buildPdf(pages, opts = {}) {
  const objects = [];
  /** 对象号从 1 开始；先把需要的编号算出来，避免手写错位 */
  const fontObjNum = 3 + pages.length * 2;
  /** 每个对象的字节偏移（xref 表要用） */
  const offsets = [];

  const push = (num, body) => {
    objects[num] = body;
  };

  // 1: Catalog, 2: Pages
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  push(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  push(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);

  // 每页: Page + Contents
  pages.forEach((lines, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    push(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    let stream;
    if (opts.image) {
      // 扫描件形态：页面只画一个矩形（代表一张图片），**没有任何文本绘制指令**
      stream = `0.9 0.9 0.9 rg 50 500 495 300 re f\n`;
    } else {
      const lines2 = lines
        .map((line, idx) => `BT /F1 14 Tf 60 ${760 - idx * 24} Td (${line.replace(/[()\\]/g, '')}) Tj ET`)
        .join('\n');
      stream = `${lines2}\n`;
    }
    push(contentNum, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  });

  // 字体
  push(fontObjNum, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);

  // 组装：header + 每个对象 + xref + trailer
  let out = '%PDF-1.4\n';
  for (let num = 1; num <= fontObjNum; num += 1) {
    const body = objects[num];
    if (body === undefined) continue;
    offsets[num] = Buffer.byteLength(out, 'latin1');
    out += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, 'latin1');
  const total = fontObjNum + 1;
  out += `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let num = 1; num <= fontObjNum; num += 1) {
    const off = offsets[num] ?? 0;
    out += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * 打包一个 **stored（不压缩）** zip，用于手写 docx。
 *
 * 说明：stored 模式的 zip 不需要 deflate，只要算对 CRC32 与各段的偏移即可——
 * 这正是「零依赖生成 docx」可行的原因。
 *
 * @param {{ name: string, data: Buffer }[]} entries 条目
 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 需要的版本
    local.writeUInt16LE(0x0800, 6); // 标志位：文件名是 UTF-8
    local.writeUInt16LE(0, 8); // 压缩方法 0 = stored
    local.writeUInt16LE(0, 10); // 修改时间
    local.writeUInt16LE(0, 12); // 修改日期
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // 压缩后大小
    local.writeUInt32LE(size, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    nameBuf.copy(local, 30);
    localParts.push(local, entry.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 需要版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移
    nameBuf.copy(central, 46);
    centralParts.push(central);

    offset += local.length + size;
  }

  const centralBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 中央目录结束签名
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, end]);
}

/** CRC32 查表（zip 用） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * 算 CRC32。
 * @param {Buffer} buf 数据
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 准备好全部夹具文件。
 */
function writeFixtures() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const txt = join(FIXTURE_DIR, 'test.txt');
  const docx = join(FIXTURE_DIR, 'test.docx');
  const pdf = join(FIXTURE_DIR, 'test.pdf');
  const scanned = join(FIXTURE_DIR, 'scanned.pdf');
  writeFileSync(txt, buildTxt(), 'utf8');
  writeFileSync(docx, buildDocx());
  writeFileSync(pdf, buildPdf([PAGE1_WORDS.map(([en, zh]) => `${en} ${zh}`), PAGE2_WORDS.map(([en, zh]) => `${en} ${zh}`)]));
  writeFileSync(scanned, buildPdf([[], []], { image: true }));
  return { txt, docx, pdf, scanned };
}

// ══════════════════════════════════════════ 主流程

console.log('\n=== R1 验收：录入格式拓展 + 优先级系统 ===\n');

console.log('[0] 前置检查');
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('✗ 没有 dist/，先跑 npm run build');
  process.exit(1);
}
check('dist/index.html 存在', true);

const fixtures = writeFixtures();
check('夹具 txt / docx / pdf / scanned.pdf 都生成了', ['txt', 'docx', 'pdf', 'scanned'].every((k) => existsSync(fixtures[k])));

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过界面验收（数据层已由 test-api / test-sync / test-presets 覆盖）');
  console.log(`\nR1 验收：${passed} 项通过，${failed} 项失败`);
  process.exit(failed > 0 ? 1 : 0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

const server = serveStatic({ root: ROOT, port: PORT, mode: 'preview' });
let chrome = null;

try {
  const up = await waitForServer(`${ORIGIN}/`);
  if (!up) throw new Error(`预览服务没起来（${ORIGIN}）`);
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });

  // ───────────────────────────────── [1] 动态加载：首屏不加载 mammoth / pdfjs
  console.log('\n[1] 动态加载验证（首屏不加载 mammoth / pdfjs）');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/import`);
    try {
      const heavy = s.requests('/assets/');
      const pdfReq = s.requests('pdf');
      const mammothReq = s.requests('mammoth');
      check('打开录入页时没有请求 pdfjs（assets/pdf-*）', pdfReq.length === 0, pdfReq.map((r) => r.url).join(' | '));
      check('打开录入页时没有请求 mammoth', mammothReq.length === 0, mammothReq.map((r) => r.url).join(' | '));
      check(
        '首屏只加载了入口 chunk（没有顺带拉 docx/pdf 的解析库）',
        heavy.filter((r) => /\/assets\/index-.*\.js$/.test(r.url)).length <= 1,
        heavy.map((r) => r.url.split('/').pop()).join(' | '),
      );
      // 录入页应有的新元素
      const ui = await s.evaluate(`(() => ({
        hasUploadTab: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '上传文件'),
        hasDropZone: document.querySelectorAll('.drop-zone').length > 0,
        accept: document.querySelector('input[type=file]')?.getAttribute('accept') ?? '',
        multiple: document.querySelector('input[type=file]')?.multiple === true,
        priorityLabels: [...document.querySelectorAll('.seg-item')].map((e) => e.textContent.trim()),
        hasPriorityHint: (document.body.textContent || '').includes('会先被「背诵」抽到'),
      }))()`);
      check('有「上传文件」页签', ui.hasUploadTab);
      check('有拖拽上传区', ui.hasDropZone);
      check('accept 列出了 docx 与 pdf', ui.accept.includes('.docx') && ui.accept.includes('.pdf'), ui.accept);
      check('文件输入支持多选', ui.multiple);
      check('优先级是 5 档单选（1~5）', ui.priorityLabels.length === 5, ui.priorityLabels.join(' | '));
      check('优先级旁有「会先被背诵抽到」的说明', ui.hasPriorityHint);
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [2] txt / docx / pdf 真实上传解析
  console.log('\n[2] 真实上传 txt / docx / pdf（多选，逐个解析）');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/import`);
    try {
      await openUploadTab(s);
      const injected = await injectFiles(s, [
        filePayload(fixtures.txt, 'text/plain'),
        filePayload(fixtures.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
        filePayload(fixtures.pdf, 'application/pdf'),
      ]);
      check('3 个文件都进了文件输入框', injected === 3, String(injected));
      const injectErr = await injectError(s);
      check('注入时页面没有抛异常', injectErr === null, String(injectErr));

      const allDone = await waitFor(
        s,
        `document.querySelectorAll('.file-row.done').length === 3 && document.querySelectorAll('.file-row.parsing').length === 0`,
        160,
      );
      const rows = await s.evaluate(`[...document.querySelectorAll('.file-row')].map((r) => ({
        name: r.querySelector('.file-name')?.textContent ?? '',
        status: r.querySelector('.file-status')?.textContent ?? '',
        cls: r.className,
      }))`);
      check('3 个文件都解析完成', allDone, JSON.stringify(rows));
      check('每个文件都显示了自己的状态', rows.length === 3 && rows.every((r) => r.status.includes('已解析')), JSON.stringify(rows));
      check('状态里写明了各自解析出多少行', rows.every((r) => /\d+ 行/.test(r.status)), JSON.stringify(rows.map((r) => r.status)));

      const text = await s.evaluate(`document.querySelector('textarea')?.value ?? ''`);
      for (const [en] of TEST_WORDS) {
        check(`解析后的文本里有「${en}」`, text.includes(en));
      }
      // docx 表格退化后，单词与释义不能糊成一团
      check('docx 表格里的单词与释义没有糊在一起（abandon 与 放弃 之间有分隔）', /abandon[\s\S]{0,4}放弃/.test(text), text.slice(0, 200));

      // pdf 页码顺序：第 1 页的词必须排在第 2 页的词之前
      const idx = (w) => text.indexOf(w);
      check(
        'pdf 页码顺序正确（第 1 页的词都在第 2 页之前）',
        PAGE1_WORDS.every(([en]) => idx(en) >= 0 && idx(en) < idx(PAGE2_WORDS[0][0])),
        `decline=${idx('decline')} efficient=${idx('efficient')}`,
      );

      // 行数显示
      const lineHint = await s.evaluate(
        `[...document.querySelectorAll('.field-hint')].map((e) => e.textContent).find((t) => t.includes('行有效内容')) ?? ''`,
      );
      check('界面显示了「共 N 行有效内容」', /\d+ 行有效内容/.test(lineHint), lineHint);
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [3] 选了 docx 之后才加载 mammoth
  console.log('\n[3] 选中 docx 之后才动态加载 mammoth');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/import`);
    try {
      await openUploadTab(s);
      s.clearRequests();
      await injectFiles(s, [
        filePayload(fixtures.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      ]);
      await waitFor(s, `document.querySelectorAll('.file-row.done').length === 1`, 160);
      const after = s.requests('/assets/');
      check(
        '选了 docx 之后新加载了一个 JS chunk（mammoth 是按需加载的）',
        after.some((r) => /\/assets\/index-.*\.js$/.test(r.url)),
        after.map((r) => r.url.split('/').pop()).join(' | '),
      );
      const pdfReq = s.requests('pdf');
      check('解析 docx 时没有顺带加载 pdfjs', pdfReq.length === 0, pdfReq.map((r) => r.url).join(' | '));
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [4] 扫描件 PDF：明确提示，不崩溃
  console.log('\n[4] 扫描件 PDF（无文本层）');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/import`);
    try {
      await openUploadTab(s);
      await injectFiles(s, [filePayload(fixtures.scanned, 'application/pdf')]);
      await waitFor(s, `document.querySelectorAll('.file-row.failed').length === 1`, 200);
      const info = await s.evaluate(`(() => ({
        failedText: document.querySelector('.file-row.failed')?.textContent ?? '',
        warns: [...document.querySelectorAll('.note.warn')].map((e) => e.textContent).join(' || '),
        textarea: document.querySelector('textarea')?.value ?? '',
        crashed: document.body.textContent.includes('页面渲染失败'),
      }))()`);
      check('扫描件被标成解析失败', info.failedText.includes('扫描'), info.failedText);
      check('给出了「无文本层 / 扫描件」的黄色提示', info.warns.includes('扫描') || info.warns.includes('文本层'), info.warns);
      check('提示里写明了本项目不做 OCR', info.warns.includes('OCR'), info.warns);
      check('没有把空数据静默塞进编辑框', info.textarea.trim() === '', JSON.stringify(info.textarea.slice(0, 60)));
      check('页面没有崩溃', info.crashed === false);
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [5] 优先级：录入 5 → 入库 → 冲突 → 保留/覆盖
  console.log('\n[5] 优先级：写入 / 冲突询问 / 保留 / 覆盖');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/import`);
    try {
      // —— 第一轮：粘贴 3 个词，优先级选 5，走规则解析（不花钱、不联网）——
      await pasteAndParse(s, ['apple\tn. 苹果', 'banana\tn. 香蕉', 'cherry\tn. 樱桃'].join('\n'), 5);
      const gotMerge = await waitFor(s, `location.hash === '#/merge'`, 120);
      check('第一轮解析后进入合并确认页', gotMerge, await s.evaluate('location.hash'));

      await confirmImport(s);
      const gotList = await waitFor(s, `location.hash === '#/list'`, 120);
      check('第一轮入库后跳到列表页', gotList, await s.evaluate('location.hash'));

      const firstRound = await readWords(s, '^(apple|banana|cherry)$');
      check(
        '第一轮 3 个词的 priority 都写成了 5',
        firstRound.length === 3 && firstRound.every((w) => w.priority === 5),
        JSON.stringify(firstRound),
      );
      // 列表页的「优先级徽章 / 筛选 / 排序」是 R3 的内容，这里只确认：
      // 入库之后数据真的能被列表页读到（而不是只在 IndexedDB 里躺着）
      const listShowsWords = await s.evaluate(`(document.body.textContent || '').includes('apple')`);
      check('入库后列表页能看到这些词', listShowsWords);

      // —— 第二轮：同一个词（apple）再录一次，优先级选 2 → 必须弹冲突询问 ——
      await s.evaluate(`location.hash = '#/import'`);
      await new Promise((r) => setTimeout(r, 900));
      await pasteAndParse(s, 'apple\tn. 苹果（第二次）', 2);
      await waitFor(s, `location.hash === '#/merge'`, 120);
      await confirmImport(s);

      const modalUp = await waitFor(s, `document.querySelector('.modal-title')?.textContent === '优先级冲突'`, 120);
      check('第二次录入同一词且优先级不同 → 弹出「优先级冲突」询问框', modalUp);
      const modalInfo = await s.evaluate(`(() => {
        const m = document.querySelector('.modal');
        if (!m) return null;
        return {
          text: m.querySelector('.modal-body')?.textContent ?? '',
          buttons: [...m.querySelectorAll('button')].map((b) => b.textContent.trim()),
        };
      })()`);
      check('询问框写明了「共 1 个词优先级冲突」', (modalInfo?.text ?? '').includes('共 1 个词优先级冲突'), modalInfo?.text?.slice(0, 120));
      check('询问框显示了「当前 5 / 本次 2」', (modalInfo?.text ?? '').includes('当前优先级 5，本次 2'), modalInfo?.text?.slice(0, 200));
      check('询问框有「全部覆盖 / 全部保留」快捷按钮', (modalInfo?.buttons ?? []).some((b) => b.includes('全部覆盖')) && (modalInfo?.buttons ?? []).some((b) => b.includes('全部保留')), JSON.stringify(modalInfo?.buttons));

      // 选「保留」→ apple 的 priority 应该还是 5
      const keepLabel = await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim().startsWith('保留'));
        if (!b) return null;
        const label = b.textContent.trim();
        b.click();
        return label;
      })()`);
      check('单条询问有「保留 5」按钮', keepLabel === '保留 5', String(keepLabel));
      // 「保留」= 这个词本次不入库。全部词都被保留时不该悄悄跳走（那会让用户以为写进去了），
      // 而是留在合并页并明确告诉他「没有任何改动」。
      const stayed = await waitFor(s, `document.body.textContent.includes('没有任何改动')`, 120);
      check('全部保留时留在合并页并明确提示「没有任何改动」', stayed, await s.evaluate('location.hash'));
      const afterKeep = await readWords(s, '^apple$');
      check('选「保留」→ apple 的 priority 仍然是 5', afterKeep.length === 1 && afterKeep[0].priority === 5, JSON.stringify(afterKeep));
      check('选「保留」不会建出重复的词', afterKeep.length === 1, JSON.stringify(afterKeep));

      // —— 第三轮：同一对优先级（5 → 2）应沿用上次的选择，不再弹窗（提示词 2.5 节）——
      await s.evaluate(`location.hash = '#/import'`);
      await new Promise((r) => setTimeout(r, 900));
      await pasteAndParse(s, 'apple\tn. 苹果（第三次）', 2);
      await waitFor(s, `location.hash === '#/merge'`, 120);
      await confirmImport(s);
      const noModal = await waitFor(s, `document.body.textContent.includes('没有任何改动')`, 120);
      check('同一对优先级冲突在本次会话内不再重复弹窗（直接沿用上次选择）', noModal);
      const stillFive = await readWords(s, '^apple$');
      check('沿用「保留」后 apple 依然是 5', stillFive[0]?.priority === 5, JSON.stringify(stillFive));

      // —— 第四轮：换一个优先级（5 → 3）是**新的**冲突 → 重新弹窗，这次选「覆盖」——
      await s.evaluate(`location.hash = '#/import'`);
      await new Promise((r) => setTimeout(r, 900));
      await pasteAndParse(s, 'apple\tn. 苹果（第四次）', 3);
      await waitFor(s, `location.hash === '#/merge'`, 120);
      await confirmImport(s);
      const modalAgain = await waitFor(s, `document.querySelector('.modal-title')?.textContent === '优先级冲突'`, 120);
      check('换一个优先级（5 → 3）会重新询问', modalAgain);
      const overwriteBtn = await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim().startsWith('覆盖为'));
        if (!b) return null;
        const label = b.textContent.trim();
        b.click();
        return label;
      })()`);
      check('询问框里的「覆盖为 3」按钮在', overwriteBtn === '覆盖为 3', String(overwriteBtn));
      const wentList = await waitFor(s, `location.hash === '#/list'`, 120);
      check('选「覆盖」后正常完成入库并跳到列表页', wentList, await s.evaluate('location.hash'));
      const afterOverwrite = await readWords(s, '^apple$');
      check('选「覆盖」→ apple 的 priority 变成 3', afterOverwrite[0]?.priority === 3, JSON.stringify(afterOverwrite));
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [6] 批量冲突：共 N 个 + 全部覆盖
  console.log('\n[6] 批量冲突：总数显示 + 「全部覆盖」');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/import`);
    try {
      const bulk = ['w1', 'w2', 'w3', 'w4', 'w5'];
      const bulkText = bulk.map((w, i) => `${w}\tn. 词${i + 1}`).join('\n');
      // 先造 5 个 priority=1 的词
      await pasteAndParse(s, bulkText, 1);
      await waitFor(s, `location.hash === '#/merge'`, 120);
      await confirmImport(s);
      await waitFor(s, `location.hash === '#/list'`, 120);

      // 再录一次这 5 个词，优先级选 4 → 应该有 5 个冲突
      await s.evaluate(`location.hash = '#/import'`);
      await new Promise((r) => setTimeout(r, 900));
      await pasteAndParse(s, bulkText, 4);
      await waitFor(s, `location.hash === '#/merge'`, 120);
      await confirmImport(s);
      await waitFor(s, `document.querySelector('.modal-title')?.textContent === '优先级冲突'`, 120);
      const modalText = await s.evaluate(`document.querySelector('.modal-body')?.textContent ?? ''`);
      check('询问框显示「共 5 个词优先级冲突」', modalText.includes('共 5 个词优先级冲突'), modalText.slice(0, 100));
      check('询问框一次只问一条、并显示「第 1/5 个冲突」', modalText.includes('第 1/5 个冲突'), modalText.slice(0, 160));
      const bulkButtons = await s.evaluate(`[...document.querySelectorAll('.modal button')].map((b) => b.textContent.trim())`);
      check('有「全部覆盖为本次优先级」快捷按钮', bulkButtons.some((b) => b.includes('全部覆盖')), JSON.stringify(bulkButtons));
      await s.evaluate(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('全部覆盖'))?.click()`);
      await waitFor(s, `location.hash === '#/list'`, 120);
      const afterBulk = await readWords(s, '^w[1-5]$');
      check(
        '「全部覆盖」后 5 个词的 priority 全变成 4',
        afterBulk.length === 5 && afterBulk.every((w) => w.priority === 4),
        JSON.stringify(afterBulk),
      );
    } finally {
      await s.close();
    }
  }
  // ───────────────────────────────── [7] 数据库迁移：老库（v5，没有 priority）→ v6
  console.log('\n[7] 数据库迁移：v5 老库升到 v6，老数据不丢、priority 兜底成 3');
  {
    // ★ 做法：先手写一个 **v5 版式**的同名库（words 表里放两条没有 priority 的"老词"），
    //   再让应用自己打开它 —— 应用里 `indexedDB.open(DB_NAME, DB_VERSION)` 会触发
    //   `onupgradeneeded` → `createSchema` → `migrateToV6Priority`，
    //   于是走的是**和线上完全相同的迁移代码**，而不是测试里另写一份。
    //
    // ★ 必须从一个**同源、但不启动应用**的页面起步（public/r1-seed.html）：
    //   应用页面一打开就会 `indexedDB.open(...)` 占住库，`deleteDatabase` 会被
    //   onblocked 挡住（那种情况下后面的断言会「假通过」）；而 `about:blank` 是
    //   opaque origin，访问 indexedDB 直接抛 SecurityError。
    const s = await openSession(CDP_PORT, `${ORIGIN}/r1-seed.html`);
    try {
      const seeded = await s.evaluate(`(() => new Promise((resolve) => {
        const del = indexedDB.deleteDatabase('blank-sheet-vocab');
        del.onsuccess = del.onerror = () => {
          const open = indexedDB.open('blank-sheet-vocab', 5);
          open.onupgradeneeded = () => {
            const db = open.result;
            const words = db.createObjectStore('words', { keyPath: 'id' });
            words.createIndex('en', 'en', { unique: false });
            words.createIndex('status', 'status', { unique: false });
            words.createIndex('sourceId', 'sourceId', { unique: false });
            words.createIndex('learnOrder', 'learnOrder', { unique: false });
            words.createIndex('attrs.reviewPriority', 'attrs.reviewPriority', { unique: false });
            words.createIndex('updatedAt', 'updatedAt', { unique: false });
            db.createObjectStore('sources', { keyPath: 'id' });
            db.createObjectStore('settings', { keyPath: 'key' });
            db.createObjectStore('sessions', { keyPath: 'id' });
            // 两条**没有 priority** 的老词（这就是要迁移的东西）
            words.put({ id: 'old1', en: 'legacyword', phonetic: '', example: '', senses: [{ id: 's1', text: '老词', aliases: [], enabled: true }], sourceId: 'src1', rawSources: [], attrs: { needSpell: false, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0 }, status: 'unlearned', learnOrder: null, createdAt: 1000, updatedAt: 1000 });
            words.put({ id: 'old2', en: 'anotherword', phonetic: '', example: '', senses: [{ id: 's2', text: '另一个', aliases: [], enabled: true }], sourceId: 'src1', rawSources: [], attrs: { needSpell: true, failCount: 1, failCountTotal: 1, reviewCount: 3, lastReviewAt: 2000, learnedAt: 1500, reviewPriority: 0.5 }, status: 'learned', learnOrder: 1, createdAt: 2000, updatedAt: 2000 });
          };
          open.onsuccess = () => { open.result.close(); resolve(true); };
        };
      }))()`);
      check('造出一个 v5 老库（2 条没有 priority 的词）', seeded === true);
      const seededShape = await s.evaluate(`(() => new Promise((resolve) => {
        const req = indexedDB.open('blank-sheet-vocab', 5);
        req.onsuccess = () => {
          const all = req.result.transaction('words').objectStore('words').getAll();
          all.onsuccess = () => {
            const v = req.result.version;
            req.result.close();
            resolve({ version: v, count: all.result.length, hasPriority: all.result.some((w) => 'priority' in w) });
          };
        };
      }))()`);
      check('老库确实是 v5 且词里没有 priority 字段', seededShape.version === 5 && seededShape.count === 2 && seededShape.hasPriority === false, JSON.stringify(seededShape));

      // 让应用**重新加载**（触发真实的 onupgradeneeded → createSchema → migrateToV6Priority）
      await s.evaluate(`location.href = ${JSON.stringify(`${ORIGIN}/#/import`)}`);
      await new Promise((r) => setTimeout(r, 2500));
      const afterMigrate = await s.evaluate(`(() => new Promise((resolve) => {
        const req = indexedDB.open('blank-sheet-vocab');
        req.onsuccess = () => {
          const db = req.result;
          const store = db.transaction('words').objectStore('words');
          const names = [...store.indexNames];
          const all = store.getAll();
          all.onsuccess = () => resolve({
            version: db.version,
            indexNames: names,
            rows: all.result.map((w) => ({ id: w.id, en: w.en, priority: w.priority, status: w.status, senses: w.senses.length })),
          });
        };
      }))()`);
      check('应用把老库升到了 v6', afterMigrate.version === 6, String(afterMigrate.version));
      check('words 表补上了 priority 索引', afterMigrate.indexNames.includes('priority'), JSON.stringify(afterMigrate.indexNames));
      check('老数据一条都没丢（还是 2 条）', afterMigrate.rows.length === 2, JSON.stringify(afterMigrate.rows));
      check(
        '老词的 priority 被补成 3（默认值）',
        afterMigrate.rows.every((r) => r.priority === 3),
        JSON.stringify(afterMigrate.rows.map((r) => `${r.en}=${r.priority}`)),
      );
      check(
        '老词的其他字段没被动过（状态 / 义项数）',
        afterMigrate.rows.some((r) => r.en === 'legacyword' && r.status === 'unlearned' && r.senses === 1) &&
          afterMigrate.rows.some((r) => r.en === 'anotherword' && r.status === 'learned' && r.senses === 1),
        JSON.stringify(afterMigrate.rows),
      );

      // 迁移后新建的词也带着 priority（新老数据形态一致）
      await pasteAndParse(s, 'freshword\tn. 新词', 3);
      const freshMerge = await waitFor(s, `location.hash === '#/merge'`, 120);
      check('迁移后还能正常录入（走到了合并页）', freshMerge, await s.evaluate('location.hash'));
      await confirmImport(s);
      await waitFor(s, `location.hash === '#/list'`, 120);
      const withFresh = await readWords(s, '^freshword$');
      check('迁移后新录入的词 priority 是 3', withFresh[0]?.priority === 3, JSON.stringify(withFresh));
    } finally {
      await s.close();
    }
  }
} catch (err) {
  failed += 1;
  console.error('\n✗ 测试过程中抛出异常：', err);
} finally {
  chrome?.proc?.kill();
  server.kill();
}

console.log(`\n=== R1 验收：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
