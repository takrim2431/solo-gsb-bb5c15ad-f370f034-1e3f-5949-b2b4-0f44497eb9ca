import { useEffect, useMemo, useState } from 'react';
import type { Cue } from '../types';
import { secondsToSrtTime } from '../lib/srt';
import { refItemKey, type RefDiffItem, type RefDiffStats } from '../lib/refdiff';

interface RefDiffPanelProps {
  /** 参考轨文件名；未载入为 null */
  refName: string | null;
  /** 参考轨字幕条数 */
  refCount: number;
  /** 当前轨字幕（用于换算列表序号） */
  currentCues: Cue[];
  /** 参考轨字幕（用于换算参考侧序号） */
  refCues: Cue[];
  /** 配对统计与差异条目；未载入参考轨为 null */
  stats: RefDiffStats | null;
  /** 起止偏差阈值（秒，起点或终点偏差严格大于阈值即列出） */
  threshold: number;
  onThresholdChange: (v: number) => void;
  /** 导入参考 SRT（只替换参考轨，不替换正在校对的字幕） */
  onImport: (file: File) => void;
  /** 清空参考轨与审阅状态 */
  onClear: () => void;
  /** 点击条目：定位时间轴（当前侧有对应字幕时同时选中） */
  onLocate: (item: RefDiffItem) => void;
}

type Filter = 'all' | RefDiffItem['kind'];

/** 带符号毫秒差：+120ms / −80ms */
function formatDelta(delta: number): string {
  const ms = Math.round(delta * 1000);
  return `${ms >= 0 ? '+' : '−'}${Math.abs(ms)}ms`;
}

function timeIndexMap(cues: Cue[]): Map<string, number> {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  return new Map(sorted.map((c, i) => [c.id, i + 1]));
}

function TimeRange({ cue }: { cue: Cue | null }) {
  if (!cue) return <span className="refdiff-time none">—</span>;
  return (
    <span className="refdiff-time">
      {secondsToSrtTime(cue.start)} → {secondsToSrtTime(cue.end)}
    </span>
  );
}

/**
 * 参考字幕差异审阅面板（停靠在舞台底部）：
 * 在当前工作区之外载入一份参考 SRT 做一对一单调配对，列出当前独有、
 * 参考独有与起止偏差超阈值的配对；点击条目定位时间轴并展示两侧时间码。
 * 参考文件与审阅状态只存在于当前页面内存，切换当前 SRT 时由 App 清空。
 */
export default function RefDiffPanel(p: RefDiffPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  // 载入 / 清空参考轨时复位审阅状态；载入后自动展开结果列表
  useEffect(() => {
    setFocusedKey(null);
    setFilter('all');
    if (p.refName !== null) setCollapsed(false);
  }, [p.refName]);

  const currentIndex = useMemo(() => timeIndexMap(p.currentCues), [p.currentCues]);
  const refIndex = useMemo(() => timeIndexMap(p.refCues), [p.refCues]);

  const items = p.stats?.items ?? [];
  const visible = filter === 'all' ? items : items.filter((it) => it.kind === filter);
  const focusedItem = items.find((it) => refItemKey(it) === focusedKey) ?? null;

  const handleClick = (item: RefDiffItem) => {
    setFocusedKey(refItemKey(item));
    p.onLocate(item);
  };

  const tabs: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'all', label: '全部', count: items.length },
    { key: 'pair', label: '偏差超限', count: p.stats?.deviated ?? 0 },
    { key: 'current-only', label: '当前独有', count: p.stats?.currentOnly ?? 0 },
    { key: 'reference-only', label: '参考独有', count: p.stats?.referenceOnly ?? 0 }
  ];

  const importButton = (
    <label className="btn mini primary">
      {p.refName ? '更换参考' : '导入参考 SRT'}
      <input
        type="file"
        accept=".srt,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) p.onImport(f);
          e.target.value = '';
        }}
      />
    </label>
  );

  const focusedCur =
    focusedItem?.kind === 'pair'
      ? focusedItem.pair.current
      : focusedItem?.kind === 'current-only'
        ? focusedItem.cue
        : null;
  const focusedRef =
    focusedItem?.kind === 'pair'
      ? focusedItem.pair.reference
      : focusedItem?.kind === 'reference-only'
        ? focusedItem.cue
        : null;

  return (
    <section className="refdiff-dock">
      <div className="refdiff-head">
        <button
          className="btn mini refdiff-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开差异列表' : '收起差异列表'}
          disabled={!p.refName}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="refdiff-title">🆚 参考字幕差异审阅</span>
        {p.refName ? (
          <>
            <span className="refdiff-file" title={p.refName}>
              {p.refName}（{p.refCount} 条）
            </span>
            <span className="refdiff-summary">
              配对 {p.stats?.paired ?? 0} 对 · 偏差超限 {p.stats?.deviated ?? 0} · 当前独有{' '}
              {p.stats?.currentOnly ?? 0} · 参考独有 {p.stats?.referenceOnly ?? 0}
            </span>
            <label className="refdiff-threshold" title="起点或终点偏差严格大于该阈值的已配对条目才会被列出">
              偏差阈值
              <input
                type="number"
                min={0}
                max={60}
                step={0.1}
                value={p.threshold}
                onChange={(e) => p.onThresholdChange(Math.max(0, Number(e.target.value) || 0))}
              />
              s
            </label>
            <span className="refdiff-tabs">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  className={['refdiff-tab', filter === t.key && 'active'].filter(Boolean).join(' ')}
                  onClick={() => setFilter(t.key)}
                >
                  {t.label} {t.count}
                </button>
              ))}
            </span>
            <div className="refdiff-actions">
              {importButton}
              <button className="btn mini" onClick={p.onClear} title="清空参考轨（不影响当前校对内容）">
                清空参考
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="refdiff-hint">未载入参考字幕（仅用于差异审阅，不替换当前校对内容，也不会落盘）</span>
            <div className="refdiff-actions">{importButton}</div>
          </>
        )}
      </div>

      {p.refName && !collapsed && (
        <div className="refdiff-body">
          {focusedItem && (
            <div className="refdiff-focus">
              <span className="refdiff-focus-label">已定位</span>
              <span className="refdiff-side">当前</span>
              <TimeRange cue={focusedCur} />
              <span className="refdiff-side">参考</span>
              <TimeRange cue={focusedRef} />
              {focusedItem.kind === 'pair' && (
                <span className="refdiff-delta">
                  Δ起点 {formatDelta(focusedItem.pair.startDelta)} · Δ终点{' '}
                  {formatDelta(focusedItem.pair.endDelta)}
                </span>
              )}
            </div>
          )}
          <div className="refdiff-list">
            {visible.length === 0 ? (
              <div className="refdiff-empty">
                {items.length === 0
                  ? `两轨 ${p.stats?.paired ?? 0} 对配对的起止偏差均在 ${p.threshold}s 阈值内，且没有任一侧独有的条目`
                  : '该分类下没有条目'}
              </div>
            ) : (
              visible.map((item) => {
                const key = refItemKey(item);
                const cur =
                  item.kind === 'pair'
                    ? item.pair.current
                    : item.kind === 'current-only'
                      ? item.cue
                      : null;
                const ref =
                  item.kind === 'pair'
                    ? item.pair.reference
                    : item.kind === 'reference-only'
                      ? item.cue
                      : null;
                const curNo = cur ? currentIndex.get(cur.id) : undefined;
                const refNo = ref ? refIndex.get(ref.id) : undefined;
                const label =
                  item.kind === 'pair'
                    ? '偏差超限'
                    : item.kind === 'current-only'
                      ? '当前独有'
                      : '参考独有';
                return (
                  <div
                    key={key}
                    className={[
                      'refdiff-row',
                      `kind-${item.kind}`,
                      key === focusedKey && 'focused'
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => handleClick(item)}
                    title="点击定位时间轴（当前侧条目同时在列表与时间轴中选中）"
                  >
                    <div className="refdiff-row-head">
                      <span className={`refdiff-badge ${item.kind}`}>{label}</span>
                      <span className="refdiff-idx">
                        {curNo ? `当前 #${curNo}` : ''}
                        {curNo && refNo ? ' ↔ ' : ''}
                        {refNo ? `参考 #${refNo}` : ''}
                      </span>
                      {item.kind === 'pair' && (
                        <span className="refdiff-delta">
                          Δ起点 {formatDelta(item.pair.startDelta)} · Δ终点{' '}
                          {formatDelta(item.pair.endDelta)}
                        </span>
                      )}
                    </div>
                    <div className="refdiff-times">
                      <span className="refdiff-side">当前</span>
                      <TimeRange cue={cur} />
                      <span className="refdiff-side refdiff-side-ref">参考</span>
                      <TimeRange cue={ref} />
                    </div>
                    <div className="refdiff-text">{(cur ?? ref)?.text ?? ''}</div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </section>
  );
}
