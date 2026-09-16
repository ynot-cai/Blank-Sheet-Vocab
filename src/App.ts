import * as localfile from './services/localfile';
import * as dao from './dao';
import { button, h } from './ui/dom';
import { registerRoute, setFallback, startRouter, currentPath, navigate } from './ui/router';
import { renderHomePage } from './ui/pages/HomePage';
import { renderImportPage } from './ui/pages/ImportPage';
import { renderListPage } from './ui/pages/ListPage';
import { renderMergePage } from './ui/pages/MergePage';
import { renderSettingsPage } from './ui/pages/SettingsPage';
import { renderLearnPage } from './ui/pages/LearnPage';
import { renderMemorizePage } from './ui/pages/MemorizePage';
import { renderReviewPage } from './ui/pages/ReviewPage';
import { mountSyncBanner } from './ui/components/SyncBanner';
import { renderFooter } from './ui/components/Footer';
import { maybeShowInstallHint, registerServiceWorker, setBannerHost } from './services/pwa';
import { toastOk, toastWarn } from './ui/components/Toast';
import { renderAboutPage } from './ui/pages/AboutPage';
import { renderKcHomePage } from './ui/pages/KcHomePage';
import { renderKcImportPage } from './ui/pages/KcImportPage';
import { renderKcCardListPage } from './ui/pages/KcCardListPage';
import { renderKcCardEditPage } from './ui/pages/KcCardEditPage';
import { renderKcCardViewPage } from './ui/pages/KcCardViewPage';
import { renderKcStudyPage } from './ui/pages/KcStudyPage';
import { renderKcExamPage } from './ui/pages/KcExamPage';
import { renderKcReviewPage } from './ui/pages/KcReviewPage';
import { renderKcSettingsPage } from './ui/pages/KcSettingsPage';
import { renderKcBankPage } from './ui/pages/KcBankPage';
import { renderDevLayoutPage } from './ui/pages/DevLayoutPage';

/**
 * 顶部导航按钮（全部点亮）。
 *
 * ★ R3：删掉了 `/memorize`「记忆」这一项。
 *   记忆环节现在是**背诵流程的内嵌环节**（背诵页的「再背一个」点够次数后按钮变「记忆」，
 *   右下角还有独立的「再次记忆」），主界面和顶栏都不再需要独立入口。
 *   路由本身**保留**（`/memorize` 仍然可用、背记页照常跳得过去），
 *   所以没有任何「孤儿链接」：全项目搜索 `#/memorize` / `navigate('/memorize')` 已确认无残留。
 */
const NAV: { path: string; label: string }[] = [
  { path: '/import', label: '录入' },
  { path: '/learn', label: '背诵' },
  { path: '/list', label: '单词列表' },
  { path: '/review', label: '复习' },
  // 二期入口：数据与一期完全独立，只是共用同一套同步通道（见二期主提示词第 7 节）
  { path: '/kc', label: '知识点' },
  { path: '/settings', label: '设置' },
];

/** 路由表 */
function registerRoutes(): void {
  registerRoute('/home', () => renderHomePage());
  registerRoute('/import', () => renderImportPage());
  registerRoute('/merge', () => renderMergePage());
  registerRoute('/list', () => renderListPage());
  registerRoute('/settings', () => renderSettingsPage());
  registerRoute('/learn', (ctx) => renderLearnPage(ctx));
  registerRoute('/memorize', () => renderMemorizePage());
  registerRoute('/review', (ctx) => renderReviewPage(ctx));
  // 数据说明页（阶段 07）：首页底部的 footer 与设置页都能进来
  registerRoute('/about', () => renderAboutPage());
  // ── 二期（知识点精学）──
  registerRoute('/kc', () => renderKcHomePage());
  registerRoute('/kc/import', () => renderKcImportPage());
  registerRoute('/kc/list', () => renderKcCardListPage());
  // 带参数的路由走 query（一期路由是精确匹配的 Map，没有动态段）：#/kc/edit?id=xxx
  registerRoute('/kc/edit', (ctx) => renderKcCardEditPage(ctx));
  registerRoute('/kc/view', (ctx) => renderKcCardViewPage(ctx));
  registerRoute('/kc/study', (ctx) => renderKcStudyPage(ctx));
  registerRoute('/kc/exam', (ctx) => renderKcExamPage(ctx));
  registerRoute('/kc/review', (ctx) => renderKcReviewPage(ctx));
  registerRoute('/kc/settings', () => renderKcSettingsPage());
  registerRoute('/kc/bank', () => renderKcBankPage());
  // 布局调试页（阶段 M1 手机适配诊断）：#/dev/layout
  // 保留在生产构建里（`?probe=1` 会被 probeLayout.mjs 用无头浏览器打），
  // 顶栏没有入口，只有知道地址才进得来；它只读不写，不改任何用户数据。
  registerRoute('/dev/layout', (ctx) => renderDevLayoutPage(ctx.query));
  setFallback('/home');
}

/**
 * 本地文件夹权限黄条：浏览器重启后需要用户点一下才能恢复读写权限。
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
 * 挂载主界面：顶栏 + 路由出口。
 * @param root 挂载点
 */
export function renderApp(root: HTMLElement): void {
  root.replaceChildren();

  const navBox = h('nav', { class: 'nav' });
  const bannerBox = h('div', { class: 'banner-box' });
  const outlet = h('main', { class: 'outlet' });

  const paintNav = (): void => {
    navBox.replaceChildren();
    navBox.appendChild(h('span', { class: 'brand', text: '白纸单词' }));
    for (const item of NAV) {
      const btn = button(item.label, () => navigate(item.path));
      // 二期是一整棵子树（/kc、/kc/import、/kc/list…），
      // 所以 /kc 这个入口在它的**所有子路由**下都该点亮
      const active = currentPath() === item.path || (item.path === '/kc' && currentPath().startsWith('/kc/'));
      btn.classList.toggle('active', active);
      navBox.appendChild(btn);
    }
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

  // PWA（阶段 06）：新版本提示条与「添加到主屏幕」引导都挂在同一个容器里。
  // 注册失败（例如 http 打开）只打日志，页面照常用。
  setBannerHost(bannerBox);
  registerServiceWorker();
  maybeShowInstallHint();

  window.addEventListener('hashchange', paintNav);
  paintNav();
  startRouter(outlet);

  // 关页面前提醒导出（距上次手动导出超过 7 天时提醒）
  window.addEventListener('beforeunload', (ev) => {
    const { remindOnClose, lastManualExportAt } = getBackupSettings();
    if (!remindOnClose || !localfile.isLinked()) return;
    if (lastManualExportAt !== null && Date.now() - lastManualExportAt < 7 * 86_400_000) return;
    ev.preventDefault();
    ev.returnValue = '';
  });
}

/** 读备份设置（避免在 App 里直接碰 dao / config 的缓存细节） */
function getBackupSettings(): { remindOnClose: boolean; lastManualExportAt: number | null } {
  const raw = appBackupSettings;
  return raw;
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
