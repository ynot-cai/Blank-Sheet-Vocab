// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import { setSettingsCache } from '../../core/config';
import * as dao from '../../dao';
import { button, h } from '../dom';
import { navigate, registerCleanup } from '../router';
import { createPaperFlow } from './paper/flow';

/**
 * 记忆页（阶段 06）：复用同一个白纸画布，直接进入记忆模式。
 * 没有进行中的背诵会话时提示先开始一轮背诵。
 */
export function renderMemorizePage(): HTMLElement {
  const page = h('div', { class: 'page memorize-page' });

  void (async () => {
    setSettingsCache(await dao.settings.get()); // 同步设置缓存
    const session = await dao.session.loadSession();
    if (!session || session.finished || session.type !== 'learn' || session.wordIds.length === 0) {
      page.replaceChildren(
        h('p', { class: 'note warn' }, '还没有进行中的背诵会话。请先开始一轮背诵。'),
        button('去背诵', () => navigate('/learn'), { variant: 'primary' }),
      );
      return;
    }
    const flow = createPaperFlow({ session, mode: 'learn', groupIndex: 0, groupCount: 1, startInMemorize: true });
    page.replaceChildren(flow.root);
    registerCleanup(page, () => flow.destroy());
  })();

  return page;
}
