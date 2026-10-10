/**
 * src/core/naming.ts —— 文件名启发式解析（纯函数）。
 */
import { describe, expect, it } from 'vitest';

import { guessFromFileName, sanitizeTitle, titleQuality } from '@core/naming';

describe('guessFromFileName：作者 - 年份 - 标题', () => {
  it('解析 "作者 - 年份 - 标题.pdf"', () => {
    const g = guessFromFileName('Zhang, Wei - 2020 - Graph Neural Networks.pdf');
    expect(g.authors).toEqual(['Zhang', 'Wei']);
    expect(g.year).toBe(2020);
    expect(g.title).toBe('Graph Neural Networks');
    expect(g.structured).toBe(true);
  });

  it('解析中文人名', () => {
    const g = guessFromFileName('李雷 - 2018 - 机器学习导论.pdf');
    expect(g.authors).toEqual(['李雷']);
    expect(g.year).toBe(2018);
    expect(g.title).toBe('机器学习导论');
    expect(g.structured).toBe(true);
  });

  // 回归：stripLeadingOrdinal 曾经把 "2021 - ..." 的前 3 位数字当序号吃掉，
  // 于是"年份 - 作者 - 标题"形态永远解析失败（title 变成 "1 - Smith - ..."）。
  it('解析 "年份 - 作者 - 标题" 形态（回归：年份不能被当序号吃掉）', () => {
    const g = guessFromFileName('2021 - Smith - Neural Machine Translation.pdf');
    expect(g.title).toBe('Neural Machine Translation');
    expect(g.year).toBe(2021);
    expect(g.authors).toEqual(['Smith']);
    expect(g.structured).toBe(true);
  });

  it('以 19/20 开头的四位年份都不受影响', () => {
    for (const year of [1999, 2000, 2010, 2024]) {
      const g = guessFromFileName(`${year} - Zhang - Neural Nets.pdf`);
      expect(g.year).toBe(year);
      expect(g.title).toBe('Neural Nets');
      expect(g.authors).toEqual(['Zhang']);
    }
  });

  it('多个作者按逗号 / and 拆分', () => {
    const g = guessFromFileName('Alice Chen and Bob Li - 2019 - A Study.pdf');
    expect(g.authors).toContain('Alice Chen');
    expect(g.authors).toContain('Bob Li');
  });

  it('下划线分隔也认，且标题里的下划线还原成空格', () => {
    const g = guessFromFileName('Wang - 2017 - deep_learning_survey.pdf');
    expect(g.year).toBe(2017);
    expect(g.title).toBe('deep learning survey');
  });
});

describe('guessFromFileName：DOI / arXiv / 标签 / 序号', () => {
  it('抽出 DOI 并从标题里剔除', () => {
    const g = guessFromFileName('Attention is all you need 10.5555/3295222.3295349.pdf');
    expect(g.doi).toBe('10.5555/3295222.3295349');
    expect(g.title).toBe('Attention is all you need');
  });

  it('抽出 arXiv 号并从标题里剔除', () => {
    const g = guessFromFileName('Attention Is All You Need arXiv:1706.03762.pdf');
    expect(g.arxivId).toBe('1706.03762');
    expect(g.title).toBe('Attention Is All You Need');
  });

  it('抽出 #标签', () => {
    const g = guessFromFileName('graph #nlp #deep-learning.pdf');
    expect(g.tags).toEqual(['nlp', 'deep-learning']);
    expect(g.title).toBe('graph');
  });

  it('剥掉开头的序号', () => {
    expect(guessFromFileName('03 - Something Interesting.pdf').title).toBe('Something Interesting');
    expect(guessFromFileName('1. Introduction.pdf').title).toBe('Introduction');
    expect(guessFromFileName('[3] Something Else.pdf').title).toBe('Something Else');
    expect(guessFromFileName('03 - Something Interesting.pdf').year).toBeNull();
  });

  it('普通文件名：不硬套作者，structured 为 false', () => {
    const g = guessFromFileName('A Survey of Everything.pdf');
    expect(g.structured).toBe(false);
    expect(g.authors).toEqual([]);
    expect(g.title).toBe('A Survey of Everything');
  });

  it('括号年份形态（带分隔符）能识别作者', () => {
    const g = guessFromFileName('Smith (2022) - On Widgets.pdf');
    expect(g.year).toBe(2022);
    expect(g.title).toBe('On Widgets');
    expect(g.authors).toEqual(['Smith']);
  });

  it('已知局限：无分隔符的 "作者 (年份) 标题" 只抽得出年份，作者不拆', () => {
    // 形态三要求 tokens.length >= 2（即名字里得有分隔符），
    // 无分隔符时 title 会保留 "作者 (年份) 标题" 原文。此处固化现状，修好请同步改断言。
    const g = guessFromFileName('Smith (2022) On Widgets.pdf');
    expect(g.year).toBe(2022);
    expect(g.authors).toEqual([]);
    expect(g.structured).toBe(false);
    expect(g.title).toBe('Smith (2022) On Widgets');
  });
});

describe('titleQuality', () => {
  it('空值 / 噪音标题得 0 分', () => {
    expect(titleQuality('')).toBe(0);
    expect(titleQuality(null)).toBe(0);
    expect(titleQuality(undefined)).toBe(0);
    expect(titleQuality('Untitled')).toBe(0);
    expect(titleQuality('Microsoft Word')).toBe(0);
    expect(titleQuality('document1')).toBe(0);
    expect(titleQuality('adobe')).toBe(0);
  });

  // 已知小瑕疵（不影响任何决策：所有调用方都用 >= 4 / >= 5 比较）：
  // "长度 < 4 直接返回 1" 排在噪音词表之前，所以短噪音词拿不到 0 分。
  it('已知瑕疵：短噪音词 / 纯空白走长度规则拿 1 分，而不是 0 分', () => {
    expect(titleQuality('   ')).toBe(1);
    expect(titleQuality('无标题')).toBe(1); // 噪音词表里有"无标题"，但先被长度规则截住
    expect(titleQuality('pdf')).toBe(1);
    expect(titleQuality('第3章')).toBe(1);
  });

  it('过短 / 带扩展名 / 章节名逐级降分', () => {
    expect(titleQuality('ab')).toBe(1);
    expect(titleQuality('paper.pdf')).toBe(1);
    expect(titleQuality('第3章')).toBe(1); // 长度 3 < 4，先被长度规则拦下
    expect(titleQuality('第3章 引言')).toBe(2); // 回归：CJK 章节名以前因为 \b 判不出来，得 5
    expect(titleQuality('slide 3')).toBe(2);
    expect(titleQuality('page 12')).toBe(2);
    expect(titleQuality('Neural Nets')).toBe(3);
  });

  it('像样的标题得满分（>= 5 才允许覆盖文件名解析结果）', () => {
    expect(titleQuality('Graph Neural Networks for NLP')).toBe(5);
    expect(titleQuality('深度学习综述')).toBe(5);
  });
});

describe('sanitizeTitle', () => {
  it('去掉空白噪声与扩展名', () => {
    expect(sanitizeTitle('  Hello   World  ')).toBe('Hello World');
    expect(sanitizeTitle('Paper.pdf')).toBe('Paper');
    expect(sanitizeTitle(null)).toBe('');
    expect(sanitizeTitle(undefined)).toBe('');
  });

  it('去掉 Word / 打印驱动的脏前后缀', () => {
    expect(sanitizeTitle('Microsoft Word - My Paper.docx')).toBe('My Paper');
    expect(sanitizeTitle('Title - Microsoft Word')).toBe('Title');
  });
});
