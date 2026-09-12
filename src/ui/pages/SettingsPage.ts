import { details, h } from '../dom';
import { renderAiSection } from './settings/AiSection';
import { renderCloudSection } from './settings/CloudSection';
import { renderDataSection } from './settings/DataSection';
import { renderDisplaySection } from './settings/DisplaySection';
import { renderPracticeSection } from './settings/PracticeSection';
import { renderPrioritySection } from './settings/PrioritySection';
import { renderStarParamsSection } from './settings/StarParamsSection';

/**
 * 设置页：A~G 七个折叠分区，默认展开 A 和 G。
 */
export function renderSettingsPage(): HTMLElement {
  const page = h('div', { class: 'page settings-page' });
  page.appendChild(h('h2', { class: 'page-title', text: '设置' }));
  page.appendChild(
    h('p', { class: 'note' }, '设置改动即存，存在本机浏览器里。星号参数（A 区）会影响背诵/记忆/复习的行为，建议先按默认值用一阵子再调。'),
  );

  page.appendChild(details('A. 星号参数（背诵 / 记忆 / 复习的规模）', [renderStarParamsSection()], true));
  page.appendChild(details('B. AI 解析（接口地址 / 模型名 / 密钥自己填）', [renderAiSection()], false));
  page.appendChild(details('C. 画面与纸张', [renderDisplaySection()], false));
  page.appendChild(details('D. 记忆与练习', [renderPracticeSection()], false));
  page.appendChild(details('E. 复习优先度', [renderPrioritySection()], false));
  page.appendChild(details('F. 云同步（多设备共用一份数据，可选）', [renderCloudSection()], false));
  page.appendChild(details('G. 数据（备份 / 恢复 / 清空）', [renderDataSection()], true));

  return page;
}
