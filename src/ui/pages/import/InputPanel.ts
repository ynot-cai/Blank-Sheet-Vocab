import { currentSettings } from '../settings/ctx';
import * as dao from '../../../dao';
import type { Source } from '../../../core/types';
import type { PresetTier } from '../../../core/presets';
import { button, details, h, numberInput, textInput } from '../../dom';
import { toastError, toastWarn } from '../../components/Toast';
import { renderPresetPanel } from './PresetPanel';

/** 录入页各分区收集到的输入 */
export interface InputState {
  sourceId: string | null;
  sourceName: string;
  priority: number;
  mode: 'ai' | 'rule';
  batchSize: number;
  fieldSep: string;
  senseSep: string;
  text: string;
}

/** 输入面板句柄 */
export interface InputPanel {
  el: HTMLElement;
  read: () => InputState;
}

/** 单个文件大小上限 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 预览行数 */
const PREVIEW_LINES = 20;

/**
 * 渲染录入页的第零区（预设词库）、第一区（来源）、第二区（输入方式）、第三区（解析设置）。
 * @param opts.onPreset 点了某个预设档位的回调（由录入页负责加载与跳转）
 * @param opts.isPresetBusy 是否有预设正在加载
 */
export function renderInputPanel(opts: {
  onPreset: (tier: PresetTier) => void;
  isPresetBusy: () => boolean;
}): InputPanel {
  const settings = currentSettings();
  const state: InputState = {
    sourceId: null,
    sourceName: '四级词汇',
    priority: 1,
    mode: 'ai',
    batchSize: 50,
    fieldSep: settings.parse.fieldSep,
    senseSep: settings.parse.senseSep,
    text: '',
  };

  const wrap = h('div', { class: 'stack' });

  // —— 第零区：预设词库 ——
  wrap.appendChild(renderPresetPanel(opts.onPreset, opts.isPresetBusy));

  // —— 第一区：来源设置 ——
  const sourceBox = h('div', { class: 'card' });
  sourceBox.appendChild(h('h3', { class: 'card-title', text: '1. 来源' }));
  const nameInput = textInput(
    state.sourceName,
    (v) => {
      state.sourceName = v;
      state.sourceId = null;
    },
    { placeholder: '如：四级词汇 / 考研核心词' },
  );
  const priorityInput = numberInput(
    state.priority,
    (v) => {
      state.priority = v;
    },
    { min: 0, max: 999 },
  );
  sourceBox.appendChild(
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: '来源名称' }), nameInput),
  );
  sourceBox.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '优先级' }),
      priorityInput,
      h('span', {
        class: 'field-hint',
        text: `数字越大越优先（当前方向：${settings.parse.priorityDir === 'desc' ? '越大越优先' : '越小越优先'}，可在设置页改）。已有词遇到更高优先级来源时义项会被覆盖。`,
      }),
    ),
  );
  const existingBox = h('div', { class: 'row' });
  sourceBox.appendChild(h('p', { class: 'field-hint', text: '已有来源（选一个可直接复用）：' }));
  sourceBox.appendChild(existingBox);

  void dao.sources.list().then((list: Source[]) => {
    if (list.length === 0) {
      existingBox.appendChild(h('span', { class: 'field-hint', text: '暂无，先新建一个吧' }));
      return;
    }
    for (const s of list) {
      existingBox.appendChild(
        button(
          `${s.name}（优先级 ${s.priority}）`,
          () => {
            state.sourceId = s.id;
            state.sourceName = s.name;
            state.priority = s.priority;
            nameInput.value = s.name;
            priorityInput.value = String(s.priority);
            toastWarn(`已选择已有来源：${s.name}`);
          },
          { variant: 'ghost' },
        ),
      );
    }
  });

  // —— 第二区：输入方式 ——
  const inputBox = h('div', { class: 'card' });
  inputBox.appendChild(h('h3', { class: 'card-title', text: '2. 输入单词文本' }));
  const preview = h('pre', { class: 'preview' });
  const lineCount = h('span', { class: 'field-hint', text: '共 0 行' });
  const applyText = (text: string): void => {
    state.text = text;
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    lineCount.textContent = `共 ${lines.length} 行有效内容`;
    preview.textContent = lines.slice(0, PREVIEW_LINES).join('\n');
  };

  const fileInput = h('input', { type: 'file', accept: '.txt,.csv,.md,text/plain', class: 'hidden' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toastError('文件太大了（限制 5MB 以内）');
      return;
    }
    void file.text().then((text) => {
      applyText(text);
      toastWarn(`已读取 ${file.name}`);
    });
  });

  const textarea = h('textarea', {
    class: 'input textarea',
    rows: '10',
    placeholder: '一行一条（单词 / 短语 / 缩写），例如：\nabandon  v. 放弃；抛弃\ngive up\tv. 放弃；认输\nNASA\tn. 美国国家航空航天局\netc.\tabbr. 等等',
  });
  textarea.addEventListener('input', () => applyText(textarea.value));

  const tabs = h('div', { class: 'tabs' });
  const tabPaste = h('div', { class: 'tab-panel' }, textarea, lineCount, preview);
  const tabFile = h(
    'div',
    { class: 'tab-panel hidden' },
    h('p', { class: 'note' }, '支持 .txt / .csv / .md，单个文件 5MB 以内。读完会先在下面预览前 20 行。'),
    button('选择文件…', () => fileInput.click(), { variant: 'primary' }),
    fileInput,
    lineCount,
    preview,
  );

  const btnPaste = button('粘贴文本', () => switchTab('paste'), { variant: 'primary' });
  const btnFile = button('上传 txt', () => switchTab('file'));
  const switchTab = (which: 'paste' | 'file'): void => {
    tabPaste.classList.toggle('hidden', which !== 'paste');
    tabFile.classList.toggle('hidden', which !== 'file');
    btnPaste.classList.toggle('btn-primary', which === 'paste');
    btnFile.classList.toggle('btn-primary', which === 'file');
  };
  tabs.appendChild(btnPaste);
  tabs.appendChild(btnFile);
  inputBox.appendChild(tabs);
  inputBox.appendChild(tabFile);
  inputBox.appendChild(tabPaste);

  // —— 第三区：解析设置 ——
  const settingsBox = h('div', { class: 'stack' });
  settingsBox.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '字段分隔符' }),
      textInput(state.fieldSep, (v) => {
        state.fieldSep = v;
      }, { placeholder: 'auto' }),
      h('span', { class: 'field-hint', text: 'auto = 自动探测（Tab > 连续空格 > 逗号 > 单个空格）。短语（如 give up）请用 Tab 或两个以上空格与义项分隔' }),
    ),
  );
  settingsBox.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '义项分隔符' }),
      textInput(state.senseSep, (v) => {
        state.senseSep = v;
      }),
      h('span', { class: 'field-hint', text: '把这一串字符里的任意一个当作义项分隔符' }),
    ),
  );

  const modeBox = h('div', { class: 'stack' });
  const radioAi = h('input', { type: 'radio', name: 'parsemode', checked: true });
  const radioRule = h('input', { type: 'radio', name: 'parsemode' });
  radioAi.addEventListener('change', () => {
    if (radioAi.checked) state.mode = 'ai';
  });
  radioRule.addEventListener('change', () => {
    if (radioRule.checked) state.mode = 'rule';
  });
  modeBox.appendChild(
    h(
      'label',
      { class: 'radio-line' },
      radioAi,
      h('span', { class: 'field-label', text: 'AI 智能解析（推荐）' }),
      h('span', { class: 'field-hint', text: 'AI 自动切词、拆义项、合并近义、补音标例句' }),
    ),
  );
  modeBox.appendChild(
    h(
      'label',
      { class: 'radio-line' },
      radioRule,
      h('span', { class: 'field-label', text: '规则解析（离线）' }),
      h('span', { class: 'field-hint', text: '走内置规则，不花钱；音标与例句留空，近义词留空' }),
    ),
  );
  settingsBox.appendChild(modeBox);
  settingsBox.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '每批词数' }),
      numberInput(
        state.batchSize,
        (v) => {
          state.batchSize = Math.min(100, Math.max(20, Math.floor(v)));
        },
        { min: 20, max: 100 },
      ),
      h('span', { class: 'field-hint', text: '范围 20~100，默认 50。批次越小越稳，但请求次数越多' }),
    ),
  );

  wrap.appendChild(sourceBox);
  wrap.appendChild(inputBox);
  wrap.appendChild(details('3. 解析设置（分隔符 / 解析方式 / 每批词数）', [settingsBox], false));

  return {
    el: wrap,
    read: () => ({ ...state }),
  };
}
