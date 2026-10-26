/**
 * 单词级的 AI 操作（版本 0.1.1）。
 *
 * 现在只有一项：**AI 重新整理义项**（用户：「在单词列表和单词模块中增加一个『AI 重新整理义项』按钮」）。
 * 放在这里是因为单词卡、单词列表、白纸页、拼写强化页都要用它，各写一遍必然不一致。
 *
 * RULES-R1: 这里只改义项文本，不参与作答判定，也没有时间限制。
 */
import type { Word } from '../core/types';
import * as dao from '../dao';
import { aiConfigFromSettings } from '../services/ai';
import { reorganizeSenses } from '../services/aiSenses';
import { toastError, toastOk, toastWarn } from './components/Toast';
import { currentSettings } from './pages/settings/ctx';

/**
 * 用 AI 重新整理一个词的义项并落库。
 *
 * - 没配 AI（没填密钥）→ 提示去设置页填，不做任何修改；
 * - AI 失败 / 返回不合法 → 提示原因，**词条保持原样**；
 * - 成功 → 写回 `senses`，用新义项数量提示用户。
 *
 * @param word 词
 * @param onSaved 写库成功后的回调（页面用来刷新卡片/列表）
 */
export async function reorganizeWordSenses(word: Word, onSaved?: (next: Word) => void): Promise<void> {
  const settings = currentSettings();
  if (settings.ai.key.trim() === '') {
    toastWarn('先在「设置 → AI 接口」里填密钥，才能用 AI 整理义项');
    return;
  }
  const result = await reorganizeSenses(aiConfigFromSettings(settings), word);
  if (result.error !== '') {
    toastError(`AI 整理义项失败：${result.error}`);
    return;
  }
  const next: Word = { ...word, senses: result.senses };
  await dao.words.put(next);
  toastOk(`已重新整理「${word.en}」的义项（${result.senses.length} 个）`);
  onSaved?.(next);
}
