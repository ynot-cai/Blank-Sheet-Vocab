import { aiConfigFromSettings, getLastAiRoute, testConnection } from '../../../services/ai';
import { normalizeApiBase } from '../../../core/syncHelper';
import { button, checkbox, h, textInput } from '../../dom';
import { toastError, toastOk } from '../../components/Toast';
import { currentSettings, patchSettings } from './ctx';

/**
 * B 区：AI 解析（接口地址 / 模型名 / 密钥全部由用户自己填）。
 */
export function renderAiSection(): HTMLElement {
  const settings = currentSettings();
  const wrap = h('div', { class: 'stack' });

  wrap.appendChild(
    h('p', { class: 'note' }, '这里填你在用的服务。可以是官方地址，也可以是任何中转/代理地址，接口格式统一为 OpenAI 兼容格式。'),
  );
  wrap.appendChild(
    h('p', { class: 'note' }, '只保证 DeepSeek 官方可用，其他服务能填通就能用，不单独适配。'),
  );
  wrap.appendChild(
    h(
      'p',
      { class: 'note warn' },
      '密钥只存在这台设备的浏览器里，每台设备各填各的，不会上传。清浏览器缓存会丢，记得重新填。',
    ),
  );
  wrap.appendChild(
    h(
      'p',
      { class: 'note' },
      '无论直连还是走代理，你的密钥都只存在本机浏览器，服务器不会保存——代理只在转发的那一瞬间用到它，用完即丢。',
    ),
  );

  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '接口地址' }),
      textInput(settings.ai.baseUrl, (v) => void patchSettings({ ai: { ...currentSettings().ai, baseUrl: v } }), {
        placeholder: 'https://api.deepseek.com',
      }),
      h('span', { class: 'field-hint', text: '填 https://api.deepseek.com 或 https://api.deepseek.com/v1 都可以，程序自己补 /chat/completions。' }),
    ),
  );

  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '模型名' }),
      textInput(settings.ai.model, (v) => void patchSettings({ ai: { ...currentSettings().ai, model: v } }), {
        placeholder: 'deepseek-chat',
      }),
    ),
  );

  const keyInput = h('input', {
    class: 'input',
    type: 'password',
    value: settings.ai.key,
    placeholder: '在这里粘贴你的密钥',
  });
  keyInput.addEventListener('input', () => void patchSettings({ ai: { ...currentSettings().ai, key: keyInput.value } }));

  const keyRow = h('div', { class: 'row' });
  keyRow.appendChild(keyInput);
  keyRow.appendChild(
    button('显示/隐藏', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    }),
  );
  keyRow.appendChild(
    button('清空', () => {
      keyInput.value = '';
      void patchSettings({ ai: { ...currentSettings().ai, key: '' } });
      toastOk('已清空密钥');
    }),
  );
  wrap.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label', text: '密钥' }), keyRow));

  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '转发地址（可选）' }),
      textInput(
        settings.ai.proxyUrl,
        (v) => void patchSettings({ ai: { ...currentSettings().ai, proxyUrl: v } }),
        { placeholder: '留空则直接用上面的接口地址' },
      ),
      h('span', { class: 'field-hint', text: '浏览器直连被跨域拦截时，填一个中转/代理地址（或阶段 08 自建的转发脚本地址）。填了这一项就不会再走下面的无状态代理。' }),
    ),
  );

  // ── 无状态代理（阶段 03）──
  const cloudBase = normalizeApiBase(currentSettings().cloud.apiBase);
  const routeLine = h('p', { class: 'test-result', text: '' });
  const paintRoute = (): void => {
    const route = getLastAiRoute();
    const configured = cloudBase !== '';
    if (route === 'direct') routeLine.textContent = '上次调用走的是：直连';
    else if (route === 'proxy') routeLine.textContent = '上次调用走的是：代理（已自动切换或无状态代理）';
    else routeLine.textContent = configured ? '还没调用过。默认先直连，被跨域拦截时自动切到代理。' : '还没调用过。想在跨域时自动切代理，请先在 F 区填后端地址。';
    routeLine.className = 'test-result';
  };
  paintRoute();

  wrap.appendChild(
    checkbox(settings.ai.forceProxy, '走无状态代理（直连总是被跨域拦时打开）', (on) => {
      void patchSettings({ ai: { ...currentSettings().ai, forceProxy: on } }).then(() => {
        toastOk(on ? '已改为经代理转发' : '已改为先尝试直连');
      });
    }),
  );
  wrap.appendChild(
    h(
      'p',
      { class: 'field-hint' },
      '代理就是你自己的后端（F 区「后端地址」+ /api/ai-proxy）。它只做转发：不存密钥、不写库、不写日志、不缓存——你的密钥随每次请求发出去，用完即弃。',
    ),
  );
  wrap.appendChild(routeLine);

  const result = h('div', { class: 'test-result' });
  wrap.appendChild(
    button(
      '测试连接',
      () => {
        result.textContent = '正在测试…';
        result.className = 'test-result';
        void testConnection(aiConfigFromSettings(currentSettings())).then((res) => {
          result.textContent = res.message;
          result.className = `test-result ${res.ok ? 'ok' : 'bad'}`;
          paintRoute();
          if (res.ok) toastOk(res.message);
          else toastError(res.message);
        });
      },
      { variant: 'primary' },
    ),
  );
  wrap.appendChild(result);

  return wrap;
}
