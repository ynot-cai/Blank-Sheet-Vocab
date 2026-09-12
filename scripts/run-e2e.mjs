/**
 * 端到端测试的启动器：自动带上系统代理（理由同 run-live.mjs）。
 *
 * 用法：node scripts/run-e2e.mjs [后端地址]
 */
import { spawn, execFileSync } from 'node:child_process';

/** 传给被测脚本的参数（后端地址） */
const args = process.argv.slice(2);
const env = { ...process.env };
const nodeFlags = [];

try {
  const query = (name) =>
    execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name],
      { encoding: 'utf8' },
    );
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(query('ProxyEnable'));
  const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(query('ProxyServer'));
  const server = match?.[1] ?? '';

  if (enabled && server !== '') {
    const first = server.split(';')[0];
    const hostPort = first.includes('=') ? first.split('=')[1] : first;
    const url = `http://${hostPort}`;
    env.HTTPS_PROXY = url;
    env.HTTP_PROXY = url;
    env.NO_PROXY = env.NO_PROXY ?? 'localhost,127.0.0.1';
    nodeFlags.push('--use-env-proxy');
    console.log(`[run-e2e] 检测到系统代理，已启用：${url}`);
  } else {
    console.log('[run-e2e] 未检测到系统代理，直连');
  }
} catch {
  console.log('[run-e2e] 读取系统代理设置失败，直连');
}

const child = spawn(process.execPath, [...nodeFlags, 'api/_dev/test-e2e.mjs', ...args], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => process.exit(code ?? 1));
