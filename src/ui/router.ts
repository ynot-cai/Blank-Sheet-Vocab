/**
 * 极简 hash 路由：hash → 页面组件映射，未注册的路由回首页。
 */

/** 路由上下文 */
export interface RouteContext {
  /** 形如 '/list' */
  path: string;
  /** '?' 后面的查询参数 */
  query: URLSearchParams;
}

/** 页面渲染函数：返回要挂到出口容器的元素 */
export type RouteRender = (ctx: RouteContext) => HTMLElement;

const routes = new Map<string, RouteRender>();
let outlet: HTMLElement | null = null;
let fallbackPath = '/home';

/**
 * 注册一条路由。
 * @param path 形如 '/list'
 * @param render 渲染函数
 */
export function registerRoute(path: string, render: RouteRender): void {
  routes.set(path, render);
}

/**
 * 设置兜底路由（未匹配时用）。
 * @param path 路由路径
 */
export function setFallback(path: string): void {
  fallbackPath = path;
}

/**
 * 解析当前 hash。
 */
function parseHash(): RouteContext {
  const raw = window.location.hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const path = pathPart === '' ? fallbackPath : pathPart;
  return { path: path.startsWith('/') ? path : `/${path}`, query: new URLSearchParams(queryPart) };
}

/**
 * 跳转到某个路由。
 * @param path 形如 '/list'
 */
export function navigate(path: string): void {
  const next = path.startsWith('#') ? path : `#${path}`;
  if (window.location.hash === next) renderCurrent();
  else window.location.hash = next;
}

/**
 * 取当前路由路径。
 */
export function currentPath(): string {
  return parseHash().path;
}

/**
 * 渲染当前路由。
 */
function renderCurrent(): void {
  if (!outlet) return;
  const ctx = parseHash();
  const render = routes.get(ctx.path) ?? routes.get(fallbackPath);
  // 旧页面如果有清理回调先执行（白纸流程会挂全局 keydown 监听，必须摘掉）
  const prev = outlet.firstElementChild;
  if (prev instanceof HTMLElement) {
    const cleanup = cleanupMap.get(prev);
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        console.warn('[router] 页面清理失败', err);
      }
    }
  }
  outlet.replaceChildren();
  if (!render) {
    outlet.appendChild(document.createTextNode('没有可显示的页面'));
    return;
  }
  try {
    outlet.appendChild(render(ctx));
  } catch (err) {
    console.error('[router] 页面渲染失败', err);
    outlet.appendChild(document.createTextNode(`页面渲染失败：${err instanceof Error ? err.message : String(err)}`));
  }
  outlet.scrollTop = 0;
}

/** 页面元素 → 清理回调（路由切换时自动执行） */
const cleanupMap = new WeakMap<HTMLElement, () => void>();

/**
 * 给页面注册清理回调（页面被替换时执行，用于移除全局监听 / 销毁白纸流程）。
 * @param el 页面根元素
 * @param fn 清理函数
 */
export function registerCleanup(el: HTMLElement, fn: () => void): void {
  cleanupMap.set(el, fn);
}

let started = false;

/**
 * 启动路由（监听 hashchange）。
 * @param el 页面出口容器
 */
export function startRouter(el: HTMLElement): void {
  outlet = el;
  if (!started) {
    started = true;
    window.addEventListener('hashchange', renderCurrent);
  }
  renderCurrent();
}

/**
 * 重新渲染当前页面（数据变化后手动刷新用）。
 */
export function refresh(): void {
  renderCurrent();
}
