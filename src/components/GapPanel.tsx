import { useEffect, useState } from 'react';
import type { SilenceStatus } from '../types';
import { secondsToSrtTime } from '../lib/srt';
import type { ActivityGap } from '../lib/activityGaps';

interface GapPanelProps {
  /** 音频分析状态（与静音分析同源：切换音频时旧结果立即失效） */
  status: SilenceStatus;
  /** 分析失败原因 */
  error: string | null;
  /** 恢复会话后等待重新选择音频 */
  audioPending: boolean;
  /** 达到下限的空档（时间序）；未就绪时传稳定空数组 */
  gaps: ActivityGap[];
  /** 扣除前的活动段数（摘要用） */
  activityCount: number;
  /** 电平阈值（dB，窗口能量不低于该值视为活动） */
  thresholdDb: number;
  /** 低能量断口合并上限（秒） */
  mergeBreak: number;
  /** 扣除字幕区间时的边界容差（秒） */
  tolerance: number;
  /** 空档最短时长下限（秒） */
  minDuration: number;
  onThresholdDbChange: (v: number) => void;
  onMergeBreakChange: (v: number) => void;
  onToleranceChange: (v: number) => void;
  onMinDurationChange: (v: number) => void;
  /** 点击条目：定位播放头试听该区间（纯定位，不改动字幕与历史） */
  onLocate: (gap: ActivityGap) => void;
}

function formatDuration(sec: number): string {
  return `${sec.toFixed(2)}s`;
}

/**
 * 音频活动空档审阅面板（停靠在舞台底部）：
 * 复用本地音频的 20ms 窗口能量，按可调电平阈值提取连续高能量段并合并
 * 短暂低能量断口；当前字幕区间先合并、再带可调边界容差从活动段中扣除，
 * 只列出剩余时长达到可调下限的区间。点击条目定位播放头试听。
 * 列表仅提示疑似未覆盖的音频，不自动补字幕、不写入撤销历史；
 * 参数 / 字幕 / 音频变化后由 App 实时重算，切换音频时旧结果随之失效。
 */
export default function GapPanel(p: GapPanelProps) {
  const [collapsed, setCollapsed] = useState(true);

  // 发现疑似空档时自动展开提醒审阅；全部覆盖后保持当前展开状态
  useEffect(() => {
    if (p.gaps.length > 0) setCollapsed(false);
  }, [p.gaps.length]);

  const totalGap = p.gaps.reduce((sum, g) => sum + g.duration, 0);
  const ready = p.status === 'done';

  // 未就绪 / 无结果时的说明文案（无音频、等待重选、分析中、分析失败、全覆盖）
  let statusText = '';
  if (p.status === 'analyzing') statusText = '音频分析中…';
  else if (p.status === 'error') statusText = `音频分析失败：${p.error ?? '未知原因'}`;
  else if (p.audioPending) statusText = '等待重新选择音频：指纹匹配并完成分析后自动列出空档';
  else if (p.status === 'idle') statusText = '尚未导入音频：导入并完成本地分析后，这里会列出疑似未被字幕覆盖的活动区间';
  else if (p.activityCount === 0) statusText = '当前电平阈值下未检测到音频活动段';
  else if (p.gaps.length === 0) statusText = '活动段均已被字幕覆盖（或剩余空档低于最短时长下限）';

  return (
    <section className="gap-dock">
      <div className="gap-head">
        <button
          className="btn mini gap-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开空档列表' : '收起空档列表'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="gap-title">🔊 音频活动空档</span>
        <span className="gap-summary">
          {ready
            ? `活动 ${p.activityCount} 段 · 疑似未覆盖 ${p.gaps.length} 段` +
              (p.gaps.length > 0 ? ` · 共 ${formatDuration(totalGap)}` : '')
            : statusText}
        </span>
        <div className="gap-params">
          <label className="gap-param" title="窗口能量（20ms RMS）不低于该值视为有声活动；恰好等于算活动">
            电平阈值
            <input
              type="number"
              min={-60}
              max={-20}
              step={1}
              value={p.thresholdDb}
              onChange={(e) =>
                p.onThresholdDbChange(Math.min(-20, Math.max(-60, Number(e.target.value) || -60)))
              }
            />
            dB
          </label>
          <label className="gap-param" title="活动段之间的低能量断口严格小于该值时合并为一段（恰好等于不合并）">
            合并断口
            <input
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={p.mergeBreak}
              onChange={(e) =>
                p.onMergeBreakChange(Math.min(2, Math.max(0, Number(e.target.value) || 0)))
              }
            />
            s
          </label>
          <label className="gap-param" title="扣除字幕区间时向两侧各扩展的边界容差（吸收口播与字幕的边界误差）">
            边界容差
            <input
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={p.tolerance}
              onChange={(e) =>
                p.onToleranceChange(Math.min(2, Math.max(0, Number(e.target.value) || 0)))
              }
            />
            s
          </label>
          <label className="gap-param" title="只列出剩余时长达到该值的空档（恰好等于也列出）">
            最短空档
            <input
              type="number"
              min={0.05}
              max={10}
              step={0.05}
              value={p.minDuration}
              onChange={(e) =>
                p.onMinDurationChange(Math.min(10, Math.max(0.05, Number(e.target.value) || 0.05)))
              }
            />
            s
          </label>
        </div>
      </div>

      {!collapsed && (
        <div className="gap-body">
          {statusText ? (
            <div className="gap-empty">{statusText}</div>
          ) : (
            <div className="gap-list">
              {p.gaps.map((g, i) => (
                <div
                  key={`${g.start}-${g.end}`}
                  className="gap-row"
                  onClick={() => p.onLocate(g)}
                  title="点击定位播放头试听该区间（仅提示，不会修改字幕）"
                >
                  <span className="gap-idx">#{i + 1}</span>
                  <span className="gap-time">
                    {secondsToSrtTime(g.start)} → {secondsToSrtTime(g.end)}
                  </span>
                  <span className="gap-duration">{formatDuration(g.duration)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="gap-note">
            仅提示疑似未被字幕覆盖的音频区间，不会自动补字幕或写入撤销历史；调整参数、字幕时间码或音频后自动重算。
          </div>
        </div>
      )}
    </section>
  );
}
