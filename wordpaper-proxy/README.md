# wordpaper-proxy（自建转发脚本，可选）

> 独立小项目，**前端代码零改动**。能直连官方接口就不用装它。

## 什么时候需要它

浏览器直连大模型 API 常遇到两个问题：

1. 很多服务不返回 CORS 头，浏览器会把请求拦掉（控制台报跨域错误）；
2. 前端填的 Key 等于公开在页面里。

这个脚本给你一个选择：自己部署一个转发口——网站连它，它去连真正的服务，并带上 CORS 头。
**只有直连报跨域错误时才需要**；能直连就不用装。

## 部署步骤

```bash
cd wordpaper-proxy
npm i
npx wrangler login
# （可选）把上游密钥固定写在服务端：
npx wrangler secret put UPSTREAM_KEY
# （强烈建议）设一个访问口令，防止陌生人白嫖你的额度：
npx wrangler secret put ACCESS_TOKEN
npm run deploy
```

部署完成后会得到形如 `https://xxx.workers.dev` 的地址。

## 前端怎么用（一行就够）

设置页 → AI 解析 →「接口地址」填 `https://xxx.workers.dev`，「密钥」填你设的 ACCESS_TOKEN
（若没设 UPSTREAM_KEY，密钥就填你自己的上游密钥；若设了 UPSTREAM_KEY，密钥只用来过口令）。
**前端不用改任何代码。**

## 换服务

改环境变量 `UPSTREAM_BASE` 即可（如 `wrangler secret put UPSTREAM_BASE` 或直接改 `wrangler.toml` 的 vars），
任何 OpenAI 兼容格式的服务都能填。

## 安全提醒

- 这个转发口是**公开的**：任何知道地址（+口令）的人都可能用你的额度。
  **务必设 `ACCESS_TOKEN`，不要把地址发到公开场合**（README、博客、群里都不行）。
- `UPSTREAM_KEY` 和 `ACCESS_TOKEN` 用 `wrangler secret put` 设置，不要写进 `wrangler.toml`。
- Worker 的限流是单实例内存计数，多实例部署会失效（要精准限流请换 Durable Object / KV）。

## 本地自测（curl 四件事）

```bash
npx wrangler dev   # 默认 http://127.0.0.1:8787

# 1) OPTIONS 预检 → 204 且带 CORS 头
curl -i -X OPTIONS http://127.0.0.1:8787

# 2) 口令不匹配 → 403（先设了 ACCESS_TOKEN 才会校验）
curl -i -X POST http://127.0.0.1:8787 -H "Content-Type: application/json" \
  -H "Authorization: Bearer wrong-token" -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'

# 3) 正确口令 + 有效上游密钥 → 200 且返回模型输出
curl -i -X POST http://127.0.0.1:8787 -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的口令或上游密钥>" -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"说 ok"}]}'

# 4) 上游密钥错误 → 上游的 401 被原样透传
curl -i -X POST http://127.0.0.1:8787 -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-wrong" -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
```

全部通过后，前端设置页把接口地址填成这个 worker 地址、密钥填口令 → 点「测试连接」应绿字成功。

## 备选部署平台

Vercel / Netlify 也能跑：把 `src/index.ts` 改写成对应平台的函数签名（导出一个 `POST` 函数）即可，
请求处理逻辑原样搬过去，前端调用方式不变。
