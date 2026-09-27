/**
 * 参考字幕差异审阅：当前轨与参考轨的一对一单调配对（纯函数，可单测）。
 *
 * 配对规则：
 * - 仅当两条字幕「去空白与标点后的文本」相同时才允许配对；
 * - 配对在两轨各自的时间顺序上单调（一一对应、不交叉、不重复使用任一条）；
 * - 目标一：最大化配对数（等价于按匹配谓词求 LCS）；
 * - 目标二：在所有配对数最大的方案中，最小化配对起点时间差 |Δstart| 总和。
 * 这样重复台词与单侧插入只会留下局部未配对条目，不会造成后续整体错位。
 *
 * 实现：标准 LCS 动态规划，按 (配对数降序, 起点差总和升序) 字典序取最优。
 * 正向 DP 只保留两行滚动数组，回溯指针矩阵 (n+1)×(m+1) 每格 1 字节，
 * 因此内存为 O(n·m) 字节量级（另加 O(m) 的数值数组）。
 */

import type { Cue } from '../types';

/** 配对矩阵规模上限（(n+1)·(m+1) 单元格数）；超出返回 null，由调用方提示 */
export const MAX_PAIR_CELLS = 25_000_000;

/**
 * 配对用文本比较键：先 NFKC 归一化（折叠全角/兼容字符），
 * 再删除所有 Unicode 空白与标点。比较键完全相同的字幕才可配对。
 */
export function normalizeCueText(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{P}]+/gu, '');
}

/** 一对已配对字幕及其起止偏差（当前 − 参考，秒，带符号） */
export interface RefPair {
  current: Cue;
  reference: Cue;
  /** 当前起点 − 参考起点 */
  startDelta: number;
  /** 当前终点 − 参考终点 */
  endDelta: number;
}

/** 两轨单调配对的完整结果 */
export interface RefDiffResult {
  /** 全部配对（按当前轨时间序） */
  pairs: RefPair[];
  /** 当前轨独有（未配对）字幕，时间序 */
  currentOnly: Cue[];
  /** 参考轨独有（未配对）字幕，时间序 */
  referenceOnly: Cue[];
}

/** 审阅面板列出的差异条目 */
export type RefDiffItem =
  | { kind: 'pair'; pair: RefPair }
  | { kind: 'current-only'; cue: Cue }
  | { kind: 'reference-only'; cue: Cue };

/** 面板统计与条目列表 */
export interface RefDiffStats {
  /** 偏差超限配对 + 两轨独有条目，按所在侧起点时间混排 */
  items: RefDiffItem[];
  /** 全部配对数（含未超限） */
  paired: number;
  /** 起止偏差超过阈值的配对数 */
  deviated: number;
  currentOnly: number;
  referenceOnly: number;
}

/**
 * 构建两轨一对一单调配对。返回 null 表示规模超出 MAX_PAIR_CELLS。
 * 两轨输入先各自按 (start, end) 排序，输出均保持时间序。
 */
export function buildRefDiff(current: Cue[], reference: Cue[]): RefDiffResult | null {
  const a = [...current].sort((x, y) => x.start - y.start || x.end - y.end);
  const b = [...reference].sort((x, y) => x.start - y.start || x.end - y.end);
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return { pairs: [], currentOnly: a, referenceOnly: b };
  }
  const width = m + 1;
  const cells = (n + 1) * width;
  if (cells > MAX_PAIR_CELLS) return null;

  const aKey = a.map((c) => normalizeCueText(c.text));
  const bKey = b.map((c) => normalizeCueText(c.text));

  // 滚动行：配对数（Int32）与起点差总和（Float64）
  let prevCount = new Int32Array(width);
  let prevCost = new Float64Array(width);
  let curCount = new Int32Array(width);
  let curCost = new Float64Array(width);
  // 回溯指针：1=对角（配对 a[i-1]↔b[j-1]）2=上（a[i-1] 当前独有）3=左（b[j-1] 参考独有）
  const back = new Uint8Array(cells);

  for (let i = 1; i <= n; i++) {
    curCount[0] = 0;
    curCost[0] = 0;
    const rowBase = i * width;
    const ai = a[i - 1];
    const ak = aKey[i - 1];
    for (let j = 1; j <= m; j++) {
      // 候选「上」：a[i-1] 不参与配对
      let bestCount = prevCount[j];
      let bestCost = prevCost[j];
      let dir = 2;
      // 候选「左」：b[j-1] 不参与配对
      if (curCount[j - 1] > bestCount || (curCount[j - 1] === bestCount && curCost[j - 1] < bestCost)) {
        bestCount = curCount[j - 1];
        bestCost = curCost[j - 1];
        dir = 3;
      }
      // 候选「对角」：文本比较键相同才允许配对
      if (ak === bKey[j - 1]) {
        const diagCount = prevCount[j - 1] + 1;
        const diagCost = prevCost[j - 1] + Math.abs(ai.start - b[j - 1].start);
        if (diagCount > bestCount || (diagCount === bestCount && diagCost < bestCost)) {
          bestCount = diagCount;
          bestCost = diagCost;
          dir = 1;
        }
      }
      curCount[j] = bestCount;
      curCost[j] = bestCost;
      back[rowBase + j] = dir;
    }
    // 交换滚动行
    const tc = prevCount;
    prevCount = curCount;
    curCount = tc;
    const ts = prevCost;
    prevCost = curCost;
    curCost = ts;
  }

  // 回溯：从 (n, m) 走到边界。计数与代价都相等的并列方案在正向已按
  // 「上 → 左 → 对角」定型（即并列时优先让更早的条目配对）
  const pairs: RefPair[] = [];
  const currentOnly: Cue[] = [];
  const referenceOnly: Cue[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const dir = back[i * width + j];
    if (dir === 1) {
      const ca = a[i - 1];
      const cb = b[j - 1];
      pairs.push({
        current: ca,
        reference: cb,
        startDelta: ca.start - cb.start,
        endDelta: ca.end - cb.end
      });
      i -= 1;
      j -= 1;
    } else if (dir === 2) {
      currentOnly.push(a[i - 1]);
      i -= 1;
    } else {
      referenceOnly.push(b[j - 1]);
      j -= 1;
    }
  }
  while (i > 0) {
    currentOnly.push(a[i - 1]);
    i -= 1;
  }
  while (j > 0) {
    referenceOnly.push(b[j - 1]);
    j -= 1;
  }
  // 回溯得到的是逆序，统一翻回时间序
  pairs.reverse();
  currentOnly.reverse();
  referenceOnly.reverse();
  return { pairs, currentOnly, referenceOnly };
}

/**
 * 配对条目的起止偏差是否超过阈值（起点或终点任一超过即超限）。
 * 严格大于：恰好等于阈值不算超限；统一按毫秒整数比较以吸收浮点误差。
 */
export function pairDeviated(pair: RefPair, thresholdSec: number): boolean {
  const limit = Math.round(Math.max(0, thresholdSec) * 1000);
  return (
    Math.round(Math.abs(pair.startDelta) * 1000) > limit ||
    Math.round(Math.abs(pair.endDelta) * 1000) > limit
  );
}

/** 差异条目的稳定 key（用于列表渲染与定位态） */
export function refItemKey(item: RefDiffItem): string {
  if (item.kind === 'pair') return `p:${item.pair.current.id}`;
  if (item.kind === 'current-only') return `c:${item.cue.id}`;
  return `r:${item.cue.id}`;
}

/**
 * 汇总面板数据：偏差超限的配对与两轨独有条目，按所在侧起点时间混排；
 * 偏差未超限的配对不列出（视为一致）。
 */
export function summarizeRefDiff(result: RefDiffResult, thresholdSec: number): RefDiffStats {
  const items: RefDiffItem[] = [];
  let deviated = 0;
  for (const pair of result.pairs) {
    if (pairDeviated(pair, thresholdSec)) {
      deviated += 1;
      items.push({ kind: 'pair', pair });
    }
  }
  for (const cue of result.currentOnly) items.push({ kind: 'current-only', cue });
  for (const cue of result.referenceOnly) items.push({ kind: 'reference-only', cue });
  // 配对以当前轨起点排序；独有条目以各自侧起点排序
  const timeOf = (it: RefDiffItem): number =>
    it.kind === 'pair' ? it.pair.current.start : it.cue.start;
  items.sort((x, y) => timeOf(x) - timeOf(y));
  return {
    items,
    paired: result.pairs.length,
    deviated,
    currentOnly: result.currentOnly.length,
    referenceOnly: result.referenceOnly.length
  };
}
