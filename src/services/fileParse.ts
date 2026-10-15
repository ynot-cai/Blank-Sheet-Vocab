/**
 * 文件解析服务（R1 阶段新增）：把用户选的文件转成**纯文本**。
 *
 * 设计边界（很重要，别越界）：
 *   · 这里**只做「文件 → 文本」**这一步，不解析单词、不切义项、不碰数据库。
 *   · 出来的文本和「用户手打进文本框」完全等价，直接进现有的
 *     「文本预览 → AI 解析（阶段 03 的 parseWordBatch）→ 合并确认 → 入库」链路。
 *     这样格式拓展不会在解析链路上开出第二条分支，也就不会有「只在 docx 路径上
 *     才出现的 bug」——这正是 `services/presetVocab.ts` 用的同一条思路。
 *
 * ★ 两个依赖（mammoth / pdfjs-dist）**必须动态 import**：
 *   两者体积都很大（pdfjs 主包 1MB+），静态引入会让首屏白白多下几百 KB。
 *   只有用户真的选了 docx / pdf 时才加载。
 *
 * ★ 本项目**不做 OCR**。PDF 没有文本层（扫描件）就明确告诉用户换个文件，
 *   不静默入库空数据——那会让用户以为「导入成功但词没了」，比报错更难查。
 */

/** 支持的文件类型 */
export type ParsedFileType = 'txt' | 'docx' | 'pdf';

/** 解析结果 */
export interface ParsedFile {
  /** 文件名（含扩展名，给界面显示） */
  name: string;
  /** 文件类型 */
  type: ParsedFileType;
  /** 解析出的纯文本（已规范化换行，末尾无多余空行） */
  text: string;
  /** 警告（如「第 3 页可能是扫描件，无文本层」）——不阻断流程，界面用黄条展示 */
  warnings: string[];
  /** 非空行数（界面显示「已解析 N 行」用） */
  lineCount: number;
}

/** 解析失败 */
export class FileParseError extends Error {
  /** 给用户看的建议（可为空） */
  readonly hint: string;

  /**
   * @param message 错误说明
   * @param hint 补救建议
   */
  constructor(message: string, hint = '') {
    super(message);
    this.name = 'FileParseError';
    this.hint = hint;
  }
}

/** 支持的扩展名 */
const SUPPORTED_EXTENSIONS: ParsedFileType[] = ['txt', 'docx', 'pdf'];

/**
 * 「无文本层」判定阈值：一页提取到的字符少于它，就认为这一页很可能是扫描图片。
 * 取 10 是因为正常的一页哪怕只有标题也有几十个字符；
 * 阈值定太高（比如 50）会把「只有一两行字的封面页」误报成扫描件。
 */
const NO_TEXT_LAYER_THRESHOLD = 10;

/**
 * 扫描件判定阈值：整份 PDF 的平均每页字符数低于它 → 认定整份基本没有文本层。
 * 取 30：正常的单词表 PDF 平均每页几百字符，扫描件则接近 0（OCR 之前是空的）。
 */
const SCANNED_AVG_THRESHOLD = 30;

/**
 * 取文件扩展名（小写，不含点）。
 * @param name 文件名
 */
export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx < 0 ? '' : name.slice(idx + 1).toLowerCase();
}

/**
 * 判断文件是否是本应用支持的格式（按扩展名）。
 *
 * ★ 按扩展名判断而不是 `file.type`：docx 的 MIME 在各系统上五花八门
 *   （有的浏览器给空串、有的给 application/octet-stream），只看 MIME 会漏掉真实文件。
 *
 * @param file 用户选的文件
 */
export function isSupported(file: File): boolean {
  return (SUPPORTED_EXTENSIONS as string[]).includes(extensionOf(file.name));
}

/**
 * `.txt/.csv/.md` 允许的扩展名（纯文本家族都当 txt 处理）。
 */
const TEXT_LIKE_EXTENSIONS = ['txt', 'csv', 'md', 'text', 'tsv'];

/**
 * 规范化文本：统一成 `\n`、去掉行尾空白、把连续 3 个以上空行压成 1 个空行、
 * 去掉首尾空行。
 *
 * ★ 为什么必须做：docx / pdf 提取出来的文本经常夹着一堆空行与行尾空格，
 *   而下一步的解析是「一行一个词条」——空行会让行数统计虚高，
 *   行尾的 `\r` 会让「Tab 分隔」这类判断直接失效。
 *   注意**不能**把空行全删掉：AI 解析靠空行分辨词组边界，全删会把上下文糊成一团。
 *
 * @param text 原始文本
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n') // CRLF / CR → LF
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+$/, '')) // 去行尾空白
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // 3 个以上连续换行压成 1 个空行
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * 统计非空行数。
 * @param text 文本
 */
export function countLines(text: string): number {
  return text.split('\n').filter((l) => l.trim() !== '').length;
}

/**
 * 用给定编码解码一段字节。
 * @param buffer 字节
 * @param encoding 编码名
 * @returns 解码失败返回 null（编码名不被支持时）
 */
function tryDecode(buffer: ArrayBuffer, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * 解码纯文本文件。
 *
 * 两种常见情况都要照顾到：
 *   1. **UTF-8**（现代默认，绝大多数情况）；
 *   2. **GBK/GB18030**（Windows 记事本「ANSI」另存的中文词表，国内很常见）。
 *
 * 判定「解出来是不是乱码」不靠猜字节，而靠**数替换字符**：
 * UTF-8 解 GBK 字节会产出大量 U+FFFD（），一看就知道不对，这时再试 GBK。
 * 反过来 GBK 解 UTF-8 字节也会出现乱码，所以两边都比一次，取坏字符少的那个。
 *
 * @param buffer 文件字节
 */
export function decodeTextFile(buffer: ArrayBuffer): { text: string; warning: string | null } {
  const utf8 = tryDecode(buffer, 'utf-8');
  if (utf8 !== null && !utf8.includes('\uFFFD')) return { text: utf8, warning: null };

  const gbk = tryDecode(buffer, 'gbk') ?? tryDecode(buffer, 'gb18030');
  if (gbk !== null) {
    const utf8Bad = utf8 === null ? Number.POSITIVE_INFINITY : (utf8.match(/\uFFFD/g) ?? []).length;
    const gbkBad = (gbk.match(/\uFFFD/g) ?? []).length;
    if (gbkBad < utf8Bad) {
      return { text: gbk, warning: '这个文件看起来是 GBK/ANSI 编码，已按 GBK 读取（如果中文乱码，请另存为 UTF-8 再上传）' };
    }
  }

  if (utf8 !== null) {
    return {
      text: utf8,
      warning: utf8.includes('\uFFFD') ? '文件里存在无法解码的字符（可能是编码不对），已尽量读取，请检查预览内容' : null,
    };
  }
  throw new FileParseError('无法识别这个文本文件的编码', '请把文件另存为 UTF-8 编码后再上传');
}

/**
 * 解析 .txt / .csv / .md 等纯文本文件。
 * @param file 文件
 * @param type 归到的类型（统一按 'txt' 处理）
 */
async function parsePlainText(file: File, type: ParsedFileType): Promise<ParsedFile> {
  const buffer = await file.arrayBuffer();
  const { text, warning } = decodeTextFile(buffer);
  const normalized = normalizeText(text);
  const warnings: string[] = [];
  if (warning !== null) warnings.push(warning);
  if (normalized === '') warnings.push('文件里没有可用的文本内容');
  return { name: file.name, type, text: normalized, warnings, lineCount: countLines(normalized) };
}

/**
 * 解析 .docx（Word 文档）。
 *
 * 用 `mammoth.extractRawText`：只要纯文本、不要样式。
 * 已知取舍：**表格会退化成纯文本行**（单元格之间用换行分隔），
 * 单词表这类内容够用；真要还原表格结构得上 HTML 转换，对这个应用是过度设计。
 *
 * @param file 文件
 */
async function parseDocx(file: File): Promise<ParsedFile> {
  const mammoth = await import('mammoth');
  const buffer = await file.arrayBuffer();
  let value: string;
  try {
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    value = result.value;
  } catch (err) {
    throw new FileParseError(
      `Word 文档解析失败：${err instanceof Error ? err.message : String(err)}`,
      '如果这个 .docx 是用很老的 Word 存的（.doc），请先另存为 .docx 或另存为 .txt 再上传',
    );
  }
  const normalized = normalizeText(value);
  const warnings: string[] = [];
  if (normalized === '') {
    warnings.push('这个 Word 文档里没有提取到文字（可能是纯图片的文档）');
  }
  return { name: file.name, type: 'docx', text: normalized, warnings, lineCount: countLines(normalized) };
}

/** pdfjs 的模块形态（动态 import 的结果，类型从包里推断不出来，这里显式声明） */
interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (src: { data: ArrayBuffer }) => { promise: Promise<PdfDocument> };
}

/** pdfjs 的文档对象（只用到我们需要的部分） */
interface PdfDocument {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy: () => Promise<void>;
}

/** pdfjs 的页面对象 */
interface PdfPage {
  getTextContent: () => Promise<{ items: { str?: string }[] }>;
}

/** worker 是否已经配置过（配置一次就够，重复配置会白跑一次 import） */
let pdfWorkerReady: Promise<void> | null = null;

/**
 * 配置 pdfjs 的 worker。
 *
 * ★ worker 必须配：不配的话 pdfjs 会在主线程上跑解析，
 *   遇到几十页的 PDF 会把页面卡死（用户看到「点了没反应」）。
 * ★ 用 `?url` 让 Vite 把 worker 文件当**静态资源**输出并给出真实 URL：
 *   这是官方推荐、也是唯一在 `base: './'`（本项目构建配置）下不会 404 的写法——
 *   手拼 `${BASE_URL}pdf.worker.min.mjs` 在子路径部署时会挂。
 * @param pdfjs pdfjs 模块
 */
async function ensurePdfWorker(pdfjs: PdfJsModule): Promise<void> {
  if (pdfWorkerReady !== null) {
    await pdfWorkerReady;
    return;
  }
  pdfWorkerReady = (async () => {
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  })();
  try {
    await pdfWorkerReady;
  } catch (err) {
    // 配置失败就退回「主线程解析」——慢，但总比整个功能不可用强
    pdfWorkerReady = null;
    console.warn('[fileParse] PDF worker 加载失败，退回主线程解析', err);
  }
}

/**
 * 解析 .pdf（**只提取文本层**，本项目不做 OCR）。
 *
 * 逐页 `getTextContent()` 拼接 `item.str`：
 *   · 页内**按行拼接**（pdfjs 的 items 是按位置排列的碎片，带 `hasEOL` 时补换行），
 *     否则「abandon 放弃」会被粘成「abandon放弃」或整页一行；
 *   · 页与页之间插一个空行，保证**页码顺序**清晰（getPage 是按页码顺序取的）。
 *
 * @param file 文件
 */
async function parsePdf(file: File): Promise<ParsedFile> {
  const pdfjs = (await import('pdfjs-dist')) as unknown as PdfJsModule;
  await ensurePdfWorker(pdfjs);

  const data = await file.arrayBuffer();
  const warnings: string[] = [];
  let doc: PdfDocument | null = null;
  try {
    doc = await pdfjs.getDocument({ data }).promise;
    const pages: string[] = [];
    let emptyPages = 0;
    let totalChars = 0;

    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const item of content.items) {
        const str = typeof item.str === 'string' ? item.str : '';
        if (str === '') continue;
        parts.push(str);
        // pdfjs 会在行尾的碎片上标 hasEOL；没有它的话整页会粘成一长串，
        // 「一行一个词条」的假设就崩了。
        if ((item as { hasEOL?: boolean }).hasEOL) parts.push('\n');
      }
      const pageText = normalizeText(parts.join(''));
      pages.push(pageText);
      totalChars += pageText.length;
      if (pageText.length < NO_TEXT_LAYER_THRESHOLD) {
        emptyPages += 1;
        warnings.push(`第 ${n} 页可能是扫描件，无文本层（没有提取到文字）`);
      }
    }

    const text = normalizeText(pages.join('\n\n'));
    const avg = doc.numPages > 0 ? totalChars / doc.numPages : 0;

    // 整份基本没有文本层 → 这是扫描件，明确劝退并说明本项目不做 OCR
    if (doc.numPages > 0 && avg < SCANNED_AVG_THRESHOLD) {
      throw new FileParseError(
        '这份 PDF 像是扫描图片，无法提取文字。',
        '请换用有文字的 PDF（用 Word/WPS 另存的 PDF 通常带文本层），或先用 OCR 工具转成 .txt 再上传。本项目不做 OCR。',
      );
    }
    if (emptyPages > 0) {
      warnings.unshift(`共 ${doc.numPages} 页，其中 ${emptyPages} 页没有文本层（可能是扫描图），已跳过`);
    }
    if (text === '') {
      warnings.push('这份 PDF 没有提取到任何文字');
    }
    return { name: file.name, type: 'pdf', text, warnings, lineCount: countLines(text) };
  } catch (err) {
    if (err instanceof FileParseError) throw err;
    throw new FileParseError(
      `PDF 解析失败：${err instanceof Error ? err.message : String(err)}`,
      '可能是文件损坏、被加密，或者不是标准 PDF。可以先用 PDF 阅读器「另存为文本」再上传',
    );
  } finally {
    // 释放 pdfjs 的 worker 与内存：几十页的 PDF 不释放会一直占着内存
    if (doc !== null) {
      try {
        await doc.destroy();
      } catch (err) {
        console.warn('[fileParse] 释放 PDF 资源失败', err);
      }
    }
  }
}

/**
 * 解析一个文件，返回纯文本。
 *
 * @param file 用户选的文件
 * @throws FileParseError 不支持的格式 / 加密 / 扫描件 / 编码无法识别
 */
export async function parseFile(file: File): Promise<ParsedFile> {
  const ext = extensionOf(file.name);
  if (TEXT_LIKE_EXTENSIONS.includes(ext)) return parsePlainText(file, 'txt');
  if (ext === 'docx') return parseDocx(file);
  if (ext === 'pdf') return parsePdf(file);
  if (ext === 'doc') {
    throw new FileParseError(
      '不支持老的 .doc 格式',
      '请用 Word/WPS 打开后「另存为」.docx，或直接另存为 .txt 再上传',
    );
  }
  throw new FileParseError(
    `不支持的文件格式：.${ext || '（无扩展名）'}`,
    '目前支持 .txt / .csv / .md / .docx / .pdf',
  );
}
