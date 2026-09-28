import { useState } from 'react';
import type { TypesetEntry } from '../lib/typeset';
import {
  MAX_MAX_LINES,
  MAX_MAX_WIDTH,
  MIN_MAX_LINES,
  MIN_MAX_WIDTH
} from '../lib/typeset';

interface TypesetPanelProps {
  /** 当前字幕条数（0 时面板仅提示） */
  cueCount: number;
  /** 每行最大宽度（汉字 / 全角宽 2，其余宽 1） */
  maxWidth: number;
  /** 最多行数（1～4） */
  maxLines: number;
  onMaxWidthChange: (v: number) => void;
  onMaxLinesChange: (v: number) => void;
  /** 全部条目的排版预览（字幕或参数变化后由 App 重算，时间序） */
  entries: TypesetEntry[];
  /** 当前全局选中字幕（高亮 + 同步选择） */
  selectedId: string | null;
  /** 点击条目：选中并滚动到对应字幕 */
  onSelect: (id: string) => void;
  /** 一次应用全部可排版且有改动的条目（一次历史操作） */
  onApply: () => void;
}

/**
 * 断行排版面板（位于字幕列表旁）：
 * 设置每行最大宽度与最多行数（1～4），实时预览全部字幕的新旧文本——
 * 空白归一、按 Unicode 字素簇切分、连续 ASCII 字母数字不拆开、行首 / 行尾禁排；
 * 全局动态规划先取最少行数、再最小化各行剩余宽度平方和、同分取断点序列字典序最小。
 * 无解或含尖括号标签的条目保留原文并显示原因，不参与应用；可一次应用全部可排版条目，
 * 只改文本，作为一次现有历史操作（可撤销 / 重做，SRT 导出使用新文本）。
 */
export default function TypesetPanel(p: TypesetPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'changed' | 'kept'>('all');

  const changed = p.entries.filter((e) => e.status === 'ok' && e.changed);
  const kept = p.entries.filter((e) => e.status !== 'ok');
  const changedIds = new Set(changed.map((e) => e.cueId));
  const keptIds = new Set(kept.map((e) => e.cueId));

  const shown = p.entries.filter((e) => {
    if (filter === 'changed') return changedIds.has(e.cueId);
    if (filter === 'kept') return keptIds.has(e.cueId);
    return true;
  });

  const widthInput = (
    <input
      type="number"
      min={MIN_MAX_WIDTH}
      max={MAX_MAX_WIDTH}
      step={1}
      value={p.maxWidth}
      onChange={(e) => {
        const v = Math.floor(Number(e.target.value));
        if (Number.isFinite(v)) p.onMaxWidthChange(Math.min(MAX_MAX_WIDTH, Math.max(MIN_MAX_WIDTH, v)));
      }}
      aria-label="每行最大宽度"
    />
  );

  return (
    <aside className="typeset-panel">
      <div className="typeset-head">
        <button
          className="btn mini typeset-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开断行排版面板' : '收起断行排版面板'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="typeset-title">↩ 断行排版</span>
        <span className="typeset-summary">
          {p.cueCount === 0
            ? '尚未导入字幕'
            : `${changed.length} 条待改${kept.length > 0 ? ` · ${kept.length} 条保留` : ''}`}
        </span>
      </div>

      {!collapsed && (
        <>
          <div className="typeset-params">
            <label
              className="typeset-param"
              title="每行最大宽度：汉字 / 全角字符宽 2，其余宽 1（连续 ASCII 字母数字作为整体计入）"
            >
              每行最大宽度
              {widthInput}
            </label>
            <label
              className="typeset-param"
              title="最多行数 1～4；在宽度与行数限制内先取最少行数，再使各行剩余宽度平方和最小"
            >
              最多行数
              <input
                type="number"
                min={MIN_MAX_LINES}
                max={MAX_MAX_LINES}
                step={1}
                value={p.maxLines}
                onChange={(e) => {
                  const v = Math.floor(Number(e.target.value));
                  if (Number.isFinite(v)) p.onMaxLinesChange(Math.min(MAX_MAX_LINES, Math.max(MIN_MAX_LINES, v)));
                }}
                aria-label="最多行数"
              />
            </label>
            <button
              className="btn primary mini typeset-apply"
              onClick={p.onApply}
              disabled={changed.length === 0}
              title={
                changed.length > 0
                  ? `把 ${changed.length} 条字幕的断行结果作为一次历史操作提交（只改文本，可撤销/重做）`
                  : '当前没有需要改动的可排版条目'
              }
            >
              应用全部（{changed.length}）
            </button>
          </div>

          <div className="typeset-rules">
            空白归一为空格 · 字素簇切分 · 汉字/全角宽 2 · ASCII 字母数字不拆 · 行首禁「，。！？；：、）】」 · 行尾禁「（【」
          </div>

          {p.cueCount === 0 ? (
            <div className="typeset-body">
              <div className="empty">导入 SRT 后，这里按宽度与行数限制实时预览全部字幕的新旧文本。</div>
            </div>
          ) : (
            <>
              <div className="typeset-filter">
                {(['all', 'changed', 'kept'] as const).map((f) => (
                  <button
                    key={f}
                    className={['typeset-filter-btn', filter === f && 'active'].filter(Boolean).join(' ')}
                    onClick={() => setFilter(f)}
                  >
                    {f === 'all' ? `全部 ${p.entries.length}` : f === 'changed' ? `待改 ${changed.length}` : `保留 ${kept.length}`}
                  </button>
                ))}
              </div>
              <div className="typeset-body">
                {shown.length === 0 && <div className="empty">该分类下没有条目</div>}
                {shown.map((e) => (
                  <TypesetRow key={e.cueId} entry={e} selected={e.cueId === p.selectedId} onSelect={p.onSelect} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}

function TypesetRow({
  entry,
  selected,
  onSelect
}: {
  entry: TypesetEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const kept = entry.status !== 'ok';
  return (
    <div
      className={['typeset-row', kept ? 'kept' : entry.changed ? 'changed' : 'same', selected && 'selected']
        .filter(Boolean)
        .join(' ')}
      onClick={() => onSelect(entry.cueId)}
      title="点击在字幕列表与时间轴中定位该条"
    >
      <div className="typeset-row-head">
        <span className="typeset-idx">#{entry.index}</span>
        {kept ? (
          <span className="typeset-badge keep" title={entry.reason ?? undefined}>
            {entry.status === 'tag' ? '含标签 · 保留' : '无解 · 保留'}
          </span>
        ) : entry.changed ? (
          <span className="typeset-badge change">
            {entry.lineCount} 行{entry.lineWidths ? ` · 宽 ${entry.lineWidths.join('/')}` : ''}
          </span>
        ) : (
          <span className="typeset-badge same">无需改动</span>
        )}
      </div>

      <div className="typeset-text-col">
        <span className="typeset-col-label">原</span>
        <div className="typeset-text old">{entry.oldText || '（空文本）'}</div>
      </div>

      {kept ? (
        <div className="typeset-reason">⛔ {entry.reason}</div>
      ) : (
        <div className="typeset-text-col">
          <span className="typeset-col-label">新</span>
          <div className="typeset-text new">
            {entry.lines && entry.lines.length > 0 ? entry.lines.join('\n') : '（空文本）'}
          </div>
        </div>
      )}
    </div>
  );
}
