import { useState } from 'react';
import type { Constraints } from '../types';
import { secondsToSrtTime } from '../lib/srt';
import { FRAME_RATES, type FrameGridPlan } from '../lib/frameGrid';

interface FramePanelProps {
  /** 当前字幕条数（0 时面板仅提示） */
  cueCount: number;
  /** 当前最短时长 / 最小间隔约束（秒），仅用于展示 */
  constraints: Constraints;
  /** 目标帧率 id（仅存当前页面内存） */
  rateId: string;
  onRateChange: (id: string) => void;
  /** 联合选帧方案；无字幕时为 null */
  plan: FrameGridPlan | null;
  /** 下载 .frame.srt（仅方案可行时可用；不修改字幕与撤销历史） */
  onExport: () => void;
  /** 定位无法接续的字幕（选中并滚动到该条） */
  onLocate: (cueId: string) => void;
}

/** 毫秒 -> SRT 时间码（00:00:00,000） */
function msToSrt(ms: number): string {
  return secondsToSrtTime(ms / 1000);
}

/**
 * 帧率网格导出面板（停靠在舞台底部）：
 * 把当前全部字幕的起止点联合吸附到目标帧率（24 / 25 / 30 / 30000/1001）的
 * 整数帧上——每个起止点取最近帧（等距取较早帧）±2 帧为候选，时间按帧率分数
 * 精确计算；方案由 App 随字幕 / 约束 / 帧率实时重算。
 * 有解时预览每条原/新时间码与总误差，导出 .frame.srt（只读导出，不写历史）；
 * 无解时显示首个无法接续的字幕及原因，导出禁用、不产出部分结果。
 */
export default function FramePanel(p: FramePanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const plan = p.plan;
  const failure = plan?.failure ?? null;
  const feasible = plan?.feasible ?? false;

  return (
    <section className="frame-dock">
      <div className="frame-head">
        <button
          className="btn mini frame-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开帧率网格导出' : '收起帧率网格导出'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="frame-title">🎞 帧率网格导出</span>
        <span className="frame-summary">
          {p.cueCount === 0
            ? '尚未导入字幕'
            : !plan
              ? ''
              : plan.feasible
                ? `${p.cueCount} 条可吸附 · 总误差 ${plan.totalErrorMs.toFixed(1)}ms`
                : `无解：第 ${failure!.cueIndex} 条${failure!.edge === 'start' ? '起点' : '终点'}无法接续`}
        </span>
        <label
          className="frame-rate"
          title="目标帧率：帧时间按帧率分数精确计算，避免累计漂移；切换后自动重新联合选帧"
        >
          目标帧率
          <select value={p.rateId} onChange={(e) => p.onRateChange(e.target.value)}>
            {FRAME_RATES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <div className="frame-actions">
          <button
            className="btn primary mini"
            onClick={p.onExport}
            disabled={!feasible}
            title={
              feasible
                ? '按帧时间四舍五入到毫秒下载 .frame.srt（原字幕与撤销历史不变）'
                : '当前约束下无解，不导出部分结果'
            }
          >
            导出 .frame.srt
          </button>
        </div>
      </div>

      {!collapsed && p.cueCount === 0 && (
        <div className="frame-body">
          <div className="frame-empty">
            导入 SRT 后，这里会把全部字幕起止点联合吸附到所选帧率的整数帧上，并预览原/新时间码。
          </div>
        </div>
      )}

      {!collapsed && p.cueCount > 0 && plan && (
        <div className="frame-body">
          {plan.feasible ? (
            <>
              <div className="frame-list">
                {plan.results.map((r) => (
                  <div key={r.cueId} className="frame-row">
                    <span className="frame-idx">#{r.index}</span>
                    <span className="frame-time old">
                      {msToSrt(r.oldStartMs)} → {msToSrt(r.oldEndMs)}
                    </span>
                    <span className="frame-arrow">⇒</span>
                    <span className="frame-time new">
                      {msToSrt(r.newStartMs)} → {msToSrt(r.newEndMs)}
                    </span>
                    <span className="frame-frames">
                      帧 {r.startFrame} → {r.endFrame}
                    </span>
                  </div>
                ))}
              </div>
              <div className="frame-note">
                全部边界相对原时间码的绝对误差总和 {plan.totalErrorMs.toFixed(1)}ms
                （先最小化总误差，同分取帧号序列字典序最小）；当前约束：最短时长{' '}
                {p.constraints.minDuration.toFixed(3)}s · 最小间隔 {p.constraints.minGap.toFixed(3)}s。
                导出为 .frame.srt，原字幕与撤销历史不变。
              </div>
            </>
          ) : (
            <div className="frame-failure">
              <span>
                ⛔ 当前约束下无解：第 {failure!.cueIndex} 条
                {failure!.edge === 'start' ? '起点' : '终点'}无法接续 —— {failure!.message}
                。不导出部分结果；可调整最短时长 / 最小间隔或更换目标帧率后重试。
              </span>
              <button
                className="btn mini"
                onClick={() => p.onLocate(failure!.cueId)}
                title="选中并滚动到无法接续的字幕"
              >
                定位
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
