/**
 * ★ T4：设置页「语音」分组。
 *
 * 结构（与阶段文档 T4 任务 4 的线框一致）：
 * ```
 * 语音来源   (•)浏览器内置（免费，无需配置）  ( )有道 TTS（需填密钥）
 * ── 有道 TTS（仅当选中时显示）──
 *   应用 ID / 应用密钥（显示/隐藏）/ 发音人 / 语速 / 语音变体 / [测试朗读]
 * ── 浏览器语音（始终可用）──
 *   可用语音（下拉，列出 name + lang + local）/ 语速 / [试听]
 * ── 缓存 ──
 *   已缓存 N 条 · 约 X MB   [清空缓存]
 *   上次第三方调用：成功 / 失败（原因）
 * ```
 *
 * ── 密钥存储（R4 方案 B）──
 * `appSecret` 存 localStorage / IndexedDB（跟其他设置一起），**不上传服务器**；
 * 它只在浏览器端参与签名，代理转发的是已经签好名的表单。
 */
import { clearTtsCache, formatBytes, getLastThirdPartyResult, isSupported, listBrowserVoices, onVoicesChanged, resetThirdPartyCircuit, resolveBrowserVoice, speak, ttsCacheStats, YOUDAO_VOICES, type TtsCacheStats, type TtsLang } from '../../../services/tts';
import type { SpeechSettings } from '../../../core/types';
import { button, h, select, textInput } from '../../dom';
import { toastError, toastOk } from '../../components/Toast';
import { currentSettings, patchSettings } from './ctx';

/** 语速滑块的范围（与 `tts/index.ts` 的 clampRate 保持一致） */
const RATE_MIN = 0.5;
const RATE_MAX = 1.5;

/**
 * 更新朗读设置里的一个字段。
 * @param patch 要改的字段（`youdao` 内部字段用 `{ youdao: {...} }` 传）
 */
function patchSpeech(patch: Partial<SpeechSettings>): Promise<void> {
  return patchSettings({ speech: { ...currentSettings().speech, ...patch } });
}

/**
 * 渲染「语音」分组。
 */
export function renderSpeechSection(): HTMLElement {
  const settings = currentSettings();
  const wrap = h('div', { class: 'stack' });
  wrap.dataset.role = 'speech-settings';

  wrap.appendChild(
    h(
      'p',
      { class: 'note' },
      '朗读可以用系统自带的语音（免费、离线、装上就能用），也可以接有道 TTS（音色更好，需自己在有道控制台申请密钥）。' +
        '不填密钥时一切照旧走系统语音。',
    ),
  );

  // ─── 语音来源 ───
  const providerBox = h('div', { class: 'radio-group' });
  providerBox.dataset.role = 'speech-provider';

  /**
   * 按「语音来源」决定有道配置区的显隐。
   *
   * ★ 必须先声明后使用：`providerBox` 的 change 回调里会调它，
   *   而回调虽然晚于声明执行，函数本身用 `const` 声明的话会落在**暂时性死区**里
   *   （ESLint 的 no-use-before-define 也会告警）。声明成 let + 提前给空实现最省事。
   */
  let paintYoudaoBox: () => void = () => undefined;

  const providerOptions: { value: SpeechSettings['provider']; label: string }[] = [
    { value: 'browser', label: '浏览器内置（免费，无需配置）' },
    { value: 'youdao', label: '有道 TTS（需填密钥，音色更好）' },
  ];
  for (const opt of providerOptions) {
    const input = h('input', {
      type: 'radio',
      name: 'speech-provider',
      value: opt.value,
      checked: settings.speech.provider === opt.value,
    });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      void patchSpeech({ provider: opt.value }).then(() => {
        paintYoudaoBox();
        toastOk(opt.value === 'youdao' ? '已切换到有道 TTS' : '已切换到浏览器内置语音');
      });
    });
    providerBox.appendChild(h('label', { class: 'radio-row' }, input, h('span', { text: opt.label })));
  }
  wrap.appendChild(
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: '语音来源' }), providerBox),
  );

  // ─── 有道 TTS（仅当选中时显示）───
  const youdaoBox = h('div', { class: 'stack speech-youdao' });
  youdaoBox.dataset.role = 'speech-youdao';

  const appKeyInput = textInput(settings.speech.youdao.appKey, (v) => {
    void patchSpeech({ youdao: { ...currentSettings().speech.youdao, appKey: v } });
    // 改了密钥就把熔断重置：用户很可能就是来修这个的
    resetThirdPartyCircuit();
  }, { placeholder: '应用 ID', class: 'speech-key' });
  youdaoBox.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '应用 ID（appKey）' }),
      appKeyInput,
      h('span', { class: 'field-hint' }, '有道控制台 → 语音合成 → 应用的「应用 ID」。'),
    ),
  );

  const secretInput = h('input', {
    class: 'input speech-key',
    type: 'password',
    value: settings.speech.youdao.appSecret,
    placeholder: '应用密钥',
  });
  secretInput.addEventListener('input', () => {
    void patchSpeech({ youdao: { ...currentSettings().speech.youdao, appSecret: secretInput.value } });
    resetThirdPartyCircuit();
  });
  const secretRow = h('div', { class: 'row' });
  secretRow.appendChild(secretInput);
  secretRow.appendChild(
    button('显示/隐藏', () => {
      secretInput.type = secretInput.type === 'password' ? 'text' : 'password';
    }, { class: 'speech-secret-toggle' }),
  );
  youdaoBox.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '应用密钥（appSecret）' }),
      secretRow,
      h(
        'span',
        { class: 'field-hint' },
        '密钥只存在这台设备的浏览器里，**只在本地参与签名**：发出去的请求里只有签名，没有密钥，服务器也看不到它。',
      ),
    ),
  );

  youdaoBox.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '发音人' }),
      select(
        YOUDAO_VOICES.map((v) => ({ value: v.value, label: v.label })),
        settings.speech.youdao.voiceName,
        (v) => {
          const preset = YOUDAO_VOICES.find((x) => x.value === v);
          void patchSpeech({
            youdao: { ...currentSettings().speech.youdao, voiceName: v },
            // 选发音人时顺手把口音对齐（美式发音人配 en-GB 会读得很怪）
            ...(preset ? { accent: preset.accent } : {}),
          });
          toastOk(`已选择：${preset?.label ?? v}`);
        },
      ),
    ),
  );

  youdaoBox.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '语音变体' }),
      select(
        [
          { value: 'single', label: '单一（只合成一个速度，省调用次数）' },
          { value: 'normal+slow', label: '正常 + 慢速（每个词合成两次，听得更清楚）' },
        ],
        settings.speech.variant,
        (v) => {
          void patchSpeech({ variant: v as SpeechSettings['variant'] });
        },
      ),
      h('span', { class: 'field-hint' }, '有道不支持调节音调，只能用速度做变化；慢速版本会额外计费一次。'),
    ),
  );

  const testResult = h('div', { class: 'test-result' });
  youdaoBox.appendChild(
    h(
      'div',
      { class: 'row' },
      button(
        '测试朗读',
        () => {
          testResult.className = 'test-result';
          testResult.textContent = '正在合成 "abandon"…';
          // 先走一次真实路径（会写缓存），再用结果反馈
          speak('abandon', { rate: currentSettings().speech.rate, lang: currentSettings().speech.accent });
          /**
           * `speak()` 是「触发即返回」的（朗读本身是异步播放），所以这里等一小会儿
           * 再读 `getLastThirdPartyResult()` 把结果写进 testResult / 弹 toast。
           *
           * RULES-R1: 这是**界面反馈的等待**，不是答题计时 ——
           * 它不影响任何作答、不判错、不阻断，与动画/过渡同类。
           */
          window.setTimeout(() => {
            const last = getLastThirdPartyResult();
            if (last === null) {
              testResult.textContent = '已发起朗读。没听到声音请检查系统音量或换个发音人。';
              testResult.className = 'test-result';
              return;
            }
            if (last.ok) {
              testResult.textContent = '成功：第三方语音已合成并播放（同时写入了缓存）。';
              testResult.className = 'test-result ok';
            } else {
              testResult.textContent = `失败：${last.reason}（已自动降级到浏览器语音）`;
              testResult.className = 'test-result bad';
            }
          }, 1500);
        },
        { variant: 'primary', class: 'speech-test' },
      ),
      h('span', { class: 'field-hint', text: '念一个固定词 abandon，用来确认能不能出声、音色好不好。' }),
    ),
  );
  youdaoBox.appendChild(testResult);

  /** 按「语音来源」决定有道配置区的显隐（切换来源时不重建整块） */
  paintYoudaoBox = (): void => {
    const isYoudao = currentSettings().speech.provider === 'youdao';
    youdaoBox.classList.toggle('hidden', !isYoudao);
  };
  paintYoudaoBox();
  wrap.appendChild(youdaoBox);

  // ─── 浏览器语音（始终可用）───
  wrap.appendChild(h('div', { class: 'divider' }));
  wrap.appendChild(h('h4', { class: 'sub-title', text: '浏览器语音（始终可用）' }));

  const voiceSelectBox = h('div', { class: 'stack' });
  voiceSelectBox.dataset.role = 'speech-voice-select';

  /**
   * 重画可用语音下拉。
   *
   * ⚠️ 必须能被**重复调用**：Chrome 首次 `getVoices()` 返回空数组，
   * 要等 `voiceschanged` 才有值 —— 只画一次的下场是「下拉永远是空的，
   * 但设备明明有一堆语音」。
   */
  const paintVoices = (): void => {
    voiceSelectBox.replaceChildren();
    const voices = listBrowserVoices();
    if (!isSupported()) {
      voiceSelectBox.appendChild(h('p', { class: 'field-hint warn', text: '当前浏览器不支持语音合成，朗读功能不可用。' }));
      return;
    }
    if (voices.length === 0) {
      voiceSelectBox.appendChild(
        h('p', { class: 'field-hint', text: '正在读取系统语音…（有些浏览器要等一两秒；一直为空说明系统里没装英文语音）' }),
      );
      return;
    }
    const current = currentSettings().speech;
    const auto = resolveBrowserVoice(current.accent, '');
    const options = [
      { value: '', label: `自动挑选（当前会挑：${auto ? auto.name : '无可用语音'}）` },
      ...voices.map((v) => ({
        value: v.name,
        label: `${v.name} · ${v.lang}${v.localService ? ' · 本地' : ' · 在线'}${v.default ? ' · 系统默认' : ''}`,
      })),
    ];
    voiceSelectBox.appendChild(
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: '可用语音' }),
        select(options, current.voiceName, (v) => {
          void patchSpeech({ voiceName: v }).then(() => {
            toastOk(v === '' ? '已改为自动挑选语音' : `已选择语音：${v}`);
          });
        }),
        h(
          'span',
          { class: 'field-hint' },
          '不同设备能用的语音完全不同，所以默认是「自动挑选」（优先本地、优先高质量）；' +
            '想指定某个音色就在这里选，换设备后名字对不上会自动回退。',
        ),
      ),
    );
    voiceSelectBox.appendChild(
      h(
        'div',
        { class: 'row' },
        button(
          '试听这个语音',
          () => {
            // ★ forceBrowser：试听时**不要**被第三方 provider 抢走，
            //   否则用户在这里挑的是「浏览器语音」，听到的却是有道的声音
            speak('abandon', {
              forceBrowser: true,
              rate: currentSettings().speech.rate,
              lang: currentSettings().speech.accent,
            });
          },
          { class: 'speech-preview' },
        ),
        h('span', { class: 'field-hint', text: '念的是 abandon（只走浏览器语音，不用第三方）。' }),
      ),
    );
  };
  paintVoices();
  // 语音列表就绪后重画一次（Chrome 的 voiceschanged）
  const offVoices = onVoicesChanged(paintVoices);
  // 页面被替换时摘掉监听（否则切页后这个回调还会跑，往已卸载的节点里写）
  wrap.addEventListener('DOMNodeRemoved', () => offVoices(), { once: true });
  wrap.appendChild(voiceSelectBox);

  // 语速滑块
  const rate = currentSettings().speech.rate;
  const rateSlider = h('input', {
    type: 'range',
    class: 'range speech-rate',
    min: String(RATE_MIN),
    max: String(RATE_MAX),
    step: '0.05',
    value: String(rate),
  });
  const rateLabel = h('span', { class: 'field-hint', text: `语速：${rate.toFixed(2)}×（默认 0.9，比系统默认略慢、更清晰）` });
  rateSlider.addEventListener('input', () => {
    rateLabel.textContent = `语速：${Number(rateSlider.value).toFixed(2)}×`;
  });
  rateSlider.addEventListener('change', () => {
    void patchSpeech({ rate: Number(rateSlider.value) });
  });
  wrap.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label', text: '语速' }), rateSlider, rateLabel));

  // 口音
  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '口音' }),
      select(
        [
          { value: 'en-US', label: '美式（en-US）' },
          { value: 'en-GB', label: '英式（en-GB）' },
        ],
        currentSettings().speech.accent,
        (v) => {
          void patchSpeech({ accent: v as TtsLang });
        },
      ),
      h('span', { class: 'field-hint' }, '同时决定浏览器语音的 lang 与有道的默认发音人。'),
    ),
  );

  // ─── 缓存 ───
  wrap.appendChild(h('div', { class: 'divider' }));
  wrap.appendChild(h('h4', { class: 'sub-title', text: '语音缓存' }));

  const cacheLine = h('div', { class: 'field-hint', text: '正在统计…' });
  cacheLine.dataset.role = 'speech-cache-stats';
  const lastLine = h('div', { class: 'field-hint' });
  lastLine.dataset.role = 'speech-last-call';

  /** 重画缓存统计与「上次第三方调用」 */
  const paintCache = (): void => {
    void ttsCacheStats().then((s: TtsCacheStats) => {
      cacheLine.textContent =
        s.count === 0
          ? '还没有缓存（第三方朗读过的词会自动缓存，第二次朗读是秒播、断网也能听）'
          : `已缓存 ${s.count} 条 · 约 ${formatBytes(s.bytes)}`;
    });
    const last = getLastThirdPartyResult();
    if (last === null) {
      lastLine.textContent = '上次第三方调用：还没调用过';
    } else {
      lastLine.textContent = last.ok
        ? `上次第三方调用：成功${last.reason === '' ? '' : `（${last.reason}）`}`
        : `上次第三方调用：失败（${last.reason}）`;
      lastLine.className = `field-hint${last.ok ? '' : ' warn'}`;
    }
  };
  paintCache();

  wrap.appendChild(
    h(
      'div',
      { class: 'row' },
      button(
        '刷新统计',
        () => {
          paintCache();
        },
        { variant: 'ghost' },
      ),
      button(
        '清空语音缓存',
        () => {
          void clearTtsCache()
            .then((n) => {
              toastOk(n === 0 ? '缓存本来就是空的' : `已清空 ${n} 条语音缓存`);
              paintCache();
            })
            .catch((err: unknown) => {
              console.error('[settings/speech] 清空缓存失败', err);
              toastError('清空缓存失败，可以稍后再试');
            });
        },
        { variant: 'danger', class: 'speech-clear-cache' },
      ),
    ),
  );
  wrap.appendChild(cacheLine);
  wrap.appendChild(lastLine);

  wrap.appendChild(
    h(
      'p',
      { class: 'note' },
      isSupported()
        ? '浏览器语音无需任何配置即可使用；第三方 TTS 只在填了密钥并选中它时才走。'
        : '当前环境不支持浏览器语音合成，只能靠第三方 TTS（需要 https 且浏览器支持）。',
    ),
  );

  return wrap;
}
