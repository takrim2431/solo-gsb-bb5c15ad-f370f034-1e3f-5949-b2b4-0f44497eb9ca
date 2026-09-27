/**
 * 音频活动空档审阅：复用静音分析的 20ms 窗口能量，按可调电平阈值提取
 * 连续高能量（活动）段并合并短暂低能量断口；把当前字幕区间先合并、再带
 * 可调边界容差从活动段中扣除，剩余时长达到可调下限的区间即「疑似未被
 * 字幕覆盖」的空档。纯函数，可单测；结果仅用于提示，不修改字幕、
 * 不进入撤销历史。
 */

import type { Cue } from '../types';
import type { WindowLevels } from './silence';

/** 默认参数 */
export const DEFAULT_GAP_THRESHOLD_DB = -40; // 与静音吸附默认阈值一致
export const DEFAULT_GAP_MERGE_BREAK = 0.25; // 短于 250ms 的低能量断口并入两侧活动段
export const DEFAULT_GAP_TOLERANCE = 0.1; // 扣除字幕时向两侧各扩展 100ms
export const DEFAULT_GAP_MIN_DURATION = 0.5; // 只列出剩余 ≥500ms 的空档

/** 时间区间（秒，半开 [start, end)） */
export interface ActivitySegment {
  start: number;
  end: number;
}

/** 疑似未覆盖的空档：区间 + 时长 */
export interface ActivityGap extends ActivitySegment {
  duration: number;
}

export interface ActivityGapOptions {
  /** 线性振幅阈值：窗口能量不低于该值视为活动（0..1） */
  threshold: number;
  /** 活动段之间允许合并的低能量断口上限（秒，严格小于才合并） */
  mergeBreak: number;
  /** 扣除字幕区间时向两侧扩展的边界容差（秒） */
  tolerance: number;
  /** 列出空档的最短剩余时长（秒，恰好等于也列出） */
  minDuration: number;
}

export interface ActivityGapResult {
  /** 扣除前的活动段（时间序） */
  activity: ActivitySegment[];
  /** 扣除字幕后达到下限的空档（时间序） */
  gaps: ActivityGap[];
}

/**
 * 从窗口能量提取活动段：能量不低于阈值的连续窗口成段（与静音判定互补，
 * 恰好等于阈值算活动）；两段之间的低能量断口严格小于 mergeBreak 时合并
 * （恰好等于不合并），与静音段合并规则同构。
 */
export function detectActivitySegments(
  levels: WindowLevels,
  threshold: number,
  mergeBreak: number
): ActivitySegment[] {
  const { levels: lv, windowSize } = levels;
  const mergeWindows = mergeBreak / windowSize;

  // 1) 连续高能量窗口 -> 候选段（窗口索引，闭区间）
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= lv.length; i++) {
    const active = i < lv.length && lv[i] >= threshold - 1e-9;
    if (active && start < 0) {
      start = i;
    } else if (!active && start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }

  // 2) 断口严格小于 mergeBreak 的相邻段合并（恰好等于不合并）
  const merged: Array<[number, number]> = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - (last[1] + 1) < mergeWindows) {
      last[1] = run[1];
    } else {
      merged.push([run[0], run[1]]);
    }
  }

  return merged.map(([s, e]) => ({
    start: Number((s * windowSize).toFixed(4)),
    end: Number(((e + 1) * windowSize).toFixed(4))
  }));
}

/**
 * 合并当前字幕区间：按时间排序后把重叠或相接的区间并为一个，
 * 避免重叠字幕在扣除时被重复切割。
 */
export function mergeCueIntervals(cues: Cue[]): ActivitySegment[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ActivitySegment[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 1e-9) {
      if (c.end > last.end) last.end = c.end;
    } else {
      merged.push({ start: c.start, end: c.end });
    }
  }
  return merged;
}

/**
 * 从活动段中扣除字幕区间：合并后的字幕区间先向两侧各扩展 tolerance
 * （起点不越过 0s），再逐个从活动段中减去；端点恰好相接不算交叠。
 */
export function subtractCueIntervals(
  activity: ActivitySegment[],
  cues: Cue[],
  tolerance: number
): ActivitySegment[] {
  const tol = Math.max(0, tolerance);
  const cuts = mergeCueIntervals(cues).map((s) => ({
    start: Math.max(0, s.start - tol),
    end: s.end + tol
  }));
  let remaining = activity.map((s) => ({ ...s }));
  for (const cut of cuts) {
    const next: ActivitySegment[] = [];
    for (const seg of remaining) {
      if (cut.end <= seg.start || cut.start >= seg.end) {
        next.push(seg); // 无交叠（含端点相接）
        continue;
      }
      if (cut.start > seg.start) next.push({ start: seg.start, end: cut.start });
      if (cut.end < seg.end) next.push({ start: cut.end, end: seg.end });
    }
    remaining = next;
  }
  return remaining;
}

/**
 * 完整管线：活动段提取 → 扣除字幕（带边界容差）→ 按最短剩余时长过滤。
 * 剩余时长达到 minDuration 即列出（恰好等于也列出，1e-9 吸收浮点误差）。
 */
export function computeActivityGaps(
  levels: WindowLevels,
  cues: Cue[],
  options: ActivityGapOptions
): ActivityGapResult {
  const activity = detectActivitySegments(levels, options.threshold, options.mergeBreak);
  const remaining = subtractCueIntervals(activity, cues, options.tolerance);
  const min = Math.max(0, options.minDuration);
  const gaps = remaining
    .filter((s) => s.end - s.start >= min - 1e-9)
    .map((s) => ({ start: s.start, end: s.end, duration: s.end - s.start }));
  return { activity, gaps };
}
