/**
 * 阅读速度修复：按「去空白与标点后的 Unicode 字素簇」密度找出过快字幕，
 * 并在相邻约束（0s / 最小间隔 / 已加载音频终点）内规划时长延长方案（纯函数，可单测）。
 *
 * 速度定义：字数 / 时长（字/秒）。字数 = 文本 NFKC 归一化、删除所有 Unicode
 * 空白与标点后，按 Unicode 字素簇（grapheme cluster）计数——emoji 与组合字符
 * 各算一个字。时长以毫秒整数参与比较，吸收浮点误差。
 *
 * 延长规划：所需延长量先均分到起点侧 / 终点侧；任一侧受 0s、相邻字幕最小间隔
 * 或已加载音频终点限制而分不满时，未分配量转给另一侧；两侧余量合计仍不足时
 * 返回缺少的毫秒数并禁止提交（不修改任何字幕）。
 */

import type { Constraints, Cue } from '../types';
import { normalizeCueText } from './refdiff';

/* ---------------- 字素簇计数 ---------------- */

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

/**
 * 统计字符串的 Unicode 字素簇数。优先使用 Intl.Segmenter(grapheme)；
 * 不支持的环境退化为按码点计数（Array.from，组合序列会被拆开，仅极端环境下偏差）。
 */
export function countGraphemes(text: string): number {
  if (!text) return 0;
  if (segmenter) {
    let n = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const _part of segmenter.segment(text)) n += 1;
    return n;
  }
  return Array.from(text).length;
}

/**
 * 阅读字数：先 NFKC 归一化并删除所有 Unicode 空白（\s）与标点（\p{P}），
 * 再按字素簇计数。与参考差异配对的文本比较键同源。
 */
export function readingChars(text: string): number {
  return countGraphemes(normalizeCueText(text));
}

/* ---------------- 超速条目 ---------------- */

/** 单条字幕的阅读速度指标 */
export interface ReadingSpeedEntry {
  cueId: string;
  /** 列表序号（1-based，时间序） */
  index: number;
  /** 去空白标点后的字素簇数 */
  chars: number;
  /** 当前时长（毫秒） */
  durationMs: number;
  /** 阅读速度（字/秒）；空时长且有字数时为 Infinity */
  cps: number;
  /** 速度严格超过阈值（毫秒精度比较） */
  over: boolean;
  /** 目标时长（毫秒，向上取整到毫秒） */
  targetMs: number;
  /** 需要的总延长量（毫秒） */
  extendMs: number;
}

/**
 * 按时间序计算全部条目的阅读速度指标。字数为 0（纯标点 / 空文本）不参与超速判定。
 * 目标时长 = max(当前时长, ceil(字数 / 阈值 × 1000)) 毫秒；1e-6 吸收浮点误差，
 * 整除场景不误加 1ms。
 */
export function buildReadingSpeed(cues: Cue[], thresholdCps: number): ReadingSpeedEntry[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const t = Math.max(0, thresholdCps);
  return sorted.map((cue, i) => {
    const chars = readingChars(cue.text);
    const durationMs = Math.round((cue.end - cue.start) * 1000);
    const cps = durationMs > 0 ? chars / (durationMs / 1000) : chars > 0 ? Number.POSITIVE_INFINITY : 0;
    let targetMs = durationMs;
    let extendMs = 0;
    if (chars > 0 && t > 0) {
      targetMs = Math.max(durationMs, Math.ceil((chars / t) * 1000 - 1e-6));
      extendMs = Math.max(0, targetMs - durationMs);
    }
    const over = chars > 0 && t > 0 && cps > t + 1e-9;
    return { cueId: cue.id, index: i + 1, chars, durationMs, cps, over, targetMs, extendMs };
  });
}

/* ---------------- 延长规划 ---------------- */

/** 单侧余量的受限原因 */
export type SlackBoundKind =
  /** 受 0s 限制（仅起点侧无相邻字幕时） */
  | 'zero'
  /** 受相邻字幕最小间隔限制 */
  | 'neighbor'
  /** 受已加载音频终点限制（仅终点侧） */
  | 'audio-end'
  /** 该侧没有触限（无相邻 / 无音频，或实际未取满余量） */
  | 'none';

/** 单侧分配结果（毫秒） */
export interface SidePlan {
  /** 该侧可让渡的最大余量（无相邻 / 无音频时为 Infinity） */
  slackMs: number;
  /** 实际从该侧延长的量 */
  takeMs: number;
  /** 实际取满余量时的触限原因（用于界面说明）；未取满为 none */
  bound: SlackBoundKind;
  /** 触限的相邻字幕序号（1-based）；非相邻原因时为 null */
  neighborIndex: number | null;
}

/** 单条超速字幕的延长方案 */
export interface ReadingSpeedFix {
  cueId: string;
  /** 原起止（毫秒） */
  oldStartMs: number;
  oldEndMs: number;
  /** 若完全满足阈值的目标起止（毫秒，不考虑余量） */
  targetStartMs: number;
  targetEndMs: number;
  /** 约束内实际可达的新起止（毫秒） */
  newStartMs: number;
  newEndMs: number;
  /** 需要的总延长量（毫秒） */
  needMs: number;
  /** 两侧余量合计（毫秒；无任何右限制时 Infinity） */
  totalSlackMs: number;
  /** 两侧余量合计仍不足时缺少的毫秒数（0 = 可提交） */
  shortfallMs: number;
  feasible: boolean;
  left: SidePlan;
  right: SidePlan;
  /** 应用后的完整字幕数组（不足或无需延长时为 null，原字幕不变） */
  nextCues: Cue[] | null;
}

/**
 * 规划单条字幕的时长延长。
 *
 * 左侧余量 = cue.start − max(0, prev.end + minGap)
 * 右侧上限 = min(next.start − minGap, 音频终点)（按存在的约束取），
 *   右侧余量 = 上限 − cue.end。
 * 所需延长先均分（奇数毫秒多的 1ms 归右侧）；一侧分不满时把未分配量转给
 * 仍有余量的另一侧（最多两轮即收敛）；两侧都取满后仍分不完的量记为 shortfallMs。
 *
 * @param audioEnd 已加载音频终点（秒）；未知 / 未加载传 0，表示不施加该限制
 */
export function planReadingSpeedFix(
  cues: Cue[],
  cueId: string,
  thresholdCps: number,
  constraints: Constraints,
  audioEnd: number
): ReadingSpeedFix | null {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const idx = sorted.findIndex((c) => c.id === cueId);
  if (idx < 0) return null;
  const cue = sorted[idx];
  const metrics = buildReadingSpeed(sorted, thresholdCps)[idx];

  const gapMs = Math.max(0, Math.round(constraints.minGap * 1000));
  const startMs = Math.round(cue.start * 1000);
  const endMs = Math.round(cue.end * 1000);
  const prev = sorted[idx - 1] ?? null;
  const next = sorted[idx + 1] ?? null;

  // ---- 左侧余量：0s 与「上一条终点 + 最小间隔」取更晚者 ----
  const leftLimit = prev ? Math.round(prev.end * 1000) + gapMs : 0;
  const leftSlackMs = Math.max(0, startMs - Math.max(0, leftLimit));
  const leftLimitKind: SlackBoundKind = prev ? 'neighbor' : 'zero';

  // ---- 右侧上限：下一条起点 − 最小间隔，与音频终点取更早者 ----
  const neighborCap = next ? Math.round(next.start * 1000) - gapMs : null;
  const audioCap = audioEnd > 0 ? Math.floor(audioEnd * 1000) : null;
  let rightCap: number | null = null;
  let rightLimitKind: SlackBoundKind = 'none';
  if (neighborCap !== null && audioCap !== null) {
    if (neighborCap <= audioCap) {
      rightCap = neighborCap;
      rightLimitKind = 'neighbor';
    } else {
      rightCap = audioCap;
      rightLimitKind = 'audio-end';
    }
  } else if (neighborCap !== null) {
    rightCap = neighborCap;
    rightLimitKind = 'neighbor';
  } else if (audioCap !== null) {
    rightCap = audioCap;
    rightLimitKind = 'audio-end';
  }
  const rightSlackMs = rightCap === null ? Number.POSITIVE_INFINITY : Math.max(0, rightCap - endMs);

  const needMs = metrics.extendMs;

  // 先均分：floor(n/2) 给起点侧，奇数毫秒多的 1ms 归终点侧；
  // 各侧先在自身余量内取用，超出部分作为未分配量
  let leftTake = Math.min(Math.floor(needMs / 2), leftSlackMs);
  let rightTake = Math.min(needMs - Math.floor(needMs / 2), rightSlackMs);
  // 未分配量在两侧间转拨：无相邻/音频的一侧余量 Infinity；两侧都取满后剩余即缺口
  let remaining = needMs - leftTake - rightTake;
  for (let guard = 0; remaining > 0 && guard < 2; guard += 1) {
    const addLeft = Math.min(remaining, leftSlackMs - leftTake);
    leftTake += addLeft;
    remaining -= addLeft;
    const addRight = Math.min(remaining, rightSlackMs - rightTake);
    rightTake += addRight;
    remaining -= addRight;
  }
  const shortfallMs = Math.max(0, remaining);
  const feasible = needMs > 0 && shortfallMs === 0;

  const newStartMs = startMs - leftTake;
  const newEndMs = endMs + rightTake;

  const EPS = 1e-6;
  const leftSide: SidePlan = {
    slackMs: leftSlackMs,
    takeMs: leftTake,
    bound: needMs > 0 && leftTake >= leftSlackMs - EPS ? leftLimitKind : 'none',
    neighborIndex: prev ? idx : null
  };
  const rightSide: SidePlan = {
    slackMs: rightSlackMs,
    takeMs: rightTake,
    bound:
      needMs > 0 && Number.isFinite(rightSlackMs) && rightTake >= rightSlackMs - EPS
        ? rightLimitKind
        : 'none',
    neighborIndex: next ? idx + 2 : null
  };

  const totalSlackMs = leftSlackMs + rightSlackMs;

  let nextCues: Cue[] | null = null;
  if (feasible) {
    nextCues = cues.map((c) =>
      c.id === cueId ? { ...c, start: newStartMs / 1000, end: newEndMs / 1000 } : c
    );
  }

  return {
    cueId,
    oldStartMs: startMs,
    oldEndMs: endMs,
    targetStartMs: startMs - needMs,
    targetEndMs: endMs + needMs,
    newStartMs,
    newEndMs,
    needMs,
    totalSlackMs,
    shortfallMs,
    feasible,
    left: leftSide,
    right: rightSide,
    nextCues
  };
}
