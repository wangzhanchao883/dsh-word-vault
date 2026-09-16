/**
 * 测试用合成图片:24 位 BMP(无压缩,纯 Node 生成,不依赖任何图形库)。
 * 用途:给照片扫描器造"已知答案"的测试页 —— 印刷词 + 荧光笔条带 + 红线 + 红圈 + 纯红涂鸦。
 */
const BLACK = [30, 30, 30];
const WHITE = [255, 255, 255];
const GREEN = [120, 220, 120];   // 荧光绿(饱和)
const RED = [220, 40, 40];       // 红笔

export class Canvas {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.px = Buffer.alloc(width * height * 3, 255);
  }

  set(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = b; // BMP 是 BGR
    this.px[i + 1] = g;
    this.px[i + 2] = r;
  }

  rect(x0, y0, x1, y1, color) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, color);
  }

  /** 用一堆小矩形拼出"印刷体单词"的样子(扫描器只关心:暗、不饱和、横向铺开) */
  word(x, y, letters, { letterW = 12, letterH = 22, gap = 4 } = {}) {
    for (let i = 0; i < letters; i++) {
      const lx = x + i * (letterW + gap);
      this.rect(lx, y, lx + letterW - 1, y + letterH - 1, BLACK);
      // 掏两个小白洞,让笔画不像实心块(更接近字形)
      this.rect(lx + 3, y + 5, lx + letterW - 4, y + 8, WHITE);
      this.rect(lx + 3, y + 14, lx + letterW - 4, y + 16, WHITE);
    }
    return x + letters * (letterW + gap) - gap;
  }

  /** 空心椭圆(红笔圈词) */
  ellipse(cx, cy, rx, ry, color, thickness = 4) {
    for (let t = 0; t < 360; t += 0.5) {
      const a = (t * Math.PI) / 180;
      for (let k = 0; k < thickness; k++) {
        this.set(Math.round(cx + (rx - k) * Math.cos(a)), Math.round(cy + (ry - k) * Math.sin(a)), color);
      }
    }
  }

  toBmp() {
    const rowSize = Math.ceil((this.w * 3) / 4) * 4;
    const pixelBytes = rowSize * this.h;
    // 头部必须全 0(compression/reserved 字段留 0xFF 会让 GDI+ 直接拒收),像素区才填白
    const buf = Buffer.alloc(54 + pixelBytes, 0);
    buf.fill(255, 54);
    buf.write("BM", 0, "ascii");
    buf.writeUInt32LE(54 + pixelBytes, 2);
    buf.writeUInt32LE(54, 10);
    buf.writeUInt32LE(40, 14);
    buf.writeInt32LE(this.w, 18);
    buf.writeInt32LE(this.h, 22);
    buf.writeUInt16LE(1, 26);
    buf.writeUInt16LE(24, 28);
    buf.writeUInt32LE(pixelBytes, 34);
    for (let y = 0; y < this.h; y++) {
      const src = (this.h - 1 - y) * this.w * 3; // BMP 自下而上
      this.px.copy(buf, 54 + y * rowSize, src, src + this.w * 3);
    }
    return buf;
  }
}

/**
 * 造一张"作业页"测试图,布局(900x620)。
 * 注意:印刷"词"必须横向铺满所在行 —— 扫描器的 darkSpread 判据要求印刷黑字横向铺开,
 * 真实页面的印刷行就是这样;第一版测试图只画了 4 个字母(占裁剪宽 27%)被正确剔除,
 * 那是测试图不真实,不是判据有问题。
 *   y≈118-150 绿荧光笔条带盖住印刷行           -> 期望 highlighter
 *   y≈264-298 印刷行 + 其下方红线              -> 期望 red-line
 *   y≈420-460 纯红涂鸦,周围没有印刷字          -> 期望被 darkSpread 剔除
 *   y≈515-575 印刷行被红笔圈住                 -> 期望 red-circle
 */
export function makeWorkbookCanvas() {
  const c = new Canvas(900, 620);
  // 行1:荧光笔盖住一整行印刷词(10 个字母 -> 宽 156,铺满条带)
  c.rect(32, 116, 210, 152, GREEN);
  c.word(40, 122, 10);
  // 行2:印刷行 + 下方红线
  c.word(40, 262, 10);
  c.rect(40, 292, 200, 298, RED);
  // 行3:纯红涂鸦(无印刷字 -> 必须被剔除)
  for (let x = 300; x < 430; x += 12) {
    c.rect(x, 420 + (x % 24), x + 8, 424 + (x % 24), RED);
    c.rect(x + 4, 436, x + 8, 452, RED);
  }
  // 行4:红圈圈住印刷词
  c.word(300, 528, 5);
  c.ellipse(344, 542, 52, 28, RED, 4);
  return c;
}
