/**
 * ★ T4：TTS 音频缓存（IndexedDB）。
 *
 * ── 为什么要缓存 ──
 * 第三方 TTS 是**按字符计费**的，而背单词场景的朗读高度重复
 * （同一个词会被反复点、反复抽到）。缓存之后：
 * 1. 第二次朗读同一个词是**秒播**（连网络都不发）；
 * 2. **断网也能朗读**已缓存的词；
 * 3. 省掉大量重复计费。
 *
 * ── 缓存键为什么是哈希而不是原字符串 ──
 * 键包含「提供方 + 归一化文本 + 速度 + 变体」。直接用原文拼键的话，
 * 一个含换行/引号的词条会得到很长的键；而且键里带明文文本不利于以后
 * 做「按前缀清缓存」之类的操作。这里统一 SHA-256 成短键（取前 32 个十六进制字符，
 * 碰撞概率对个人词库量级完全可以忽略）。
 *
 * ── 为什么不做过期 ──
 * 语音合成结果是**确定性的**（同样的文本 + 同样的 voice = 同样的音频），
 * 没有「过期」的概念。用户想清理就在设置页点「清空语音缓存」。
 */
import { STORE, tx, txRun } from '../../core/db';

/** 缓存里的一条记录 */
interface TtsCacheRow {
  /** 缓存键（sha256 前 32 位） */
  key: string;
  /** 音频字节 */
  bytes: ArrayBuffer;
  /** 字节数（列表统计不用再读 bytes，省一次反序列化） */
  size: number;
  /** 写入时间 */
  createdAt: number;
}

/** 缓存统计 */
export interface TtsCacheStats {
  /** 条数 */
  count: number;
  /** 总体积（字节） */
  bytes: number;
}

/** 缓存键的长度（sha256 十六进制前 N 位） */
const KEY_LENGTH = 32;

/**
 * 算缓存键。
 *
 * 入参的**顺序与含义都是缓存正确性的一部分**：任何一项变了都必须落到不同的键上，
 * 否则会出现「换了发音人却播了上一个发音人的音频」这种很难查的问题。
 * @param parts 参与键的字段（提供方 / 文本 / 速度 / 变体 / 发音人）
 */
export async function ttsCacheKey(parts: {
  providerId: string;
  text: string;
  speed: number;
  variant: number;
  voice: string;
}): Promise<string> {
  const raw = [parts.providerId, parts.voice, parts.speed.toFixed(2), String(parts.variant), parts.text].join('\u0000');
  const data = new TextEncoder().encode(raw);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // 没有 WebCrypto（http 非 localhost）时退化成简单哈希：**仍然能工作**，
    // 只是碰撞概率略高。朗读属于可降级功能，不该因为拿不到 subtle 就完全不可用。
    let h = 2166136261;
    for (const b of data) {
      h ^= b;
      h = Math.imul(h, 16777619);
    }
    return `fnv-${(h >>> 0).toString(16)}`;
  }
  const digest = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, KEY_LENGTH);
}

/**
 * 读缓存。
 * @param key 缓存键
 * @returns 音频字节；没命中返回 null
 */
export async function getCachedAudio(key: string): Promise<ArrayBuffer | null> {
  try {
    const row = await tx<TtsCacheRow | undefined>(STORE.ttsCache, 'readonly', (s) => s.get(key) as IDBRequest<TtsCacheRow | undefined>);
    const bytes = row?.bytes;
    // 老记录 / 脏数据兜底：不是 ArrayBuffer 就当没命中（宁可重新合成，也不要播坏数据）
    return bytes instanceof ArrayBuffer ? bytes : null;
  } catch (err) {
    console.warn('[tts] 读缓存失败（当作没命中）', err);
    return null;
  }
}

/**
 * 写缓存。
 *
 * ⚠️ 失败**不抛错**：缓存写不进去（配额满 / 隐私模式）不该让朗读失败，
 * 这一次照常播、下次再合成一遍而已。
 * @param key 缓存键
 * @param bytes 音频字节
 */
export async function putCachedAudio(key: string, bytes: ArrayBuffer): Promise<void> {
  if (bytes.byteLength === 0) return;
  try {
    await txRun(STORE.ttsCache, 'readwrite', (s) => {
      s.put({ key, bytes, size: bytes.byteLength, createdAt: Date.now() } satisfies TtsCacheRow);
    });
  } catch (err) {
    console.warn('[tts] 写缓存失败（不影响本次朗读）', err);
  }
}

/**
 * 缓存统计（条数 + 总体积）。
 *
 * 只读 `size` 字段，不读 `bytes` —— 后者会把所有音频反序列化一遍，
 * 缓存大了以后打开设置页会明显卡顿。
 */
export async function ttsCacheStats(): Promise<TtsCacheStats> {
  try {
    const rows = await tx<{ size?: number }[]>(STORE.ttsCache, 'readonly', (s) => s.getAll() as IDBRequest<{ size?: number }[]>);
    let bytes = 0;
    for (const r of rows) if (typeof r.size === 'number' && Number.isFinite(r.size)) bytes += r.size;
    return { count: rows.length, bytes };
  } catch (err) {
    console.warn('[tts] 读缓存统计失败', err);
    return { count: 0, bytes: 0 };
  }
}

/**
 * 清空语音缓存。
 * @returns 清掉的条数
 */
export async function clearTtsCache(): Promise<number> {
  const before = await ttsCacheStats();
  await tx(STORE.ttsCache, 'readwrite', (s) => s.clear());
  return before.count;
}

/**
 * 把字节数格式化成人类可读的体积。
 * @param bytes 字节数
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
