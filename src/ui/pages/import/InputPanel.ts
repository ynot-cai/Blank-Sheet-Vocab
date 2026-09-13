import { currentSettings } from '../settings/ctx';
import * as dao from '../../../dao';
import type { Source } from '../../../core/types';
import { WORD_PRIORITY_DEFAULT } from '../../../core/types';
import type { PresetTier } from '../../../core/presets';
import { FileParseError, isSupported, parseFile, type ParsedFile } from '../../../services/fileParse';
import { button, details, h, numberInput, textInput } from '../../dom';
import { toastError, toastOk, toastWarn } from '../../components/Toast';
import { renderPrioritySelect, type PrioritySelectHandle } from '../../components/PrioritySelect';
import { renderPresetPanel } from './PresetPanel';

/** 录入页各分区收集到的输入 */
export interface InputState {
  sourceId: string | null;
  sourceName: string;
  /** 来源优先级（决定义项归谁，与下一条完全无关） */
  sourcePriority: number;
  /** ★ 词级优先级（R1）：这一批词入库时写入每个词，决定背诵先抽谁 */
  priority: number;
  mode: 'ai' | 'rule';
  batchSize: number;
  fieldSep: string;
  senseSep: string;
  text: string;
  /** 解析文件时的警告（如「第 3 页无文本层」），由录入页在结果页顶部展示黄条 */
  fileWarnings: string[];
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

/** 一个已选文件在界面上的状态 */
interface FileRowState {
  file: File;
  status: 'pending' | 'parsing' | 'done' | 'failed';
  parsed: ParsedFile | null;
  message: string;
}

/**
 * 渲染录入页的第零区（预设词库）、第一区（来源+优先级）、第二区（输入方式）、第三区（解析设置）。
 *
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
    sourcePriority: 1,
    priority: WORD_PRIORITY_DEFAULT,
    mode: 'ai',
    batchSize: 50,
    fieldSep: settings.parse.fieldSep,
    senseSep: settings.parse.senseSep,
    text: '',
    fileWarnings: [],
  };

  const wrap = h('div', { class: 'stack' });

  // —— 第零区：预设词库 ——
  wrap.appendChild(renderPresetPanel(opts.onPreset, opts.isPresetBusy));

  // —— 第一区：来源设置 ——
  const sourceBox = h('div', { class: 'card' });
  sourceBox.appendChild(h('h3', { class: 'card-title', text: '1. 来源与优先级' }));
  const nameInput = textInput(
    state.sourceName,
    (v) => {
      state.sourceName = v;
      state.sourceId = null;
    },
    { placeholder: '如：四级词汇 / 考研核心词' },
  );
  const sourcePriorityInput = numberInput(
    state.sourcePriority,
    (v) => {
      state.sourcePriority = v;
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
      h('span', { class: 'field-label', text: '来源优先级' }),
      sourcePriorityInput,
      h('span', {
        class: 'field-hint',
        text: `数字越大越优先（当前方向：${settings.parse.priorityDir === 'desc' ? '越大越优先' : '越小越优先'}，可在设置页改）。它只决定「同一个词在别的来源里已存在时，谁的义项被保留」，与下面的词优先级无关。`,
      }),
    ),
  );

  // ★ 词级优先级（R1）：这一批词写入 word.priority，决定背诵先抽谁
  const prioritySelect: PrioritySelectHandle = renderPrioritySelect(state.priority, (v) => {
    state.priority = v;
  });
  sourceBox.appendChild(prioritySelect.el);

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
          `${s.name}（来源优先级 ${s.priority}）`,
          () => {
            state.sourceId = s.id;
            state.sourceName = s.name;
            state.sourcePriority = s.priority;
            nameInput.value = s.name;
            sourcePriorityInput.value = String(s.priority);
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
  const warnBox = h('div', { class: 'stack' });

  /**
   * 把文本写进编辑框（并刷新行数/预览）。
   *
   * ★ 走 textarea 而不是直接改变量：用户要求「解析后文本进入现有的文本预览/编辑框（可手动修正）」，
   *   所以编辑框必须是**唯一事实来源**——文件解析的结果写进去，用户改了也算数。
   * @param text 文本
   */
  const applyText = (text: string): void => {
    textarea.value = text;
    state.text = text;
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    lineCount.textContent = `共 ${lines.length} 行有效内容`;
    preview.textContent = lines.slice(0, PREVIEW_LINES).join('\n');
  };

  /** 把一个文件解析出的文本追加进编辑框（多选时逐个追加，中间空一行） */
  const appendText = (text: string): void => {
    const current = textarea.value.trim();
    applyText(current === '' ? text : `${current}\n\n${text}`);
  };

  // —— 文件多选 + 拖拽 ——
  const fileRows: FileRowState[] = [];
  const fileListBox = h('div', { class: 'stack file-list' });
  const fileInput = h('input', {
    type: 'file',
    accept: '.txt,.csv,.md,.docx,.pdf,text/plain,application/pdf',
    multiple: true,
    class: 'hidden',
  });

  /** 重画文件列表 */
  const drawFileList = (): void => {
    fileListBox.replaceChildren();
    if (fileRows.length === 0) return;
    for (const row of fileRows) {
      const ext = row.file.name.slice(row.file.name.lastIndexOf('.') + 1).toLowerCase();
      const icon = ext === 'pdf' ? '📕' : ext === 'docx' ? '📘' : '📄';
      const statusText =
        row.status === 'pending'
          ? '待解析'
          : row.status === 'parsing'
            ? '解析中…'
            : row.status === 'done'
              ? `已解析 ${row.parsed?.lineCount ?? 0} 行`
              : `失败：${row.message}`;
      fileListBox.appendChild(
        h(
          'div',
          { class: `file-row ${row.status}` },
          h('span', { class: 'file-icon', text: icon }),
          h('span', { class: 'file-name', text: row.file.name }),
          h('span', { class: 'field-hint', text: `${(row.file.size / 1024).toFixed(1)} KB` }),
          h('span', { class: `file-status ${row.status}`, text: statusText }),
        ),
      );
    }
  };

  /** 重画文件解析警告（黄条） */
  const drawWarnings = (): void => {
    warnBox.replaceChildren();
    if (state.fileWarnings.length === 0) return;
    for (const w of state.fileWarnings) {
      warnBox.appendChild(h('p', { class: 'note warn', text: w }));
    }
  };

  /**
   * 逐个解析文件（**串行**）。
   *
   * 为什么串行而不是 Promise.all：docx/pdf 解析很吃内存，
   * 一次选 10 个 PDF 并发解析在手机上会直接被系统杀掉标签页。
   * 串行的另一个好处是列表状态能一个个点亮，用户看得见进度。
   */
  const parseAll = async (): Promise<void> => {
    state.fileWarnings = [];
    drawWarnings();
    for (const row of fileRows) {
      if (row.status !== 'pending') continue;
      if (row.file.size > MAX_FILE_BYTES) {
        row.status = 'failed';
        row.message = '文件超过 5MB';
        drawFileList();
        continue;
      }
      row.status = 'parsing';
      drawFileList();
      try {
        const parsed = await parseFile(row.file);
        row.status = 'done';
        row.parsed = parsed;
        row.message = '';
        if (parsed.text.trim() === '') {
          row.status = 'failed';
          row.message = '没有提取到文字';
          state.fileWarnings.push(`${row.file.name}：没有提取到文字，已跳过（不会写入空数据）`);
        } else {
          appendText(parsed.text);
          for (const w of parsed.warnings) state.fileWarnings.push(`${row.file.name}：${w}`);
        }
      } catch (err) {
        row.status = 'failed';
        row.message = err instanceof FileParseError ? err.message : err instanceof Error ? err.message : String(err);
        const hint = err instanceof FileParseError && err.hint !== '' ? `（${err.hint}）` : '';
        state.fileWarnings.push(`${row.file.name}：${row.message}${hint}`);
      }
      drawFileList();
      drawWarnings();
    }
    const ok = fileRows.filter((r) => r.status === 'done').length;
    const bad = fileRows.filter((r) => r.status === 'failed').length;
    if (ok > 0) toastOk(`已解析 ${ok} 个文件${bad > 0 ? `，${bad} 个失败（见下方提示）` : ''}`);
    else if (bad > 0) toastError('所有文件都解析失败了，请看下方每条文件的原因');
  };

  /** 接收一批文件（点选或拖拽都会走这里） */
  const acceptFiles = (files: FileList | File[]): void => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const unsupported: string[] = [];
    for (const file of incoming) {
      if (!isSupported(file)) {
        unsupported.push(file.name);
        continue;
      }
      fileRows.push({ file, status: 'pending', parsed: null, message: '' });
    }
    if (unsupported.length > 0) {
      toastWarn(`已跳过 ${unsupported.length} 个不支持的文件：${unsupported.slice(0, 3).join('、')}${unsupported.length > 3 ? '…' : ''}`);
    }
    drawFileList();
    if (fileRows.some((r) => r.status === 'pending')) void parseAll();
  };

  fileInput.addEventListener('change', () => {
    // ★ 顺序很重要：`input.files` 是**活引用**，把 `input.value` 清空会**同时清空它**。
    //   所以必须先用 Array.from 把文件拷出来，再清 value——
    //   反过来写的话（先 `value = ''` 再读 `files`）拿到的是一个空 FileList，
    //   表现是「选了文件却什么都没发生」，而且不报任何错。
    //   这个顺序错误在 headless 实测里被抓住过：change 里 files.length 是 3，
    //   走到 acceptFiles 时 incoming.length 已经变成 0。
    const picked = fileInput.files === null ? [] : Array.from(fileInput.files);
    fileInput.value = '';
    if (picked.length > 0) acceptFiles(picked);
  });

  // 拖拽上传（整块区域都能接）
  const dropZone = h(
    'div',
    { class: 'drop-zone' },
    h('span', { class: 'drop-title', text: '把文件拖到这里，或点下面的按钮选择' }),
    h('span', {
      class: 'field-hint',
      text: '支持 .txt / .csv / .md / .docx / .pdf，可一次选多个，单个文件 5MB 以内。PDF 只提取文本层，扫描件（图片 PDF）无法识别。',
    }),
    button('选择文件…', () => fileInput.click(), { variant: 'primary' }),
    fileInput,
  );
  dropZone.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dropZone.classList.remove('dragging');
    const dt = ev.dataTransfer;
    if (dt) acceptFiles(dt.files);
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
    dropZone,
    fileListBox,
    warnBox,
    lineCount,
    preview,
  );

  const btnPaste = button('粘贴文本', () => switchTab('paste'), { variant: 'primary' });
  const btnFile = button('上传文件', () => switchTab('file'));
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
    read: () => ({ ...state, fileWarnings: [...state.fileWarnings] }),
  };
}

