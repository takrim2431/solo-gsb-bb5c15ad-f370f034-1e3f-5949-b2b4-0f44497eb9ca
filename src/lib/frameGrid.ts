/**
 * 帧率网格导出：把全部字幕起止点联合吸附到目标帧率的整数帧上（纯函数，可单测）。
 *
 * 帧率以分数 num/den（帧/秒）表示，帧 n 的精确时间为 n·den/num 秒；全部时间
 * 比较与误差累计都在该分数域内以整数完成，不做逐帧浮点累加，避免累计漂移，
 * 仅在最终输出时把帧时间四舍五入到毫秒。
 *
 * 候选：每个起止点取「最近帧（等距取较早帧）」及其前后各 2 帧，共至多 5 个；
 * 负帧（早于 0s）直接排除。
 *
 * 联合选择：全部字幕按时间序展开为 2N 个边界（起、止交替），动态规划逐边界
 * 选帧——每条终点帧 ≥ 起点帧 + 1、输出毫秒时间码的时长 ≥ 当前最短时长、
 * 相邻间隔 ≥ 当前最小间隔、起点不早于 0；目标先最小化全部边界相对原时间码的
 * 绝对误差总和（分数域精确求和），同分取按字幕顺序排列的帧号序列字典序最小者。
 * 无解时报告首个无法接续的字幕边界及原因，不产生任何部分结果。
 */

import type { Constraints, Cue } from '../types';

/** 目标帧率（分数表示：num/den 帧每秒） */
export interface FrameRate {
  id: string;
  label: string;
  /** 帧/秒 分子 */
  num: number;
  /** 帧/秒 分母 */
  den: number;
}

/** 可选目标帧率：24 / 25 / 30 / 30000/1001 帧每秒 */
export const FRAME_RATES: FrameRate[] = [
  { id: '24', label: '24 帧/秒', num: 24, den: 1 },
  { id: '25', label: '25 帧/秒', num: 25, den: 1 },
  { id: '30', label: '30 帧/秒', num: 30, den: 1 },
  { id: '30000/1001', label: '30000/1001 帧/秒（≈29.97）', num: 30000, den: 1001 }
];

export const DEFAULT_FRAME_RATE_ID = '25';

export function frameRateById(id: string): FrameRate {
  return FRAME_RATES.find((r) => r.id === id) ?? FRAME_RATES[0];
}

/**
 * 毫秒时间对应的最近帧号；与两帧等距时取较早帧。
 * 全程整数运算：帧位置 = ms·num / (1000·den)，余数与半帧做精确比较。
 */
export function nearestFrame(ms: number, rate: FrameRate): number {
  const a = ms * rate.num;
  const b = 1000 * rate.den;
  const k0 = Math.floor(a / b);
  const r = a - k0 * b;
  return 2 * r <= b ? k0 : k0 + 1;
}

/** 帧 n 的时间四舍五入到毫秒（整数运算，半毫秒进位） */
export function frameToMs(frame: number, rate: FrameRate): number {
  const p = frame * rate.den * 1000;
  const q = rate.num;
  const k = Math.floor(p / q);
  const r = p - k * q;
  return 2 * r >= q ? k + 1 : k;
}

/** 候选帧：最近帧及其前后各 2 帧，排除负帧（起点不早于 0），升序 */
export function frameCandidates(ms: number, rate: FrameRate): number[] {
  const n = nearestFrame(ms, rate);
  const out: number[] = [];
  for (let f = n - 2; f <= n + 2; f += 1) {
    if (f >= 0) out.push(f);
  }
  return out;
}

/**
 * 单边界误差的整数缩放值：|帧时间 − 原时间| × num（单位 1/num 毫秒）。
 * 帧时间 = frame·den/num 秒 → frame·den·1000/num 毫秒，与原 ms 比较通分后
 * 分子即该值；全程整数，求和无浮点漂移。
 */
function errScaled(frame: number, ms: number, rate: FrameRate): number {
  return Math.abs(frame * rate.den * 1000 - ms * rate.num);
}

/** 单条字幕的吸附结果 */
export interface FrameGridCueResult {
  cueId: string;
  /** 列表序号（1-based，时间序） */
  index: number;
  oldStartMs: number;
  oldEndMs: number;
  startFrame: number;
  endFrame: number;
  newStartMs: number;
  newEndMs: number;
}

/** 无解时的首个无法接续边界 */
export interface FrameGridFailure {
  cueId: string;
  /** 列表序号（1-based，时间序） */
  cueIndex: number;
  edge: 'start' | 'end';
  message: string;
}

export interface FrameGridPlan {
  rate: FrameRate;
  feasible: boolean;
  /** 有解时与全部字幕一一对应（时间序）；无解为空数组（不产出部分结果） */
  results: FrameGridCueResult[];
  /** 全部边界相对原时间码的绝对误差总和（毫秒）；无解为 0 */
  totalErrorMs: number;
  failure: FrameGridFailure | null;
}

/** 动态规划单边界状态 */
interface DpState {
  frame: number;
  /** 累计缩放误差（整数：毫秒误差 × num） */
  err: number;
  /** 上一边界层的状态下标；首层为 -1 */
  pred: number;
  /** 本层内的字典序名次（同误差并列时比较用） */
  rank: number;
}

/**
 * 在全部字幕的候选边界上联合选帧。
 *
 * 每层只保留「误差最小、并列时字典序最小」的最优前缀——同一帧号的历史对后续
 * 约束与代价完全等价，故局部最优即全局最优；字典序名次按（前驱名次, 帧号）
 * 逐层指派，使并列比较为 O(1)。
 */
export function planFrameGrid(
  cues: Cue[],
  constraints: Constraints,
  rate: FrameRate
): FrameGridPlan {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const n = sorted.length;
  if (n === 0) {
    return { rate, feasible: true, results: [], totalErrorMs: 0, failure: null };
  }
  const minDurMs = Math.max(0, Math.round(constraints.minDuration * 1000));
  const minGapMs = Math.max(0, Math.round(constraints.minGap * 1000));
  const layers: DpState[][] = [];

  for (let i = 0; i < 2 * n; i += 1) {
    const cueIdx = i >> 1;
    const isStart = (i & 1) === 0;
    const cue = sorted[cueIdx];
    const ms = Math.round((isStart ? cue.start : cue.end) * 1000);
    const cands = frameCandidates(ms, rate);
    const prev = i > 0 ? layers[i - 1] : null;
    const states: DpState[] = [];

    for (const f of cands) {
      const fMs = frameToMs(f, rate);
      const own = errScaled(f, ms, rate);
      if (!prev) {
        states.push({ frame: f, err: own, pred: -1, rank: 0 });
        continue;
      }
      // 在上一边界层的可达状态中选（累计误差, 字典序名次）最优且兼容的前驱
      let best = -1;
      for (let j = 0; j < prev.length; j += 1) {
        const p = prev[j];
        const gMs = frameToMs(p.frame, rate);
        if (isStart) {
          // 相邻间隔：本起点 − 上一条终点 ≥ 最小间隔（按输出毫秒时间码）
          if (fMs - gMs < minGapMs) continue;
        } else {
          // 同条起止：至少相隔 1 帧，且毫秒时长 ≥ 最短时长
          if (f - p.frame < 1 || fMs - gMs < minDurMs) continue;
        }
        if (
          best < 0 ||
          p.err < prev[best].err ||
          (p.err === prev[best].err && p.rank < prev[best].rank)
        ) {
          best = j;
        }
      }
      if (best >= 0) {
        states.push({ frame: f, err: prev[best].err + own, pred: best, rank: 0 });
      }
    }

    if (states.length === 0) {
      return {
        rate,
        feasible: false,
        results: [],
        totalErrorMs: 0,
        failure: buildFailure(sorted, cueIdx, isStart, cands, prev, minDurMs, minGapMs, rate)
      };
    }

    // 层内字典序名次：按（前驱名次, 帧号）排序后依次指派
    const predRank = states.map((s) => (s.pred < 0 || !prev ? -1 : prev[s.pred].rank));
    const order = states
      .map((_, idx) => idx)
      .sort((a, b) => predRank[a] - predRank[b] || states[a].frame - states[b].frame);
    order.forEach((stateIdx, rank) => {
      states[stateIdx].rank = rank;
    });
    layers.push(states);
  }

  // 末层取（累计误差, 字典序名次）最优，回溯全部帧号
  const last = layers[layers.length - 1];
  let bestIdx = 0;
  for (let i = 1; i < last.length; i += 1) {
    const s = last[i];
    const b = last[bestIdx];
    if (s.err < b.err || (s.err === b.err && s.rank < b.rank)) bestIdx = i;
  }
  const frames = new Array<number>(2 * n);
  let cursor = bestIdx;
  for (let i = 2 * n - 1; i >= 0; i -= 1) {
    const st = layers[i][cursor];
    frames[i] = st.frame;
    cursor = st.pred;
  }

  const results: FrameGridCueResult[] = sorted.map((cue, k) => {
    const startFrame = frames[2 * k];
    const endFrame = frames[2 * k + 1];
    return {
      cueId: cue.id,
      index: k + 1,
      oldStartMs: Math.round(cue.start * 1000),
      oldEndMs: Math.round(cue.end * 1000),
      startFrame,
      endFrame,
      newStartMs: frameToMs(startFrame, rate),
      newEndMs: frameToMs(endFrame, rate)
    };
  });

  return {
    rate,
    feasible: true,
    results,
    totalErrorMs: last[bestIdx].err / rate.num,
    failure: null
  };
}

/**
 * 构造无解报告：按时间序首个无法接续的边界。
 * 最优可达性由「上一边界最小可达帧号 gMin」与「本边界最大候选帧号 fMax」决定
 * （帧时间随帧号严格递增），据此给出最大可达间隔 / 时长与约束的差距。
 */
function buildFailure(
  sorted: Cue[],
  cueIdx: number,
  isStart: boolean,
  cands: number[],
  prev: DpState[] | null,
  minDurMs: number,
  minGapMs: number,
  rate: FrameRate
): FrameGridFailure {
  const cue = sorted[cueIdx];
  const base = {
    cueId: cue.id,
    cueIndex: cueIdx + 1,
    edge: isStart ? ('start' as const) : ('end' as const)
  };
  if (!prev || cands.length === 0) {
    return { ...base, message: '没有不早于 0 的候选帧' };
  }
  let gMin = Number.POSITIVE_INFINITY;
  for (const p of prev) gMin = Math.min(gMin, p.frame);
  const fMax = cands[cands.length - 1]; // 候选升序
  if (isStart) {
    const bestGap = frameToMs(fMax, rate) - frameToMs(gMin, rate);
    return {
      ...base,
      message: `与第 ${cueIdx} 条终点的间隔最大只能达到 ${bestGap}ms，小于最小间隔 ${minGapMs}ms`
    };
  }
  if (fMax < gMin + 1) {
    return { ...base, message: `候选终点帧与起点帧（最早第 ${gMin} 帧）相隔不足 1 帧` };
  }
  const bestDur = frameToMs(fMax, rate) - frameToMs(gMin, rate);
  return {
    ...base,
    message: `时长最大只能达到 ${bestDur}ms，小于最短时长 ${minDurMs}ms`
  };
}

/**
 * 把可行方案映射为完整字幕数组（新数组，原字幕对象与撤销历史不变）；
 * 方案无解时返回 null。
 */
export function applyFrameGrid(cues: Cue[], plan: FrameGridPlan): Cue[] | null {
  if (!plan.feasible) return null;
  const byId = new Map(plan.results.map((r) => [r.cueId, r]));
  return cues.map((c) => {
    const r = byId.get(c.id);
    if (!r) return c;
    return { ...c, start: r.newStartMs / 1000, end: r.newEndMs / 1000 };
  });
}
