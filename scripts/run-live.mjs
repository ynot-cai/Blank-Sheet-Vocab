/**
 * 线上冒烟测试的启动器：自动带上系统代理。
 *
 * 背景（踩过的坑）：这台机器开着系统代理（127.0.0.1:7897），
 * PowerShell / curl 会自动走系统代理，但 **Node 的 fetch 默认完全忽略代理**，
 * 于是出现「浏览器能打开、curl 能通，Node 却 CONNECT_TIMEOUT」这种诡异现象。
 *
 * 解决办法：读 Windows 的 WinINET 代理设置，写进 HTTPS_PROXY / HTTP_PROXY，
 * 再用 Node 24 的 `--use-env-proxy` 让 fetch 真正走代理。
 * 没有配代理的机器上这些环境变量本来就只有 NO_PROXY，行为不变。
 *
 * 用法：node scripts/run-live.mjs [后端地址]
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

/** 传给被启动脚本的参数（后端地址） */
const args = process.argv.slice(2);

/** 环境变量：继承当前 + 补上代理 */
const env = { ...process.env };

/** Node 24 需要显式开启才会读代理环境变量 */
const nodeFlags = [];

try {
  // 读 WinINET 代理设置（非 Windows 或读不到就跳过）
  const out = execFileSync(
    'reg',
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
    { encoding: 'utf8' },
  );
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
  const serverOut = execFileSync(
    'reg',
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
    { encoding: 'utf8' },
  );
  const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(serverOut);
  const server = match?.[1] ?? '';

  if (enabled && server !== '') {
    // 可能形如 "http=127.0.0.1:7897;https=127.0.0.1:7897"，取第一段
    const first = server.split(';')[0];
    const hostPort = first.includes('=') ? first.split('=')[1] : first;
    const url = `http://${hostPort}`;
    env.HTTPS_PROXY = url;
    env.HTTP_PROXY = url;
    env.NO_PROXY = env.NO_PROXY ?? 'localhost,127.0.0.1';
    nodeFlags.push('--use-env-proxy');
    console.log(`[run-live] 检测到系统代理，已启用：${url}`);
  } else {
    console.log('[run-live] 未检测到系统代理，直连');
  }
} catch {
  console.log('[run-live] 读取系统代理设置失败（非 Windows 或权限不足），直连');
}

const child = spawn(process.execPath, [...nodeFlags, 'api/_dev/test-live.mjs', ...args], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => process.exit(code ?? 1));
