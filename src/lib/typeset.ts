/**
 * 断行排版：在「每行最大宽度 + 最多行数」约束内重排单条字幕文本（纯函数，可单测）。
 *
 * 预处理：原换行符及连续空白（含制表符等所有 Unicode 空白）一律归一为单个空格，
 * 再去掉行首 / 行尾空格。按 Unicode 字素簇切分；汉字 / 全角字符宽度记 2，
 * 其余记 1；连续 ASCII 字母数字视为不可拆分的原子。
 *
 * 禁排：行首禁止「，。！？；：、）】」，行尾禁止「（【」；断点落在空格上时
 * 不适用禁排（空格作为断点被消耗，不进入任何行）。
 *
 * 求解：全局动态规划（绝不逐行贪心）——先取最少行数，再最小化各行剩余宽度
 * 平方和；上述都相同的并列方案取断点序列字典序最小者。无解（原子超宽 /
 * 行数不足 / 禁排规则下无法成行）的条目保留原文并给出原因；含尖括号标签
 * （如 <i>…</i>、{\\an8} 风格标记外的 SRT/ASS 内联标签、VTT 时间戳标签）的
 * 条目同样保留原文并标注原因，不参与应用。
 */

import type { Cue } from '../types';

/* ---------------- 字素簇切分 ---------------- */

/**
 * Intl.Segmenter 的最小类型声明：目标 lib 为 ES2020，内置类型里没有该 API。
 * 现代浏览器（Chrome 87+/Firefox 90+/Safari 14.1+）与 Node 16+ 均已支持。
 */
interface GraphemeSegmenter {
  segment(input: string): Iterable<unknown>;
}
interface GraphemeSegmenterCtor {
  new (locales?: string | string[], options?: { granularity?: 'grapheme' | 'word' | 'sentence' }): GraphemeSegmenter;
}
const SegmenterCtor = (Intl as unknown as { Segmenter?: GraphemeSegmenterCtor }).Segmenter;

const segmenter: GraphemeSegmenter | null = SegmenterCtor
  ? new SegmenterCtor(undefined, { granularity: 'grapheme' })
  : null;

/** 按 Unicode 字素簇切分；极端环境不支持时退化为按码点切分 */
export function splitGraphemes(text: string): string[] {
  if (!text) return [];
  if (segmenter) {
    const out: string[] = [];
    for (const part of segmenter.segment(text) as Iterable<{ segment?: string } | string>) {
      out.push(typeof part === 'string' ? part : (part.segment ?? ''));
    }
    return out.filter((s) => s.length > 0);
  }
  return Array.from(text);
}

/* ---------------- 字宽 ---------------- */

/**
 * 判断码点是否为「汉字 / 全角字符」（宽 2）。
 * 覆盖 CJK 表意文字及扩展区、兼容表意文字、假名、谚文、全角 ASCII / 符号、
 * CJK 标点与全角标点，以及常见宽版符号与 emoji 区块；其余码点（含半角标点、
 * ASCII、组合记号、零宽字符）宽 1。字素簇的宽度按其首个码点取值，
 * 组合字符 / ZWJ emoji 序列因此按基础字形计宽。
 */
export function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母（宽）
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 / 康熙 / 增补标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 平假名 / 片假名 / 注音 / CJK 符号与标点（含「（）【】、：」等全角标点）
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文音节
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式标点
    (cp >= 0xff01 && cp <= 0xff60) || // 全角 ASCII 与全角标点（，。！？；：等）
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角货币 / 记号
    (cp >= 0x1f300 && cp <= 0x1f64f) || // 杂项符号与象形文字 / 表情修饰
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // 交通与地图符号
    (cp >= 0x1f900 && cp <= 0x1f9ff) || // 补充象形文字
    (cp >= 0x1fa70 && cp <= 0x1faff) || // 符号与象形文字扩展 A
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK 扩展 B~F 等（合并大区段）
    (cp >= 0x30000 && cp <= 0x3fffd) // CJK 扩展 G/H
  );
}

/** 字素簇宽度：汉字 / 全角字符 2，其余 1（按首个码点判定） */
export function graphemeWidth(grapheme: string): number {
  const cp = grapheme.codePointAt(0);
  return cp !== undefined && isWideCodePoint(cp) ? 2 : 1;
}

/* ---------------- 参数与禁排集合 ---------------- */

export const MIN_MAX_WIDTH = 1;
export const MAX_MAX_WIDTH = 200;
export const DEFAULT_MAX_WIDTH = 30;
export const MIN_MAX_LINES = 1;
export const MAX_MAX_LINES = 4;
export const DEFAULT_MAX_LINES = 2;

/** 行首禁排标点 */
const LINE_START_BANNED = new Set(['，', '。', '！', '？', '；', '：', '、', '）', '】']);
/** 行尾禁排标点 */
const LINE_END_BANNED = new Set(['（', '【']);

/**
 * 尖括号标签检测：斜杠可选、以字母开头的任意标签（<i>、</i>、<b>、<font color=...>
 * 等 SRT/HTML 内联标签，<xxx> 形式的 ASS 行内覆盖标签），以及 WebVTT 时间戳标签
 * （<00:00:00.000>）。含标签的条目自动排版可能破坏标记，保留原文不参与应用。
 */
const ANGLE_TAG_RE = /<(?:\/?[A-Za-z][^<>]*|\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})>/;

export function hasAngleTag(text: string): boolean {
  return ANGLE_TAG_RE.test(text);
}

/* ---------------- 归一化与分词 ---------------- */

/** 原换行及连续空白归一为单个空格，行首尾去空格 */
export function normalizeForTypeset(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface SpaceUnit {
  kind: 'space';
  width: number;
}

interface TokenUnit {
  kind: 'token';
  /** 构成该原子的字素簇（长度 1，或一段连续 ASCII 字母数字） */
  chars: string[];
  width: number;
}

type Unit = SpaceUnit | TokenUnit;

const ASCII_ALNUM_RE = /^[A-Za-z0-9]$/;

/**
 * 归一化文本分词：空格各成一个单元；连续 ASCII 字母数字合并为不可拆分原子，
 * 其余每个字素簇单独成原子。
 */
function tokenize(normalized: string): Unit[] {
  const graphemes = splitGraphemes(normalized);
  const units: Unit[] = [];
  let i = 0;
  while (i < graphemes.length) {
    const g = graphemes[i];
    if (g === ' ') {
      units.push({ kind: 'space', width: 1 });
      i += 1;
      continue;
    }
    if (ASCII_ALNUM_RE.test(g)) {
      const chars: string[] = [];
      let width = 0;
      while (i < graphemes.length && ASCII_ALNUM_RE.test(graphemes[i])) {
        chars.push(graphemes[i]);
        width += graphemeWidth(graphemes[i]);
        i += 1;
      }
      units.push({ kind: 'token', chars, width });
    } else {
      units.push({ kind: 'token', chars: [g], width: graphemeWidth(g) });
      i += 1;
    }
  }
  return units;
}

/* ---------------- 动态规划断行 ---------------- */

interface DpState {
  /** 到达该 token 边界使用的行数 */
  lines: number;
  /** 各行剩余宽度平方和 */
  cost: number;
  /** 断点序列（token 边界下标；不含 0 与终点 T） */
  breaks: number[];
}

interface SolvedLayout {
  feasible: boolean;
  lines: number;
  cost: number;
  /** 每行的 token 起止（左闭右开） */
  segments: Array<[number, number]>;
}

/**
 * 在约束内求最优断行。
 *
 * DP：状态 dp[b] = 前 b 个 token 已排满时的最优方案；枚举最后一行 a+1..b，
 * 行宽 = 原子宽度和 + 原子间空格数，超 maxWidth 不可行；切点 b<T 还须通过
 * 禁排（或恰好落在空格上）。比较键严格按「行数升序 → 剩余宽度平方和升序 →
 * 断点序列字典序升序」。这是全局最优，不是逐行贪心。
 *
 * @param kinsoku  是否启用行首 / 行尾禁排（无解原因分析时放宽）
 * @param lineCap  行数上限（无解原因分析时可取 Infinity）
 */
function solveLayout(
  units: Unit[],
  maxWidth: number,
  lineCap: number,
  kinsoku: boolean
): SolvedLayout {
  const tokens = units.filter((u): u is TokenUnit => u.kind === 'token');
  const T = tokens.length;
  if (T === 0) return { feasible: true, lines: 0, cost: 0, segments: [] };

  // 每个 token 在 units 中的位置（用于判断切点间隙是否落在空格上）
  const unitPos: number[] = [];
  for (let i = 0; i < units.length; i += 1) {
    if (units[i].kind === 'token') unitPos.push(i);
  }
  // 宽度前缀和
  const prefixW: number[] = [0];
  // gapSpace[t]：token t 与 token t-1 之间的间隙是否含空格；spacePrefix 为其累计
  const gapSpace: boolean[] = [false];
  const spacePrefix: number[] = [0];
  for (let t = 0; t < T; t += 1) {
    prefixW.push(prefixW[t] + tokens[t].width);
    if (t > 0) {
      let hasSpace = false;
      for (let i = unitPos[t - 1] + 1; i < unitPos[t]; i += 1) {
        if (units[i].kind === 'space') {
          hasSpace = true;
          break;
        }
      }
      gapSpace.push(hasSpace);
    }
    spacePrefix.push(spacePrefix[t] + (t > 0 && gapSpace[t] ? 1 : 0));
  }

  /**
   * token l..r（含两端）行宽：原子宽度和 + 原子之间的空格数。
   * gapSpace[t] 是 token t 与 t-1 之间的间隙，故行内间隙对应 gapSpace[l+1..r]，
   * 即 spacePrefix[r+1] - spacePrefix[l+1]（间隙属于其后的 token）。
   */
  const lineWidth = (l: number, r: number): number =>
    prefixW[r + 1] - prefixW[l] + (spacePrefix[r + 1] - spacePrefix[l + 1]);

  /** 切点 b（b>0，b<T）是否允许：落在空格上，或满足行首 / 行尾禁排 */
  const cutAllowed = (b: number): boolean => {
    if (gapSpace[b]) return true;
    if (!kinsoku) return true;
    // 切点之后新行的第一个 token 不能以行首禁排标点开头；
    // 切点之前最后一行的最后一个 token（b-1）不能以行尾禁排标点结尾
    const firstGrapheme = tokens[b].chars[0];
    const lastToken = tokens[b - 1];
    const lastGrapheme = lastToken.chars[lastToken.chars.length - 1];
    return !LINE_START_BANNED.has(firstGrapheme) && !LINE_END_BANNED.has(lastGrapheme);
  };

  const dp: (DpState | null)[] = Array.from({ length: T + 1 }, () => null);
  dp[0] = { lines: 0, cost: 0, breaks: [] };

  for (let b = 1; b <= T; b += 1) {
    let best: DpState | null = null;
    // cutAllowed 只依赖切点 b；不允许的切点在任何 a 下都不能采用
    if (b < T && !cutAllowed(b)) {
      dp[b] = null;
      continue;
    }
    // 倒序枚举最后一行起点 a：行宽随 a 减小而单调增加，一旦超过 maxWidth
    // 立即停止（更早的 a 只会更宽）。每个 token 宽 ≥1，内循环至多 O(maxWidth)，
    // 整体约 O(T·maxWidth)，避免超长条目上退化到 O(T²)。
    for (let a = b - 1; a >= 0; a -= 1) {
      const prev = dp[a];
      const w = lineWidth(a, b - 1);
      if (w > maxWidth) break;
      if (!prev) continue;
      if (prev.lines + 1 > lineCap) continue;

      const candidate: DpState = {
        lines: prev.lines + 1,
        cost: prev.cost + (maxWidth - w) * (maxWidth - w),
        breaks: [...prev.breaks, b]
      };
      if (best === null || better(candidate, best)) best = candidate;
    }
    dp[b] = best;
  }

  const final = dp[T];
  if (!final) return { feasible: false, lines: Number.POSITIVE_INFINITY, cost: Number.POSITIVE_INFINITY, segments: [] };

  const cuts = final.breaks.slice(0, -1); // 终点 T 不作为重建断点
  const segments: Array<[number, number]> = [];
  let start = 0;
  for (const cut of cuts) {
    segments.push([start, cut]);
    start = cut;
  }
  segments.push([start, T]);
  return { feasible: true, lines: final.lines, cost: final.cost, segments };
}

/** 方案比较：先行数少，再剩余宽度平方和小，再断点序列字典序小 */
function better(a: DpState, b: DpState): boolean {
  if (a.lines !== b.lines) return a.lines < b.lines;
  if (a.cost !== b.cost) return a.cost < b.cost;
  const n = Math.min(a.breaks.length, b.breaks.length);
  for (let i = 0; i < n; i += 1) {
    if (a.breaks[i] !== b.breaks[i]) return a.breaks[i] < b.breaks[i];
  }
  return a.breaks.length < b.breaks.length;
}

/** 依据分词结果与行段重建文本：行内 token 间隙若有空格则补一个空格，行间用 \n */
function renderLines(units: Unit[], segments: Array<[number, number]>): { text: string; lines: string[]; widths: number[] } {
  // 抽出 token，并记录每个 token 与前一个 token 之间是否存在空格单元
  const tokens: TokenUnit[] = [];
  const spaceBeforeToken: boolean[] = [];
  let prevTokenPos = -1;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit.kind === 'space') continue;
    let hasSpace = false;
    for (let j = prevTokenPos + 1; j < i; j += 1) {
      if (units[j].kind === 'space') hasSpace = true;
    }
    spaceBeforeToken.push(hasSpace);
    tokens.push(unit);
    prevTokenPos = i;
  }

  const lines: string[] = [];
  const widths: number[] = [];
  for (const [l, r] of segments) {
    let text = '';
    let width = 0;
    for (let t = l; t < r; t += 1) {
      if (t > l && spaceBeforeToken[t]) {
        text += ' ';
        width += 1;
      }
      text += tokens[t].chars.join('');
      width += tokens[t].width;
    }
    lines.push(text);
    widths.push(width);
  }
  return { text: lines.join('\n'), lines, widths };
}

/* ---------------- 单条 / 批量规划 ---------------- */

export type TypesetStatus = 'ok' | 'tag' | 'infeasible';

export interface TypesetEntry {
  cueId: string;
  /** 列表序号（1-based，时间序） */
  index: number;
  status: TypesetStatus;
  /** 归一化后的原文本（空白归一、首尾去空格） */
  normalized: string;
  /** 原始文本 */
  oldText: string;
  /** 重排后文本（ok 时提供；行间 \n）；其余为 null */
  newText: string | null;
  /** 重排后各行文本；未排出版本为 null */
  lines: string[] | null;
  /** 各行实际宽度；未排出版本为 null */
  lineWidths: number[] | null;
  /** 实际使用行数；未排出版本为 null */
  lineCount: number | null;
  /** ok 且新文本与原文本不同（参与一次应用） */
  changed: boolean;
  /** 保留原文的原因（tag / infeasible 时提供） */
  reason: string | null;
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 规划单条字幕的断行。含尖括号标签直接保留；其余先归一化 / 分词，
 * 再跑全局 DP；严格规则无解时放宽禁排 / 行数重跑以区分具体无解原因。
 */
export function planTypesetEntry(
  cue: Cue,
  index: number,
  rawMaxWidth: number,
  rawMaxLines: number
): TypesetEntry {
  const maxWidth = clampInt(rawMaxWidth, MIN_MAX_WIDTH, MAX_MAX_WIDTH, DEFAULT_MAX_WIDTH);
  const maxLines = clampInt(rawMaxLines, MIN_MAX_LINES, MAX_MAX_LINES, DEFAULT_MAX_LINES);
  const oldText = cue.text;

  const base: TypesetEntry = {
    cueId: cue.id,
    index,
    status: 'ok',
    normalized: normalizeForTypeset(oldText),
    oldText,
    newText: null,
    lines: null,
    lineWidths: null,
    lineCount: null,
    changed: false,
    reason: null
  };

  if (hasAngleTag(oldText)) {
    return {
      ...base,
      status: 'tag',
      reason: '文本含尖括号标签（如 <i>、<font …>、<00:00:00.000>），自动断行可能破坏标记，保留原文不参与应用'
    };
  }

  const normalized = base.normalized;
  const units = tokenize(normalized);

  if (normalized === '') {
    // 纯空白 / 空文本：归一化为空串，无需断行（空文本不产生可见行）
    return { ...base, newText: '', lines: [], lineWidths: [], lineCount: 0, changed: oldText !== '' };
  }

  const strict = solveLayout(units, maxWidth, maxLines, true);
  if (strict.feasible) {
    const rendered = renderLines(units, strict.segments);
    return {
      ...base,
      newText: rendered.text,
      lines: rendered.lines,
      lineWidths: rendered.widths,
      lineCount: rendered.lines.length,
      changed: rendered.text !== oldText
    };
  }

  // 无解原因定位：三档放宽，依次区分「原子超宽」「行数不足（放宽禁排后仍超）」
  // 「行数 + 禁排共同受限（放宽禁排即满足行数）」「纯禁排无解」。
  // 1) 行数有限、放开禁排
  const relaxedKinsoku = solveLayout(units, maxWidth, maxLines, false);
  if (relaxedKinsoku.feasible) {
    return {
      ...base,
      status: 'infeasible',
      reason: `行首 / 行尾禁排规则（行首禁「，。！？；：、）】」、行尾禁「（【」）下无法在每行宽度 ${maxWidth}、最多 ${maxLines} 行内排下，保留原文`
    };
  }

  // 2) 行数与禁排都放开
  const relaxedAll = solveLayout(units, maxWidth, Number.POSITIVE_INFINITY, false);
  if (!relaxedAll.feasible) {
    const tokens = units.filter((u): u is TokenUnit => u.kind === 'token');
    const wide = tokens.find((tk) => tk.width > maxWidth);
    const reason = wide
      ? `存在不可拆分片段宽度 ${wide.width}（连续 ASCII 字母数字不可拆开），超过每行最大宽度 ${maxWidth}，无法断行`
      : `超过每行最大宽度 ${maxWidth}，无法断行`;
    return { ...base, status: 'infeasible', reason };
  }

  // 3) 放开禁排后仍需更多行
  return {
    ...base,
    status: 'infeasible',
    reason: `最少需要 ${relaxedAll.lines} 行才能排下，超过最多 ${maxLines} 行的限制（即使放宽行首 / 行尾禁排仍如此），保留原文`
  };
}

/** 按时间序规划全部字幕（字幕或参数变化即应重算） */
export function planTypeset(cues: Cue[], maxWidth: number, maxLines: number): TypesetEntry[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  return sorted.map((cue, i) => planTypesetEntry(cue, i + 1, maxWidth, maxLines));
}

/**
 * 一次应用全部可排版且确有改动的条目：只替换这些条目的 text，
 * 其余条目保持原引用；结果作为一次历史操作提交（撤销 / 重做 / SRT 导出复用现有流程）。
 * 返回 null 表示没有任何可应用改动。
 */
export function applyTypeset(cues: Cue[], entries: TypesetEntry[]): Cue[] | null {
  const nextById = new Map<string, string>();
  for (const e of entries) {
    if (e.status === 'ok' && e.changed && e.newText !== null) nextById.set(e.cueId, e.newText);
  }
  if (nextById.size === 0) return null;
  return cues.map((c) => {
    const text = nextById.get(c.id);
    return text !== undefined ? { ...c, text } : c;
  });
}
