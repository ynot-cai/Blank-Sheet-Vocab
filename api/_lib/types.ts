/**
 * Serverless Functions 的最小请求/响应类型。
 *
 * 为什么不直接 import `@vercel/node` 的 VercelRequest/VercelResponse：
 * 这两个类型只是 Node 原生 IncomingMessage / ServerResponse 的一层薄封装，
 * 自己声明最小结构后，处理函数既能被 Vercel 调用，也能被本地测试脚本直接调用，
 * 不必为了类型再装一个只用于编译的包。
 *
 * ApiResponse 直接继承 Node 的 Writable：AI 代理要用 `pipeline()` 把上游流
 * 管道到响应上，Vercel 的 VercelResponse 和本地 harness 的假响应都是 Writable。
 */
import type { Writable } from 'node:stream';

/** 请求头集合（Vercel 会把头名统一成小写） */
export type HeaderMap = Record<string, string | string[] | undefined>;

/** 最小请求结构 */
export interface ApiRequest {
  method?: string;
  headers: HeaderMap;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  url?: string;
}

/** 最小响应结构（本身是 Node Writable，流式透传直接用） */
export interface ApiResponse extends Writable {
  statusCode: number;
  /** 是否已经开始发送响应（流式透传出错时用来判断还能不能改状态码） */
  headersSent?: boolean;
  setHeader(name: string, value: string | number | string[]): void;
}

/** 处理函数签名 */
export type ApiHandler = (req: ApiRequest, res: ApiResponse) => Promise<void>;
