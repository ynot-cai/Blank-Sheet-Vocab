import * as localfile from './services/localfile';
import * as dao from './dao';
import { button, h } from './ui/dom';
import { registerRoute, setFallback, startRouter, currentPath, navigate } from './ui/router';
import { renderHomePage } from './ui/pages/HomePage';
import { renderSettingsPage } from './ui/pages/SettingsPage';
import { renderImportPage } from './ui/pages/ImportPage';
import { renderMergePage } from './ui/pages/MergePage';
import { renderListPage } from './ui/pages/ListPage';
import { renderLearnPage } from './ui/pages/LearnPage';
import { renderLearnPaperPage } from './ui/pages/LearnPaperPage';
import { renderAboutPage } from './ui/pages/AboutPage';
import { renderFooter } from './ui/components/Footer';
import { PLACEHOLDER_SPECS, renderPlaceholderPage } from './ui/pages/PlaceholderPage';
import { mountSyncBanner } from './ui/components/SyncBanner';
import { maybeShowInstallHint, registerServiceWorker, setBannerHost } from './services/pwa';
import { toastOk, toastWarn } from './ui/components/Toast';

/**
 * 顶部浅白栏的全局入口（版本 0.0.3）。
 *
 * ── 两排的分工（`逻辑与交互要求.md` §5.1）──
 * - **第一排**：会进入学习 / 练习的——录入、背诵、复习、拼写强化。
 *   以后凡涉及实际背诵工作的按钮，一律加在第一排。
 * - **第二排**：数据查看与系统设置——单词列表、设置。
 *
 * 白栏上的这一排是**全局入口**（用户在 0.0.3 明确选择），不是页面工具栏；
 * 首页时右侧**留空**（首页自己已经有一整套按钮了）。
 */
const NAV: { path: string; label: string }[] = [
  { path: '/import', label: '录入' },
  { path: '/learn', label: '背诵' },
  { path: '/review', label: '复习' },
  { path: '/spell', label: '拼写强化' },
  { path: '/list', label: '单词列表' },
  { path: '/settings', label: '设置' },
];

/**
 * **白栏整体消失**的界面（`逻辑与交互要求.md` §5.1）。
 * 判据不是「哪几个页面」，而是「**进去就是练**」——背诵、复习、拼写强化。
 * 以后新增的全屏练习界面，也要加进这里。
 */
const FULLSCREEN_PATHS = ['/learn/paper', '/review', '/spell'];

/** 首页路径：白栏标题右侧留空 */
const HOME_PATH = '/home';

/**
 * 路由表（版本 0.0.6）。
 *
 * ★ 0.0.6 装回了三套归档模块（用户要求「恢复已归档的程序」）：
 *   - **录入**（`/import`，含 `/merge` 合并确认页）—— 归档文档 04 / 07
 *   - **单词列表**（`/list`）—— 归档文档 08
 *   它们的依赖（services/fileParse、importJob、parsePipeline、presetVocab、reparse、
 *   core/parser、core/merge）也一并装回。
 *
 * ⚠️ **仍然没有实现的两项**（保持占位页）：
 *   - 背诵 `/learn`、复习 `/review`：它们共用「白纸画布」，那是本次归档里最大的一块
 *     （`已归档/02`，2,890 行），用户本轮没有要求恢复；
 *   - 拼写强化 `/spell`：全新的独立功能，用户明确「现在先别做，只做按钮」。
 */
function registerRoutes(): void {
  registerRoute(HOME_PATH, () => renderHomePage());
  registerRoute('/settings', () => renderSettingsPage());
  registerRoute('/import', () => renderImportPage());
  registerRoute('/merge', () => renderMergePage());
  registerRoute('/list', () => renderListPage());
  for (const spec of PLACEHOLDER_SPECS) {
    registerRoute(spec.path, () => renderPlaceholderPage(spec));
  }
  /**
   * ★ 背诵（版本 0.0.9）：入口页 + 白纸界面。
   * 写在占位页循环**之后**，覆盖掉 `PLACEHOLDER_SPECS` 里原先的 `/learn` 占位
   * （路由表是 `Map`，后来者覆盖前者）。
   * ⚠️ `/learn` 是**入口页**（要保留顶栏那排全局入口），只有 `/learn/paper` 才全屏。
   */
  registerRoute('/learn', () => renderLearnPage());
  registerRoute('/learn/paper', () => renderLearnPaperPage());
  registerRoute('/about', () => renderAboutPage());
  setFallback(HOME_PATH);
}

/**
 * 本地文件夹权限黄条：浏览器重启后需要用户点一下才能恢复读写权限。
 *
 * ★ 保留说明：这条黄条属于**数据层**（本地文件夹自动备份）的一部分，不是设置项。
 *   设置页没有它的入口，但连接权限的恢复入口必须留着 ——
 *   否则已经连过本地文件夹的用户在浏览器重启后再也没有办法恢复备份写入。
 */
function renderPermissionBanner(container: HTMLElement): void {
  const draw = (): void => {
    container.replaceChildren();
    if (!localfile.isSupported() || !localfile.isLinked() || !localfile.needsPermission()) return;
    container.appendChild(
      h(
        'div',
        { class: 'perm-banner' },
        h('span', { text: '与本地文件夹的连接需要重新授权，点一下继续自动备份。' }),
        button(
          '点击恢复与本地文件夹的连接',
          () => {
            void localfile.requestPermission().then((ok) => {
              if (ok) {
                toastWarn('已恢复连接');
                void localfile.syncNow().catch(() => undefined);
              } else toastWarn('未获得授权，可以稍后再点');
              draw();
            });
          },
          { variant: 'primary' },
        ),
      ),
    );
  };
  localfile.subscribe(draw);
  draw();
}

/**
 * 挂载主界面：顶部浅白栏 + 路由出口。
 * @param root 挂载点
 */
export function renderApp(root: HTMLElement): void {
  root.replaceChildren();

  const navBox = h('nav', { class: 'nav' });
  const bannerBox = h('div', { class: 'banner-box' });
  const outlet = h('main', { class: 'outlet' });

  const paintNav = (): void => {
    const path = currentPath();
    navBox.replaceChildren();

    // 全屏练习界面：白栏整体消失（先判它，后面的按钮就不用建了）
    const fullscreen = FULLSCREEN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
    navBox.classList.toggle('nav-hidden', fullscreen);
    if (fullscreen) return;

    navBox.appendChild(h('span', { class: 'nav-tagline', text: '用白纸单词——个人自用的背单词工具' }));
    navBox.appendChild(h('span', { class: 'brand', text: '白纸单词' }));

    // 首页标题右侧留空（首页自己就是入口，再来一排全局入口是重复的）
    if (path === HOME_PATH) return;

    const actions = h('div', { class: 'nav-actions' });
    for (const item of NAV) {
      actions.appendChild(button(item.label, () => navigate(item.path)));
    }
    navBox.appendChild(actions);
  };

  registerRoutes();
  root.appendChild(navBox);
  root.appendChild(bannerBox);
  root.appendChild(outlet);
  root.appendChild(renderFooter());
  renderPermissionBanner(bannerBox);
  // 云同步失败时的轻提示 / 常驻提示（不阻断任何操作）
  mountSyncBanner(bannerBox, () => {
    void dao.syncScheduler
      .syncNow()
      .then((res) => {
        if (res && !res.error) toastOk(`同步完成：拉取 ${res.pulled} 条 / 推送 ${res.pushed} 条`);
        else toastWarn(`同步仍然失败：${res?.error ?? '未知原因'}`);
      })
      .catch(() => toastWarn('同步失败，数据已存本地'));
  });

  // PWA：新版本提示条与「添加到主屏幕」引导都挂在同一个容器里。
  // 注册失败（例如 http 打开）只打日志，页面照常用。
  setBannerHost(bannerBox);
  registerServiceWorker();
  maybeShowInstallHint();

  window.addEventListener('hashchange', paintNav);
  paintNav();
  startRouter(outlet);

  // 关页面前提醒导出（距上次手动导出超过 7 天时提醒）
  window.addEventListener('beforeunload', (ev) => {
    const { remindOnClose, lastManualExportAt } = appBackupSettings;
    if (!remindOnClose || !localfile.isLinked()) return;
    if (lastManualExportAt !== null && Date.now() - lastManualExportAt < 7 * 86_400_000) return;
    ev.preventDefault();
    ev.returnValue = '';
  });
}

/** 由 main.ts 注入的备份设置快照 */
let appBackupSettings: { remindOnClose: boolean; lastManualExportAt: number | null } = {
  remindOnClose: true,
  lastManualExportAt: null,
};

/**
 * 更新关页提醒用的设置快照（main.ts 在载入/变更设置时调用）。
 * @param next 备份设置
 */
export function setBackupSettingsSnapshot(next: { remindOnClose: boolean; lastManualExportAt: number | null }): void {
  appBackupSettings = next;
}
