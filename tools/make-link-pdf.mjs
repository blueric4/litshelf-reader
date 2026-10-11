/**
 * 造一个"带链接注释"的两页 PDF，用来验证阅读器的链接热区（真实 CNKI 排版稿里没有链接注释）。
 *   · 第 1 页：一段文字，上面压一个**文内跳转**链接（跳到第 2 页）；
 *   · 第 1 页：再来一个**外链**（https://example.com）。
 * 用法：node tools/make-link-pdf.mjs [输出路径，默认 tmp/link-fixture/link-test.pdf]
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] ?? 'tmp/link-fixture/link-test.pdf');

const content1 = `BT /F1 22 Tf 72 770 Td (LitShelf link fixture - page 1) Tj ET
BT /F1 13 Tf 72 740 Td (Click the box above this line: internal link -> page 2) Tj ET
BT /F1 13 Tf 72 690 Td (Below: external link -> https://example.com) Tj ET
BT /F1 11 Tf 72 600 Td (The two buttons are real PDF /Link annotations.) Tj ET`;
const content2 = `BT /F1 22 Tf 72 770 Td (Page 2 - arrived by internal link) Tj ET`;

const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R /Annots [8 0 R 9 0 R] >>',
  `<< /Length ${Buffer.byteLength(content1)} >>\nstream\n${content1}\nendstream`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
  `<< /Length ${Buffer.byteLength(content2)} >>\nstream\n${content2}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Annot /Subtype /Link /Rect [72 718 460 752] /Border [0 0 1] /Dest [5 0 R /Fit] >>',
  '<< /Type /Annot /Subtype /Link /Rect [72 668 460 702] /Border [0 0 1] /A << /S /URI /URI (https://example.com) >> >>',
];

let pdf = '%PDF-1.7\n';
const offsets = [];
for (let i = 0; i < objs.length; i += 1) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
}
const xrefAt = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, pdf, 'latin1');
console.log(`已生成：${OUT}（${Buffer.byteLength(pdf)} 字节，2 页，1 个文内链接 + 1 个外链）`);
