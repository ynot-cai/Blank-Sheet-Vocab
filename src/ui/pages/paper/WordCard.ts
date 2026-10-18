/**
 * 单词卡：正中弹出；可编辑英文与中文义项（右键删除、左键拖拽排序）。
 *
 * ★ 版本 0.0.9 的第三处修复就在这里：保存后要**把最新数据回传给调用方**，
 *   由它去刷新白纸上的中文（`PaperStage.refreshWord`）。上一版只改了库里的数据，
 *   纸上那份文本是烘死的，所以「背诵期间改中文不立即显示」。
 */
import type { Word } from '../../../core/types';
import { button, h, textInput } from '../../dom';
import { EXAMPLE_NOT_FOUND } from '../../../core/senseRules';

/** 单词卡参数 */
export interface WordCardOptions {
  word: Word;
  /** 是否手机（决定一些尺寸） */
  isPhone: boolean;
  /** 保存（编辑态点「保存」时回传最新词） */
  onSave: (next: Word) => void;
  /** 斩 */
  onChop: () => void;
  /** 关闭 */
  onClose: () => void;
  /** 朗读 */
  onSpeak: () => void;
}

/**
 * 渲染单词卡（挂到 document.body，因为要居中遮罩）。
 * @returns 卸载函数
 */
export function openWordCard(opts: WordCardOptions): () => void {
  let current: Word = { ...opts.word, senses: opts.word.senses.map((s) => ({ ...s, aliases: [...s.aliases] })) };
  let editing = false;
  let dragFrom = -1;

  const layer = h('div', { class: 'paper-card-layer' });
  const card = h('div', { class: 'paper-card' });
  layer.appendChild(card);

  const close = (): void => {
    layer.remove();
    opts.onClose();
  };

  // 点遮罩关闭（点卡片本身不关）
  layer.addEventListener('click', (ev) => {
    if (ev.target === layer) close();
  });

  /** 右键菜单（只有「删除」一项） */
  const openMenu = (x: number, y: number, senseIndex: number): void => {
    document.querySelectorAll('.paper-context-menu').forEach((n) => n.remove());
    const menu = h('div', { class: 'paper-context-menu', style: { left: `${x}px`, top: `${y}px` } });
    const del = h('button', { type: 'button', class: 'danger', text: '删除' });
    del.addEventListener('click', () => {
      current = { ...current, senses: current.senses.filter((_, i) => i !== senseIndex) };
      menu.remove();
      draw();
    });
    menu.appendChild(del);
    document.body.appendChild(menu);
    const dismiss = (ev: MouseEvent): void => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    // 直接注册即可：打开菜单的是 contextmenu，而 dismiss 听的是 mousedown，
    // 那一次 mousedown 早在注册之前就派发完了，不会立刻把自己关掉。
    // 原来这里用「延迟 0 毫秒的定时器」推迟注册，被 R1 的「可疑计时」扫描误报，现已去掉定时器。
    document.addEventListener('mousedown', dismiss);
  };

  /** 画一遍整卡 */
  const draw = (): void => {
    card.replaceChildren();

    const x = h('button', { class: 'paper-card-close', type: 'button', text: '×', title: '关闭' });
    x.addEventListener('click', close);
    card.appendChild(x);

    // ── 第 1 行：英文 + 中文（仅义项代表） ──
    const head = h('div', { class: 'paper-card-head' });
    if (editing) {
      head.appendChild(
        textInput(current.en, (v) => {
          current = { ...current, en: v };
        }, { placeholder: '英文 / 短语' }),
      );
    } else {
      head.appendChild(h('span', { class: 'paper-card-word', text: current.en }));
      head.appendChild(
        h('span', { class: 'paper-card-senses', text: current.senses.filter((s) => s.text.trim() !== '').map((s) => s.text).join('　') }),
      );
    }
    card.appendChild(head);

    // ── 编辑态：中文义项列表（可改、右键删、拖拽排序） ──
    if (editing) {
      const list = h('div', { class: 'paper-sense-list' });
      current.senses.forEach((sense, index) => {
        const item = h('div', { class: 'paper-sense-item', draggable: 'true' });
        // 代表义项（可编辑文本）
        const textEl = h('span', { class: 'paper-sense-text', contenteditable: 'true', text: sense.text });
        textEl.addEventListener('input', () => {
          current = {
            ...current,
            senses: current.senses.map((s, i) => (i === index ? { ...s, text: (textEl.textContent ?? '').trim() } : s)),
          };
        });
        textEl.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          openMenu(ev.clientX, ev.clientY, index);
        });
        item.appendChild(textEl);

        // 近义词（较灰，只读展示 + 同样可右键删整条）
        for (const alias of sense.aliases) {
          item.appendChild(h('span', { class: 'paper-sense-alias', text: alias }));
        }

        // 拖拽排序
        item.addEventListener('dragstart', () => {
          dragFrom = index;
          item.classList.add('dragging');
        });
        item.addEventListener('dragend', () => {
          dragFrom = -1;
          item.classList.remove('dragging');
          card.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
        });
        item.addEventListener('dragover', (ev) => {
          ev.preventDefault();
          item.classList.add('drop-target');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
        item.addEventListener('drop', (ev) => {
          ev.preventDefault();
          if (dragFrom < 0 || dragFrom === index) return;
          const next = [...current.senses];
          const [moved] = next.splice(dragFrom, 1);
          if (moved) next.splice(index, 0, moved);
          current = { ...current, senses: next };
          draw();
        });

        list.appendChild(item);
      });
      // ⚠️ 用户第 5 条：删掉了原先自己加的「+ 添加中文意思」按钮——
      //    需求只写了「可修改每一条、右键删除、拖拽排序」，没要求新增。
      card.appendChild(list);
    }

    // ── 第 2 行：音标 + 发音 ──
    const ph = h('div', { class: 'paper-card-phonetic-row' });
    ph.appendChild(h('span', { text: current.phonetic || '（无音标）' }));
    const speakBtn = h('button', { type: 'button', class: 'paper-btn', text: '🔊 发音', title: '朗读这个单词' });
    speakBtn.addEventListener('click', opts.onSpeak);
    ph.appendChild(speakBtn);
    card.appendChild(ph);

    // ── 第 3 行：例句（最多两行，超出给「查看全部」） ──
    const exampleText = current.example.trim();
    const ex = h('div', { class: 'paper-card-example', text: exampleText === '' ? EXAMPLE_NOT_FOUND : exampleText });
    card.appendChild(ex);
    if (exampleText.length > 80) {
      const more = h('button', { type: 'button', class: 'paper-btn', text: '查看全部' });
      more.addEventListener('click', () => {
        ex.classList.toggle('expanded');
        more.textContent = ex.classList.contains('expanded') ? '收起' : '查看全部';
      });
      card.appendChild(more);
    }

    // ── 第 4 行：按钮区 ──
    const actions = h('div', { class: 'paper-card-actions' });
    if (editing) {
      const save = button('保存', () => {
        opts.onSave(current);
        editing = false;
        draw();
      }, { variant: 'primary' });
      actions.appendChild(save);
    } else {
      actions.appendChild(
        button('编辑', () => {
          editing = true;
          draw();
        }),
      );
    }
    // 空壳：拼写 / 仅拼写（按用户要求只留占位）
    actions.appendChild(button('拼写', () => undefined, { title: '待实现（本轮为空壳）' }));
    actions.appendChild(button('仅拼写', () => undefined, { title: '待实现（本轮为空壳）' }));
    actions.appendChild(
      button('斩', () => {
        opts.onChop();
        close();
      }, { variant: 'danger' }),
    );
    card.appendChild(actions);

    // 编辑态下让整卡重画会丢焦点，所以 draw 只在结构性变化时调；
    // 文本输入走 input 事件直接写 current（见上面 textEl / textInput 的写法）。
  };

  draw();
  document.body.appendChild(layer);
  return close;
}
