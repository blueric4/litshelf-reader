/**
 * 示例文献生成器：首次启动引导 / 设置页"生成示例文献"用。
 *
 * 这里手写生成 **结构完整、pdf.js 可打开** 的多页 PDF（Catalog / Pages / Page / Font / Contents +
 * 正确的 xref 偏移表 + trailer + startxref），不依赖任何第三方库：
 *  - 正文一律 ASCII，避免 CJK 字体嵌入（不嵌字体就打不开）；
 *  - 页数 3–8，每页内容明显不同（"Page 3 of 6 - Method"），便于验证阅读位置记忆；
 *  - /Info 里带 Title / Author / CreationDate，便于验证元数据启发式；
 *  - 文件名覆盖常见学术命名形态（"Zhang et al. - 2023 - 标题.pdf"、"2021_Wang_标题.pdf"、
 *    "李雷 - 2022 - 中文文献示例.pdf"、"Attention Is All You Need (2017).pdf"），
 *    以及中文名、带空格名、子目录内的文件。
 *
 * 幂等：同名文件直接覆盖；重复调用不会产生重复文件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { longPath } from './paths';
import { ensureDir } from './fsutil';

export interface SampleLibraryResult {
  /** 示例文献所在的目录（绝对路径） */
  dir: string;
  /** 生成的文件总数 */
  files: number;
}

export interface PaperSpec {
  /** 相对示例目录的路径（可含子目录分隔符） */
  file: string;
  title: string;
  author: string;
  year: number;
  venue: string;
  /** 页数（3–8） */
  pages: number;
  doi?: string;
  /** 每页的小标题，不足时按 DEFAULT_SECTIONS 补齐 */
  sections?: string[];
}

export interface DocSpec {
  file: string;
  content: string;
}

const DEFAULT_SECTIONS = [
  'Introduction',
  'Related Work',
  'Method',
  'Experiments',
  'Results',
  'Discussion',
  'Conclusion',
  'Appendix',
];

const PAPERS: PaperSpec[] = [
  {
    file: 'Zhang et al. - 2023 - Deep Learning for Medical Imaging.pdf',
    title: 'Deep Learning for Medical Imaging: A Practical Review',
    author: 'Wei Zhang, Li Chen, Marco Rossi',
    year: 2023,
    venue: 'IEEE Transactions on Medical Imaging',
    pages: 6,
    doi: '10.1109/TMI.2023.3141592',
    sections: ['Introduction', 'Data and Preprocessing', 'Network Architectures', 'Experiments', 'Results', 'Conclusion'],
  },
  {
    file: '2021_Wang_Graph Neural Networks.pdf',
    title: 'Graph Neural Networks for Citation Analysis',
    author: 'Hui Wang',
    year: 2021,
    venue: 'Journal of Informetrics',
    pages: 5,
    doi: '10.1016/j.joi.2021.101234',
    sections: ['Introduction', 'Message Passing', 'Citation Graph Benchmark', 'Ablation Study', 'Conclusion'],
  },
  {
    file: '李雷 - 2022 - 中文文献示例.pdf',
    title: 'A Chinese Sample Paper on Local Literature Management',
    author: 'Li Lei',
    year: 2022,
    venue: 'Journal of Digital Libraries (China)',
    pages: 4,
    sections: ['Introduction', 'Local Library Design', 'Evaluation', 'Conclusion'],
  },
  {
    file: 'Attention Is All You Need (2017).pdf',
    title: 'Attention Is All You Need',
    author: 'Ashish Vaswani, Noam Shazeer, Niki Parmar',
    year: 2017,
    venue: 'Advances in Neural Information Processing Systems',
    pages: 8,
    doi: '10.48550/arXiv.1706.03762',
    sections: [
      'Introduction',
      'Background',
      'Model Architecture',
      'Why Self-Attention',
      'Training',
      'Results',
      'Conclusion',
      'Attention Visualizations',
    ],
  },
  {
    file: '子目录/韩梅梅 等 - 2024 - 面向中文的文献阅读.pdf',
    title: 'Reading Chinese Papers on a Local Shelf',
    author: 'Han Meimei, Li Lei',
    year: 2024,
    venue: '中文信息学报 (sample)',
    pages: 3,
    sections: ['Introduction', 'Layout and Typography', 'Conclusion'],
  },
  {
    file: 'Vaswani et al. - 2018 - Transformer Architectures Survey.pdf',
    title: 'Transformer Architectures: A Survey of Variants',
    author: 'Ashish Vaswani, Jakob Uszkoreit',
    year: 2018,
    venue: 'arXiv preprint',
    pages: 7,
    sections: ['Introduction', 'Encoder Variants', 'Decoder Variants', 'Efficient Attention', 'Pretraining', 'Open Problems', 'Conclusion'],
  },
  {
    file: '2020_Chen_Contrastive Learning Survey.pdf',
    title: 'Contrastive Learning: A Survey',
    author: 'Ting Chen, Simon Kornblith',
    year: 2020,
    venue: 'IEEE TPAMI',
    pages: 5,
    doi: '10.1109/TPAMI.2020.2988765',
    sections: ['Introduction', 'Instance Discrimination', 'MoCo and SimCLR', 'Evaluation Protocols', 'Conclusion'],
  },
  {
    file: 'Smith & Jones (2019) - Reinforcement Learning Basics.pdf',
    title: 'Reinforcement Learning Basics for Practitioners',
    author: 'John Smith, Mary Jones',
    year: 2019,
    venue: 'MIT Press (sample chapter)',
    pages: 4,
    sections: ['Markov Decision Processes', 'Value Iteration', 'Policy Gradients', 'Conclusion'],
  },
];

const DOCS: DocSpec[] = [
  {
    file: '阅读笔记 - 深度学习综述.md',
    content: `# 阅读笔记：深度学习综述

## 一句话总结
这篇综述把医学影像里的深度学习方法按"数据 → 网络 → 评价"三段做了梳理。

## 要点
1. 数据预处理（重采样、窗宽窗位归一化）对结果的影响常被低估。
2. 分割任务上 U-Net 系结构仍是基线；分类任务上预训练权重迁移收益最大。
3. 评价指标必须与临床目标对齐，AUC 高不代表临床可用。

## 待办
- [ ] 复现 Table 3 的实验设置
- [ ] 查一下文中的 DOI 是否可解析
- [ ] 在文献架里给这篇打上 #综述 #医学影像 标签
`,
  },
  {
    file: '2024 - Survey Notes on Graph Neural Networks.md',
    content: `# Survey Notes on Graph Neural Networks

- Message passing is the shared abstraction of most GNN variants.
- Over-smoothing: deeper stacks collapse node representations.
- Citation graphs are a natural benchmark for bibliographic tools.

> 备注：这篇的引用格式建议用 GB/T 7714。
`,
  },
  {
    file: '子目录/中文文献阅读方法.md',
    content: `# 中文文献阅读方法

三遍读法：
1. 第一遍看标题、摘要、图表，判断要不要继续。
2. 第二遍看方法与实验设置，记下可复现的关键参数。
3. 第三遍逐段精读，把批注写进阅读器里，而不是另开文档。

放在子目录里是为了验证"目录树"与"按文件夹分组"这两处界面。
`,
  },
  {
    file: 'README - 文献架使用说明.md',
    content: `# 文献架 LitShelf 示例文献

这个文件夹是软件自动生成的示例数据，可以随时删掉。

- 8 篇 PDF 用于验证：分页阅读、阅读位置记忆、缩略图、全文检索。
- 4 篇 Markdown 与 2 篇纯文本用于验证：内置阅读器、笔记、字数统计。
- 子目录 用于验证：目录树浏览与文件夹分组。

把本文件夹添加为文献库根目录即可开始体验。
`,
  },
  {
    file: '参考文献格式速查.txt',
    content: `参考文献格式速查（示例文本）

GB/T 7714：作者. 题名[文献类型标志]. 刊名, 年, 卷(期): 起止页码.
APA：Author, A. A. (Year). Title of the work. Publisher.
IEEE：[1] A. Author, "Title of paper," Journal Name, vol. 1, no. 1, pp. 1-10, Year.

提示：在文献架里选中条目后可以直接复制引用文本。
`,
  },
  {
    file: '2022 会议投稿要点.txt',
    content: `2022 会议投稿要点

1. 摘要不超过 250 词，结论要写清楚贡献点。
2. 图表必须自解释，图注里写清楚统计口径。
3. 参考文献里同一篇会议论文不要同时出现 arXiv 与正式版本。
4. 提交前用软件里的"导出库"生成 BibTeX，避免手工誊抄出错。
`,
  },
];

/** 把任意文本压成 PDF 可用的 ASCII（非 ASCII 一律替换，保证 1 字符 = 1 字节） */
function ascii(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, '?');
}

/** PDF 字符串字面量转义 */
function esc(text: string): string {
  return ascii(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** 单页内容流：/F1 Helvetica，逐行 BT ... Tj ET */
function pageContent(spec: PaperSpec, pageIndex: number): string {
  const total = spec.pages;
  const section = spec.sections?.[pageIndex] ?? DEFAULT_SECTIONS[pageIndex] ?? `Section ${pageIndex + 1}`;
  const lines: string[] = [];
  lines.push(`${spec.title}`);
  lines.push(`Page ${pageIndex + 1} of ${total} - ${section}`);
  lines.push(`${spec.author} | ${spec.venue} | ${spec.year}`);
  if (pageIndex === 0 && spec.doi) lines.push(`DOI: ${spec.doi}`);
  lines.push('');
  lines.push(`Abstract (page ${pageIndex + 1}): this sample page belongs to the "${section}" part of the paper.`);
  lines.push('Each page carries distinct text so that reading position memory can be verified.');
  lines.push(`Paragraph 1. ${section} is discussed with respect to the overall argument of the paper.`);
  lines.push('Paragraph 2. We report the setup, the metrics and the main observations in plain ASCII.');
  lines.push(`Paragraph 3. Keyword markers for full text search: litshelf page ${pageIndex + 1} ${section.toLowerCase()}.`);

  const out: string[] = [];
  let y = 742;
  out.push(`BT /F1 15 Tf 72 ${y} Td (${esc(lines[0])}) Tj ET`);
  y -= 26;
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) {
      y -= 8;
      continue;
    }
    const size = i === 1 ? 12 : 10;
    out.push(`BT /F1 ${size} Tf 72 ${y} Td (${esc(lines[i])}) Tj ET`);
    y -= 18;
  }
  return `${out.join('\n')}\n`;
}

/** 手写一个合法的多页 PDF（对象 + xref + trailer + startxref） */
export function buildSamplePdf(spec: PaperSpec): Buffer {
  const pageCount = Math.max(1, spec.pages);
  const kids: string[] = [];
  const pageObjects: { pageObj: number; contentObj: number; content: string }[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const pageObj = 5 + i * 2; // 1 Catalog / 2 Pages / 3 Font / 4 Info，之后每页两个对象
    pageObjects.push({ pageObj, contentObj: pageObj + 1, content: pageContent(spec, i) });
    kids.push(`${pageObj} 0 R`);
  }

  const objects: string[] = [];
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[3] =
    `<< /Title (${esc(spec.title)}) /Author (${esc(spec.author)}) /Subject (LitShelf sample document) ` +
    `/Keywords (sample, litshelf, ${esc(spec.venue)}) /Creator (LitShelf Sample Generator) /Producer (LitShelf) ` +
    `/CreationDate (D:${spec.year}01010000Z) >>`;
  for (const p of pageObjects) {
    objects[p.pageObj - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${p.contentObj} 0 R >>`;
    objects[p.contentObj - 1] = `<< /Length ${Buffer.byteLength(p.content, 'latin1')} >>\nstream\n${p.content}\nendstream`;
  }

  const parts: string[] = [];
  let bytes = 0;
  const push = (s: string): void => {
    parts.push(s);
    bytes += Buffer.byteLength(s, 'latin1');
  };

  push('%PDF-1.4\n');
  push('%\xE2\xE3\xCF\xD3\n'); // 二进制标记行，告诉工具这不是纯文本
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(bytes);
    push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
  }
  const xrefOffset = bytes;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  // latin1：上面所有字符都在 0x00–0xFF 内，字节偏移与字符偏移一致
  return Buffer.from(parts.join(''), 'latin1');
}

/**
 * 在 dir 下生成示例文献（幂等覆盖）。
 * 返回文件总数与目录绝对路径，供 UI 展示 / 随后 addRoot 使用。
 */
export async function createSampleLibrary(dir: string): Promise<SampleLibraryResult> {
  const root = path.resolve(dir);
  await ensureDir(root);

  let files = 0;
  for (const spec of PAPERS) {
    const target = path.join(root, spec.file);
    await ensureDir(path.dirname(target));
    await fs.writeFile(longPath(target), buildSamplePdf(spec));
    files += 1;
  }
  for (const doc of DOCS) {
    const target = path.join(root, doc.file);
    await ensureDir(path.dirname(target));
    await fs.writeFile(longPath(target), doc.content, 'utf8');
    files += 1;
  }
  return { dir: root, files };
}

/** 供自测 / 诊断使用：本次会生成哪些相对路径 */
export function sampleLibraryManifest(): string[] {
  return [...PAPERS.map((p) => p.file), ...DOCS.map((d) => d.file)];
}
