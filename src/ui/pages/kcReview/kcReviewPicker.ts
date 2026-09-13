/**
 * 复习的「选多少个」界面（从 KcReviewPage 拆出来：单文件 ≤ 300 行）。
 *
 * 与学习流程共用 `renderKcCountPicker`，复习额外给一句**推荐数字**的说明
 * （用户明确要求「进入时给一个推荐值」）。
 */
import type { KnowledgeCard } from '../../../core/kcTypes';
import { renderKcCountPicker } from '../../components/KcCountPicker';
import { h } from '../../dom';
import { navigate } from '../../router';
import { recommendReviewCount } from './kcReviewFlow';

/** 复习候选（学过/学完的卡片） */
function candidatesOf(all: KnowledgeCard[]): KnowledgeCard[] {
  return all.filter((c) => c.deleted !== 1 && (c.status === 'learning' || c.status === 'learned'));
}

/**
 * 渲染复习的选数量界面。
 * @param all 全部卡片
 * @param onStart 点「开始」回调（参数 = 复习几个）
 */
export function renderReviewPicker(all: KnowledgeCard[], onStart: (count: number) => void): HTMLElement {
  const box = h('div', {});
  const candidates = candidatesOf(all);
  const recommended = recommendReviewCount(all);
  box.appendChild(
    renderKcCountPicker({
      candidateCount: candidates.length,
      candidateLabel: '可复习',
      maxSuggest: Math.max(1, recommended),
      onStart,
      emptyTitle: '还没有学过的知识点',
      emptyHint: '复习只针对「学过」的卡片。先去「学习」过一遍，或者去「录入」加几张卡片。',
      emptyActions: [
        { label: '去学习', onClick: () => navigate('/kc/study') },
        { label: '去录入', onClick: () => navigate('/kc/import') },
      ],
    }),
  );
  if (candidates.length > 0) {
    box.appendChild(
      h('p', {
        class: 'kc-hint-dim kc-review-recommend',
        text: `按复习优先度算，建议这次复习约 ${recommended} 个（最该复习的那一批）。`,
      }),
    );
  }
  return box;
}
