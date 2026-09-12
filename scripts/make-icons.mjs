/**
 * 生成 PWA 图标（零依赖，只用 node:zlib）。
 *
 * 为什么自己写：要求是「真 PNG 文件」（iOS 不支持 SVG 的 apple-touch-icon），
 * 而为了几个图标去装 sharp / canvas / pwa-asset-generator 不划算——
 * PNG 的最小实现（IHDR + IDAT + IEND + CRC32）几十行就够，而且结果可复现。
 *
 * 用法：npm run icons
 * 产物：public/icons/192x192.png、512x512.png、180x180.png、favicon.png
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, '../public/icons');

/** 图标背景色（与 manifest 的 theme_color 一致：白纸风） */
const BG = { r: 255, g: 255, b: 255 };
/** 主色（应用的强调色） */
const FG = { r: 47, g: 111, b: 237 };
/** 描边色 */
const LINE = { r: 210, g: 216, b: 226 };

/** CRC32 查表 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * 计算 CRC32。
 * @param {Buffer} buf 数据
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 拼一个 PNG 数据块（长度 + 类型 + 数据 + CRC）。
 * @param {string} type 块类型，如 IHDR
 * @param {Buffer} data 块数据
 */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * 把 RGBA 像素编码成 PNG。
 * @param {number} width 宽
 * @param {number} height 高
 * @param {Buffer} rgba 像素数据（width*height*4）
 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0; // 压缩
  ihdr[11] = 0; // 滤波
  ihdr[12] = 0; // 隔行

  // 每行前面加一个滤波字节（0 = None）
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 画一张图标：白底 + 圆角边框 + 一个「纸」上写着横线的意象 + 主色矩形块。
 * 图形全部用解析几何算，缩放时不会糊。
 * @param {number} size 边长
 */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 512; // 比例因子（按 512 设计）

  /** 写一个像素 */
  const put = (x, y, color, alpha = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // 简单 alpha 混合（图标内部用不到复杂合成，够用）
    const a = alpha / 255;
    rgba[i] = Math.round(rgba[i] * (1 - a) + color.r * a);
    rgba[i + 1] = Math.round(rgba[i + 1] * (1 - a) + color.g * a);
    rgba[i + 2] = Math.round(rgba[i + 2] * (1 - a) + color.b * a);
    rgba[i + 3] = 255;
  };

  // 背景
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) put(x, y, BG);

  // 圆角边框（浅灰）
  const pad = 20 * s;
  const radius = 96 * s;
  const inRounded = (x, y, left, top, w, h, r) => {
    const rx = Math.min(Math.max(x, left + r), left + w - r);
    const ry = Math.min(Math.max(y, top + r), top + h - r);
    const dx = x - rx;
    const dy = y - ry;
    // 在直边区域内一定成立；在四个角上判断到圆心的距离
    const inRect = x >= left && x <= left + w && y >= top && y <= top + h;
    if (!inRect) return false;
    if (x > left + r && x < left + w - r) return true;
    if (y > top + r && y < top + h - r) return true;
    return dx * dx + dy * dy <= r * r;
  };
  const boxL = pad;
  const boxT = pad;
  const boxW = size - pad * 2;
  const boxH = size - pad * 2;
  const borderW = 10 * s;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const outer = inRounded(x, y, boxL, boxT, boxW, boxH, radius);
      const inner = inRounded(x + borderW, y + borderW, boxL, boxT, boxW - borderW * 2, boxH - borderW * 2, radius - borderW);
      if (outer && !inner) put(x, y, LINE);
    }
  }

  // 「白纸上的三行词」：用主色/灰色横线表示
  const lineX = 118 * s;
  const lineW = [276, 214, 246].map((w) => w * s);
  const lineH = 34 * s;
  const lineGap = 66 * s;
  let lineY = 168 * s;
  const colors = [FG, { r: 120, g: 130, b: 145 }, { r: 180, g: 188, b: 200 }];
  lineW.forEach((w, i) => {
    const color = colors[i] ?? FG;
    for (let y = Math.round(lineY); y < lineY + lineH; y += 1) {
      for (let x = Math.round(lineX); x < lineX + w; x += 1) put(x, y, color);
    }
    lineY += lineH + lineGap;
  });

  // 右下角一个主色小方块（暗示「点击/记忆」）
  const dotSize = 84 * s;
  const dotX = size - pad - dotSize - 46 * s;
  const dotY = size - pad - dotSize - 46 * s;
  for (let y = Math.round(dotY); y < dotY + dotSize; y += 1) {
    for (let x = Math.round(dotX); x < dotX + dotSize; x += 1) put(x, y, FG);
  }

  return rgba;
}

/**
 * 生成一个尺寸的图标文件。
 * @param {number} size 边长
 * @param {string} file 文件名
 */
function writeIcon(size, file) {
  const png = encodePng(size, size, drawIcon(size));
  writeFileSync(resolve(OUT_DIR, file), png);
  console.log(`  ${file}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

mkdirSync(OUT_DIR, { recursive: true });
console.log('生成 PWA 图标 → public/icons/');
writeIcon(192, '192x192.png');
writeIcon(512, '512x512.png');
writeIcon(180, '180x180.png');
writeIcon(32, 'favicon.png');
console.log('完成。改图标请编辑本脚本后重新运行 npm run icons。');
