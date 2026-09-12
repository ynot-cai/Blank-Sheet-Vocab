/**
 * 数据说明页（阶段 07）。
 *
 * 自用工具，语气直白：核心就一件事——**我的数据到底在哪**。
 * 内容必须与实际实现一致，不夸大也不含糊（这里的每一条都能在代码里对上）：
 * - 浏览器本地（主存储）：IndexedDB 库名 blank-sheet-vocab；
 * - 云端（可选）：Turso，只存同步码的 SHA-256 哈希 + 单词数据；
 * - 本地备份文件（可选）：Chrome/Edge 连文件夹后自动写 blank-sheet-vocab-data.json；
 * - 服务器**不接触** AI 密钥（方案 B），也没有任何存密钥的表。
 */
import { appVersionLabel } from '../../core/version';
import { SYNC, getSettings } from '../../core/config';
import { relativeTime } from '../../core/syncHelper';
import { button, h } from '../dom';
import { navigate } from '../router';

/**
 * 渲染「关于数据」页面。
 */
export function renderAboutPage(): HTMLElement {
  const page = h('div', { class: 'page about-page' });
  const settings = getSettings();

  page.appendChild(h('h2', { class: 'page-title', text: '数据说明' }));
  page.appendChild(
    h('p', { class: 'note' }, '这是自用工具，下面把「数据存在哪、服务器存什么、怎么删」一次性说清楚。'),
  );

  // ── 一、数据存在哪（三层） ──
  page.appendChild(h('h3', { class: 'sub-title', text: '一、数据存在哪里' }));
  page.appendChild(
    h(
      'div',
      { class: 'about-grid' },
      aboutCard('1. 浏览器本地（主）', [
        '单词、学习记录、设置、AI 接口配置全部存在你当前这台设备的浏览器里（IndexedDB，库名 blank-sheet-vocab）。',
        '断网也能用：录入、背诵、记忆、复习、列表都不依赖网络。',
        '换浏览器 / 清缓存就会没有——这是唯一的存储风险。',
      ]),
      aboutCard('2. 云端数据库（可选，用于多设备）', [
        `开启云同步后，单词数据会同步到你自己部署的后端（Vercel）+ Turso 数据库。`,
        `同步码不同 = 数据空间不同；所有设备填同一个码才能共用一份数据。`,
        `同步是后台静默的，失败也不影响本地使用（顶部只给一条轻提示）。`,
      ]),
      aboutCard('3. 本地备份文件（可选）', [
        'Chrome / Edge 上可以「连接本地文件夹」，之后每次改动自动写 blank-sheet-vocab-data.json（防抖 2 秒）。',
        '这个文件在你自己指定的文件夹里，和浏览器、和云端都无关。',
        'Safari 不支持这个能力，请用手动「导出备份」。',
      ]),
    ),
  );

  // ── 二、服务器存什么 ──
  page.appendChild(h('h3', { class: 'sub-title', text: '二、服务器存什么、不存什么' }));
  const yes = h('ul', { class: 'about-list about-yes' });
  for (const item of [
    '存：你的单词数据（英文、音标、例句、义项、学习记录）',
    `存：同步码的哈希值（SHA-256，64 位十六进制）——服务器不知道你的明文同步码`,
    '存：数据的更新时间戳与软删除标记（多设备同步要用）',
  ]) {
    yes.appendChild(h('li', { text: `✅ ${item}` }));
  }
  const no = h('ul', { class: 'about-list about-no' });
  for (const item of [
    '不存：你的 AI 接口密钥（只在你自己浏览器里，服务器全程不接收、不存储）',
    '不存：你的姓名、手机号、邮箱、位置等任何个人信息',
    '不存：浏览记录；不做用户追踪、行为分析、广告',
  ]) {
    no.appendChild(h('li', { text: `❌ ${item}` }));
  }
  page.appendChild(yes);
  page.appendChild(no);
  page.appendChild(
    h(
      'p',
      { class: 'note' },
      'AI 密钥的用法是「方案 B」：调用 AI 时由你的浏览器把密钥发出去（直连，或被跨域拦住时经 /api/ai-proxy 转发一次），服务器只做转发，用完即弃，不写库、不写日志、不缓存。',
    ),
  );

  // ── 三、安全说明 ──
  page.appendChild(h('h3', { class: 'sub-title', text: '三、安全说明' }));
  page.appendChild(
    h('ul', { class: 'about-list' }, [
      h('li', { text: '全站 HTTPS（Vercel 自动签发证书，无需自己配）' }),
      h('li', { text: '同步码只以哈希形式存储；数据库里也没有任何存密钥的表' }),
      h('li', { text: '所有数据查询都带空间隔离条件，换一个同步码就是另一个互不可见的数据空间' }),
      h('li', { text: `AI 代理只允许转发白名单内的上游域名（可配置），代理本身不连数据库` }),
    ]),
  );

  // ── 四、数据怎么删 ──
  page.appendChild(h('h3', { class: 'sub-title', text: '四、数据怎么删' }));
  page.appendChild(
    h('ul', { class: 'about-list' }, [
      h('li', { text: '设置 → 云同步 → 「清空云端数据」：删掉云端这个同步码下的全部数据（本机不动）' }),
      h('li', { text: '浏览器设置里「清除网站数据」：删掉本地存储（含同步码与 AI 密钥，会丢，请先导出备份）' }),
      h('li', { text: '换一个同步码：相当于换一个全新的数据空间，旧数据仍在旧码下，随时填回旧码就能看到' }),
      h('li', { text: '设置 → 数据 → 「清空本地数据」：把本机词库清空' }),
    ]),
  );

  // ── 五、当前状态（把实际配置回显出来，方便自查） ──
  page.appendChild(h('h3', { class: 'sub-title', text: '五、当前的同步状态' }));
  const statusBox = h('ul', { class: 'about-list' });
  const cloud = settings.cloud;
  statusBox.appendChild(h('li', { text: `云同步：${cloud.enabled ? '已开启' : '未开启（纯本地使用）'}` }));
  if (cloud.enabled) {
    statusBox.appendChild(h('li', { text: `后端地址：${cloud.apiBase.trim() === '' ? '（未填）' : cloud.apiBase}` }));
    statusBox.appendChild(h('li', { text: `同步码：${cloud.syncCode.trim() === '' ? '（未填）' : `已设置（${cloud.syncCode.trim().length} 位，明文只在这台设备）`}` }));
    statusBox.appendChild(h('li', { text: `上次同步：${relativeTime(cloud.lastSyncAt)}` }));
  }
  statusBox.appendChild(h('li', { text: `自动同步：${cloud.autoSync ? '开' : '关'}（数据变动后防抖 ${Math.round(SYNC.debounceMs / 1000)} 秒）` }));
  statusBox.appendChild(h('li', { text: `AI 密钥：${settings.ai.key.trim() === '' ? '未填（纯离线规则解析）' : '已填（只在这台设备的浏览器里）'}` }));
  page.appendChild(statusBox);

  // ── 六、版本与免责 ──
  page.appendChild(h('h3', { class: 'sub-title', text: '六、版本与免责' }));
  page.appendChild(
    h('ul', { class: 'about-list' }, [
      h('li', { text: `当前版本：${appVersionLabel()}（构建时间戳，刷新后变了就是新版本）` }),
      h('li', { text: 'AI 生成的释义、例句可能有误，请自行甄别' }),
      h('li', { text: '本工具为个人自用项目，按「现状」提供，不承诺任何可用性' }),
    ]),
  );

  // ── 底部操作 ──
  page.appendChild(
    h(
      'div',
      { class: 'row' },
      button('返回首页', () => navigate('/home'), { variant: 'primary' }),
      button('去设置备份', () => navigate('/settings'), { variant: 'ghost' }),
    ),
  );

  // 备案号占位（默认隐藏，设置 → 画面与纸张 里填了才显示）
  const icp = getSettings().display.beian ?? '';
  if (icp.trim() !== '') {
    page.appendChild(h('p', { class: 'footer-small', text: icp.trim() }));
  }

  return page;
}

/**
 * 一张小卡片（标题 + 若干条说明）。
 * @param title 标题
 * @param lines 说明文字
 */
function aboutCard(title: string, lines: string[]): HTMLElement {
  const box = h('div', { class: 'about-card' });
  box.appendChild(h('h4', { class: 'about-card-title', text: title }));
  for (const line of lines) box.appendChild(h('p', { class: 'about-card-line', text: line }));
  return box;
}
