/**
 * 拼写强化（`#/spell`）—— 版本 0.0.25。
 *
 * 用户需求见 `开发必读/逻辑与交互要求.md` 第十二节，要点：
 * - 入口 → 功能首页（待强化单词情况 + 「开始复习」）→ 按专属优先级选词生成队列 → 逐个拼写；
 * - 复习界面自上而下：**中文意思**（页面中部、大字号）→ **提示框**（词性等补充信息，空则留白）→
 *   **输入框**（Enter = 确认）→ **提示栏**（提示 / 小喇叭 / 确认）；
 * - 提交后切到**主程序同款单词卡**，卡内任意键 / 点击 → 下一题，且**成绩在离开卡之前写入**；
 * - 每题满分 5：点小喇叭 −1、点提示 −1，下限 0；
 * - 满分 5 的词本轮不再出现；未满分的词间隔 5 个词后再出现（剩余不足 5 个就追加到末尾）；
 * - 整个功能内右下角始终有「退出」按钮，返回主界面，已记录的成绩不丢。
 *
 * 状态机：`home` → `quiz`（拼写）→ `card`（单词卡）→ `quiz` … → `summary`。
 *
 * RULES-R1: 全程**没有时间限制 / 倒计时 / 超时判错**——本页唯一的 setTimeout 是
 * 「等这一轮点击派发完、再挂单词卡的『任意键继续』监听」，不参与任何判分。
 */
import { SPELL_MAX_SCORE, hintLetters, reinsertEntry, sortSpellCandidates, spellScore, takeCycleBatch, type SpellEntry } from '../../core/spellSelect';
import { activeSenses } from '../../core/model';
import type { Word } from '../../core/types';
import * as dao from '../../dao';
import { speak } from '../../services/tts';
import { h } from '../dom';
import { toastOk, toastWarn } from '../components/Toast';
import { renderWordCard } from '../components/WordCard';
import { reorganizeWordSenses } from '../wordAiActions';
import { navigate } from '../router';
import { currentSettings } from './settings/ctx';

/** 页面状态 */
type SpellStage = 'home' | 'quiz' | 'card' | 'summary';

/** 从词的义项里抽出「补充信息」（词性，如 n. / v. / adj.）；抽不到就返回空串 */
function hintInfoOf(word: Word): string {
  const tags = new Set<string>();
  for (const sense of activeSenses(word)) {
    const m = /^\s*([a-zA-Z]+\.(?:\s*&\s*[a-zA-Z]+\.)?)\s*/.exec(sense.text);
    if (m) tags.add(m[1].replace(/\s+/g, ''));
  }
  return Array.from(tags).join(' / ');
}

/** 词的中文释义（代表义 + 近义词，与考核拼写环节同一口径） */
function meaningOf(word: Word): string {
  const parts: string[] = [];
  for (const sense of activeSenses(word)) {
    const text = sense.text.replace(/^\s*[a-zA-Z]+\.\s*/, '').trim();
    const aliases = sense.aliases.filter((a) => a.trim() !== '');
    parts.push([text, ...aliases].join('，'));
  }
  return parts.join('；');
}


/**
 * 渲染拼写强化页。
 */
export function renderSpellPage(): HTMLElement {
  const page = h('div', { class: 'page spell-page' });

  /** 状态 */
  let stage: SpellStage = 'home';
  /** 队列（会不断追加：这是「炒饭式」循环的载体） */
  let queue: SpellEntry[] = [];
  /** 在「排好序的候选」里的循环游标（取完一轮从头部绕回） */
  let cycleOffset = 0;
  /** 已经循环了几轮（只为提示用） */
  let cycles = 0;
  /** 当前题下标 */
  let index = 0;
  /** 本题已点「提示」次数 / 小喇叭次数 */
  let hintClicks = 0;
  let speakClicks = 0;
  /** 本轮统计 */
  let roundQuestions = 0;
  let roundFullScore = 0;
  let roundRepeat = 0;
  let roundTotalScore = 0;
  /** 被标记的词（首页展示用） */
  let tagged: Word[] = [];
  /** 本功能记录（首页展示历史得分用） */
  let records = new Map<string, import('../../core/types').SpellRecord>();

  /** 主区域 */
  const main = h('div', { class: 'spell-main' });
  /** 右下角常驻「退出」按钮（用户：整个功能内始终显示） */
  const exitBtn = h('button', { class: 'spell-exit', type: 'button', text: '退出', title: '返回主界面' });
  exitBtn.addEventListener('click', () => navigate('/home'));
  page.appendChild(main);
  page.appendChild(exitBtn);

  /** 读数据 */
  const refreshData = async (): Promise<void> => {
    const [all, recs] = await Promise.all([dao.words.listAlive(), dao.spellRecords.map()]);
    // ★ 0.0.27（用户）：「仅拼写」是进入拼写强化的属性标签
    tagged = all.filter((w) => w.spellOnly === true && w.status !== 'chopped');
    records = recs;
  };

  // ══════════════════════ 首页 ══════════════════════
  const drawHome = (): void => {
    stage = 'home';
    page.dataset['stage'] = stage;
    main.replaceChildren();
    const settings = currentSettings();
    const box = h('div', { class: 'spell-home' });
    box.appendChild(h('h2', { class: 'spell-title', text: '拼写强化' }));
    box.appendChild(
      h('p', {
        class: 'spell-sub',
        text: `待强化 ${tagged.length} 个单词 · 每轮取前 ${settings.spell.count} 个（按本功能专属优先级）`,
      }),
    );

    if (tagged.length === 0) {
      box.appendChild(
        h('p', {
          class: 'spell-empty',
          text: '还没有标记要强化的单词。在单词卡或单词列表里点「拼写」，这个词就会进入这里（状态自动置为已背）。',
        }),
      );
    } else {
      const list = h('div', { class: 'spell-list' });
      // 首页按专属优先级排序展示，用户能看到「接下来先练谁」
      const entries = sortSpellCandidates(tagged, records, settings.spell).slice(0, 30);
      for (const entry of entries) {
        const rec = entry.record;
        const row = h('div', { class: 'spell-row' });
        row.appendChild(h('span', { class: 'spell-row-en', text: entry.word.en }));
        row.appendChild(h('span', { class: 'spell-row-cn', text: meaningOf(entry.word) }));
        row.appendChild(
          h('span', {
            class: 'spell-row-meta',
            text: rec === null ? '还没练过' : `出现 ${rec.attempts} 次 · 最近 ${rec.lastScore} 分 · 最高 ${rec.bestScore} 分`,
          }),
        );
        row.appendChild(h('span', { class: 'spell-row-prio', text: `优先度 ${Math.round(entry.priority * 10) / 10}` }));
        list.appendChild(row);
      }
      box.appendChild(list);
      if (tagged.length > 30) box.appendChild(h('p', { class: 'spell-note', text: `……共 ${tagged.length} 个，这里只列前 30 个。` }));
    }

    const actions = h('div', { class: 'spell-actions' });
    const start = h('button', { class: 'spell-primary', type: 'button', text: '开始复习' });
    start.addEventListener('click', () => void startRound());
    actions.appendChild(start);
    box.appendChild(actions);
    main.appendChild(box);
  };

  // ══════════════════════ 开始一轮 ══════════════════════
  const startRound = async (): Promise<void> => {
    await refreshData();
    const settings = currentSettings();
    /**
     * ★ 1.0.3（用户「炒饭式循环复习」）：先按优先级把**全部**候选排好序，
     * 再按游标取第一批；队列走完后用同一个排序结果接着取下一批，永远循环。
     */
    const sorted = sortSpellCandidates(tagged, records, settings.spell);
    const first = takeCycleBatch(sorted, 0, settings.spell.count);
    queue = first.batch;
    cycleOffset = first.nextOffset;
    cycles = 1;
    if (queue.length === 0) {
      toastWarn('还没有标记要强化的单词');
      return;
    }
    index = 0;
    roundQuestions = 0;
    roundFullScore = 0;
    roundRepeat = 0;
    roundTotalScore = 0;
    drawQuiz();
  };

  // ══════════════════════ 拼写界面 ══════════════════════
  const drawQuiz = (): void => {
    stage = 'quiz';
    page.dataset['stage'] = stage;
    const entry = queue[index];
    if (entry === undefined) {
      // 理论上 advance 会先补货；这里兜底再补一次，仍然空才结束
      void refillThenDraw();
      return;
    }
    const word = entry.word;
    hintClicks = 0;
    speakClicks = 0;
    main.replaceChildren();

    const box = h('div', { class: 'spell-quiz' });
    // 中文意思（页面中部、大字号）
    box.appendChild(h('div', { class: 'spell-meaning', text: meaningOf(word) }));
    // 提示框（词性等补充信息；没有内容就留空，不写占位文字）
    const info = hintInfoOf(word);
    const infoBox = h('div', { class: 'spell-info' });
    infoBox.dataset['role'] = 'spell-info';
    infoBox.textContent = info;
    box.appendChild(infoBox);

    // 输入框
    const input = h('input', {
      class: 'spell-input',
      type: 'text',
      placeholder: '',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
    });
    input.dataset['role'] = 'spell-input';
    box.appendChild(input);

    // 提示字母（第一次点「提示」后才出现）
    const letters = h('div', { class: 'spell-letters' });
    letters.dataset['role'] = 'spell-letters';
    box.appendChild(letters);

    // 提示栏：提示 / 小喇叭 / 确认
    const bar = h('div', { class: 'spell-bar' });
    const hintBtn = h('button', { class: 'spell-btn', type: 'button', text: '提示' });
    const speakBtn = h('button', { class: 'spell-btn', type: 'button', text: '🔊', title: '朗读这个单词（每次 −1 分）' });
    const submitBtn = h('button', { class: 'spell-btn spell-btn-primary', type: 'button', text: '确认' });
    bar.appendChild(hintBtn);
    bar.appendChild(speakBtn);
    bar.appendChild(submitBtn);
    box.appendChild(bar);

    // 本题剩余分（点一次就变，给用户即时反馈；不额外加按钮）
    const remain = h('div', { class: 'spell-remain', text: `本题还剩 ${SPELL_MAX_SCORE} 分` });
    box.appendChild(remain);
    main.appendChild(box);

    hintBtn.addEventListener('click', () => {
      hintClicks += 1;
      letters.textContent = hintLetters(word.en, hintClicks);
      letters.dataset.clicks = String(hintClicks);
      updateRemain();
    });
    speakBtn.addEventListener('click', () => {
      speakClicks += 1;
      const speech = currentSettings().speech;
      speak(word.en, { rate: speech.rate, lang: speech.accent });
      updateRemain();
    });
    const updateRemain = (): void => {
      remain.textContent = `本题还剩 ${spellScore(hintClicks, speakClicks)} 分`;
    };
    /**
     * 提交：先算分、**立即写库**（用户：成绩必须在离开单词卡之前写入记录），再切单词卡。
     */
    const submit = (): void => {
      const score = spellScore(hintClicks, speakClicks);
      // ★ 0.0.28：拼写本身是否写对（用于单词卡页的「正确 / 错误」圆形标识）
      const typed = input.value.trim();
      const correct = typed.toLowerCase() === word.en.trim().toLowerCase();
      void (async () => {
        try {
          // 提交时就把成绩写掉：中途退出 / 异常都不会丢（用户「三」「五」）
          await dao.spellRecords.recordScore(word.id, score);
        } catch (err) {
          console.error('[spell] 成绩写入失败', err);
          toastWarn('成绩保存失败，请检查存储空间');
        }
        roundQuestions += 1;
        roundTotalScore += score;
        if (score === SPELL_MAX_SCORE) roundFullScore += 1;
        drawCard(word, score, typed, correct);
      })();
    };
    submitBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (ev) => {
      if (ev.repeat) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    });
    input.focus();
  };

  // ══════════════════════ 单词卡（沿用主程序） ══════════
  const drawCard = (word: Word, score: number, typed: string, correct: boolean): void => {
    stage = 'card';
    page.dataset['stage'] = stage;
    main.replaceChildren();
    const box = h('div', { class: 'spell-card-page' });
    box.appendChild(h('h2', { class: 'spell-title', text: '单词卡' }));
    // ★ 0.0.28（用户）：「正确与错误的标识使用圆形底色（正确绿色、错误红色）加白色勾叉图标标出。」
    const result = h('div', { class: `spell-result ${correct ? 'ok' : 'bad'}`, dataset: { role: 'spell-result' } });
    result.appendChild(h('span', { class: 'spell-result-icon', text: correct ? '✓' : '✗' }));
    result.appendChild(h('span', { text: correct ? '拼写正确' : '拼写错误' }));
    box.appendChild(result);
    box.appendChild(h('p', { class: 'spell-sub', text: `本题得分 ${score} / ${SPELL_MAX_SCORE}` }));
    const shell = h('div', { class: 'answer-card spell-answer-card' });
    shell.appendChild(
      renderWordCard(word, {
        // 「完全沿用主背诵程序的单词卡样式」：可编辑、可斩、可标记拼写，行为与白纸页一致
        editable: true,
        // ★ 0.1.1：单词卡上的「AI 整理义项」（拼写强化没有画布，只需落库）
        onReorganizeSenses: () => void reorganizeWordSenses(word),
        // 拼错的词在卡里同时给出逐格对照（勾叉是圆形底色那块样式）
        answerFeedback: correct ? [] : [{ input: typed === '' ? '（未填）' : typed, ok: false }],
        onClose: () => undefined,
        onChange: (next) => {
          void dao.words.put(next).then(() => toastOk('已保存'));
        },
        onChop: () => {
          void dao.words.chop(word.id).then(() => toastOk(`已斩「${word.en}」`));
        },
        onSpell: (value) => {
          void dao.words.setNeedSpell(word.id, value);
        },
        onSpellOnly: (value) => {
          void dao.words.setSpellOnly(word.id, value);
        },
      }),
    );
    shell.appendChild(h('div', { class: 'answer-hint', text: '点击或按任意键进入下一个单词' }));
    box.appendChild(shell);
    box.appendChild(
      h('p', { class: 'spell-note', text: score === SPELL_MAX_SCORE ? '满分，这个词本轮不再出现。' : '未拿满分，间隔 5 个单词后会再出现。' }),
    );
    main.appendChild(box);

    /** 离开单词卡 → 记录已提前写好，这里只负责调度下一个 */
    const next = (): void => {
      document.removeEventListener('keydown', onKey, true);
      box.removeEventListener('click', onClick);
      advance(score);
    };
    // ★ 0.0.27（用户）：长按任意键只算一次
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      next();
    };
    const onClick = (): void => next();
    // 任意键 / 点击（在页面任意位置）都能进下一题。
    // 用 setTimeout(0) 推迟到本轮点击派发结束（等动画/事件收尾）再挂监听，避免同一次点击立刻触发下一题
    window.setTimeout(() => {
      document.addEventListener('keydown', onKey, true);
      box.addEventListener('click', onClick);
    }, 0);
  };

  // ══════════════════════ 炒饭式循环调度（1.0.3） ══════════════════════
  /**
   * 队列用完时补货：重新读一遍记录（通过次数刚变过）→ 重新按优先级排序 →
   * 从游标处再取一批追加到队列尾部。取完一轮自动绕回开头，于是「下一个」可以一直点下去。
   */
  const refillQueue = async (): Promise<boolean> => {
    await refreshData();
    if (tagged.length === 0) return false;
    const settings = currentSettings();
    const sorted = sortSpellCandidates(tagged, records, settings.spell);
    const next = takeCycleBatch(sorted, cycleOffset, settings.spell.count);
    cycleOffset = next.nextOffset;
    // 已消化的前缀丢掉，避免队列无限变长
    if (queue.length > settings.spell.count * 3) {
      queue = queue.slice(index);
      index = 0;
    }
    queue = queue.concat(next.batch);
    cycles += 1;
    return next.batch.length > 0;
  };

  /** 兜底：队列真的空了才补货并重画 */
  const refillThenDraw = async (): Promise<void> => {
    const ok = await refillQueue();
    if (!ok) {
      toastWarn('还没有标记要强化的单词');
      void refreshData().then(drawHome);
      return;
    }
    drawQuiz();
  };

  /**
   * 答完一题后的调度（用户规则 e）：未满分 → 插到后面隔 5 个词的位置再来一次，直到通过为止；
   * 队列走到头 → 自动循环到下一批（「炒饭式」），不再出现「本轮结束」的终点。
   * @param score 本题得分
   */
  const advance = (score: number): void => {
    const entry = queue[index];
    if (entry !== undefined && score < SPELL_MAX_SCORE) {
      // 规则 e：未通过 → 间隔 5 个单词后再次出现；剩余不足 5 个则追加到末尾
      queue = reinsertEntry(queue, index, { ...entry, record: records.get(entry.word.id) ?? null });
      roundRepeat += 1;
    }
    index += 1;
    if (index >= queue.length) {
      void (async () => {
        const ok = await refillQueue();
        if (!ok) {
          drawQuiz();
          return;
        }
        // 每循环一轮给一次轻提示（不打断答题）
        toastOk(`已循环第 ${cycles} 轮，继续练习`);
        drawQuiz();
      })();
      return;
    }
    drawQuiz();
  };
  // ── 初始化 ──
  void (async () => {
    try {
      await refreshData();
    } catch (err) {
      console.error('[spell] 读取数据失败', err);
    }
    drawHome();
  })();

  // 供测试/调试确认状态（不参与业务）
  page.dataset['stage'] = stage;

  return page;
}
