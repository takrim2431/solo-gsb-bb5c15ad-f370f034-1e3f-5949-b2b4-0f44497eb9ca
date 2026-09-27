import { useEffect, useState } from 'react';
import type { Cue } from '../types';
import { secondsToSrtTime } from '../lib/srt';
import type { ReadingSpeedEntry, ReadingSpeedFix, SidePlan } from '../lib/readingSpeed';

interface SpeedPanelProps {
  /** 超过当前阈值的条目（时间序） */
  overEntries: ReadingSpeedEntry[];
  /** 全部条目数 */
  totalCount: number;
  /** 字数/秒阈值 */
  threshold: number;
  onThresholdChange: (v: number) => void;
  /** 面板选中的字幕 id；切换 SRT 后由 App 清空 */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 选中字幕（已被删除 / 换文件时为 null） */
  selectedCue: Cue | null;
  /** 选中条目的速度指标（选中条目不再超限时仍提供，用于提示） */
  selectedMetrics: ReadingSpeedEntry | null;
  /** 选中条目的延长规划；无选中为 null */
  fix: ReadingSpeedFix | null;
  /** 是否已加载音频（决定右侧是否受音频终点限制） */
  audioLoaded: boolean;
  /** 合法规划作为一次历史记录提交 */
  onApply: () => void;
}

/** 毫秒 -> SRT 时间码（00:00:00,000） */
function msToSrt(ms: number): string {
  return secondsToSrtTime(ms / 1000);
}

function formatCps(cps: number): string {
  if (!Number.isFinite(cps)) return '∞';
  return cps.toFixed(2);
}

function sideBoundText(side: SidePlan, which: 'left' | 'right'): string {
  if (side.bound === 'none') return '';
  if (side.bound === 'zero') return '已到 0s';
  if (side.bound === 'audio-end') return '已到音频终点';
  if (side.bound === 'neighbor' && side.neighborIndex !== null) {
    return which === 'left'
      ? `受上一条（#${side.neighborIndex}）最小间隔限制`
      : `受下一条（#${side.neighborIndex}）最小间隔限制`;
  }
  return '受相邻字幕最小间隔限制';
}

/**
 * 阅读速度修复面板（停靠在舞台底部）：
 * 列出「去空白标点后 Unicode 字素簇数 ÷ 字幕时长」超过可调字/秒阈值的条目；
 * 选中条目时在约束（0s / 相邻最小间隔 / 已加载音频终点）内预览时长延长方案，
 * 余量不足显示缺少的毫秒数并禁止提交；足够时展示新旧时间码，确认后作为一次
 * 历史操作提交（可撤销/重做并参与现有 SRT 导出）。
 * 面板内容随当前字幕与约束实时重算；选中状态由 App 持有，切换 SRT 时清空。
 */
export default function SpeedPanel(p: SpeedPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  // 出现超速条目时自动展开列表；全部恢复正常时收起，避免空面板长期占位
  useEffect(() => {
    if (p.overEntries.length > 0) setCollapsed(false);
  }, [p.overEntries.length]);

  const fix = p.fix;
  const showDetail = p.selectedId !== null && p.selectedCue !== null && p.selectedMetrics !== null;
  const selectedStillOver = p.selectedMetrics?.over ?? false;
  const canApply = fix !== null && fix.feasible && fix.nextCues !== null;

  return (
    <section className="speed-dock">
      <div className="speed-head">
        <button
          className="btn mini speed-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开超速条目列表' : '收起超速条目列表'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="speed-title">⏩ 阅读速度修复</span>
        <span className="speed-summary">
          {p.totalCount === 0
            ? '尚未导入字幕'
            : p.overEntries.length === 0
              ? `${p.totalCount} 条字幕均未超过阈值`
              : `${p.totalCount} 条中 ${p.overEntries.length} 条超过 ${p.threshold} 字/秒`}
        </span>
        <label className="speed-threshold" title="字数 = 去掉空白与标点后的 Unicode 字素簇数；字数 ÷ 时长（字/秒）严格超过该值的条目被标出">
          速度阈值
          <input
            type="number"
            min={0.1}
            max={60}
            step={0.5}
            value={p.threshold}
            onChange={(e) => p.onThresholdChange(Math.max(0.1, Number(e.target.value) || 0.1))}
          />
          字/秒
        </label>
      </div>

      {!collapsed && p.totalCount > 0 && (
        <div className="speed-body">
          <div className="speed-list">
            {p.overEntries.length === 0 ? (
              <div className="speed-empty">当前阈值下没有超速条目</div>
            ) : (
              p.overEntries.map((e) => (
                <div
                  key={e.cueId}
                  className={['speed-row', e.cueId === p.selectedId && 'focused'].filter(Boolean).join(' ')}
                  onClick={() => p.onSelect(e.cueId === p.selectedId ? null : e.cueId)}
                  title="点击查看时长延长预览，再次点击取消选择"
                >
                  <span className="speed-idx">#{e.index}</span>
                  <span className="speed-cps">
                    {formatCps(e.cps)} <em>字/秒</em>
                  </span>
                  <span className="speed-meta">
                    {e.chars} 字 · {e.durationMs}ms → 需 {e.targetMs}ms
                  </span>
                </div>
              ))
            )}
          </div>

          {showDetail && (
            <div className={['speed-detail', canApply ? 'ok' : '', fix && fix.shortfallMs > 0 ? 'short' : ''].filter(Boolean).join(' ')}>
              {!selectedStillOver ? (
                <span className="speed-detail-note">该条目当前速度未超过 {p.threshold} 字/秒，无需延长（阈值或字幕变化后自动重算）。</span>
              ) : !fix ? (
                <span className="speed-detail-note">无法计算延长方案。</span>
              ) : (
                <>
                  <div className="speed-detail-grid">
                    <span className="speed-detail-label">#{p.selectedMetrics!.index}</span>
                    <span className="speed-detail-stats">
                      {p.selectedMetrics!.chars} 字 · 当前 {fix.oldEndMs - fix.oldStartMs}ms（
                      {formatCps(p.selectedMetrics!.cps)} 字/秒）· 目标 {p.selectedMetrics!.targetMs}ms · 需延长{' '}
                      <strong>{fix.needMs}ms</strong>
                    </span>
                    <div className="speed-detail-actions">
                      <button
                        className="btn primary mini"
                        onClick={p.onApply}
                        disabled={!canApply}
                        title={canApply ? '把延长结果作为一次历史记录提交（可撤销/重做）' : '两侧余量不足，无法满足目标时长'}
                      >
                        应用延长
                      </button>
                      <button className="btn mini" onClick={() => p.onSelect(null)} title="取消选择（不修改字幕）">
                        取消
                      </button>
                    </div>
                  </div>
                  <div className="speed-detail-text">{p.selectedCue!.text}</div>
                  <div className="speed-detail-alloc">
                    <span className="alloc-side">
                      起点侧 −{fix.left.takeMs}ms
                      {fix.left.bound !== 'none' && <em className="alloc-bound">（{sideBoundText(fix.left, 'left')}）</em>}
                    </span>
                    <span className="alloc-arrow">⟵ 延长 ⟶</span>
                    <span className="alloc-side">
                      终点侧 +{fix.right.takeMs}ms
                      {fix.right.bound !== 'none' && <em className="alloc-bound">（{sideBoundText(fix.right, 'right')}）</em>}
                    </span>
                    {!p.audioLoaded && <span className="alloc-hint">未加载音频：终点侧暂不受音频终点限制</span>}
                  </div>
                  <div className="speed-detail-times">
                    <div className="time-col">
                      <span className="time-col-label">原时间码</span>
                      <code>
                        {msToSrt(fix.oldStartMs)} → {msToSrt(fix.oldEndMs)}
                      </code>
                    </div>
                    <div className="time-col">
                      <span className="time-col-label">
                        {fix.shortfallMs > 0 ? '约束内可达（新时间码）' : '新时间码'}
                      </span>
                      <code>
                        {msToSrt(fix.newStartMs)} → {msToSrt(fix.newEndMs)}
                      </code>
                    </div>
                  </div>
                  {fix.shortfallMs > 0 ? (
                    <div className="speed-shortfall">
                      ⚠ 两侧可用余量合计 {Number.isFinite(fix.totalSlackMs) ? `${fix.totalSlackMs}ms` : '充足'}，距目标时长仍缺少{' '}
                      <strong>{fix.shortfallMs}ms</strong>：0s / 相邻字幕最小间隔
                      {p.audioLoaded ? ' / 音频终点' : ''} 已无更多空间，禁止提交，原字幕不变。
                    </div>
                  ) : (
                    <div className="speed-ok">✓ 余量充足：确认后作为一次历史操作提交，可撤销/重做并随现有 SRT 导出。</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
