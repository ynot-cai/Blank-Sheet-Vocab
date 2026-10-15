import * as localfile from './services/localfile';
import * as dao from './dao';
import { button, h } from './ui/dom';
import { registerRoute, setFallback, startRouter, currentPath, navigate } from './ui/router';
import { renderHomePage } from './ui/pages/HomePage';
import { renderSettingsPage } from './ui/pages/SettingsPage';
import { mountSyncBanner } from './ui/components/SyncBanner';
import { maybeShowInstallHint, registerServiceWorker, setBannerHost } from './services/pwa';
import { toastOk, toastWarn } from './ui/components/Toast';

/**
 * 顶部导航按钮。
 *
 * ★ 版本 0.0.1「删除与归档行动」：顶栏**只保留「设置」一个入口**。
 *   录入 / 背诵 / 单词列表 / 复习 / 知识点 五个入口随各自模块一起归档删除
 *   （见 已归档/ 目录下 01~12 号模块文档）。
 *   现在整个程序的可达界面只有两页：主页（`/home`）与设置页（`/settings`）。
 */
const NAV: { path: string; label: string }[] = [{ path: '/settings', label: '设置' }];

/**
 * 路由表。
 *
 * ★ 版本 0.0.1：只保留主页与设置页两条路由。
 *   被拔掉的页面（录入 / 合并 / 单词列表 / 背诵 / 记忆 / 复习 / 关于 /
 *   知识点十一个页面 / 布局调试页）连同它们的源码一起进了「已归档」，
 *   路由在这里一并删除 —— 不留「死路由」，因为它们的目标模块已经不在程序里了。
 */
function registerRoutes(): void {
  registerRoute('/home', () => renderHomePage());
  registerRoute('/settings', () => renderSettingsPage());
  setFallback('/home');
}

/**
 * 本地文件夹权限黄条：浏览器重启后需要用户点一下才能恢复读写权限。
 *
 * ★ 保留说明：这条黄条属于**数据层**（本地文件夹自动备份）的一部分，不是设置项。
 *   设置页的「数据」分区已归档，但连接权限的恢复入口必须留着 ——
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
      btn.classList.toggle('active', currentPath() === item.path);
      navBox.appendChild(btn);
    }
  };

  registerRoutes();
  root.appendChild(navBox);
  root.appendChild(bannerBox);
  root.appendChild(outlet);
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
