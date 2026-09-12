/**
 * 极简 .env 读取（不引第三方依赖）。
 * 只支持 `KEY=VALUE` 这种写法，够自用项目使用；已存在的环境变量不覆盖
 * （这样命令行临时指定的值优先级最高）。
 *
 * 顺带注册 TypeScript 加载钩子（见 loader-register.mjs）：
 * 测试脚本必须**静态** import 这个文件，钩子才会在它动态 import src/**\/*.ts 之前生效。
 */
import { existsSync, readFileSync } from 'node:fs';
import './loader-register.mjs';

/** 是否已经读过，避免重复执行 */
let loaded = false;

/**
 * 把文件里的 KEY=VALUE 灌进 process.env。
 * @param {string} file 文件路径
 */
function loadOne(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * 依次读取 .env.local / .env。
 * @param {string} dir 目录（默认当前工作目录；脚本在 api/_dev 里时传 '..'）
 */
export function loadEnvFiles(dir = '.') {
  if (loaded) return;
  loaded = true;
  const prefix = dir === '.' ? '' : `${dir.replace(/\/+$/, '')}/`;
  loadOne(`${prefix}.env.local`);
  loadOne(`${prefix}.env`);
}
