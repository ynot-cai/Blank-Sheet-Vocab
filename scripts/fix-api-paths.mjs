/**
 * 一次性迁移：把测试脚本里引用的接口路径改成与 Vercel 一致的形式。
 *
 * `/api/sync-pull`  → `/api/sync-pull`
 * `/api/sync-push`  → `/api/sync-push`
 * `/api/sync-purge` → `/api/sync-purge`
 *
 * 背景：Vercel 把 api/ 下的文件名映射成路由，`api/sync-pull.ts` 对应 `/api/sync-pull`。
 * 之前前端与本地测试壳都写成带斜杠的路径，线上一直 404（表现是「同步不了」）。
 * 只改字符串字面量与 fetch 模板串，注释里保留说明性文字不动。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 要处理的目录 */
const DIRS = ['api/_dev', 'scripts'];

/** 替换规则：只在字符串字面量/模板串里出现时替换 */
const RULES = [
  [/\/api\/sync\/pull/g, '/api/sync-pull'],
  [/\/api\/sync\/push/g, '/api/sync-push'],
  [/\/api\/sync\/purge/g, '/api/sync-purge'],
];

let changed = 0;

for (const dir of DIRS) {
  for (const name of readdirSync(dir)) {
    if (!/\.(mjs|ts)$/.test(name)) continue;
    const file = join(dir, name);
    const before = readFileSync(file, 'utf8');
    let after = before;
    for (const [pattern, replacement] of RULES) {
      after = after.replace(pattern, replacement);
    }
    if (after !== before) {
      writeFileSync(file, after, 'utf8');
      changed += 1;
      console.log(`  改：${file}`);
    }
  }
}

console.log('');
console.log(`一共修改 ${changed} 个文件`);
