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

/** 顶部导航按钮（全部点亮） */
const NAV: { path: string; label: string }[] = [
  { path: '/import', label: '录入' },
  { path: '/learn', label: '背诵' },
  { path: '/memorize', label: '记忆' },
  { path: '/list', label: '单词列表' },
  { path: '/review', label: '复习' },
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
  setFallback('/home');
}

/** 点「记忆」：没有进行中的背诵会话时给提示 */
function onMemorizeClick(): void {
  void (async () => {
    const session = await dao.session.loadSession();
    if (!session || session.finished || session.type !== 'learn' || session.wordIds.length === 0) {
      toastWarn('请先开始一轮背诵');
      navigate('/learn');
      return;
    }
    navigate('/memorize');
  })();
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
    const active = currentPath();
    navBox.replaceChildren();
    navBox.appendChild(h('span', { class: 'brand', text: '单词白纸' }));
    for (const item of NAV) {
      const btn = button(item.label, () => {
        if (item.path === '/memorize') onMemorizeClick();
        else navigate(item.path);
      });
      btn.classList.toggle('active', active === item.path);
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
