#!/usr/bin/env node
/**
 * 有道 TTS 签名的**参考实现**（Node 版），配合《有道 TTS 接入教程》使用。
 *
 * ── 为什么需要这个脚本 ──
 * 有道签名的算法有三个反直觉的点（见下），写错的表现只有一句
 * 「202 签名校验失败」，完全看不出哪里错了。所以给用户一份**能在本地跑、
 * 只用 Node 标准库**的参考实现：
 *
 * ```bash
 * node scripts/youdaoSign.mjs                      # 用内置的测试输入算一个参考值
 * node scripts/youdaoSign.mjs --appKey xx --appSecret yy --q abandon
 * ```
 *
 * 然后把浏览器里 `await __selftest.youdaoSignValue()` 的输出与这里比对 ——
 * 两个**互相独立**的实现（浏览器 WebCrypto vs Node crypto）算出同一个哈希，
 * 才能证明算法写对了（只测一边等于自己跟自己对答案）。
 *
 * ── 算法（照抄官方文档）──
 * ```
 * sign = SHA256(appKey + input + salt + curtime + appSecret)
 * input = q.length > 20 ? q 前10 + q.length + q 后10 : q
 * ```
 * ⚠️ 三个坑：
 * 1. 拼接用 **q 本身**，`input` 只参与签名、不作为参数发给有道；
 * 2. `q.length` 是**字符数**（JS 的字符串长度）；
 * 3. 生成签名时 q **不做 URL encode**（编码只在发送时做）。
 *
 * 这个脚本**不发任何请求**，只算签名，纯离线。
 */
import { createHash, randomUUID } from 'node:crypto';

/** 默认测试输入（与 src/dev/selftest.ts 的 YOUDAO_SIGN_SAMPLE 必须完全一致） */
const SAMPLE = {
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  salt: '2fa4f0d0-1e6b-4c2f-9c1a-3f8f2b7d5e10',
  curtime: '1700000000',
  q: 'abandon',
};

/**
 * 解析 `--key value` 形式的参数。
 * @param {string[]} argv process.argv.slice(2)
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) out[key] = 'true';
    else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

/**
 * 计算签名用的 input 字段。
 * @param {string} q 待合成文本
 */
export function signInput(q) {
  if (q.length <= 20) return q;
  return `${q.slice(0, 10)}${q.length}${q.slice(-10)}`;
}

/**
 * 算签名。
 * @param {{appKey: string, appSecret: string, salt: string, curtime: string, q: string}} args 参数
 */
export function youdaoSign(args) {
  const input = signInput(args.q);
  return createHash('sha256')
    .update(`${args.appKey}${input}${args.salt}${args.curtime}${args.appSecret}`, 'utf8')
    .digest('hex');
}

/**
 * 生成一份「可以直接用 curl 发」的完整表单（可选，方便手工调通接口）。
 * @param {{appKey: string, appSecret: string, q: string, voiceName?: string, speed?: number}} args 参数
 */
export function signedForm(args) {
  const salt = randomUUID();
  const curtime = String(Math.floor(Date.now() / 1000));
  const sign = youdaoSign({ appKey: args.appKey, appSecret: args.appSecret, salt, curtime, q: args.q });
  const form = new URLSearchParams({
    q: args.q,
    appKey: args.appKey,
    salt,
    sign,
    signType: 'v3',
    curtime,
    voiceName: args.voiceName ?? 'youmeimei',
    format: 'mp3',
    speed: String(Math.min(2, Math.max(0.5, args.speed ?? 1))),
  });
  return { salt, curtime, sign, input: signInput(args.q), form };
}

// ── 命令行入口（被 import 时不执行）──
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')) {
  const args = parseArgs(process.argv.slice(2));
  const merged = { ...SAMPLE, ...args };
  const hasSecret = typeof args.appSecret === 'string' && args.appSecret !== 'true';

  console.log('\n=== 有道 TTS 签名参考实现（Node）===\n');
  console.log('输入：');
  console.log(`  appKey    = ${merged.appKey}`);
  console.log(`  appSecret = ${hasSecret ? '（已提供，不打印）' : merged.appSecret}`);
  console.log(`  salt      = ${merged.salt}`);
  console.log(`  curtime   = ${merged.curtime}`);
  console.log(`  q         = ${merged.q}`);
  console.log(`  q.length  = ${merged.q.length}`);
  console.log(`  input     = ${signInput(merged.q)}`);
  const sign = youdaoSign(merged);
  console.log(`\nsign = ${sign}\n`);
  console.log('把上面这个 sign 与浏览器里的输出比对：');
  console.log('  await __selftest.youdaoSignValue()   // 用内置测试输入');
  console.log('两者必须完全一致（同样的输入 → 同样的 sha256）。\n');

  if (hasSecret) {
    const f = signedForm({ appKey: merged.appKey, appSecret: merged.appSecret, q: merged.q });
    console.log('顺带给你一份可直接发的表单（含随机 salt / 当前时间）：');
    console.log(`  curl -sS -X POST https://openapi.youdao.com/ttsapi \\\n    -H 'Content-Type: application/x-www-form-urlencoded' \\\n    --data '${f.form.toString()}' --output test.mp3`);
    console.log('\n（本项目更推荐直接用设置页的「测试朗读」按钮，它会走同一条路径。）\n');
  }
}
