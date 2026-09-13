/**
 * 「同一个词已存在、但优先级不同」的询问框（R1 阶段新增）。
 *
 * 触发场景（提示词 2.5 节）：
 *   再次录入一个库里已经有的词，且这次选的优先级和库里那条不一样。
 *   按用户要求**必须问一次**，不能静默覆盖也不能静默忽略——
 *   「我明明选了 5，怎么没生效」和「我的 5 被悄悄改成 2 了」都是不可接受的。
 *
 * 这个框一次处理**整批冲突**（可能 12 个词），所以顶部显示总数，
 * 并提供「全部覆盖 / 全部保留」两个快捷按钮，避免一个个点。
 * 单个处理时也能选「应用到本次所有冲突」，把后面的都按同一个答案处理。
 */
import { button, h } from '../dom';
import { openModal, type ModalHandle } from './Modal';

/** 一条优先级冲突 */
export interface PriorityConflict {
  /** 单词 id（库里那条） */
  wordId: string;
  /** 英文（显示用） */
  en: string;
  /** 库里当前的优先级 */
  currentPriority: number;
  /** 本次要写入的优先级 */
  incomingPriority: number;
}

/** 一条冲突的处理结果 */
export type ConflictResolution = 'overwrite' | 'keep';

/**
 * 本次会话内已经问过的冲突（提示词 2.5 节：「用户选择后记录到本次会话，不再重复问」）。
 *
 * 作用域是**模块级 + 页面生命周期**：刷新页面就清空。
 * 这是刻意的——用户下周再导入同一批词时，很可能就是改主意了（比如想把优先级提上去），
 * 那时候必须再问一次；而「同一次录入流程里同一对优先级反复弹窗」才是真正烦人的。
 *
 * key 里带上三个值（词 id + 当前优先级 + 本次优先级）而不是只带词 id：
 * 只带词 id 的话，用户这次选了「保留 3」，下次导入选了 5 时就会被静默跳过——
 * 「我明明选了 5 却没生效」正是这个功能要避免的事。
 */
const resolvedThisSession = new Map<string, ConflictResolution>();

/**
 * 生成会话去重用的 key。
 * @param c 冲突
 */
function sessionKey(c: PriorityConflict): string {
  return `${c.wordId}::${c.currentPriority}::${c.incomingPriority}`;
}

/**
 * 查这次冲突是否在本次会话里已经问过了。
 * @param c 冲突
 */
export function recallConflict(c: PriorityConflict): ConflictResolution | null {
  return resolvedThisSession.get(sessionKey(c)) ?? null;
}

/**
 * 记下这次冲突的用户选择。
 * @param c 冲突
 * @param resolution 用户的选择
 */
export function rememberConflict(c: PriorityConflict, resolution: ConflictResolution): void {
  resolvedThisSession.set(sessionKey(c), resolution);
}

/**
 * 清空会话记忆（「取消本次导入」时调，避免残留影响下一次录入）。
 */
export function resetConflictMemory(): void {
  resolvedThisSession.clear();
}

/** 询问框的返回值 */
export interface PriorityConflictAnswer {
  /** 每条冲突（按 id）的处理结果 */
  decisions: Map<string, ConflictResolution>;
  /** 本批里选「保留」的条数（给汇报用） */
  keptCount: number;
  /** 本批里选「覆盖」的条数 */
  overwrittenCount: number;
}

/**
 * 汇总处理结果。
 * @param decisions 每条冲突的决定
 * @param conflicts 冲突列表
 */
function summarize(
  decisions: Map<string, ConflictResolution>,
  conflicts: PriorityConflict[],
): PriorityConflictAnswer {
  let kept = 0;
  let overwritten = 0;
  for (const c of conflicts) {
    const value = decisions.get(c.wordId) === 'overwrite' ? 'overwrite' : 'keep';
    // 记进会话记忆：同一批里重复出现的词、以及用户退回上一步再点一次「确认入库」，
    // 都不会再弹第二个一模一样的框（提示词 2.5 节的要求）。
    rememberConflict(c, value);
    if (value === 'overwrite') overwritten += 1;
    else kept += 1;
  }
  return { decisions, keptCount: kept, overwrittenCount: overwritten };
}

/**
 * 打开冲突询问框。
 *
 * @param conflicts 全部冲突（按顺序问；总数用于显示）
 * @param opts.sourceName 本次录入的来源名（只用于文案）
 * @returns 每条冲突的处理结果。
 *   用户直接关掉弹窗（遮罩/Esc/右上角 ✕）时按「**全部保留**」处理——
 *   保守方向：不动用户已有的数据，最坏情况只是这次录入的优先级没生效，
 *   用户可以事后在列表页改；而误覆盖是不可撤销的。
 */
export function askPriorityConflicts(
  conflicts: PriorityConflict[],
  opts: { sourceName: string },
): Promise<PriorityConflictAnswer> {
  return new Promise((resolve) => {
    let answered = false;
    const decisions = new Map<string, ConflictResolution>();
    /** 当前问到第几条 */
    let index = 0;
    /** 是否已经选了「应用到本次所有冲突」（选了就一次性填完剩下的） */
    let applyToRest: ConflictResolution | null = null;

    const question = h('p', { class: 'modal-text' });
    const progress = h('p', { class: 'field-hint' });
    const listBox = h('div', { class: 'conflict-list' });
    // 单个处理的三个按钮放在 body 里（不是 modal 的 footer）：
    // 它们的作用域是「当前这一条」，和底部的「全部覆盖/全部保留」不是一回事，
    // 混在同一行会让人以为「保留」是放弃整批。
    const singleRow = h('div', { class: 'row' });

    /** 交给 openModal 赋值；上面的回调只可能在它返回之后被触发 */
    let handle: ModalHandle | null = null;

    /** 收工：填上还没决定的，resolve 并关窗 */
    const finish = (fill: ConflictResolution): void => {
      for (const c of conflicts) if (!decisions.has(c.wordId)) decisions.set(c.wordId, fill);
      if (answered) return;
      answered = true;
      resolve(summarize(decisions, conflicts));
      handle?.close();
    };

    /** 画「当前这一条」的提问 + 右侧整批进度列表 */
    const drawCurrent = (): void => {
      listBox.replaceChildren();
      for (const c of conflicts) {
        const decided = decisions.get(c.wordId);
        listBox.appendChild(
          h(
            'div',
            {
              class: `conflict-line${decided === undefined ? '' : decided === 'overwrite' ? ' won' : ' kept'}`,
            },
            h('span', { class: 'conflict-en', text: c.en }),
            h('span', { class: 'field-hint', text: `当前 ${c.currentPriority} → 本次 ${c.incomingPriority}` }),
            h('span', {
              class: 'field-hint',
              text: decided === undefined ? '（待定）' : decided === 'overwrite' ? '覆盖' : '保留',
            }),
          ),
        );
      }

      const c = conflicts[index];
      if (c === undefined) {
        // 全部问完了（正常情况下走不到这里，兜底防呆）
        finish('keep');
        return;
      }

      progress.textContent = `第 ${index + 1}/${conflicts.length} 个冲突`;
      question.textContent = `单词「${c.en}」已存在（当前优先级 ${c.currentPriority}，本次 ${c.incomingPriority}），是否覆盖优先级？`;
      const lines = listBox.children;
      if (lines[index] instanceof HTMLElement) lines[index].classList.add('active');

      /** 决定当前这一条；rest=true 表示「应用到本次所有冲突」 */
      const decide = (value: ConflictResolution, rest: boolean): void => {
        decisions.set(c.wordId, value);
        if (rest) applyToRest = value;
        advance();
      };

      singleRow.replaceChildren();
      singleRow.appendChild(
        button(`覆盖为 ${c.incomingPriority}`, () => decide('overwrite', false), { variant: 'primary' }),
      );
      singleRow.appendChild(button(`保留 ${c.currentPriority}`, () => decide('keep', false)));
      singleRow.appendChild(button('应用到本次所有冲突', () => decide('overwrite', true)));
    };

    /** 走到下一条；如果设了「应用到所有」就把剩下的按同一答案填掉 */
    const advance = (): void => {
      if (applyToRest !== null) {
        finish(applyToRest);
        return;
      }
      index += 1;
      while (index < conflicts.length && decisions.has(conflicts[index]?.wordId ?? '')) index += 1;
      drawCurrent();
    };

    const box = h('div', { class: 'stack' });
    box.appendChild(
      h('p', {
        class: 'note warn',
        text: `共 ${conflicts.length} 个词优先级冲突（来自「${opts.sourceName}」）。可以逐条选择，也可以直接用下面的快捷按钮一次处理。`,
      }),
    );
    box.appendChild(progress);
    box.appendChild(question);
    box.appendChild(singleRow);
    box.appendChild(h('span', { class: 'field-label', text: '快捷（作用于一整批）' }));
    box.appendChild(
      h(
        'div',
        { class: 'row' },
        button('全部覆盖为本次优先级', () => finish('overwrite'), { variant: 'primary' }),
        button('全部保留现有优先级', () => finish('keep')),
      ),
    );
    box.appendChild(listBox);

    handle = openModal({
      title: '优先级冲突',
      width: '620px',
      body: box,
      actions: [{ text: '稍后再说（全部保留）', variant: 'ghost', onClick: (close) => {
        finish('keep');
        close();
      } }],
      onClose: () => {
        // 直接点遮罩/Esc 关掉：保守处理成「全部保留」
        finish('keep');
      },
    });

    drawCurrent();
  });
}
