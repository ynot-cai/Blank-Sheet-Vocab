/**
 * PWA 支持（阶段 06）：注册 Service Worker、新版本提示、添加到主屏幕引导。
 *
 * 三条纪律：
 * 1. **新版本不自动刷新**——正在背单词时被刷新会丢进度，所以只提示，用户点了才换；
 * 2. **不阻断**——注册失败（比如在 http 上打开）只打日志，页面照常用；
 * 3. **只在需要时打扰**——已经装到主屏幕了就不再提示安装。
 */

/** 顶部提示条的容器（由 App 提供） */
let bannerHost: HTMLElement | null = null;

/** 「添加到主屏幕」引导的标记键 */
const INSTALL_HINT_KEY = 'blank-sheet-vocab.installHintShown';

/**
 * 设置提示条容器（App 挂载后调用）。
 * @param host 容器元素
 */
export function setBannerHost(host: HTMLElement): void {
  bannerHost = host;
}

/**
 * 是否以「独立窗口」方式打开（= 已经添加到主屏幕）。
 */
export function isStandalone(): boolean {
  const mq = window.matchMedia?.('(display-mode: standalone)');
  // iOS Safari 用的是 navigator.standalone
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return Boolean(mq?.matches) || iosStandalone;
}

/**
 * 注册 Service Worker（只在支持且非本地文件协议时）。
 * 注意：http 下浏览器不注册 SW，只有 https 和 localhost 可以。
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    console.info('[pwa] 当前浏览器不支持 Service Worker，离线能力不可用（不影响正常使用）');
    return;
  }
  if (location.protocol === 'file:') return;

  // 首次就接管页面的情况（说明是第一次装）：不算「有新版本」
  let hadController = navigator.serviceWorker.controller !== null;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    // 新版本已经接管：这时候刷新才会真正用上新代码
    showUpdateBanner();
  });

  void navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      console.info('[pwa] Service Worker 已注册');

      // 发现新版本 → 提示用户（不自动刷新）
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
        });
      });
    })
    .catch((err: unknown) => {
      console.warn('[pwa] Service Worker 注册失败（离线能力不可用，其他功能正常）', err);
    });
}

/** 是否已经提示过「有新版本」 */
let updateBannerShown = false;

/** 显示「有新版本可用，点击刷新」提示条 */
function showUpdateBanner(): void {
  if (updateBannerShown || !bannerHost) return;
  updateBannerShown = true;

  const bar = document.createElement('div');
  bar.className = 'update-banner';
  bar.textContent = '有新版本可用，点击刷新';
  bar.addEventListener('click', () => {
    // 通知 SW 立即接管，然后刷新（用户主动点的，不会丢进度）
    navigator.serviceWorker.controller?.postMessage('skip-waiting');
    window.location.reload();
  });
  bannerHost.appendChild(bar);
}

/**
 * 首次在手机上打开时，提示一次「怎么加到主屏幕」。
 * Android / iOS 的说法不一样，所以分开写。
 */
export function maybeShowInstallHint(): void {
  if (isStandalone() || !bannerHost) return;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!isMobile) return;
  try {
    if (localStorage.getItem(INSTALL_HINT_KEY) === '1') return;
  } catch {
    return; // 隐私模式读不到就不提示，别每次都烦人
  }

  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const bar = document.createElement('div');
  bar.className = 'install-banner';

  const text = document.createElement('span');
  text.textContent = isIos
    ? '想当 App 用？点浏览器底部的「分享」→「添加到主屏幕」'
    : '想当 App 用？点浏览器菜单 →「添加到主屏幕」';
  bar.appendChild(text);

  const close = document.createElement('button');
  close.className = 'btn btn-ghost install-close';
  close.type = 'button';
  close.textContent = '知道了';
  close.addEventListener('click', () => {
    try {
      localStorage.setItem(INSTALL_HINT_KEY, '1');
    } catch {
      /* 写不进去也无所谓 */
    }
    bar.remove();
  });
  bar.appendChild(close);
  bannerHost.appendChild(bar);
}
