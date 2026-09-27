import { parseSrt, serializeSrt, secondsToSrtTime, srtTimeToSeconds } from '../src/lib/srt';
import { validateEdge, applyEdge, initHistory, commitHistory, undoHistory, redoHistory } from '../src/lib/cues';
import {
  analyzeChannels,
  computeWindowLevels,
  detectSilences,
  MERGE_GAP,
  MIN_SILENCE_DURATION,
  nearestSilenceEdge,
  resolveEdgeCandidate,
  SNAP_RADIUS,
  WINDOW_SIZE
} from '../src/lib/silence';
import {
  computeLoopRange,
  DEFAULT_LOOP_MARGINS,
  loopDisableReason,
  loopDisableText,
  loopEntryTarget,
  loopWrapTarget,
  MIN_LOOP_LENGTH
} from '../src/lib/abLoop';
import {
  SHADOW_DRIFT_LIMIT,
  clampRelative,
  describeGetUserMediaError,
  hasRecordingSupport,
  needsDriftCorrection,
  pickRecorderMimeType,
  trackDrift
} from '../src/lib/shadow';
import {
  buildDriftPlan,
  parseTimeInput,
  resolveDriftRange,
  secondsToInputTime
} from '../src/lib/drift';
import { sha256Bytes } from '../src/lib/sha256';
import {
  matchAudioFingerprint,
  SESSION_SCHEMA_VERSION,
  validateSession
} from '../src/lib/session';
import {
  buildRefDiff,
  MAX_PAIR_CELLS,
  normalizeCueText,
  pairDeviated,
  refItemKey,
  summarizeRefDiff
} from '../src/lib/refdiff';
import {
  buildReadingSpeed,
  countGraphemes,
  planReadingSpeedFix,
  readingChars
} from '../src/lib/readingSpeed';
import {
  computeActivityGaps,
  detectActivitySegments,
  mergeCueIntervals,
  subtractCueIntervals
} from '../src/lib/activityGaps';
import {
  applyFrameGrid,
  frameCandidates,
  frameRateById,
  frameToMs,
  FRAME_RATES,
  nearestFrame,
  planFrameGrid
} from '../src/lib/frameGrid';

let fail = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.error('❌', msg);
  } else {
    console.log('✅', msg);
  }
}

// 1. 时间格式往返
assert(secondsToSrtTime(0) === '00:00:00,000', '0 序列化');
assert(secondsToSrtTime(3661.5) === '01:01:01,500', '3661.5 序列化');
assert(srtTimeToSeconds('00:00:01,500') === 1.5, '逗号毫秒解析');
assert(srtTimeToSeconds('00:00:01.5') === 1.5, '点毫秒解析（容错）');

// 2. 解析含 BOM / CRLF / 缺序号的 SRT
const srt = '﻿1\r\n00:00:01,000 --> 00:00:03,000\r\n你好\r\n\r\n' +
  '00:00:04.000 --> 00:00:06,500\r\n第二行\r\n第二行续\r\n\r\n' +
  'bad block\r\n\r\n' +
  '3\r\n00:00:10,000 --> 00:00:09,000\r\n逆序应跳过\r\n';
const { cues, warnings } = parseSrt(srt);
assert(cues.length === 2, `解析出 2 条（实际 ${cues.length}）`);
assert(warnings.length === 2, `产生 2 条告警（实际 ${warnings.length}）`);
assert(cues[0].text === '你好', '第一条文本');
assert(cues[1].start === 4 && cues[1].end === 6.5, '点分隔第二块');

// 3. 导出保持时间顺序且重新连续编号
cues[0].start = 100; // 打乱顺序后导出
const out = serializeSrt(cues);
const nums = [...out.matchAll(/^(\d+)$/gm)].map((m) => Number(m[1]));
assert(JSON.stringify(nums) === '[1,2]', `导出编号连续 1,2（实际 ${JSON.stringify(nums)}）`);
assert(out.startsWith('1\n00:00:04,000'), '导出按时间升序，最早者编号 1');

// 4. 约束校验
const C = { minDuration: 0.5, minGap: 0.1 };
let r = validateEdge(cues, cues[0].id, 'start', -1, C);
assert(!r.ok && r.message.includes('00:00'), '左边界越过 0 被拒绝');
const base = [
  { id: 'a', start: 1, end: 2, text: 'a' },
  { id: 'b', start: 3, end: 4, text: 'b' }
];
r = validateEdge(base, 'a', 'end', 2.95, C);
assert(!r.ok && r.message.includes('间隔'), `间隔 0.05 < 0.1 被拒绝：${r.ok ? '' : r.message}`);
r = validateEdge(base, 'a', 'end', 3.2, C);
assert(!r.ok && r.message.includes('重叠'), `重叠被拒绝：${r.ok ? '' : r.message}`);
r = validateEdge(base, 'a', 'end', 1.4, C);
assert(!r.ok && r.message.includes('短于最短时长'), '时长不足被拒绝');
r = validateEdge(base, 'a', 'end', 2.9, C);
assert(r.ok, '间隔恰好 0.1 合法');
r = validateEdge(base, 'b', 'start', 2.1, C);
assert(r.ok, '右块左边界贴到 2.1 合法');
r = validateEdge(base, 'b', 'start', 2.05, C);
assert(!r.ok, '右块左边界间隔不足被拒绝');

// 5. 应用变更 & 撤销重做
let h = initHistory(base);
const next = applyEdge(base, 'a', 'end', 2.5);
h = commitHistory(h, next);
assert(h.present[0].end === 2.5 && h.past.length === 1, '提交边界调整');
h = undoHistory(h);
assert(h.present[0].end === 2 && h.future.length === 1, '撤销恢复');
h = redoHistory(h);
assert(h.present[0].end === 2.5, '重做再次应用');
h = commitHistory(h, applyEdge(h.present, 'a', 'end', 2.8));
assert(h.future.length === 0, '新提交清空 redo 栈');

// 6. 静音检测：窗口 RMS（各声道取最大）
function tone(samples: number, v: number): Float32Array {
  return new Float32Array(samples).fill(v);
}
// 1s 单声道：0~0.3s 有声(0.5)，0.3~0.6s 静音，0.6~1.0s 有声(0.3)
{
  const sr = 1000;
  const ch = new Float32Array(sr);
  ch.fill(0.3, 0, sr);
  ch.fill(0.5, 0, 300);
  ch.fill(0, 300, 600);
  const win = computeWindowLevels([ch], sr);
  assert(win.windowSize === WINDOW_SIZE, `窗口为 ${WINDOW_SIZE}s`);
  assert(win.levels.length === 50, `1s / 20ms = 50 窗口（实际 ${win.levels.length}）`);
  assert(win.levels[0] === 0.5, '有声窗口 RMS=0.5');
  assert(win.levels[20] === 0, '静音窗口 RMS=0');
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 1, `检测出 1 段静音（实际 ${segs.length}）`);
  assert(segs[0].start === 0.3 && segs[0].end === 0.6, `静音段 0.3~0.6（实际 ${segs[0].start}~${segs[0].end}）`);
}

// 7. 各声道取最大值：一声道静音、另一声道有声 => 窗口不判静音
{
  const sr = 1000;
  const silent = new Float32Array(sr); // 全 0
  const loud = new Float32Array(sr).fill(0.2);
  const win = computeWindowLevels([silent, loud], sr);
  assert(Math.abs(win.levels[10] - 0.2) < 1e-6, '双声道取 RMS 最大值 0.2');
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 0, '任一非静音声道则整窗口非静音');
}

// 8. 短于 200ms 的静音不成段；恰好 200ms 合法
{
  const sr = 1000;
  const ch = new Float32Array(sr).fill(0.2);
  ch.fill(0, 100, 250); // 150ms 静音
  ch.fill(0, 400, 600); // 200ms 静音
  const win = computeWindowLevels([ch], sr);
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 1, `仅 200ms 段保留（实际 ${segs.length} 段）`);
  assert(segs[0].start === 0.4 && segs[0].end === 0.6, `保留 0.4~0.6 段（实际 ${segs[0].start}~${segs[0].end}）`);
  assert(MIN_SILENCE_DURATION === 0.2, '最短静音默认 200ms');
}

// 9. 间隔不足 80ms 的两段先合并；恰好 80ms 不合并
{
  const sr = 1000;
  const ch = new Float32Array(sr).fill(0.2);
  ch.fill(0, 0, 200); // 200ms
  ch.fill(0, 260, 460); // 间隔 60ms，应合并
  ch.fill(0, 540, 740); // 与上段间隔恰好 80ms，不合并
  const win = computeWindowLevels([ch], sr);
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 2, `合并后 2 段（实际 ${segs.length}）`);
  assert(segs[0].start === 0 && segs[0].end === 0.46, `60ms 间隔被合并为 0~0.46（实际 0~${segs[0].end}）`);
  assert(segs[1].start === 0.54 && segs[1].end === 0.74, '80ms 间隔不合并');
  assert(MERGE_GAP === 0.08, '合并间隔默认 80ms');
}

// 10. 阈值严格小于判定：RMS 恰好等于阈值不算静音
{
  const sr = 1000;
  const ch = new Float32Array(sr).fill(0.01);
  const win = computeWindowLevels([ch], sr);
  assert(detectSilences(win, { threshold: 0.01 }).length === 0, 'RMS 等于阈值不判静音');
  const ch2 = new Float32Array(sr).fill(0.009);
  const win2 = computeWindowLevels([ch2], sr);
  assert(detectSilences(win2, { threshold: 0.01 }).length === 1, 'RMS 低于阈值判静音');
}

// 11. analyzeChannels 端到端 + 可调阈值重新分段
{
  const sr = 1000;
  const ch = new Float32Array(sr);
  ch.fill(0.05, 0, 400);
  ch.fill(0, 400, 800);
  ch.fill(0.05, 800, 1000);
  const low = analyzeChannels([ch], sr, { threshold: 0.01 });
  assert(low.segments.length === 1 && low.segments[0].start === 0.4, '低阈值：只检出真静音');
  const high = detectSilences(low, { threshold: 0.06 });
  // 首尾 0.05 弱信号段（0~0.4 与 0.8~1.0）也低于阈值，与真静音合并为整段
  assert(high.length === 1 && high[0].start === 0 && high[0].end === 1, `调高阈值：弱信号段也算静音并合并（实际 ${high[0]?.start}~${high[0]?.end}）`);
}

// 12. 最近静音边缘：150ms 半径、等距取更早者
const sil = [
  { start: 1.0, end: 2.0 },
  { start: 3.0, end: 4.0 }
];
assert(SNAP_RADIUS === 0.15, '吸附半径默认 150ms');
let e = nearestSilenceEdge(sil, 1.1);
assert(e?.time === 1.0, '靠近 1.0 起点吸附');
e = nearestSilenceEdge(sil, 1.9);
assert(e?.time === 2.0 && e.side === 'end', '靠近 2.0 终点吸附');
e = nearestSilenceEdge(sil, 2.5);
assert(e === null, '超出 150ms 无吸附');
e = nearestSilenceEdge(sil, 1.15);
assert(e === null, '恰好 150ms 边界外不吸附（严格小于半径）');
// 相邻两段 [1,2]、[3,4]：2.5 距两个边缘都是 0.5，取更早者 2.0
e = nearestSilenceEdge(sil, 2.5, 0.6);
assert(e?.time === 2.0, '等距时取更早边缘（2.0 而非 3.0）');

// 13. resolveEdgeCandidate：吸附合法 / 吸附不合法回退 / 开关关闭
const dragCues = [
  { id: 'a', start: 0.2, end: 1.0, text: 'a' },
  { id: 'b', start: 2.3, end: 3.0, text: 'b' }
];
const DC = { minDuration: 0.5, minGap: 0.1 };
// 右边界拖到 1.91（距 2.0 终点 90ms），吸附到 2.0：与 b(2.3) 间隔 0.3 合法
let rr = resolveEdgeCandidate(dragCues, 'a', 'end', 1.91, DC, sil, true);
assert(rr.snapped && rr.time === 2.0 && rr.valid, `吸附到合法静音边缘 2.0（snapped=${rr.snapped}）`);
// 吸附点违反最短时长：a 时长要求 1.0s；从 0.91 吸附到 1.0 时时长恰 0.8s
// 改用 minDuration 0.95 且原始候选 0.91（时长 0.71，本身也非法，验证回退原因）
const DC2 = { minDuration: 0.95, minGap: 0.1 };
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 0.91, DC2, sil, true);
assert(!rr.snapped && rr.time === 0.91 && !!rr.snapRejected, '吸附点违反最短时长 -> 回退未吸附候选并带原因');
assert(rr.snapRejected?.includes('短于最短时长'), `回退原因指明时长：${rr.snapRejected ?? ''}`);
assert(rr.valid === false, '回退后的候选（时长 0.71<0.95）本身仍非法');
// 吸附点合法但另一约束不合法时不影响：吸附到 1.0 在 DC 下时长 0.8、与邻居无冲突
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 0.91, DC, sil, true);
assert(rr.snapped && rr.time === 1.0 && rr.valid, '吸附到 1.0（时长 0.8 ≥ 0.5）合法');
// 吸附点违反最小间隔：拖 a 右边界到 2.91 附近，吸附到 3.0 会与 b 重叠
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 2.91, DC, sil, true);
assert(!rr.snapped && (rr.snapRejected?.includes('重叠') || rr.snapRejected?.includes('间隔')), `吸附点重叠/间隔不足回退：${rr.snapRejected ?? ''}`);
// 回退后未吸附候选仍合法的情形：静音段 [1.5,2.16] 终点 2.16 距 b(2.3) 仅 0.14
// （间隔不足 0.1 否……改为段终点 2.25）；拖动 a 右边界到 2.12（合法，间隔 0.18），
// 距 2.25 为 0.13 会吸附，但 2.25 与 b 间隔仅 0.05 -> 吸附非法，回退保留 2.12
const sil2 = [{ start: 1.5, end: 2.25 }];
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 2.12, DC, sil2, true);
assert(!rr.snapped && rr.time === 2.12 && rr.valid && !!rr.snapRejected, '吸附非法但原候选合法：回退保留 2.12 并提示');
assert(rr.snapRejected?.includes('间隔'), `回退原因为间隔不足：${rr.snapRejected ?? ''}`);
// 开关关闭：即使在半径内也不吸附
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 1.91, DC, sil, false);
assert(!rr.snapped && rr.time === 1.91, '吸附关闭时保留原始候选');
// 原始候选非法但吸附点合法：短块 b(2.3~2.6) 左边界拖到 2.14（时长 0.46 不足），
// 距静音边缘 2.0 为 0.14，吸附后时长 0.6 合法
const dragCues2 = [
  { id: 'a', start: 0.2, end: 1.0, text: 'a' },
  { id: 'b', start: 2.3, end: 2.6, text: 'b' }
];
rr = resolveEdgeCandidate(dragCues2, 'b', 'start', 2.14, DC, sil, true);
assert(rr.snapped && rr.time === 2.0 && rr.valid, '原候选时长不足但吸附到 2.0 合法');

// 14. A-B 循环：区间计算（余量、裁剪、空区间）
{
  const cue = { start: 2, end: 4 };
  let lr = computeLoopRange(cue, { pre: 0.5, post: 0.25 }, 10);
  assert(lr?.a === 1.5 && lr?.b === 4.25, `循环区间加余量（实际 ${lr?.a}~${lr?.b}）`);
  lr = computeLoopRange({ start: 0.2, end: 1 }, { pre: 0.5, post: 0 }, 10);
  assert(lr?.a === 0, 'A 点不越过 0s');
  lr = computeLoopRange({ start: 8, end: 9.8 }, { pre: 0, post: 0.5 }, 10);
  assert(lr?.b === 10, 'B 点裁剪到音频时长');
  lr = computeLoopRange({ start: 12, end: 13 }, { pre: 0.3, post: 0.3 }, 10);
  assert(lr === null, '区间整体超出音频时长 -> 空');
  lr = computeLoopRange({ start: 9.98, end: 10.5 }, { pre: 0, post: 0 }, 10);
  assert(lr === null, `裁剪后不足 ${MIN_LOOP_LENGTH}s -> 空`);
  lr = computeLoopRange(null, { pre: 0.3, post: 0.3 }, 10);
  assert(lr === null, '无选中字幕 -> 无区间');
  lr = computeLoopRange(cue, { pre: -1, post: -1 }, 10);
  assert(lr?.a === 2 && lr?.b === 4, '负余量按 0 处理');
  lr = computeLoopRange({ start: 8, end: 9 }, { pre: 0, post: 0.5 }, 0);
  assert(lr?.b === 9.5, '时长未知（0）时不裁剪 B');
  assert(DEFAULT_LOOP_MARGINS.pre >= 0 && DEFAULT_LOOP_MARGINS.post >= 0, '默认余量非负');
}

// 15. A-B 循环：禁用原因优先级与文案
{
  const cue = { start: 2, end: 4 };
  const range = { a: 1.5, b: 4.25 };
  assert(loopDisableReason(false, cue, range) === 'no-audio', '无音频禁用');
  assert(loopDisableReason(true, null, null) === 'no-selection', '未选字幕禁用');
  assert(loopDisableReason(true, cue, null) === 'empty-range', '区间为空禁用');
  assert(loopDisableReason(true, cue, range) === null, '条件满足可开启');
  assert(loopDisableReason(false, null, null) === 'no-audio', '无音频优先于未选字幕');
  assert(loopDisableText('empty-range').includes('裁剪'), '空区间原因说明裁剪');
}

// 16. A-B 循环：播放状态转换（越过 B 回 A / 进入新区间校正）
{
  const range = { a: 1, b: 4 };
  assert(loopWrapTarget(3.9, range) === null, '未越过 B 不干预');
  assert(loopWrapTarget(4, range) === 1, '恰好到 B 回 A');
  assert(loopWrapTarget(4.2, range) === 1, '越过 B 回 A');
  assert(loopWrapTarget(5, null) === null, '无区间不干预');
  assert(loopEntryTarget(0.5, range) === 1, '落在新区间之前 -> 跳到新 A');
  assert(loopEntryTarget(5, range) === 1, '落在新区间之后 -> 跳到新 A');
  assert(loopEntryTarget(2, range) === null, '区间内不动播放头');
  assert(loopEntryTarget(1, range) === null, '恰在 A 不动');
  assert(loopEntryTarget(4, range) === null, '恰在 B 不动（播放推进由回卷处理）');
  assert(loopEntryTarget(0.5, null) === null, '无区间不校正');
}

// 17. 单句跟读：能力检测、时钟偏差与纠偏阈值
{
  assert(!hasRecordingSupport(undefined, undefined), '无 mediaDevices / MediaRecorder -> 不支持');
  assert(
    !hasRecordingSupport({ getUserMedia: 1 }, function MediaRecorder() {}),
    'getUserMedia 非函数 -> 不支持'
  );
  assert(
    hasRecordingSupport({ getUserMedia: () => undefined }, function MediaRecorder() {}),
    '两者皆为函数 -> 支持录音'
  );
  assert(SHADOW_DRIFT_LIMIT === 0.08, '偏差阈值 80ms');

  assert(Math.abs(trackDrift(1, 0.9) - 0.1) < 1e-9, '录音滞后 100ms -> 偏差 +0.1');
  assert(Math.abs(trackDrift(0.9, 1) - -0.1) < 1e-9, '录音超前 100ms -> 偏差 -0.1');
  assert(!needsDriftCorrection(0.08), '恰好 80ms 不纠偏（严格大于）');
  assert(needsDriftCorrection(0.081), '超过 80ms 触发纠偏');
  assert(needsDriftCorrection(-0.09), '超前超过 80ms 同样纠偏');
  assert(!needsDriftCorrection(0.02), '20ms 不干预');

  assert(clampRelative(-1, 2) === 0, '相对时间负值夹到 0');
  assert(clampRelative(3, 2) === 2, '相对时间超出时长夹到时长');
  assert(clampRelative(1.5, 2) === 1.5, '区间内保持');
  assert(clampRelative(NaN, 2) === 0, 'NaN 按 0 处理');
  assert(clampRelative(1, NaN) === 0, '时长非法按 0 处理');
}

// 18. 单句跟读：MIME 选择与权限错误归类
{
  const supported = new Set(['audio/webm']);
  const isOk = (m: string) => supported.has(m);
  assert(pickRecorderMimeType(isOk) === 'audio/webm', 'webm 受支持时选中');
  assert(pickRecorderMimeType(() => false) === '', '全部不支持 -> 空串（用默认容器）');
  const safari = new Set(['audio/mp4']);
  assert(pickRecorderMimeType((m) => safari.has(m)) === 'audio/mp4', 'Safari 退回 mp4');
  // 抛异常的 isTypeSupported 不应击穿选择流程
  assert(
    pickRecorderMimeType((m) => {
      if (m === 'audio/webm') throw new Error('boom');
      return false;
    }) === '',
    'isTypeSupported 抛错时安全降级为空串'
  );

  const denied = describeGetUserMediaError(new DOMException('denied', 'NotAllowedError'));
  assert(denied.kind === 'permission' && denied.recoverable, '权限拒绝 -> 可恢复提示');
  const noDev = describeGetUserMediaError(new DOMException('x', 'NotFoundError'));
  assert(noDev.kind === 'device' && noDev.recoverable, '无设备 -> 可恢复提示');
  const unknown = describeGetUserMediaError(new Error('weird'));
  assert(unknown.kind === 'unknown' && unknown.text.includes('weird'), '未知错误保留原文案');
}

// 19. 区间漂移：目标时间输入解析与格式化
{
  assert(parseTimeInput('83.5') === 83.5, '纯秒数解析');
  assert(parseTimeInput('1:23.5') === 83.5, 'mm:ss.mmm 解析');
  assert(parseTimeInput('01:02:03,500') === 3723.5, 'hh:mm:ss,ms 解析');
  assert(parseTimeInput('00:01') === 1, 'mm:ss 解析');
  assert(parseTimeInput('abc') === null, '非法输入返回 null');
  assert(parseTimeInput('') === null, '空输入返回 null');
  assert(parseTimeInput('-5') === -5, '负值可解析（由映射校验拦截）');
  assert(secondsToInputTime(83.5) === '01:23.500', '输入默认值格式化');
  assert(secondsToInputTime(3723.5) === '1:02:03.500', '满 1 小时带小时位');
  assert(parseTimeInput(secondsToInputTime(3723.5)) === 3723.5, '格式化往返一致');
}

// 20. 区间漂移：连续区间解析
const driftCues = [
  { id: 'a', start: 1, end: 2, text: 'a' },
  { id: 'b', start: 3, end: 4, text: 'b' },
  { id: 'c', start: 5, end: 6, text: 'c' },
  { id: 'd', start: 7, end: 8, text: 'd' }
];
{
  assert(resolveDriftRange(driftCues, 'b', 'd').map((c) => c.id).join('') === 'bcd', '区间 b→d 连续');
  assert(resolveDriftRange(driftCues, 'd', 'b').map((c) => c.id).join('') === 'bcd', '反向锚点同样取连续区间');
  assert(resolveDriftRange(driftCues, 'b', 'b').length === 1, '单条区间');
  assert(resolveDriftRange(driftCues, 'x', 'b').length === 0, '锚点失效返回空');
}

// 21. 区间漂移：线性映射、约束校验与首个冲突定位
{
  const DC3 = { minDuration: 0.5, minGap: 0.1 };

  // 恒等映射：合法且缩放为 1
  let plan = buildDriftPlan(driftCues, 'b', 'c', 3, 6, DC3);
  assert(plan !== null && plan.conflict === null && plan.scale === 1, '恒等映射合法且缩放为 1');

  // 整体平移 -0.5：合法；区间外字幕保持原引用
  plan = buildDriftPlan(driftCues, 'b', 'c', 2.5, 5.5, DC3);
  assert(plan?.conflict === null, '整体平移 -0.5 合法');
  assert(plan?.mappedAll[1].start === 2.5 && plan?.mappedAll[2].end === 5.5, '平移映射值正确');
  assert(plan?.mappedAll[0] === driftCues[0] && plan?.mappedAll[3] === driftCues[3], '区间外字幕保持原引用');

  // 平移 +1：c.end=7 与 d.start=7 间隔 0 < 0.1，定位区间内末条 c
  plan = buildDriftPlan(driftCues, 'b', 'c', 4, 7, DC3);
  assert(
    plan?.conflict?.kind === 'min-gap' && plan.conflict.cueId === 'c',
    `与区间外下一条间隔不足，定位末条（实际 ${plan?.conflict?.cueId}）`
  );

  // 压缩到恰好最短时长（0.5）与足够间隔：合法（边界值不误判）
  plan = buildDriftPlan(driftCues, 'b', 'c', 3, 4.5, DC3);
  assert(plan?.conflict === null && plan?.scale === 0.5, '压缩到恰好最短时长仍合法');
  assert(plan?.mappedAll[1].end === 3.5 && plan?.mappedAll[2].start === 4, '压缩映射值正确');

  // 过度压缩：b 时长 0.2 < 0.5，定位首条
  plan = buildDriftPlan(driftCues, 'b', 'c', 3, 3.6, DC3);
  assert(
    plan?.conflict?.kind === 'min-duration' && plan.conflict.cueId === 'b',
    '过度压缩触发最短时长冲突并定位首条'
  );

  // 目标锚点倒序 / 零长度
  plan = buildDriftPlan(driftCues, 'b', 'c', 6, 3, DC3);
  assert(plan?.conflict?.kind === 'anchors-reversed', '目标锚点倒序被拒绝');
  plan = buildDriftPlan(driftCues, 'b', 'c', 3, 3, DC3);
  assert(plan?.conflict?.kind === 'anchors-reversed', '目标锚点相等（零长度）按倒序拒绝');

  // 负目标锚点
  plan = buildDriftPlan(driftCues, 'b', 'c', -1, 2, DC3);
  assert(plan?.conflict?.kind === 'invalid-anchor', '负目标锚点被拒绝');

  // 与区间外上一条重叠：定位首条 b
  plan = buildDriftPlan(driftCues, 'b', 'c', 1.95, 4.95, DC3);
  assert(
    plan?.conflict?.kind === 'min-gap' && plan.conflict.cueId === 'b' && plan.conflict.message.includes('重叠'),
    `与上一条重叠，定位首条（实际 ${plan?.conflict?.cueId}）`
  );

  // 与上一条间隔恰好等于最小间隔：合法
  plan = buildDriftPlan(driftCues, 'b', 'c', 2.1, 5.1, DC3);
  assert(plan?.conflict === null, '间隔恰好等于最小间隔合法');

  // 区间内相邻间隔不足（时长仍合法）：定位后条 c
  const wide = [
    { id: 'a', start: 0.5, end: 1, text: 'a' },
    { id: 'b', start: 2, end: 6, text: 'b' },
    { id: 'c', start: 6.5, end: 10.5, text: 'c' },
    { id: 'd', start: 11, end: 12, text: 'd' }
  ];
  plan = buildDriftPlan(wide, 'b', 'c', 2, 3.275, DC3);
  assert(
    plan?.conflict?.kind === 'min-gap' && plan.conflict.cueId === 'c',
    `区间内相邻间隔不足，定位后条（实际 ${plan?.conflict?.cueId}）`
  );

  // 映射结果四舍五入到毫秒
  plan = buildDriftPlan(driftCues, 'b', 'b', 2.5004, 3.5004, DC3);
  assert(plan?.mappedAll[1].start === 2.5 && plan?.conflict === null, '映射值取整到毫秒');

  // 合法结果作为一次历史记录提交：整体撤销 / 重做，并可由现有 SRT 导出
  const okPlan = buildDriftPlan(driftCues, 'b', 'c', 2.5, 5.5, DC3);
  assert(okPlan !== null && okPlan.conflict === null, '漂移计划可提交');
  let h3 = initHistory(driftCues);
  h3 = commitHistory(h3, okPlan!.mappedAll);
  assert(h3.present[1].start === 2.5 && h3.past.length === 1, '漂移结果作为一次历史提交');
  h3 = undoHistory(h3);
  assert(h3.present[1].start === 3, '撤销整体还原区间');
  h3 = redoHistory(h3);
  assert(h3.present[1].start === 2.5, '重做恢复漂移结果');
  assert(
    serializeSrt(h3.present).includes('00:00:02,500 --> 00:00:03,500'),
    '漂移结果可由现有 SRT 导出'
  );
}

/* ---------------- 会话恢复：SHA-256 / 指纹 / 快照校验 ---------------- */

// 空串与 "abc" 的标准 SHA-256 向量
assert(
  sha256Bytes(new TextEncoder().encode('')) ===
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'SHA-256 空向量'
);
assert(
  sha256Bytes(new TextEncoder().encode('abc')) ===
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'SHA-256 "abc" 向量'
);
// 覆盖多块（>64 字节）与长度恰好跨过块边界的填充
assert(
  sha256Bytes(new TextEncoder().encode('a'.repeat(55))).length === 64,
  'SHA-256 55 字节（跨块填充）输出长度 64'
);
assert(
  sha256Bytes(new TextEncoder().encode('a'.repeat(200))) ===
    sha256Bytes(new TextEncoder().encode('a'.repeat(200))),
  'SHA-256 长输入确定性'
);

// 指纹匹配以大小 + 哈希为准，文件名可不同
const fp = { name: 'a.wav', size: 100, sha256: 'a'.repeat(64) };
assert(matchAudioFingerprint(fp, { name: 'a.wav', size: 100, sha256: 'a'.repeat(64) }).matched, '同名同指纹匹配');
const renamed = matchAudioFingerprint(fp, { name: 'b.wav', size: 100, sha256: 'a'.repeat(64) });
assert(renamed.matched && renamed.nameMismatch, '仅文件名不同仍匹配但标记 nameMismatch');
assert(!matchAudioFingerprint(fp, { name: 'a.wav', size: 99, sha256: 'a'.repeat(64) }).matched, '大小不同拒绝');
assert(!matchAudioFingerprint(fp, { name: 'a.wav', size: 100, sha256: 'b'.repeat(64) }).matched, '哈希不同拒绝');

// 构造一份合法会话
function makeValidSession(over: Record<string, unknown> = {}): Record<string, unknown> {
  const cue = (id: string, s: number, e: number) => ({ id, start: s, end: e, text: id });
  return {
    id: 's1',
    schemaVersion: SESSION_SCHEMA_VERSION,
    revision: 3,
    createdAt: 1000,
    updatedAt: 2000,
    srtName: 'x.srt',
    snapshot: {
      past: [[cue('a', 0, 1), cue('b', 2, 3)]],
      present: [cue('a', 0, 1.5), cue('b', 2, 3)],
      future: []
    },
    view: {
      constraints: { minDuration: 0.5, minGap: 0.08 },
      pps: 80,
      snapEnabled: true,
      silenceThresholdDb: -40,
      loopEnabled: false,
      loopMargins: { pre: 0.3, post: 0.3 },
      selectedId: 'a'
    },
    audio: { name: 'a.wav', size: 100, sha256: 'a'.repeat(64) },
    ...over
  };
}

assert(validateSession(makeValidSession()).ok, '合法会话校验通过');
assert(
  validateSession(makeValidSession({ schemaVersion: 99 })).ok === false,
  '结构版本不匹配拒绝（失败不得改动工作区）'
);
assert(
  validateSession(makeValidSession({ revision: -2 })).ok === false,
  'revision 非非负整数拒绝'
);
assert(
  validateSession(makeValidSession({ updatedAt: 500 })).ok === false,
  'updatedAt 早于 createdAt 拒绝'
);
const badStack = makeValidSession();
(badStack.snapshot as Record<string, unknown>).past = [
  [{ id: 'a', start: 0, end: 1, text: 'a' }] // 缺少 b，且只有一帧——id 集合与 present 不一致
];
assert(validateSession(badStack).ok === false, '撤销栈字幕集合与当前不一致拒绝');
const badAudio = makeValidSession({ audio: { name: 'a.wav', size: 1, sha256: 'zzz' } });
assert(validateSession(badAudio).ok === false, '音频指纹格式损坏拒绝');
const badView = makeValidSession();
badView.view = { ...(badView.view as object), pps: 99999 };
assert(validateSession(badView).ok === false, '视图设置越界拒绝');
const badSelected = makeValidSession();
badSelected.view = { ...(badSelected.view as object), selectedId: 'ghost' };
assert(validateSession(badSelected).ok === false, '选中字幕不属于会话拒绝');
const nullAudio = makeValidSession({ audio: null });
assert(validateSession(nullAudio).ok, '无音频指纹的会话合法');

/* ---------------- 参考字幕差异审阅：单调配对 ---------------- */

// 22. 文本归一化：NFKC + 去空白与标点
{
  assert(normalizeCueText('你好， 世界！') === '你好世界', '去标点与空白');
  assert(normalizeCueText('  Hello,\nWorld! ') === 'HelloWorld', '多行空白与标点');
  assert(normalizeCueText('ＡＢＣ．１２３') === 'ABC123', 'NFKC 折叠全角字符');
  assert(normalizeCueText('…') === '', '纯标点归一化为空串');
}

// 23. 重复台词：最大化配对数，再最小化起点时间差总和
{
  // 当前 A@0 B@10 A@20；参考 A@5 A@15 B@25
  const cur = [
    { id: 'c1', start: 0, end: 1, text: 'A' },
    { id: 'c2', start: 10, end: 11, text: 'B' },
    { id: 'c3', start: 20, end: 21, text: 'A' }
  ];
  const ref = [
    { id: 'r1', start: 5, end: 6, text: 'A' },
    { id: 'r2', start: 15, end: 16, text: 'A' },
    { id: 'r3', start: 25, end: 26, text: 'B' }
  ];
  const diff = buildRefDiff(cur, ref)!;
  // LCS 长度 2；候选方案：(c1↔r1,c2↔r3) 代价 5+15=20，(c1↔r1,c3↔r2) 代价 5+5=10
  assert(diff.pairs.length === 2, `最大化配对数 2（实际 ${diff.pairs.length}）`);
  assert(
    diff.pairs[0].current.id === 'c1' && diff.pairs[0].reference.id === 'r1',
    '首对 c1↔r1'
  );
  assert(
    diff.pairs[1].current.id === 'c3' && diff.pairs[1].reference.id === 'r2',
    '次对 c3↔r2：在并列配对数中取起点差总和最小'
  );
  assert(diff.currentOnly.map((c) => c.id).join('') === 'c2', '当前独有 c2');
  assert(diff.referenceOnly.map((c) => c.id).join('') === 'r3', '参考独有 r3');
}

// 24. 单侧插入不造成后续错位；去空白标点后文本相同即可配对
{
  const cur = [
    { id: 'c1', start: 0, end: 1, text: '你好，世界' },
    { id: 'c2', start: 2, end: 3, text: '单侧插入的一句' },
    { id: 'c3', start: 4, end: 5, text: '再见！' }
  ];
  const ref = [
    { id: 'r1', start: 0.2, end: 1.2, text: '你好 世界' },
    { id: 'r3', start: 4.4, end: 5.4, text: '再见。' }
  ];
  const diff = buildRefDiff(cur, ref)!;
  assert(diff.pairs.length === 2, `插入前后两句均配对（实际 ${diff.pairs.length}）`);
  assert(
    diff.pairs[0].current.id === 'c1' && diff.pairs[0].reference.id === 'r1',
    '首句：空白差异不影响配对'
  );
  assert(
    diff.pairs[1].current.id === 'c3' && diff.pairs[1].reference.id === 'r3',
    '插入句之后仍对齐正确条目：标点差异不影响配对'
  );
  assert(diff.currentOnly.length === 1 && diff.currentOnly[0].id === 'c2', '插入句为当前独有');
  assert(diff.referenceOnly.length === 0, '参考侧无独有');
}

// 25. 偏差阈值（严格大于、毫秒精度）与条目汇总
{
  const cur = [
    { id: 'c1', start: 1, end: 2, text: 'x' },
    { id: 'c2', start: 5, end: 6, text: 'y' },
    { id: 'c3', start: 9, end: 10, text: 'z' }
  ];
  const ref = [
    { id: 'r1', start: 1.4, end: 2.6, text: 'x' }, // Δ起 -0.4 / Δ终 -0.6
    { id: 'r2', start: 5.1, end: 6.1, text: 'y' }, // Δ -0.1
    { id: 'r4', start: 20, end: 21, text: 'w' }
  ];
  const diff = buildRefDiff(cur, ref)!;
  assert(diff.pairs.length === 2, 'x / y 两 对配对');
  const p1 = diff.pairs[0];
  assert(p1.startDelta < 0 && p1.endDelta < 0, '偏差带符号：当前早于参考为负');
  assert(pairDeviated(p1, 0.5), '终点偏差 0.6 > 0.5 超限');
  assert(!pairDeviated(p1, 0.6), '恰好 0.6 不算超过（严格大于）');
  assert(!pairDeviated(diff.pairs[1], 0.5), '0.1 偏差不超限');
  const stats = summarizeRefDiff(diff, 0.5);
  assert(stats.paired === 2 && stats.deviated === 1, `统计：2 对配对、1 对超限（实际 ${stats.paired}/${stats.deviated}）`);
  assert(stats.currentOnly === 1 && stats.referenceOnly === 1, '统计：两轨各 1 条独有');
  assert(stats.items.length === 3, '条目 = 1 超限 + 2 独有');
  assert(
    stats.items[0].kind === 'pair' &&
      stats.items[1].kind === 'current-only' &&
      stats.items[2].kind === 'reference-only',
    '条目按所在侧起点时间混排'
  );
  assert(refItemKey(stats.items[0]).startsWith('p:'), '配对条目 key 以 p: 开头');
  // 阈值放大后超限配对不再列出
  assert(summarizeRefDiff(diff, 1).deviated === 0, '阈值 1s 时无超限条目');
}

// 26. 随机样本：配对单调、文本键一致、两侧条目守恒
{
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const texts = ['A', 'B', 'C', 'D'];
  const mk = (prefix: string, count: number) => {
    const out: Array<{ id: string; start: number; end: number; text: string }> = [];
    let t = 0;
    for (let i = 0; i < count; i++) {
      t += rnd() * 2;
      out.push({ id: `${prefix}${i}`, start: t, end: t + 0.5, text: texts[Math.floor(rnd() * texts.length)] });
      t += 0.6;
    }
    return out;
  };
  const cur = mk('c', 60);
  const ref = mk('r', 55);
  const diff = buildRefDiff(cur, ref)!;
  const curOrder = new Map(
    [...cur].sort((a, b) => a.start - b.start || a.end - b.end).map((c, i) => [c.id, i])
  );
  const refOrder = new Map(
    [...ref].sort((a, b) => a.start - b.start || a.end - b.end).map((c, i) => [c.id, i])
  );
  let ok = true;
  for (let k = 1; k < diff.pairs.length; k++) {
    const p0 = diff.pairs[k - 1];
    const p1 = diff.pairs[k];
    if (!(curOrder.get(p0.current.id)! < curOrder.get(p1.current.id)!)) ok = false;
    if (!(refOrder.get(p0.reference.id)! < refOrder.get(p1.reference.id)!)) ok = false;
  }
  for (const p of diff.pairs) {
    if (normalizeCueText(p.current.text) !== normalizeCueText(p.reference.text)) ok = false;
  }
  assert(ok, '随机样本：配对在两轨各自严格单调，且比较键相同');
  assert(diff.pairs.length + diff.currentOnly.length === 60, '当前轨条目守恒');
  assert(diff.pairs.length + diff.referenceOnly.length === 55, '参考轨条目守恒');
}

// 27. 空轨与规模上限
{
  const one = [{ id: 'a', start: 0, end: 1, text: 'x' }];
  const emptyCur = buildRefDiff([], one)!;
  assert(emptyCur.pairs.length === 0 && emptyCur.referenceOnly.length === 1, '当前轨为空：全部为参考独有');
  const emptyRef = buildRefDiff(one, [])!;
  assert(emptyRef.pairs.length === 0 && emptyRef.currentOnly.length === 1, '参考轨为空：全部为当前独有');
  assert(MAX_PAIR_CELLS > 0, '配对矩阵单元格上限为正数');
}

// 28. 阅读速度：字素簇计数（去空白标点、NFKC、emoji ZWJ 序列）
{
  assert(countGraphemes('abc') === 3, 'ASCII 3 字素');
  assert(countGraphemes('你好') === 2, '中文 2 字素');
  assert(countGraphemes('é') === 1, '组合字符 e+◌́ 为 1 字素');
  assert(countGraphemes('👨‍👩‍👧') === 1, 'emoji ZWJ 家庭序列为 1 字素');
  assert(readingChars('你好， 世界！') === 4, '去中文标点与空白后 4 字');
  assert(readingChars('  Hello,\nWorld! ') === 10, '去英文标点与空白后 10 字');
  assert(readingChars('ＡＢＣ．１２３') === 6, '全角 NFKC 折叠后 6 字');
  assert(readingChars('…— !?') === 0, '纯标点空白为 0 字');
  assert(readingChars('👍👍') === 2, 'emoji 各算 1 字');
}

// 29. 阅读速度：超速判定与目标时长（向上取整到毫秒，整除不误加）
{
  const speedCues = [
    { id: 'a', start: 0, end: 1, text: '一二三四五六七八九十一二' }, // 12 字 / 1s = 12 > 10
    { id: 'b', start: 2, end: 3, text: '一二三四五六七八九十' },     // 10 字 / 1s = 10，恰好不超
    { id: 'c', start: 4, end: 2, text: 'x' }                        // 非法时长由解析器保证，此处不构造
  ].filter((c) => c.end > c.start);
  const metrics = buildReadingSpeed(speedCues, 10);
  assert(metrics[0].over && !metrics[1].over, '12 字/秒超 10，10 字/秒恰好不超');
  assert(metrics[0].targetMs === 1200 && metrics[0].extendMs === 200, '12 字 / 10 = 1.2s 目标时长');
  assert(metrics[1].extendMs === 0, '不超限时无需延长');
  // 13 字 / 10：1.3s；整除场景 10 字 -> 1000ms 而非 1001
  assert(buildReadingSpeed([{ id: 'x', start: 0, end: 1, text: '一二三四五六七八九十'.repeat(1) }], 10)[0].targetMs === 1000, '整除目标时长不取整 +1');
  const m7 = buildReadingSpeed([{ id: 'x', start: 0, end: 1, text: '一二三四五六七' }], 3); // 7 字/3 = 2.333...
  assert(m7[0].targetMs === 2334, '7/3 字每秒 -> 2334ms（ceil）');
  // 阈值放大后不再超限
  assert(buildReadingSpeed(speedCues, 20).every((m) => !m.over), '阈值 20 时无超速条目');
}

// 30. 阅读速度修复：均分延长、转拨、触限与缺口
{
  const SC = { minDuration: 0.3, minGap: 0.1 };
  // a[0~1] b[2~2.5]（10 字需 500ms） c[5~6]：目标 1.0s，左余 1000、右余 1400
  const sc = [
    { id: 'a', start: 0, end: 1, text: 'a' },
    { id: 'b', start: 2, end: 2.5, text: '一二三四五六七八九十' },
    { id: 'c', start: 5, end: 6, text: 'c' }
  ];
  let fix = planReadingSpeedFix(sc, 'b', 10, SC, 0)!;
  assert(fix.needMs === 500, 'b 需延长 500ms');
  assert(fix.left.takeMs === 250 && fix.right.takeMs === 250, '两侧余量充足：均分 250/250');
  assert(fix.newStartMs === 1750 && fix.newEndMs === 2750, '新起止 1.750 / 2.750');
  assert(fix.feasible && fix.nextCues !== null, '方案可行并给出 nextCues');

  // 左触限（a.end=1.9，左余 0）：全量 500 转给右侧（右余 2400 充足）
  const sc2 = [
    { id: 'a', start: 0, end: 1.9, text: 'a' },
    { id: 'b', start: 2, end: 2.5, text: '一二三四五六七八九十' },
    { id: 'c', start: 5, end: 6, text: 'c' }
  ];
  fix = planReadingSpeedFix(sc2, 'b', 10, SC, 0)!;
  assert(fix.left.takeMs === 0 && fix.right.takeMs === 500, `左触限转拨右侧 0/500（实际 ${fix.left.takeMs}/${fix.right.takeMs}）`);
  assert(fix.left.bound === 'neighbor' && fix.left.neighborIndex === 1, '左侧标记受上一条 #1 限制');

  // 右触限（c.start=2.7，右余 100ms）：左余 1000 充足，400 转给左
  const sc3 = [
    { id: 'a', start: 0, end: 1, text: 'a' },
    { id: 'b', start: 2, end: 2.5, text: '一二三四五六七八九十' },
    { id: 'c', start: 2.7, end: 6, text: 'c' }
  ];
  fix = planReadingSpeedFix(sc3, 'b', 10, SC, 0)!;
  assert(fix.left.takeMs === 400 && fix.right.takeMs === 100, `右触限转拨左侧 400/100（实际 ${fix.left.takeMs}/${fix.right.takeMs}）`);
  assert(fix.right.bound === 'neighbor' && fix.right.neighborIndex === 3, '右侧标记受下一条 #3 限制');
  assert(fix.feasible, '转拨后可行');

  // 两侧余量合计不足：左余 0（a.end=1.9）、右余 100，缺 400
  const sc4 = [
    { id: 'a', start: 0, end: 1.9, text: 'a' },
    { id: 'b', start: 2, end: 2.5, text: '一二三四五六七八九十' },
    { id: 'c', start: 2.7, end: 6, text: 'c' }
  ];
  fix = planReadingSpeedFix(sc4, 'b', 10, SC, 0)!;
  assert(!fix.feasible && fix.shortfallMs === 400, `两侧余量不足缺 400ms（实际 ${fix.shortfallMs}）`);
  assert(fix.nextCues === null, '不足时不产生 nextCues（原字幕不变）');
  assert(fix.left.takeMs === 0 && fix.right.takeMs === 100, `两侧取 0/100（实际 ${fix.left.takeMs}/${fix.right.takeMs}）`);

  // 0s 限制：首条字幕无左邻，起点 0.2，左余 200；右余充足 -> 均分 250 时左先取 200，300 转右
  const sc5 = [
    { id: 'b', start: 0.2, end: 0.5, text: '一二三四五六七八九十一二三四' }, // 14 字 / 0.3s，目标 1400ms，需 1100
    { id: 'c', start: 5, end: 6, text: 'c' }
  ];
  fix = planReadingSpeedFix(sc5, 'b', 10, SC, 0)!;
  assert(fix.needMs === 1100, `需 1100ms（实际 ${fix.needMs}）`);
  assert(fix.left.takeMs === 200 && fix.left.bound === 'zero', `左侧取满到 0s 并标记 zero（实际 ${fix.left.takeMs}）`);
  assert(fix.right.takeMs === 900 && fix.feasible, `剩余 900 转右侧（实际 ${fix.right.takeMs}）`);

  // 音频终点限制：无右邻，音频 2.75s 结束 -> 右余 250（均分即触限），左余 1000，250 转左
  fix = planReadingSpeedFix(sc, 'b', 10, SC, 2.75)!;
  assert(fix.right.takeMs === 250 && fix.right.bound === 'audio-end', `右侧受音频终点限制取 250（实际 ${fix.right.takeMs}）`);
  assert(fix.left.takeMs === 250 && fix.feasible, '250 转左侧后可行');
  // 未加载音频（0）且单条无邻居：两侧余量无限，均分
  const only = [{ id: 'solo', start: 2, end: 2.5, text: '一二三四五六七八九十' }];
  fix = planReadingSpeedFix(only, 'solo', 10, SC, 0)!;
  assert(fix.right.bound === 'none' && Number.isFinite(fix.right.slackMs) === false, '无右邻且无音频：右余无限');
  assert(fix.left.bound === 'none' && fix.left.takeMs === 250, `无左邻时左限 0s、余量 2000ms 未取满（实际 ${fix.left.takeMs}）`);

  // 音频终点比下一条更紧时取音频：右余 min(2600-2500=100, 2650-2500=150)=100 邻居
  fix = planReadingSpeedFix(sc3, 'b', 10, SC, 2.65)!;
  assert(fix.right.takeMs === 100 && fix.right.bound === 'neighbor', '下一条间隔后 2.60 早于音频 2.65，取邻居限制');

  // 初始均分即超过一侧余量：左余 50（a.end=1.85 + 间隔 0.1），右余 950（c.start=3.55）。先取左 50，650 转右
  const scTightLeft = [
    { id: 'a', start: 0, end: 1.85, text: 'a' },
    { id: 'b', start: 2, end: 2.5, text: '一二三四五六七八九十一二' }, // 12 字需 700ms
    { id: 'c', start: 3.55, end: 6, text: 'c' }
  ];
  fix = planReadingSpeedFix(scTightLeft, 'b', 10, SC, 0)!;
  assert(fix.needMs === 700 && fix.left.takeMs === 50 && fix.right.takeMs === 650, `左触限且初始均分超额：50/650（实际 ${fix.left.takeMs}/${fix.right.takeMs}）`);
  assert(fix.feasible && fix.left.bound === 'neighbor', '转拨后可行，左标记受上一条限制');

  // 奇数毫秒：1 字 / 4 阈值，1s -> 目标 250ms，需 150ms（已 1s？构造 100ms 时长）
  const sc6 = [{ id: 'a', start: 1, end: 1.1, text: '一字' }]; // 2 字 / 0.1s，目标 200ms，需 100
  fix = planReadingSpeedFix(sc6, 'a', 10, SC, 0)!;
  assert(fix.needMs === 100 && fix.left.takeMs === 50 && fix.right.takeMs === 50, '偶数均分');
  const sc7 = [{ id: 'a', start: 1, end: 1.1, text: '一二三' }]; // 3 字 / 0.1s，目标 300ms，需 200
  fix = planReadingSpeedFix(sc7, 'a', 10, SC, 0)!;
  assert(fix.needMs === 200, '需 200ms');
  // 奇数验证：3 字 / 0.2s（200ms）阈值 10 -> 300ms 需 100 -> 50/50；用 4 字/0.25 -> 400 需 150
  const sc8 = [{ id: 'a', start: 1, end: 1.25, text: '一二三四' }];
  fix = planReadingSpeedFix(sc8, 'a', 10, SC, 0)!;
  assert(fix.needMs === 150 && fix.left.takeMs === 75 && fix.right.takeMs === 75, `150ms 均分 75/75（实际 ${fix.left.takeMs}/${fix.right.takeMs}）`);
  // 奇数 101ms：构造 3 字 / 0.199s = 199ms，目标 300，需 101
  const sc9 = [{ id: 'a', start: 1, end: 1.199, text: '一二三' }];
  fix = planReadingSpeedFix(sc9, 'a', 10, SC, 0)!;
  assert(fix.needMs === 101 && fix.left.takeMs === 50 && fix.right.takeMs === 51, `奇数毫秒多 1ms 归右侧 50/51（实际 ${fix.left.takeMs}/${fix.right.takeMs}）`);

  // 失效 id 返回 null
  assert(planReadingSpeedFix(sc, 'ghost', 10, SC, 0) === null, '锚点失效返回 null');

  // 合法结果作为一次历史记录：可撤销 / 重做，并由现有 SRT 导出
  const okFix = planReadingSpeedFix(sc, 'b', 10, SC, 0)!;
  let h4 = initHistory(sc);
  h4 = commitHistory(h4, okFix.nextCues!);
  assert(h4.past.length === 1 && h4.present[1].start === 1.75, '速度修复作为一次历史提交');
  h4 = undoHistory(h4);
  assert(h4.present[1].start === 2, '撤销还原');
  h4 = redoHistory(h4);
  assert(h4.present[1].end === 2.75, '重做恢复');
  assert(serializeSrt(h4.present).includes('00:00:01,750 --> 00:00:02,750'), '修复结果可由现有 SRT 导出');
}

/* ---------------- 音频活动空档审阅 ---------------- */

// 31. 活动段提取：阈值互补判定与断口合并
{
  const sr = 1000;
  const ch = new Float32Array(sr * 2);
  ch.fill(0.5, 0, 1000); // 0~1.0s 有声
  ch.fill(0, 1000, 1200); // 1.0~1.2s 低能量断口（200ms）
  ch.fill(0.5, 1200, 2000); // 1.2~2.0s 有声
  const win = computeWindowLevels([ch], sr);

  const merged = detectActivitySegments(win, 0.01, 0.25);
  assert(
    merged.length === 1 && merged[0].start === 0 && merged[0].end === 2,
    `断口 200ms < 250ms 合并为 0~2（实际 ${merged.length} 段）`
  );
  const exact = detectActivitySegments(win, 0.01, 0.2);
  assert(exact.length === 2, '断口恰好等于合并上限不合并（严格小于才合并）');
  assert(
    exact[0].start === 0 && exact[0].end === 1 && exact[1].start === 1.2 && exact[1].end === 2,
    `两段 0~1.0 与 1.2~2.0（实际 ${exact[0]?.start}~${exact[0]?.end} / ${exact[1]?.start}~${exact[1]?.end}）`
  );
  const wide = detectActivitySegments(win, 0.01, 0.15);
  assert(wide.length === 2, '断口 200ms > 150ms 不合并');

  // 与静音判定互补：能量恰好等于阈值算活动
  const flat = computeWindowLevels([new Float32Array(sr).fill(0.01)], sr);
  assert(detectActivitySegments(flat, 0.01, 0).length === 1, '能量恰好等于阈值算活动');
  assert(detectActivitySegments(flat, 0.02, 0).length === 0, '能量低于阈值不算活动');
  // 全静音音频：无活动段
  const quiet = computeWindowLevels([new Float32Array(sr)], sr);
  assert(detectActivitySegments(quiet, 0.01, 0.25).length === 0, '全静音无活动段');
}

// 32. 字幕区间合并、带容差扣除与最短时长过滤
{
  // 重叠与相接的字幕区间先合并为一个
  const mergedCues = mergeCueIntervals([
    { id: 'a', start: 0.3, end: 0.8, text: 'a' },
    { id: 'b', start: 0.7, end: 1.1, text: 'b' },
    { id: 'c', start: 1.1, end: 1.3, text: 'c' },
    { id: 'd', start: 1.5, end: 1.6, text: 'd' }
  ]);
  assert(
    mergedCues.length === 2 && mergedCues[0].start === 0.3 && mergedCues[0].end === 1.3,
    `重叠/相接字幕合并为 0.3~1.3（实际 ${mergedCues.length} 段）`
  );
  assert(mergedCues[1].start === 1.5 && mergedCues[1].end === 1.6, '独立区间保持原样');

  // 带边界容差扣除：[0.3,0.8] 容差 0.1 -> 扣除 [0.2,0.9]
  const rest = subtractCueIntervals(
    [{ start: 0, end: 1 }],
    [{ id: 'a', start: 0.3, end: 0.8, text: 'a' }],
    0.1
  );
  assert(
    rest.length === 2 && Math.abs(rest[0].end - 0.2) < 1e-9 && Math.abs(rest[1].start - 0.9) < 1e-9,
    '容差向两侧扩展后扣除'
  );
  // 容差把字幕起点夹到 0s（[0.05,0.5] 容差 0.1 -> 扣除 [0,0.6]）
  const clamped = subtractCueIntervals(
    [{ start: 0, end: 1 }],
    [{ id: 'a', start: 0.05, end: 0.5, text: 'a' }],
    0.1
  );
  assert(
    clamped.length === 1 && Math.abs(clamped[0].start - 0.6) < 1e-9 && clamped[0].end === 1,
    '容差扩展不越过 0s'
  );
  // 零容差精确扣除；端点相接不算交叠
  const rest0 = subtractCueIntervals(
    [{ start: 0, end: 2 }],
    [{ id: 'a', start: 0.5, end: 1, text: 'a' }],
    0
  );
  assert(rest0.length === 2 && rest0[0].end === 0.5 && rest0[1].start === 1, '零容差精确扣除');
  const touching = subtractCueIntervals(
    [{ start: 1, end: 2 }],
    [{ id: 'a', start: 0.5, end: 1, text: 'a' }],
    0
  );
  assert(touching.length === 1 && touching[0].start === 1 && touching[0].end === 2, '端点相接不切割');
  // 重叠字幕先合并再扣除，不会因重复切割产生错误碎片
  const overlap = subtractCueIntervals(
    [{ start: 0, end: 2 }],
    [
      { id: 'a', start: 0.3, end: 0.8, text: 'a' },
      { id: 'b', start: 0.7, end: 1.1, text: 'b' }
    ],
    0
  );
  assert(
    overlap.length === 2 && overlap[0].end === 0.3 && overlap[1].start === 1.1,
    '重叠字幕合并后一次性扣除'
  );
}

// 33. 端到端：活动段 - 字幕（带容差）-> 按下限过滤；无字幕 / 全覆盖边界
{
  const sr = 1000;
  const ch = new Float32Array(sr * 2);
  ch.fill(0.5, 0, 1000);
  ch.fill(0, 1000, 1200);
  ch.fill(0.5, 1200, 2000);
  const win = computeWindowLevels([ch], sr);

  // 活动 0~1.0 与 1.2~2.0；字幕 [0.3,0.8] 容差 0.1 -> 剩余 [0,0.2] [0.9,1.0] [1.2,2.0]
  const result = computeActivityGaps(win, [{ id: 'a', start: 0.3, end: 0.8, text: 'a' }], {
    threshold: 0.01,
    mergeBreak: 0.15,
    tolerance: 0.1,
    minDuration: 0.2
  });
  assert(result.activity.length === 2, '扣除前 2 段活动');
  assert(result.gaps.length === 2, `0.2s 与 0.8s 达到下限、0.1s 被过滤（实际 ${result.gaps.length} 段）`);
  assert(Math.abs(result.gaps[0].duration - 0.2) < 1e-6, '剩余恰好等于下限也列出');
  assert(
    Math.abs(result.gaps[1].start - 1.2) < 1e-9 && Math.abs(result.gaps[1].duration - 0.8) < 1e-6,
    '第二段 1.2~2.0（0.8s）'
  );

  // 无字幕：全部活动段都是空档
  const noCues = computeActivityGaps(win, [], {
    threshold: 0.01,
    mergeBreak: 0.15,
    tolerance: 0.1,
    minDuration: 0.5
  });
  assert(noCues.gaps.length === 2, '无字幕时活动段全部列为空档');

  // 字幕加容差全覆盖：无空档
  const covered = computeActivityGaps(win, [{ id: 'a', start: 0, end: 2, text: 'a' }], {
    threshold: 0.01,
    mergeBreak: 0.15,
    tolerance: 0.1,
    minDuration: 0.05
  });
  assert(covered.gaps.length === 0, '字幕加容差全覆盖时无空档');

  // 调高阈值后弱信号不再算活动：空档随参数实时变化
  const raised = computeActivityGaps(
    computeWindowLevels([new Float32Array(sr).fill(0.005)], sr),
    [],
    { threshold: 0.01, mergeBreak: 0.25, tolerance: 0, minDuration: 0.5 }
  );
  assert(raised.activity.length === 0 && raised.gaps.length === 0, '弱信号低于阈值无活动段');
}

/* ---------------- 帧率网格导出 ---------------- */

// 34. 最近帧（等距取较早帧）、帧时间分数计算与候选帧
{
  const r25 = frameRateById('25'); // 40ms/帧
  assert(nearestFrame(1000, r25) === 25, '1.000s @25fps -> 帧 25');
  assert(nearestFrame(1020, r25) === 25, '等距（25.5 帧）取较早帧 25');
  assert(nearestFrame(1021, r25) === 26, '超过半帧取 26');
  assert(nearestFrame(1019, r25) === 25, '不足半帧取 25');
  const r2 = { id: 't', label: '2', num: 2, den: 1 }; // 合成 2fps：500ms/帧
  assert(nearestFrame(1250, r2) === 2, '合成帧率等距 2.5 -> 较早帧 2');
  assert(nearestFrame(1251, r2) === 3, '合成帧率过半帧 -> 3');

  const r29 = frameRateById('30000/1001');
  assert(frameToMs(30, r29) === 1001, '30000/1001：帧 30 恰好 1001ms');
  assert(
    frameToMs(30000, r29) === 1001000,
    '30000/1001：帧 30000 恰好 1001000ms（分数计算无累计漂移）'
  );
  assert(nearestFrame(1001, r29) === 30, '1001ms 最近帧 30');
  assert(frameToMs(25, r25) === 1000 && frameToMs(1, r25) === 40, '25fps 帧时间');
  assert(frameToMs(1, { id: 't', label: '', num: 16, den: 1 }) === 63, '帧时间半毫秒四舍五入进位');

  assert(frameCandidates(1000, r25).join(',') === '23,24,25,26,27', '候选为最近帧前后各 2 帧');
  assert(frameCandidates(10, r25).join(',') === '0,1,2', '起点不早于 0：负帧被排除');
  assert(FRAME_RATES.length === 4, '可选帧率 24/25/30/30000-1001 共 4 档');
}

// 35. 联合选帧：零误差、时长 / 间隔约束、字典序并列、无解报告
{
  const r25 = frameRateById('25');
  const FC = { minDuration: 0.5, minGap: 0.08 };

  // 帧上时间码：零误差
  const exact = planFrameGrid(
    [
      { id: 'a', start: 1, end: 2, text: 'a' },
      { id: 'b', start: 3, end: 4, text: 'b' }
    ],
    FC,
    r25
  );
  assert(exact.feasible && exact.totalErrorMs === 0, '帧上时间码零误差');
  assert(
    exact.results[0].startFrame === 25 && exact.results[0].endFrame === 50 &&
      exact.results[1].startFrame === 75 && exact.results[1].endFrame === 100,
    '帧号 25→50 / 75→100'
  );

  // 乱序输入按时间序联合选择
  const unsorted = planFrameGrid(
    [
      { id: 'b', start: 3, end: 4, text: 'b' },
      { id: 'a', start: 1, end: 2, text: 'a' }
    ],
    FC,
    r25
  );
  assert(unsorted.results[0].cueId === 'a' && unsorted.results[1].cueId === 'b', '按时间序联合选择');

  // 时长约束下联合让位：1.000→1.100，最短时长 0.2s。
  // 满足时长的并列最优（总误差 100ms）：(23,28) 与 (24,29)，取帧号序列字典序最小 (23,28)
  const dur = planFrameGrid(
    [{ id: 'a', start: 1, end: 1.1, text: 'a' }],
    { minDuration: 0.2, minGap: 0 },
    r25
  );
  assert(
    dur.feasible && dur.results[0].startFrame === 23 && dur.results[0].endFrame === 28,
    `时长约束下联合让位为 23→28（实际 ${dur.results[0]?.startFrame}→${dur.results[0]?.endFrame}）`
  );
  assert(
    dur.results[0].newStartMs === 920 && dur.results[0].newEndMs === 1120 &&
      Math.abs(dur.totalErrorMs - 100) < 1e-9,
    '新时间码 0.920→1.120（时长恰好 200ms），总误差 100ms'
  );

  // 起止至少相隔 1 帧：1.000→1.010，最短时长 0 -> 终点不能同帧，取 25→26
  const oneFrame = planFrameGrid(
    [{ id: 'a', start: 1, end: 1.01, text: 'a' }],
    { minDuration: 0, minGap: 0 },
    r25
  );
  assert(
    oneFrame.feasible && oneFrame.results[0].startFrame === 25 && oneFrame.results[0].endFrame === 26,
    '起止至少相隔 1 帧'
  );

  // 间隔约束 + 字典序并列：c1 1.0→1.5，c2 1.6→3.0，最小间隔 0.2s。
  // 总误差 100ms 的并列方案 (25,35,40,75) / (25,36,41,75) / (25,37,42,75)，取字典序最小
  const tie = planFrameGrid(
    [
      { id: 'a', start: 1, end: 1.5, text: 'a' },
      { id: 'b', start: 1.6, end: 3, text: 'b' }
    ],
    { minDuration: 0.05, minGap: 0.2 },
    r25
  );
  assert(
    tie.feasible &&
      tie.results[0].startFrame === 25 && tie.results[0].endFrame === 35 &&
      tie.results[1].startFrame === 40 && tie.results[1].endFrame === 75,
    `同分取帧号序列字典序最小 (25,35,40,75)（实际 ${tie.results.map((r) => `${r.startFrame},${r.endFrame}`).join(' / ')}）`
  );
  assert(Math.abs(tie.totalErrorMs - 100) < 1e-9, '并列方案总误差 100ms');
  assert(
    tie.results[0].newEndMs === 1400 && tie.results[1].newStartMs === 1600,
    '间隔恰好 200ms 满足最小间隔'
  );

  // 无解：间隔无法满足 -> 报告第 2 条起点，不产生部分结果
  const noGap = planFrameGrid(
    [
      { id: 'a', start: 1, end: 1.5, text: 'a' },
      { id: 'b', start: 1.55, end: 3, text: 'b' }
    ],
    { minDuration: 0.05, minGap: 0.5 },
    r25
  );
  assert(!noGap.feasible && noGap.results.length === 0, '无解时不产生部分结果');
  assert(
    noGap.failure?.cueIndex === 2 && noGap.failure.edge === 'start' && noGap.failure.cueId === 'b',
    '报告第 2 条起点无法接续'
  );
  assert(noGap.failure?.message.includes('间隔') ?? false, `原因指明间隔不足：${noGap.failure?.message ?? ''}`);

  // 无解：时长无法满足 -> 报告第 1 条终点
  const noDur = planFrameGrid(
    [{ id: 'a', start: 1, end: 1.1, text: 'a' }],
    { minDuration: 0.5, minGap: 0 },
    r25
  );
  assert(
    !noDur.feasible && noDur.failure?.cueIndex === 1 && noDur.failure.edge === 'end',
    '报告第 1 条终点无法接续'
  );
  assert(noDur.failure?.message.includes('时长') ?? false, `原因指明时长不足：${noDur.failure?.message ?? ''}`);

  // 起点不早于 0：0.010s 起点吸附到帧 0
  const zero = planFrameGrid(
    [{ id: 'a', start: 0.01, end: 1, text: 'a' }],
    { minDuration: 0.05, minGap: 0 },
    r25
  );
  assert(
    zero.feasible && zero.results[0].startFrame === 0 && zero.results[0].newStartMs === 0,
    '起点吸附到帧 0（不早于 0）'
  );

  // 30000/1001：帧上时间码零误差
  const ntsc = planFrameGrid(
    [{ id: 'a', start: 1.001, end: 2.002, text: 'a' }],
    { minDuration: 0.5, minGap: 0 },
    frameRateById('30000/1001')
  );
  assert(
    ntsc.feasible && ntsc.totalErrorMs === 0 &&
      ntsc.results[0].startFrame === 30 && ntsc.results[0].endFrame === 60,
    '30000/1001 帧上时间码零误差（帧 30→60）'
  );

  // applyFrameGrid：生成新数组，原字幕对象不变；结果可由现有 SRT 导出
  const src = [
    { id: 'a', start: 1, end: 1.5, text: 'a' },
    { id: 'b', start: 1.6, end: 3, text: 'b' }
  ];
  const tiePlan = planFrameGrid(src, { minDuration: 0.05, minGap: 0.2 }, r25);
  const mapped = applyFrameGrid(src, tiePlan)!;
  assert(
    mapped[0].start === 1 && mapped[0].end === 1.4 && mapped[1].start === 1.6 && mapped[1].end === 3,
    '映射后新时间码 1.000→1.400 / 1.600→3.000'
  );
  assert(src[0].end === 1.5 && mapped[0] !== src[0], '原字幕对象不变（撤销历史不受影响）');
  const frameOut = serializeSrt(mapped);
  assert(
    frameOut.includes('00:00:01,000 --> 00:00:01,400') && frameOut.includes('00:00:01,600 --> 00:00:03,000'),
    '帧时间四舍五入到毫秒导出'
  );
  assert(
    applyFrameGrid(src, planFrameGrid(src, { minDuration: 0.05, minGap: 0.5 }, r25)) === null,
    '无解时映射返回 null'
  );
}

process.exit(fail ? 1 : 0);