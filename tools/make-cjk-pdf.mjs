/**
 * 造一份"真·中文 PDF"当测试夹具（用来验证中文划词与渲染）。
 *
 * 为什么这样造：不嵌入字体，用 Type0/CIDFontType0 + Identity-H 编码 + ToUnicode CMap，
 * 这正是国内 Word/LaTeX 导出中文 PDF 的常见形态（CID 字体、靠 CMap 取字）。
 * pdf.js 会走系统字体回退把字画出来，同时靠 ToUnicode 生成正确的文本层
 * （可选中、可搜索）——正好用来复现"中文划词"的场景。
 *
 * 关键点：Identity-H 下字符串里的 2 字节就是 CID，所以 ToUnicode 写成"码位 → 同一码位"
 * 即可自洽；若用 UniGB-UCS2-H，则 ToUnicode 必须按 Adobe-GB1 的 CID 映射，写错就抽不出文字。
 *
 * 用法：node tools/make-cjk-pdf.mjs [输出目录]
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 每行：x, y, 字号, 文本 */
const LINES = [
  { x: 72, y: 770, size: 20, text: '中文文献阅读与标注测试' },
  { x: 72, y: 730, size: 11, text: '张三，李四，王五　中国科学院计算技术研究所　2024' },
  { x: 72, y: 690, size: 14, text: '摘要' },
  { x: 72, y: 668, size: 12, text: '本文提出了一种面向中文学术文献的本地阅读与标注方法。' },
  { x: 72, y: 648, size: 12, text: '该系统能够在文件夹内容发生变化时自动同步，并保留读者的标注。' },
  { x: 72, y: 628, size: 12, text: '实验表明，在三千篇文献规模下索引时间低于三秒，交互保持流畅。' },
  { x: 72, y: 588, size: 14, text: '一、引言' },
  { x: 72, y: 566, size: 12, text: '随着文献数量的增长，研究者需要一个既能自动整理、又能随手批注的工具。' },
  { x: 72, y: 546, size: 12, text: '传统方案要求手动导入，且在文件改名或移动后容易丢失阅读进度。' },
  { x: 72, y: 526, size: 12, text: '我们通过内容指纹识别文件的移动，从而在改名之后仍然保留原有笔记。' },
  { x: 72, y: 486, size: 14, text: '二、方法' },
  { x: 72, y: 464, size: 12, text: '系统分为扫描、解析、索引三个阶段，全部在本地完成，不依赖网络。' },
  { x: 72, y: 444, size: 12, text: '标注以相对页面尺寸的比例存储，因此缩放之后位置依然准确。' },
  { x: 72, y: 404, size: 14, text: '三、结论' },
  { x: 72, y: 382, size: 12, text: '本地优先的文献管理工具可以同时满足自动化与可信任两个要求。' },
  { x: 72, y: 342, size: 11, text: '关键词：文献管理；本地优先；自动同步；批注；中文排版' },
];

/** UTF-16BE 十六进制（Identity-H 下字符串字节即 CID，这里让 CID = Unicode 码位） */
function hexOf(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      // 补充平面字符在 UniGB-UCS2-H 下无法表示，测试夹具里直接跳过
      continue;
    }
    out += code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

function contentStream() {
  const parts = ['q 0.9 0.9 0.9 rg 60 360 480 430 re f Q'];
  for (const line of LINES) {
    parts.push(`BT /F1 ${line.size} Tf 1 0 0 1 ${line.x} ${line.y} Tm <${hexOf(line.text)}> Tj ET`);
  }
  return parts.join('\n');
}

function toUnicodeCMap() {
  const seen = new Map();
  for (const line of LINES) {
    for (const ch of line.text) {
      const code = ch.codePointAt(0);
      if (code > 0xffff || ch === ' ') continue;
      seen.set(code, ch);
    }
  }
  const entries = [...seen.keys()];
  const lines = [];
  // 每 100 个一组，符合 CMap 规范
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const code of chunk) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      lines.push(`<${hex}> <${hex}>`);
    }
    lines.push('endbfchar');
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${lines.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

function buildPdf() {
  const content = contentStream();
  const cmap = toUnicodeCMap();
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 >>',
    `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>\nstream\n${cmap}\nendstream`,
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 /CapHeight 880 /StemV 93 >>',
  ];

  const chunks = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'];
  const offsets = [];
  let cursor = Buffer.byteLength(chunks[0], 'latin1');
  objects.forEach((body, idx) => {
    offsets.push(cursor);
    const text = `${idx + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(text);
    cursor += Buffer.byteLength(text, 'latin1');
  });

  const xrefStart = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const titleHex = [...'中文文献阅读与标注测试'].map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info << /Title <FEFF${titleHex}> /Author (Zhang San; Li Si) /CreationDate (D:20240612090000+08'00') >> >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(xref);
  return Buffer.from(chunks.join(''), 'latin1');
}

const outDir = process.argv[2] ?? path.join(process.cwd(), 'tmp', 'cjk-fixture');
await fs.mkdir(outDir, { recursive: true });
const file = path.join(outDir, '中文文献阅读与标注测试.pdf');
await fs.writeFile(file, buildPdf());
const stat = await fs.stat(file);
console.log(`已生成：${file}（${stat.size} 字节，${LINES.length} 行中文）`);
