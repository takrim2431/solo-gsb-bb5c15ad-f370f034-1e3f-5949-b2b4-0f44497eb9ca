/**
 * 断行排版：在「每行最大显示宽度」与「最多行数」内重排单条字幕文本（纯函数，可单测）。
 *
 * 归一化：原换行符与任意连续 Unicode 空白（含全角空格、制表符）统一折叠为单个
 * ASCII 空格，整体再去掉行首行尾空格；随后按 Unicode 字素簇切分，原子为：
 *  - 空格（宽 1）；
 *  - 连续 ASCII 字母数字（[A-Za-z0-9]+，每个宽 1，整段不可拆）；
 *  - 其余字素（汉字及全角字符宽 2，其余宽 1；emoji ZWJ 序列等整体算 1 个字素、宽 1）。
 *
 * 断行只能发生在原子之间；成行后行首行尾空格不计入宽度。
 * 禁则：行首禁止「，。！？；：、）】」，行尾禁止「（【」。
 *
 * 选择目标（严格优先级，非逐行贪心）：
 *  1. 行数最少；
 *  2. 行数相同，各行剩余宽度（maxWidth − 行宽）的平方和最小；
 *  3. 仍同分，取断点序列字典序最小者。
 * 分层动态规划求解（第 k 层 = 恰好 k 行覆盖前 j 个原子），同层状态以
 * （前驱断点序列名次, 行末位置）指派字典序名次，使并列比较为 O(1)。
 *
 * 无解（含不可拆单元超宽、行数超限或禁则无法满足）与含尖括号标签（<…>）的条目
 * 保留原文并给出原因，不参与应用。
 */

import type { Cue } from '../types';
import { splitGraphemes } from './readingSpeed';

/** 断行排版参数 */
export interface ReflowOptions {
  /** 每行最大显示宽度（汉字 / 全角宽 2，其余宽 1）；正整数 */
  maxWidth: number;
  /** 最多行数：1～4 */
  maxLines: number;
}

export const DEFAULT_REFLOW_OPTIONS: ReflowOptions = { maxWidth: 30, maxLines: 2 };
export const REFLOW_MIN_LINES = 1;
export const REFLOW_MAX_LINES = 4;

/** 跳过原因（区分标签 / 无解子类，便于汇总与测试） */
export type ReflowSkipKind = 'tag' | 'atom-width' | 'lines' | 'punct';

/** 单条字幕的排版预览结果 */
export interface ReflowEntry {
  cueId: string;
  /** 列表序号（1-based，时间序） */
  index: number;
  /** 原始文本（未归一化，含原换行） */
  oldText: string;
  /** true = 可排版；false = 保留原文（reason 给出原因） */
  ok: boolean;
  /** 排版后文本（行以 \n 连接）；跳过为 null */
  newText: string | null;
  /** 排版后各行文本（跳过为空数组） */
  lines: string[];
  /** 各行显示宽度（与 lines 对齐；跳过为空数组） */
  widths: number[];
  /** 跳过原因（ok 时为 null） */
  reason: string | null;
  /** 跳过原因分类（ok 时为 null） */
  reasonKind: ReflowSkipKind | null;
}

export interface ReflowPlan {
  options: ReflowOptions;
  /** 与时间序字幕一一对应的预览条目 */
  entries: ReflowEntry[];
  /** 可排版且文本确有变化的条目数（应用按钮据此启停） */
  changedCount: number;
  /** 保留原文字条数（无解 / 含标签） */
  skippedCount: number;
  /** 跳过分类计数 */
  skipByKind: Record<ReflowSkipKind, number>;
}

/* ---------------- 字符宽度与原子 ---------------- */

type AtomType = 'space' | 'word' | 'glyph';

interface Atom {
  type: AtomType;
  /** 原子原文（空格为 ' '；word 为连续 ASCII 字母数字；glyph 为单个字素簇） */
  text: string;
  /** 显示宽度 */
  width: number;
}

/** 行首禁排字符（闭合类标点不应出现在行首） */
const LINE_START_BANNED = new Set(['，', '。', '！', '？', '；', '：', '、', '）', '】']);
/** 行尾禁排字符（开括号不应留在行尾） */
const LINE_END_BANNED = new Set(['（', '【']);

/**
 * 该码点是否按宽 2 计：CJK 汉字 / 假名 / 谚文、CJK 标点与全角 ASCII（U+FF01..FF5E）、
 * 全角空格（归一化后不会出现）、CJK 兼容 / 兼容形式等。其余（含所有 emoji）宽 1。
 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文 Jamo
    cp === 0x2329 || cp === 0x232a || // 〈〉（CJK 角括号）
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 / 汉字结构 / 假名 / CJK 标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 平假名 / 片假名 / CJK 兼容符号（含 ｢｣､･）
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0xa4cf) || // CJK 统一汉字 / 彝文
    (cp >= 0xa960 && cp <= 0xa97f) || // 谚文扩展 A
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0xfe10 && cp <= 0xfe19) || // 竖排标点
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容标点 / 小号全角形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII（含全角标点与字母数字）
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角货币 / 记号
    (cp >= 0x1f200 && cp <= 0x1f2ff) || // 带圈表意文字补充
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以后
  );
}

function isAsciiAlnumCodePoint(cp: number): boolean {
  return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122);
}

/** 字素簇显示宽度：首码点为宽字符则 2，否则 1（组合序列、emoji 宽 1） */
function graphemeWidth(g: string): number {
  return isWideCodePoint(g.codePointAt(0) ?? 0) ? 2 : 1;
}

/** 检测尖括号标签：<…>（内容不含尖括号 / 换行），如 <i>、</b>、<font color="red"> */
const TAG_RE = /<[^<>\n]*>/;

/**
 * 归一化并切分为原子序列。
 * 任意连续 Unicode 空白（\s 含 \n、\t、全角空格 U+3000）折叠为单个 ASCII 空格，
 * 去掉整体首尾空格后按 Unicode 字素簇切分；连续 ASCII 字母数字合并为不可拆 word 原子。
 */
function tokenize(raw: string): { normalized: string; atoms: Atom[] } {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const clusters = splitGraphemes(normalized);
  const atoms: Atom[] = [];
  let word = '';
  const flushWord = () => {
    if (word) {
      atoms.push({ type: 'word', text: word, width: word.length });
      word = '';
    }
  };
  for (const g of clusters) {
    if (g === ' ') {
      flushWord();
      atoms.push({ type: 'space', text: ' ', width: 1 });
      continue;
    }
    // 仅「恰好单个 ASCII 字母数码点」的字素并入连续字母数字（é、e+组合符不算）
    const cp = g.codePointAt(0) ?? 0;
    if (g.length === 1 && isAsciiAlnumCodePoint(cp)) {
      word += g;
      continue;
    }
    flushWord();
    atoms.push({ type: 'glyph', text: g, width: graphemeWidth(g) });
  }
  flushWord();
  return { normalized, atoms };
}

/* ---------------- 分层动态规划 ---------------- */

interface LineInfo {
  /** 去掉首尾空格后的内容宽度 */
  width: number;
  valid: boolean;
}

interface DpState {
  /** 截至本行末的剩余宽度平方和累计 */
  cost: number;
  /** 上一行末原子下标（首层为 -1） */
  pred: number;
  /** 本层内断点序列字典序名次 */
  rank: number;
}

/** 行候选 [i, j) 的内容区间与可行性（前缀和 + 预处理的内容边界，O(1)） */
function makeLineInspector(atoms: Atom[], maxWidth: number) {
  const n = atoms.length;
  const prefix = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + atoms[i].width;
  // nextContent[i]：≥ i 的第一个非空格原子（无则 n）
  const nextContent = new Int32Array(n + 1);
  nextContent[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    nextContent[i] = atoms[i].type === 'space' ? nextContent[i + 1] : i;
  }
  // prevContentEnd[j]：< j 的最后一个非空格原子（无则 -1）
  const prevContentEnd = new Int32Array(n + 1);
  prevContentEnd[0] = -1;
  for (let j = 0; j < n; j += 1) {
    prevContentEnd[j + 1] = atoms[j].type === 'space' ? prevContentEnd[j] : j;
  }

  return (i: number, j: number): LineInfo => {
    const cs = nextContent[i];
    const cl = prevContentEnd[j];
    if (cs > cl) return { width: 0, valid: false }; // 整行只有空格
    const width = prefix[cl + 1] - prefix[cs];
    if (width < 1 || width > maxWidth) return { width, valid: false };
    const first = atoms[cs];
    const last = atoms[cl];
    if (first.type === 'glyph' && LINE_START_BANNED.has(first.text)) {
      return { width, valid: false };
    }
    if (last.type === 'glyph' && LINE_END_BANNED.has(last.text)) {
      return { width, valid: false };
    }
    return { width, valid: true };
  };
}

interface SolveResult {
  /** 最少行数；不可行为 Infinity */
  lineCount: number;
  /** 各行覆盖的原子边界（长度 lineCount+1，首尾为 0 / n）；不可行为 null */
  bounds: number[] | null;
  /** 各行内容宽度 */
  widths: number[];
}

/**
 * 分层动态规划：第 k 层仅保留每个行末位置 j 的「（累计平方和, 断点序列字典序）」
 * 最优前驱——同一 (k, j) 的历史对后续代价与并列顺序完全等价，局部最优即全局最优。
 * 从 k=1 起逐层求，首个在 k 行覆盖全部原子的层即最少行数解。
 */
function solve(atoms: Atom[], maxWidth: number, maxLines: number): SolveResult {
  const n = atoms.length;
  if (n === 0) return { lineCount: 0, bounds: [0], widths: [] };
  const inspect = makeLineInspector(atoms, maxWidth);
  // layers[k-1][j]：恰好 k 行覆盖前 j 个原子的状态（null = 不可达）
  const layers: Array<Array<DpState | null>> = [];

  // 第 1 层
  {
    const layer: Array<DpState | null> = new Array(n + 1).fill(null);
    for (let j = 1; j <= n; j += 1) {
      const li = inspect(0, j);
      if (!li.valid) continue;
      layer[j] = { cost: (maxWidth - li.width) ** 2, pred: -1, rank: 0 };
    }
    assignRanks(layer, null);
    layers.push(layer);
    if (layer[n]) return finish(layers, atoms, inspect);
  }

  for (let k = 2; k <= maxLines; k += 1) {
    const prev = layers[k - 2];
    const layer: Array<DpState | null> = new Array(n + 1).fill(null);
    for (let i = 1; i < n; i += 1) {
      const ps = prev[i];
      if (!ps) continue;
      // i 固定、j 递增时内容宽度单调不减（尾随空格不缩窄内容），超宽后该行之后必超宽
      for (let j = i + 1; j <= n; j += 1) {
        const li = inspect(i, j);
        if (li.width > maxWidth) break;
        if (!li.valid) continue;
        const total = ps.cost + (maxWidth - li.width) ** 2;
        const cur = layer[j];
        if (
          !cur ||
          total < cur.cost ||
          (total === cur.cost && ps.rank < (prev[cur.pred] as DpState).rank)
        ) {
          layer[j] = { cost: total, pred: i, rank: 0 };
        }
      }
    }
    assignRanks(layer, prev);
    layers.push(layer);
    if (layer[n]) return finish(layers, atoms, inspect);
  }
  return { lineCount: Number.POSITIVE_INFINITY, bounds: null, widths: [] };
}

/** 本层状态按（前驱断点序列名次, 行末位置）排序后依次指派字典序名次 */
function assignRanks(layer: Array<DpState | null>, prev: Array<DpState | null> | null): void {
  const ends: number[] = [];
  for (let j = 0; j < layer.length; j += 1) if (layer[j]) ends.push(j);
  ends.sort((a, b) => {
    const sa = layer[a] as DpState;
    const sb = layer[b] as DpState;
    const ra = sa.pred < 0 || !prev ? -1 : (prev[sa.pred] as DpState).rank;
    const rb = sb.pred < 0 || !prev ? -1 : (prev[sb.pred] as DpState).rank;
    return ra - rb || a - b;
  });
  ends.forEach((end, rank) => {
    (layer[end] as DpState).rank = rank;
  });
}

/** 末层（覆盖全部原子的最少行层）回溯断点，并还原各行内容文本与宽度 */
function finish(
  layers: Array<Array<DpState | null>>,
  atoms: Atom[],
  inspect: (i: number, j: number) => LineInfo
): SolveResult {
  const k = layers.length;
  const bounds = new Array<number>(k + 1);
  const widths = new Array<number>(k);
  let end = atoms.length;
  for (let line = k - 1; line >= 0; line -= 1) {
    const st = layers[line][end] as DpState;
    bounds[line + 1] = end;
    widths[line] = inspect(st.pred < 0 ? 0 : st.pred, end).width;
    end = st.pred < 0 ? 0 : st.pred;
  }
  bounds[0] = 0;
  return { lineCount: k, bounds, widths };
}

/**
 * 「只看宽度」的最少行数：忽略禁则，每行取能放下的最长内容前缀（逐行贪心）。
 * 行宽对内容前缀单调，该贪心在「无禁则、不可拆单元」模型下取到行数最小值，
 * 仅用于无解时区分「行数超限」与「禁则导致」，不参与实际选点。
 */
function minimumWidthLines(atoms: Atom[], maxWidth: number): number {
  const n = atoms.length;
  const contentPos: number[] = [];
  for (let i = 0; i < n; i += 1) if (atoms[i].type !== 'space') contentPos.push(i);
  if (contentPos.length === 0) return 0;
  const prefix = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + atoms[i].width;
  let lines = 0;
  let c = 0;
  while (c < contentPos.length) {
    const first = contentPos[c];
    let last = c;
    while (last + 1 < contentPos.length) {
      const nextLast = contentPos[last + 1];
      if (prefix[nextLast + 1] - prefix[first] > maxWidth) break;
      last += 1;
    }
    lines += 1;
    c = last + 1;
  }
  return lines;
}

/* ---------------- 单条 / 全量计划 ---------------- */

/** 排版单条已归一化的文本；返回行文本数组或带分类的无解原因 */
function reflowOne(
  raw: string,
  maxWidth: number,
  maxLines: number
): { ok: true; lines: string[]; widths: number[] } | { ok: false; reason: string; kind: ReflowSkipKind } {
  if (TAG_RE.test(raw)) {
    return { ok: false, kind: 'tag', reason: '含尖括号标签（如 <i> / <font>），保留原文不参与排版' };
  }
  const { atoms } = tokenize(raw);
  if (atoms.length === 0) return { ok: true, lines: [], widths: [] };

  // 不可拆单元自身超宽：任何断行方式都放不下
  for (const a of atoms) {
    if (a.type !== 'space' && a.width > maxWidth) {
      return {
        ok: false,
        kind: 'atom-width',
        reason: `存在宽度 ${a.width} 超过每行最大宽度 ${maxWidth} 的不可拆单元，无法排版`
      };
    }
  }

  const result = solve(atoms, maxWidth, maxLines);
  if (result.bounds !== null) {
    const lines: string[] = [];
    for (let k = 0; k < result.lineCount; k += 1) {
      const text = atoms
        .slice(result.bounds[k], result.bounds[k + 1])
        .map((a) => a.text)
        .join('')
        .trim();
      lines.push(text);
    }
    return { ok: true, lines, widths: result.widths };
  }

  // 无解归因：只看宽度（放开禁则）最少需要多少行
  const needed = minimumWidthLines(atoms, maxWidth);
  if (needed > maxLines) {
    return {
      ok: false,
      kind: 'lines',
      reason: `宽度限制下至少需要 ${needed} 行，超过最多行数 ${maxLines} 行`
    };
  }
  return {
    ok: false,
    kind: 'punct',
    reason: `受行首（，。！？；：、）】）/ 行尾（（【）禁则限制，${maxLines} 行内无法满足`
  };
}

/** 归一化参数（容错外部输入）：正整数宽度，行数夹到 1～4 */
export function normalizeReflowOptions(input: ReflowOptions): ReflowOptions {
  const maxWidth = Number.isFinite(input.maxWidth) ? Math.max(1, Math.floor(input.maxWidth)) : DEFAULT_REFLOW_OPTIONS.maxWidth;
  const maxLines = Math.min(
    REFLOW_MAX_LINES,
    Math.max(REFLOW_MIN_LINES, Number.isFinite(input.maxLines) ? Math.floor(input.maxLines) : DEFAULT_REFLOW_OPTIONS.maxLines)
  );
  return { maxWidth, maxLines };
}

/**
 * 计算全部字幕的断行排版预览（时间序，与 cues 排序后一一对应）。
 * 纯只读：不修改任何字幕；字幕或参数变化时由调用方重新调用。
 */
export function buildReflowPlan(cues: Cue[], input: ReflowOptions): ReflowPlan {
  const options = normalizeReflowOptions(input);
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const skipByKind: Record<ReflowSkipKind, number> = { tag: 0, 'atom-width': 0, lines: 0, punct: 0 };
  let changedCount = 0;
  const entries: ReflowEntry[] = sorted.map((cue, i) => {
    const r = reflowOne(cue.text, options.maxWidth, options.maxLines);
    if (!r.ok) {
      skipByKind[r.kind] += 1;
      return {
        cueId: cue.id,
        index: i + 1,
        oldText: cue.text,
        ok: false,
        newText: null,
        lines: [],
        widths: [],
        reason: r.reason,
        reasonKind: r.kind
      };
    }
    const newText = r.lines.join('\n');
    const changed = newText !== cue.text;
    if (changed) changedCount += 1;
    return {
      cueId: cue.id,
      index: i + 1,
      oldText: cue.text,
      ok: true,
      newText,
      lines: r.lines,
      widths: r.widths,
      reason: null,
      reasonKind: null
    };
  });
  return {
    options,
    entries,
    changedCount,
    skippedCount: entries.length - entries.filter((e) => e.ok).length,
    skipByKind
  };
}

/**
 * 把计划应用为完整字幕数组（新数组）：仅「可排版且文本有变化」的条目更新 text，
 * 其余字幕对象保持原引用；时间码与 id 一律不动。无任何可更新条目时返回 null。
 */
export function applyReflow(cues: Cue[], plan: ReflowPlan): Cue[] | null {
  if (plan.changedCount === 0) return null;
  const byId = new Map(
    plan.entries.filter((e) => e.ok && e.newText !== null && e.newText !== e.oldText).map((e) => [e.cueId, e.newText as string])
  );
  return cues.map((c) => {
    const text = byId.get(c.id);
    return text === undefined ? c : { ...c, text };
  });
}
