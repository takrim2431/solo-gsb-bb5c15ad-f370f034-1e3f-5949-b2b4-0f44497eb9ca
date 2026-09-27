import { useEffect, useMemo, useRef } from 'react';
import type { Cue } from '../types';
import { secondsToSrtTime } from '../lib/srt';

interface CueListProps {
  cues: Cue[];
  currentTime: number;
  selectedId: string | null;
  /** 区间漂移选中的连续区间（时间序 id）；无区间为 null */
  driftRangeIds: string[] | null;
  /** 区间漂移首个冲突字幕（红色标记）；无冲突为 null */
  driftConflictId: string | null;
  /** 阅读速度超过阈值的字幕 id 集合；无则空集 */
  speedOverIds: Set<string>;
  /** 各字幕阅读速度（字/秒），用于行内角标 */
  speedCpsById: Map<string, number>;
  /** 变化时强制重新滚动到选中行（定位冲突时选中项可能未变） */
  focusNonce: number;
  onSelect: (id: string) => void;
  /** Shift+点击：以当前锚点为起点选择连续区间 */
  onExtendRange: (id: string) => void;
  onSeek: (t: number) => void;
}

export default function CueList({
  cues,
  currentTime,
  selectedId,
  driftRangeIds,
  driftConflictId,
  speedOverIds,
  speedCpsById,
  focusNonce,
  onSelect,
  onExtendRange,
  onSeek
}: CueListProps) {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const selectedRef = useRef<HTMLDivElement | null>(null);
  const driftSet = useMemo(() => new Set(driftRangeIds ?? []), [driftRangeIds]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, focusNonce]);

  return (
    <aside className="cue-list">
      <div className="cue-list-head">
        字幕列表（{sorted.length}）
        <span className="hint">
          {driftRangeIds ? `漂移区间 ${driftRangeIds.length} 条 · Shift+点击调整` : '点击时间码定位 · Shift+点击选区间'}
        </span>
      </div>
      <div className="cue-list-body">
        {sorted.length === 0 && <div className="empty">尚未导入 SRT 文件</div>}
        {sorted.map((cue, i) => {
          const active = currentTime >= cue.start && currentTime < cue.end;
          return (
            <div
              key={cue.id}
              ref={cue.id === selectedId ? selectedRef : null}
              className={[
                'cue-row',
                cue.id === selectedId && 'selected',
                active && 'playing',
                driftSet.has(cue.id) && 'in-drift-range',
                cue.id === driftConflictId && 'drift-conflict',
                speedOverIds.has(cue.id) && 'speed-over'
              ].filter(Boolean).join(' ')}
              onClick={(e) => {
                if (e.shiftKey) onExtendRange(cue.id);
                else onSelect(cue.id);
              }}
            >
              <div className="cue-row-index">{i + 1}</div>
              <button
                className="cue-row-time"
                title="定位到该字幕"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(cue.id);
                  onSeek(cue.start);
                }}
              >
                {secondsToSrtTime(cue.start)}
                <br />
                {secondsToSrtTime(cue.end)}
              </button>
              <div className="cue-row-text">{cue.text}</div>
              <div className="cue-row-dur">
                {(cue.end - cue.start).toFixed(2)}s
                {speedOverIds.has(cue.id) && (
                  <span className="speed-badge" title="阅读速度超过当前阈值（去空白标点后的字素簇数 ÷ 时长）">
                    ⏩ {Number.isFinite(speedCpsById.get(cue.id) ?? 0) ? (speedCpsById.get(cue.id) ?? 0).toFixed(1) : '∞'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
