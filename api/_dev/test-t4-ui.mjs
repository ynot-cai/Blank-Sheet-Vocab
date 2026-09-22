/**
 * T4 验收：朗读零成本优化 + TTS 抽象层与有道适配器
 * 运行：`npm run test:t4-ui`
 *
 * ── 覆盖范围 ──
 *  [1] 零成本优化（不填密钥也生效）：normalizeForSpeech 三条硬性等式、
 *      默认 rate 0.9、voice 优先挑 localService、1.5 秒内重复触发只念一次
 *  [2] 抽象层三级降级：未填密钥 → 浏览器语音；填了且成功 → 第三方 + 写缓存；
 *      第三方失败 → 静默降级（不弹框）；连续失败 3 次 → 本会话不再尝试
 *  [3] 缓存：第二次朗读秒播（不打网络）、缓存统计、清空
 *  [4] 有道适配器：**签名与 Node 参考实现逐字一致**（这是最容易错的一处）
 *  [5] 代理安全：api/tts-proxy.ts 里没有 appSecret、不写日志内容、校验 Origin
 *  [6] 设置页：语音分组存在、密钥可填、默认 rate 0.9
 *
 * ── 关键设计：本地假上游 ──
 * 测试不能真的去求有道（要密钥、要计费、联网不稳）。所以本地起一个
 * **假的有道 ttsapi**，并让 dev server 把 `/api/tts-proxy` 代理到本地 API 服务
 * （`api/_dev/server.mjs` + 环境变量 `TTS_TARGET` 指向假上游）。
 * 这样走的是**和线上完全同一条代码路径**（真实处理函数 + 真实转发逻辑），
 * 只是上游换成了可控的假服务。
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4244;
const API_PORT = 4245;
const FAKE_TTS_PORT = 4246;
const CDP_PORT = 9406;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'blank-sheet-vocab';

/** 与 src/dev/selftest.ts 的 YOUDAO_SIGN_SAMPLE / scripts/youdaoSign.mjs 的 SAMPLE 必须一致 */
const YOUDAO_SAMPLE = {
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  salt: '2fa4f0d0-1e6b-4c2f-9c1a-3f8f2b7d5e10',
  curtime: '1700000000',
  q: 'abandon',
};

let passed = 0;
let failed = 0;

/**
 * 一条断言。
 *
 * 输出里带**递增编号**：有一次一个 `check()` 调用点因为我改坏了函数而
 * 完全没打印，光看「44 通过 / 1 失败」根本不知道是哪一条 —— 编号能让
 * 「第几条没出现」一眼可见。失败用 `X` 而不是 ✗，是为了在 Windows 控制台
 * 重定向到文件时不会被编码吃掉（✗ 在部分代码页下会变成乱码，反而更难查）。
 *
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} detail 失败时的具体数值
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ [${passed + failed}] ${name}`);
  } else {
    failed += 1;
    console.log(`  X [${passed + failed}] ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/**
 * 去掉源码里的注释（**只留代码**）。
 *
 * 用途：断言「代理文件里没有 appSecret」这类安全属性时，注释里的说明文字
 * （例如「不读、不存、不打印 appSecret」）不能被算成「代码里出现了 appSecret」。
 *
 * ⚠️ 为什么是逐字符扫描而不是几个正则：正则版实测**不可靠** ——
 *   JSDoc 块里只要出现 `//`（这个文件里到处都是），
 *   `/\/\*[\s\S]*?\*\//` 与「逐行去 //」的组合就会在错误的位置收尾，
 *   于是注释文字又漏回「代码」里，断言假阳性（第一次跑就是栽在这）。
 *   扫描器同时处理字符串字面量，避免把字符串里的 `//` 误当注释。
 * @param {string} src 源码
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  /** 当前状态：代码 / 块注释 / 行注释 / 字符串 */
  let state = 'code';
  let quote = '';
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        state = 'string';
        quote = ch;
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += '\n';
      }
      i += 1;
      continue;
    }
    // state === 'string'
    out += ch;
    if (ch === '\\') {
      out += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === quote) state = 'code';
    i += 1;
  }
  return out;
}

/** Node 参考实现（与 scripts/youdaoSign.mjs 同一算法，这里内联一份做交叉验证） */
function nodeSignInput(q) {
  return q.length <= 20 ? q : `${q.slice(0, 10)}${q.length}${q.slice(-10)}`;
}
function nodeYoudaoSign({ appKey, appSecret, salt, curtime, q }) {
  return createHash('sha256').update(`${appKey}${nodeSignInput(q)}${salt}${curtime}${appSecret}`, 'utf8').digest('hex');
}

const NODE_REFERENCE_SIGN = nodeYoudaoSign(YOUDAO_SAMPLE);

/** 假的「有道 ttsapi」：记录收到的表单，成功时回一段 mp3 头 */
const fakeUpstream = {
  requests: [],
  /** 让下一次请求失败（用于验证降级）；'code' | 'http' | null */
  failMode: null,
  server: null,
};

/**
 * 起假上游。
 */
function startFakeUpstream() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const params = Object.fromEntries(new URLSearchParams(body));
        fakeUpstream.requests.push({ path: req.url, params, contentType: req.headers['content-type'] ?? '' });

        if (fakeUpstream.failMode === 'http') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errorCode: '500', message: '（假上游）故意失败' }));
          return;
        }
        if (fakeUpstream.failMode === 'code') {
          // 有道的真实失败形态：HTTP 200 + JSON 错误体
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errorCode: '202', message: '签名校验失败' }));
          return;
        }
        // 成功：回一段假的 mp3。
        // ★ Content-Type 必须是 audio/*：前端按它区分「成功（音频）」与
        //   「失败（JSON 错误体）」（`readYoudaoResponse`）。写错成 application/json
        //   会让客户端把音频当错误体去 JSON.parse —— 实测表现为
        //   「有道 TTS 失败： HTTP 200」这种完全看不出原因的报错。
        const audio = Buffer.from('ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000FAKE-MP3-BYTES', 'binary');
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length) });
        res.end(audio);
      });
    });
    server.listen(FAKE_TTS_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 起 vite dev（把 /api 代理到本地 api 服务） */
function startDev() {
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  return spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    // ★ 必须把 API 端口一并传给 vite：否则它的 /api 代理会指向默认的 3000，
    //   而本测试的 API 服务在 API_PORT 上 —— 表现是代理 ECONNREFUSED，
    //   看起来像「TTS 代理不工作」，其实是代理指错了地方。
    env: { ...process.env, LOCAL_API_PORT: String(API_PORT) },
  });
}

/** 起本地 API 服务（api/_dev/server.mjs 会把 /api/* 映射到真实处理函数） */
function startApiServer() {
  return spawn(process.execPath, ['api/_dev/server.mjs'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      LOCAL_API_PORT: String(API_PORT),
      // ★ 关键：把 TTS 代理的上游指向假服务（生产环境留空即用有道官方地址）
      TTS_TARGET: `http://127.0.0.1:${FAKE_TTS_PORT}/ttsapi`,
      // 白名单放开本地来源（与 ai-proxy 的同一套机制）
      ALLOWED_ORIGIN: `${ORIGIN},http://localhost:${PORT},http://127.0.0.1:5173`,
    },
  });
}

/** 等服务器就绪 */
async function waitForServer(url, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 注入：错误收集器 + 朗读调用记录 + `<audio>` 打桩。
 *
 * ★ `<audio>` 必须打桩：无头环境里 `new Audio(...).play()` 会 reject
 *   （没有音频输出设备 / 自动播放策略），而我们的探针要断言的是
 *   「走到播放这一步了吗、播的是哪一段」—— 打桩后这两个问题都能答，
 *   也不会因为播放失败被误判成功能坏了。
 */
const COLLECTOR = `
window.__t4Errors = [];
window.__t4Spoken = [];
window.__t4Played = [];
(() => {
  // ① 记录所有 speechSynthesis.speak 调用
  if ('speechSynthesis' in window) {
    const synth = window.speechSynthesis;
    const raw = synth.speak.bind(synth);
    synth.speak = function (u) { try { window.__t4Spoken.push(String(u && u.text)); } catch (e) {} return raw(u); };
  } else {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak(u) { window.__t4Spoken.push(String(u && u.text)); }, cancel() {}, getVoices() { return []; }, addEventListener() {}, removeEventListener() {} },
      configurable: true, writable: true,
    });
  }
  // ② 打桩 <audio>：记录播放的字节数与来源，play() 立刻 resolve
  const RawAudio = window.Audio;
  window.__t4AudioUrls = [];
  window.__t4AudioCtorCalls = 0;
  window.Audio = function (src) {
    window.__t4AudioCtorCalls += 1;
    const el = new RawAudio();
    if (src !== undefined) el.src = String(src);
    el.play = function () {
      window.__t4Played.push({ src: String(el.src || ''), hasBlob: String(el.src || '').startsWith('blob:') });
      return Promise.resolve();
    };
    el.pause = function () {};
    return el;
  };
})();
const _ce = console.error;
console.error = function (...a) { window.__t4Errors.push({ kind: 'console', msg: a.map(String).join(' ') }); return _ce.apply(console, a); };
const _cw = console.warn;
console.warn = function (...a) { window.__t4Errors.push({ kind: 'console', msg: a.map(String).join(' ') }); return _cw.apply(console, a); };
window.addEventListener('error', (ev) => window.__t4Errors.push({ kind: 'error', msg: String(ev.message || ev.type) }));
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  window.__t4Errors.push({ kind: 'rejection', msg: r instanceof Error ? r.message : String(r) });
});
`;

/** 把朗读设置写成指定状态（直接改库，避免为了测调度去点一堆控件） */
const setSpeech = (patch) => `(async () => {
  const dao = await import('/src/dao/index.ts');
  const cfg = await import('/src/core/config.ts');
  const now = cfg.getSettings();
  await dao.settings.set({ speech: Object.assign({}, now.speech, ${JSON.stringify(patch)}) });
  const fresh = await dao.settings.get();
  return fresh.speech;
})()`;

/** 清空 TTS 缓存 */
const clearCache = `(async () => {
  const tts = await import('/src/services/tts/index.ts');
  return tts.clearTtsCache();
})()`;

/** 读缓存统计 */
const cacheStats = `(async () => {
  const tts = await import('/src/services/tts/index.ts');
  return tts.ttsCacheStats();
})()`;

/** 数词库（验朗读不写业务数据） */
const COUNT_WORDS = `(() => new Promise((resolve) => {
  const req = indexedDB.open('${DB_NAME}');
  req.onsuccess = () => {
    const db = req.result;
    const g = db.transaction('words').objectStore('words').count();
    g.onsuccess = () => { db.close(); resolve(g.result); };
    g.onerror = () => { db.close(); resolve(-1); };
  };
  req.onerror = () => resolve(-1);
}))()`;

const fakeServer = await startFakeUpstream();
const apiProc = startApiServer();
const dev = startDev();
let browserProc = null;

try {
  if (!(await waitForServer(ORIGIN))) throw new Error('dev server 没起来');
  if (!(await waitForServer(`http://127.0.0.1:${API_PORT}/api/health`))) throw new Error('本地 API 服务没起来');
  const browser = findBrowser();
  if (!browser) throw new Error('找不到 Chrome / Edge');
  const launched = await launch(browser, CDP_PORT, { windowSize: '1280,900' });
  browserProc = launched.proc;

  /**
   * 开一个新页面（装 stub 与错误收集器）。
   * @param {string} hash 形如 '#/settings'
   * @param {number} waitMs 额外等待
   */
  async function open(hash, waitMs = 2600) {
    const s = await openSession(CDP_PORT, `${ORIGIN}/${hash}`, { waitMs });
    await s.addInitScript(COLLECTOR);
    await s.reload(waitMs);
    return s;
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [1] 零成本优化：文本预处理 / 默认语速 / voice 挑选 / 去重 ════════');
  {
    const page = await open('#/home');
    const norm = await page.evaluate(`(async () => {
      const m = await import('/src/services/tts/normalize.ts');
      return {
        phonetic: m.normalizeForSpeech('abandon /əˈbændən/'),
        contraction: m.normalizeForSpeech("don't"),
        hyphen: m.normalizeForSpeech('well-known'),
        bracket: m.normalizeForSpeech('run (v.)'),
        chinese: m.normalizeForSpeech('abandon 放弃'),
        year: m.normalizeForSpeech('1999'),
        spaces: m.normalizeForSpeech('  a   b  '),
        wont: m.normalizeForSpeech("won't"),
        lets: m.normalizeForSpeech("let's"),
        chineseKept: m.normalizeForSpeech('放弃', true),
      };
    })()`);
    console.log('   normalizeForSpeech 实测：', JSON.stringify(norm, null, 2));
    check('★ normalizeForSpeech("abandon /əˈbændən/") === "abandon"', norm.phonetic === 'abandon', norm.phonetic);
    check('★ normalizeForSpeech("don\'t") === "do not"', norm.contraction === 'do not', norm.contraction);
    check('★ normalizeForSpeech("well-known") === "well known"', norm.hyphen === 'well known', norm.hyphen);
    check('剥离括号内容（run (v.) → run）', norm.bracket === 'run', norm.bracket);
    check('剥离中文（英文模式下不念释义）', norm.chinese === 'abandon', norm.chinese);
    check('数字转英文读法（1999 → nineteen ninety nine）', norm.year === 'nineteen ninety nine', norm.year);
    check('合并多余空白', norm.spaces === 'a b', norm.spaces);
    check('won\'t → will not', norm.wont === 'will not', norm.wont);
    check("let's → let us", norm.lets === 'let us', norm.lets);
    check('中文语言时保留中文', norm.chineseKept === '放弃', norm.chineseKept);

    const rateDefault = await page.evaluate(`(async () => {
      const cfg = await import('/src/core/config.ts');
      return cfg.DEFAULT_SETTINGS.speech.rate;
    })()`);
    check('★ 默认语速 = 0.9（不是系统默认的 1.0）', rateDefault === 0.9, String(rateDefault));

    const voicePick = await page.evaluate(`(async () => {
      const v = await import('/src/services/tts/voices.ts');
      const mk = (name, lang, localService, def) => ({ name, lang, localService, default: !!def, voiceURI: name });
      const voices = [
        mk('English (America) Compact', 'en-US', true, true),   // 低质量，但 local+default
        mk('Google US English', 'en-US', false, false),          // 在线、名称含 google
        mk('Samantha (Enhanced)', 'en-US', true, false),         // 本地 + 高质量
        mk('Ting-Ting', 'zh-CN', true, false),
      ];
      const picked = v.pickBrowserVoice('en-US', voices);
      const pickedGb = v.pickBrowserVoice('en-GB', voices);
      return { picked: picked && picked.name, pickedGb: pickedGb && pickedGb.name };
    })()`);
    console.log('   voice 挑选：', JSON.stringify(voicePick));
    check('★ voice 优先挑 localService === true 的英文语音', voicePick.picked === 'Samantha (Enhanced)', String(voicePick.picked));
    check('没有完全匹配时回退到前缀匹配的英文语音', voicePick.pickedGb === 'Samantha (Enhanced)', String(voicePick.pickedGb));

    // 去重：1.5 秒内重复触发同一文本只念一次
    await page.evaluate(setSpeech({ provider: 'browser', voiceName: '', rate: 0.9 }));
    const dedupe = await page.evaluate(`(async () => {
      const tts = await import('/src/services/tts/index.ts');
      window.__t4Spoken.length = 0;
      tts.speak('repeat');
      tts.speak('repeat');
      tts.speak('repeat');
      return window.__t4Spoken.length;
    })()`);
    await new Promise((r) => setTimeout(r, 1600));
    const afterWindow = await page.evaluate(`(async () => {
      const tts = await import('/src/services/tts/index.ts');
      tts.speak('repeat');
      return window.__t4Spoken.length;
    })()`);
    console.log(`   1.5 秒内连点 3 次 → 发声 ${dedupe} 次；窗口过后再点 → 共 ${afterWindow} 次`);
    check('★ 1.5 秒内重复触发同一文本 → 只念一次', dedupe === 1, `实际 ${dedupe}`);
    check('窗口过后再点可以正常发声', afterWindow === 2, `实际 ${afterWindow}`);
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [2] 抽象层三级降级 ════════');
  {
    const page = await open('#/home');
    await page.evaluate(clearCache);
    fakeUpstream.requests.length = 0;

    // ① 未填密钥：即使 provider=youdao 也应该走浏览器语音（密钥缺失即降级）
    await page.evaluate(setSpeech({ provider: 'youdao', youdao: { appKey: '', appSecret: '', voiceName: 'youmeimei' } }));
    const noKey = await page.evaluate(`(async () => {
      const tts = await import('/src/services/tts/index.ts');
      window.__t4Spoken.length = 0;
      window.__t4Played.length = 0;
      tts.speak('nokeyword');
      await new Promise((r) => setTimeout(r, 300));
      return { spoken: window.__t4Spoken.slice(), played: window.__t4Played.length, last: tts.getLastThirdPartyResult() };
    })()`);
    console.log('   未填密钥：', JSON.stringify(noKey));
    check('★ 未填密钥 → 走浏览器语音发声', noKey.spoken.includes('nokeyword'), JSON.stringify(noKey.spoken));
    check('未填密钥时不发第三方请求（假上游 0 次调用）', fakeUpstream.requests.length === 0, `${fakeUpstream.requests.length} 次`);

    // ② 填了密钥且成功：走第三方 + 写缓存
    await page.evaluate(setSpeech({
      provider: 'youdao',
      youdao: { appKey: 'test-app-key', appSecret: 'test-app-secret', voiceName: 'youmeimei' },
    }));
    const beforeOk = fakeUpstream.requests.length;
    const success = await page.evaluate(`(async () => {
      const tts = await import('/src/services/tts/index.ts');
      window.__t4Spoken.length = 0;
      window.__t4Played.length = 0;
      await tts.speakAsync('thirdparty');
      await new Promise((r) => setTimeout(r, 200));
      // 直接打一次代理，把响应头也带出来（排查「音频被当成错误」这类问题）
      const form = new URLSearchParams({ q: 'probe', appKey: 'k', salt: 's', sign: 'x', signType: 'v3', curtime: '1', voiceName: 'youmeimei', format: 'mp3', speed: '0.9' });
      const raw = await fetch('/api/tts-proxy', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
      const buf = await raw.arrayBuffer();
      // 把服务端日志里那两行 DIAG 也带回来（代理到底把什么头设进去了）
      return {
        spoken: window.__t4Spoken.slice(),
        played: window.__t4Played.slice(),
        last: tts.getLastThirdPartyResult(),
        probe: { status: raw.status, contentType: raw.headers.get('Content-Type'), bytes: buf.byteLength, head: new TextDecoder().decode(buf.slice(0, 40)) },
      };
    })()`);
    const afterOk = fakeUpstream.requests.length;
    console.log(`   填了密钥：上游调用 ${afterOk - beforeOk} 次，播放 ${success.played.length} 次`);
    console.log('   代理直连探测：', JSON.stringify(success.probe));
    check('★ 填了密钥且成功 → 走第三方（上游被调用）', afterOk > beforeOk, `${beforeOk} → ${afterOk}`);
    check('★ 第三方成功时播放的是音频字节（blob URL）', success.played.some((p) => p.hasBlob), JSON.stringify(success.played));
    check('第三方成功时不走浏览器语音', !success.spoken.includes('thirdparty'), JSON.stringify(success.spoken));
    check('记录了「上次第三方调用：成功」', success.last?.ok === true, JSON.stringify(success.last));

    // 校验真实请求里的签名与 Node 参考实现一致（走完整链路）
    /**
     * ⚠️ 必须**按 q 找**那一条请求，不能取 `requests` 的最后一条 ——
     * 上面为了看响应头额外打过一次 `q=probe` 的探测请求，
     * 「最后一条」会变成探测请求，签名校验就会拿 `sign=x` 去比（实测踩过）。
     */
    const realReq = [...fakeUpstream.requests].reverse().find((r) => r.params.q === 'thirdparty');
    check('上游收到了 thirdparty 的合成请求', realReq !== undefined, JSON.stringify(fakeUpstream.requests.map((r) => r.params.q)));
    const expectedSign = realReq === undefined ? '' : nodeYoudaoSign({
      appKey: realReq.params.appKey,
      appSecret: 'test-app-secret',
      salt: realReq.params.salt,
      curtime: realReq.params.curtime,
      q: realReq.params.q,
    });
    console.log('   上游收到的表单字段：', JSON.stringify(Object.keys(realReq?.params ?? {}).sort()));
    check('★ 真实请求的签名与 Node 参考实现一致', realReq?.params.sign === expectedSign, `浏览器=${realReq?.params.sign} Node=${expectedSign}`);
    check('表单含 signType=v3', realReq?.params.signType === 'v3', String(realReq?.params.signType));
    check('表单里没有 appSecret（密钥不出本机）', realReq !== undefined && !JSON.stringify(realReq.params).includes('test-app-secret'), JSON.stringify(realReq?.params));
    check('请求是表单编码', (realReq?.contentType ?? '').includes('application/x-www-form-urlencoded'), String(realReq?.contentType));

    // ③ 缓存：第二次朗读同一词 → 秒播（不再打上游）
    /**
     * ⚠️ 必须先等过**去重窗口**（1.5 秒）。
     *
     * 「去重」和「缓存」是两件不同的优化：前者管「同一句话 1.5 秒内不要连读」，
     * 后者管「同一个词不要重复请求上游」。第一次跑这个用例时两次朗读只隔了 224ms，
     * 被去重直接拦掉了 —— 看起来像「缓存命中不播放」，其实是去重生效了。
     * 等过窗口再念，才能真正测到缓存这条路。
     */
    await new Promise((r) => setTimeout(r, 1700));
    const beforeCache = fakeUpstream.requests.length;
    const cached = await page.evaluate(`(async () => {
      const tts = await import('/src/services/tts/index.ts');
      const cfg = await import('/src/core/config.ts');
      window.__t4Played.length = 0;
      const audioCtorCallsBefore = window.__t4AudioCtorCalls ?? 0;
      const beforeState = { provider: cfg.getSettings().speech.provider, disabled: tts.isThirdPartyDisabled() };
      await tts.speakAsync('thirdparty');
      await new Promise((r) => setTimeout(r, 300));
      const stats = await tts.ttsCacheStats();
      return {
        played: window.__t4Played.slice(),
        last: tts.getLastThirdPartyResult(),
        stats,
        beforeState,
        afterState: { provider: cfg.getSettings().speech.provider, disabled: tts.isThirdPartyDisabled() },
        audioCtorCalls: (window.__t4AudioCtorCalls ?? 0) - audioCtorCallsBefore,
        errs: (window.__t4Errors ?? []).filter((e) => e.kind !== 'console').slice(0, 3),
        warns: (window.__t4Errors ?? []).filter((e) => e.kind === 'console').slice(-3),
      };
    })()`);
    const afterCache = fakeUpstream.requests.length;
    console.log(`   第二次朗读同一词：上游调用 ${afterCache - beforeCache} 次，播放 ${cached.played.length} 次，Audio 构造 ${cached.audioCtorCalls} 次，缓存 ${JSON.stringify(cached.stats)}`);
    console.log('   状态：', JSON.stringify({ before: cached.beforeState, after: cached.afterState }));
    if (cached.played.length === 0) console.log('   排查信息：', JSON.stringify({ warns: cached.warns, errs: cached.errs }, null, 2));
    check('★ 第二次朗读命中缓存 → 不再请求上游', afterCache === beforeCache, `${beforeCache} → ${afterCache}`);
    check('★ 缓存命中也能正常播放', cached.played.length > 0, JSON.stringify(cached.played));
    check('缓存命中时标注「（缓存命中）」', String(cached.last?.reason ?? '').includes('缓存'), JSON.stringify(cached.last));

    const stats = await page.evaluate(cacheStats);
    console.log('   缓存统计：', JSON.stringify(stats));
    check('缓存里有 1 条（只缓存了念过的那个词）', stats.count >= 1, JSON.stringify(stats));
    check('缓存统计带体积', typeof stats.bytes === 'number' && stats.bytes > 0, JSON.stringify(stats));
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [3] 失败静默降级 + 连续 3 次熔断 ════════');
  {
    const page = await open('#/home');
    await page.evaluate(clearCache);
    await page.evaluate(setSpeech({
      provider: 'youdao',
      youdao: { appKey: 'test-app-key', appSecret: 'test-app-secret', voiceName: 'youmeimei' },
    }));

    // 让假上游返回「200 + JSON 错误」（有道的真实失败形态）
    fakeUpstream.failMode = 'code';
    const failed = await page.evaluate(`(async () => {
      const tts = await import('/src/services/tts/index.ts');
      window.__t4Spoken.length = 0;
      tts.speak('failonce');
      await new Promise((r) => setTimeout(r, 600));
      return {
        spoken: window.__t4Spoken.slice(),
        last: tts.getLastThirdPartyResult(),
        toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
        fatal: !!document.querySelector('[data-role="fatal-page"]'),
      };
    })()`);
    console.log('   第三方失败：', JSON.stringify(failed));
    check('★ 第三方失败 → 静默降级到浏览器语音', failed.spoken.includes('failonce'), JSON.stringify(failed.spoken));
    /**
     * ⚠️ 只断言「没有与朗读相关的错误提示」。
     * 空词库时应用会正常弹一条「先去录入页加几个词吧」——
     * 那是既有功能，不该被这条断言误伤（第一版就是被它判失败的）。
     */
    const ttsToasts = (failed.toasts ?? []).filter((t) => /朗读|语音|TTS|有道|失败/.test(String(t)));
    check('★ 第三方失败不弹朗读相关的错误框打断', ttsToasts.length === 0, JSON.stringify(failed.toasts));
    check('第三方失败不弹致命页', !failed.fatal, `fatal=${failed.fatal}`);
    check('记录了失败原因', failed.last?.ok === false && String(failed.last?.reason ?? '').length > 0, JSON.stringify(failed.last));
    check('错误码 202 映射成人话（签名错误…）', String(failed.last?.reason ?? '').includes('签名'), String(failed.last?.reason));

    // 连续失败 3 次 → 本会话不再尝试第三方
    const circuit = await page.evaluate(`(async () => {
      const tts = await import('/src/services/tts/index.ts');
      for (const w of ['f1', 'f2', 'f3']) { tts.speak(w); await new Promise((r) => setTimeout(r, 350)); }
      return { disabled: tts.isThirdPartyDisabled() };
    })()`);
    const callsBefore = fakeUpstream.requests.length;
    const afterCircuit = await page.evaluate(`(async () => {
      const tts = await import('/src/services/tts/index.ts');
      window.__t4Spoken.length = 0;
      tts.speak('aftercircuit');
      await new Promise((r) => setTimeout(r, 600));
      return { spoken: window.__t4Spoken.slice(), disabled: tts.isThirdPartyDisabled() };
    })()`);
    const callsAfter = fakeUpstream.requests.length;
    console.log(`   熔断：disabled=${circuit.disabled}；熔断后上游调用 ${callsAfter - callsBefore} 次，发声 ${JSON.stringify(afterCircuit.spoken)}`);
    check('★ 连续失败 3 次后进入熔断', circuit.disabled === true, JSON.stringify(circuit));
    check('★ 熔断后不再请求第三方', callsAfter === callsBefore, `${callsBefore} → ${callsAfter}`);
    check('熔断后直接用浏览器语音发声', afterCircuit.spoken.includes('aftercircuit'), JSON.stringify(afterCircuit.spoken));

    // 用户改密钥 → 熔断重置
    const reset = await page.evaluate(`(async () => {
      const tts = await import('/src/services/tts/index.ts');
      tts.resetThirdPartyCircuit();
      return tts.isThirdPartyDisabled();
    })()`);
    check('重置熔断后可以再试第三方', reset === false, String(reset));

    fakeUpstream.failMode = null;
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [4] 有道签名：与 Node 参考实现逐字一致 ════════');
  {
    const page = await open('#/home');
    const signInfo = await page.evaluate(`(async () => {
      const y = await import('/src/services/tts/youdao.ts');
      const sample = ${JSON.stringify(YOUDAO_SAMPLE)};
      const sign = await y.youdaoSign(sample);
      const inputShort = y.youdaoSignInput(sample.q);
      const longQ = 'abcdefghijKLMNOPQRSTUVWXYZ0123456789';
      const inputLong = y.youdaoSignInput(longQ);
      return { sign, inputShort, inputLong, longQ, longQExpected: longQ.slice(0,10) + longQ.length + longQ.slice(-10) };
    })()`);
    console.log(`   固定输入：${JSON.stringify(YOUDAO_SAMPLE)}`);
    console.log(`   浏览器 sign = ${signInfo.sign}`);
    console.log(`   Node     sign = ${NODE_REFERENCE_SIGN}`);
    check('★ 浏览器 WebCrypto 的 sign 与 Node crypto 完全一致', signInfo.sign === NODE_REFERENCE_SIGN, `${signInfo.sign} vs ${NODE_REFERENCE_SIGN}`);
    check('短文本（≤20）的 input 就是 q', signInfo.inputShort === YOUDAO_SAMPLE.q, signInfo.inputShort);
    check('长文本（>20）的 input = 前10 + 长度 + 后10', signInfo.inputLong === signInfo.longQExpected, `${signInfo.inputLong} vs ${signInfo.longQExpected}`);

    const selftest = await page.evaluate(`(async () => {
      const st = await import('/src/dev/selftest.ts');
      return st.runYoudaoSignSelfTest();
    })()`);
    console.log('   自测项：', JSON.stringify(selftest, null, 2));
    check('window.__selftest.youdaoSign 自测 5 项全通过', Array.isArray(selftest) && selftest.length === 5 && selftest.every((r) => r.ok), JSON.stringify(selftest.filter((r) => !r.ok)));
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [5] 代理安全（不碰密钥 / 不记内容） ════════');
  {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(join(ROOT, 'api', 'tts-proxy.ts'), 'utf8');
    /**
     * ⚠️ 只看**代码**，不看注释。
     *
     * 为什么：这个文件的注释里**故意**写着「不读、不存、不打印 appSecret」
     * 这类说明（那正是它要自证的安全属性）。把注释一起扫进去会得出
     * 「代理里出现了 appSecret」的假阳性 —— 判据应该是「有没有真的用到它」。
     */
    const code = stripComments(src);
    const leakIdx = code.toLowerCase().indexOf('appsecret');
    check(
      '★ 代理代码里没有 appSecret 相关变量（注释说明不算）',
      leakIdx < 0,
      leakIdx < 0 ? '' : JSON.stringify(code.slice(Math.max(0, leakIdx - 160), leakIdx + 80)),
    );
    check('★ 代理不 import 数据库（无状态）', !/_lib\/db\.js|inventory/.test(code), '');
    check('代理校验 Origin', src.includes('isOriginAllowed'), '');
    check('代理响应不缓存（no-store）', src.includes('no-store'), '');
    check('代理删除 set-cookie / content-length', src.includes('set-cookie') && src.includes('content-length'), '');
    // 关键：日志行里不能出现 body / 表单内容
    const logLines = src.split('\n').filter((l) => l.includes('console.'));
    const leaks = logLines.filter((l) => /body|params|form|sign|secret|q\b/i.test(l.replace(/\/\/.*$/, '')));
    console.log('   代理里的 console 调用：', JSON.stringify(logLines.map((l) => l.trim())));
    check('★ 代理的日志不含请求内容（body / 签名 / 文本）', leaks.length === 0, JSON.stringify(leaks));

    /**
     * 端到端验证「非白名单来源被拒」。
     *
     * 用一个不在 ALLOWED_ORIGIN 里的 Origin 直接打代理 —— 这是浏览器之外
     * 的调用方唯一能伪造的东西（CORS 头在服务端只是校验，不是防线，
     * 真正的防线就是这里返回 403）。
     */
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/tts-proxy`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'q=x&appKey=y',
    });
    console.log('   非白名单来源 →', res.status, (await res.text()).slice(0, 80));
    check('★ 非白名单来源访问 TTS 代理 → 403', res.status === 403, `实际 ${res.status}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [6] 设置页「语音」分组 ════════');
  {
    const page = await open('#/settings');
    /**
     * ★ 先把来源拨回「浏览器内置」再断言默认态。
     *
     * 为什么：这个页面是**新建的标签页**，读到的是上一个用例（[3] 把 provider
     * 设成了 youdao）留下的设置 —— 那不是「默认值」，是上一个用例的残留。
     * 直接断言「默认选中浏览器」测的是用例顺序，不是功能。
     */
    await page.evaluate(setSpeech({ provider: 'browser', youdao: { appKey: '', appSecret: '', voiceName: 'youmeimei' } }));
    await page.reload(2600);
    const sec = await page.evaluate(`(() => {
      const d = [...document.querySelectorAll('.settings-page details.section')].find((x) => x.dataset.section === 'speech');
      if (!d) return { found: false, groups: [...document.querySelectorAll('.settings-page details.section')].map((x) => x.dataset.section) };
      d.open = true;
      const wrap = d.querySelector('[data-role="speech-settings"]');
      return {
        found: true,
        hasWrap: !!wrap,
        providers: [...(wrap?.querySelectorAll('[data-role="speech-provider"] input') ?? [])].map((r) => ({ value: r.value, checked: r.checked })),
        youdaoHidden: wrap?.querySelector('[data-role="speech-youdao"]')?.classList.contains('hidden') ?? null,
        rate: wrap?.querySelector('.speech-rate')?.value ?? '',
        rateMax: wrap?.querySelector('.speech-rate')?.max ?? '',
        hasVoiceSelect: !!wrap?.querySelector('[data-role="speech-voice-select"]'),
        hasKeyInputs: wrap?.querySelectorAll('.speech-key').length ?? 0,
        hasClearCache: !!wrap?.querySelector('.speech-clear-cache'),
        text: (wrap?.textContent ?? '').slice(0, 200),
      };
    })()`);
    console.log('   语音分组：', JSON.stringify(sec));
    check('★ 设置页有「语音」分组', sec.found && sec.hasWrap, JSON.stringify(sec.groups));
    check('两种语音来源可选（浏览器 / 有道）', sec.providers?.length === 2, JSON.stringify(sec.providers));
    check('默认选中浏览器内置', sec.providers?.find((p) => p.value === 'browser')?.checked === true, JSON.stringify(sec.providers));
    check('未选有道时密钥区隐藏', sec.youdaoHidden === true, String(sec.youdaoHidden));
    check('★ 语速默认 0.9、上限 1.5', sec.rate === '0.9' && sec.rateMax === '1.5', `value=${sec.rate} max=${sec.rateMax}`);
    check('有可用语音下拉', sec.hasVoiceSelect, '');
    check('有应用 ID + 应用密钥两个输入框', sec.hasKeyInputs >= 2, String(sec.hasKeyInputs));
    check('有「清空语音缓存」入口', sec.hasClearCache, '');

    // 切到有道 → 密钥区出现
    const afterSwitch = await page.evaluate(`(() => {
      const wrap = document.querySelector('[data-role="speech-settings"]');
      const radio = [...(wrap?.querySelectorAll('[data-role="speech-provider"] input') ?? [])].find((r) => r.value === 'youdao');
      if (!radio) return { ok: false };
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const youdaoVisible = await page.evaluate(`!document.querySelector('[data-role="speech-youdao"]')?.classList.contains('hidden')`);
    check('切到有道后密钥区显示', afterSwitch.ok && youdaoVisible, `ok=${afterSwitch.ok} visible=${youdaoVisible}`);
    check('页面没有未捕获异常', (await page.evaluate(`(window.__t4Errors ?? []).filter((e) => e.kind !== 'console').length`)) === 0);

    // 收尾：恢复浏览器语音
    await page.evaluate(setSpeech({ provider: 'browser' }));
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [7] 朗读不写业务数据 ════════');
  {
    const page = await open('#/home');
    const before = await page.evaluate(COUNT_WORDS);
    await page.evaluate(clearCache);
    await page.evaluate(setSpeech({ provider: 'browser' }));
    await page.evaluate(`(async () => {
      const tts = await import('/src/services/tts/index.ts');
      for (const w of ['a', 'b', 'c']) { tts.speak(w); await new Promise((r) => setTimeout(r, 200)); }
    })()`);
    const after = await page.evaluate(COUNT_WORDS);
    console.log(`   朗读前后词库条数：${before} → ${after}`);
    check('朗读不增删任何词', before === after, `${before} → ${after}`);
    const cacheRows = await page.evaluate(cacheStats);
    check('浏览器语音不写 TTS 缓存（缓存只存第三方音频）', cacheRows.count === 0, JSON.stringify(cacheRows));
    await page.close();
  }
} catch (err) {
  console.error('T4 验收脚本出错：', err);
  failed += 1;
} finally {
  dev.kill();
  apiProc.kill();
  fakeServer.close();
  if (browserProc) browserProc.kill();
}

console.log(`\n════ T4 验收结果：${passed} 通过 / ${failed} 失败 ════`);
if (failed > 0) {
  console.log('任一项 FAIL —— 不许声称完成。');
  process.exit(1);
}
process.exit(0);
