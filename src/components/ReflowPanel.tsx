import type { ReflowOptions, ReflowPlan } from '../lib/reflow';
import { REFLOW_MAX_LINES, REFLOW_MIN_LINES } from '../lib/reflow';

interface ReflowPanelProps {
  /** 当前字幕条数（0 时仅提示导入） */
  cueCount: number;
  /** 当前参数（已夹取合法范围） */
  options: ReflowOptions;
  onOptionsChange: (next: ReflowOptions) => void;
  /** 全字幕排版预览；无字幕时为 null */
  plan: ReflowPlan | null;
  /** 一次应用全部可排版且有变化的条目 */
  onApply: () => void;
  /** 点击条目定位字幕（列表 / 时间轴） */
  onLocate: (cueId: string) => void;
}

/**
 * 断行排版面板（停靠在字幕列表旁）：
 * 设置每行最大宽度与最多行数（1～4），预览全部字幕的新旧文本。
 * 原换行与连续空白归一为空格、行首尾去空格；按 Unicode 字素切分，
 * 汉字及全角宽 2、其余宽 1，连续 ASCII 字母数字不拆；
 * 行首 / 行尾禁则见 lib/reflow。选点为全局最优（最少行数 → 剩余宽度平方和
 * 最小 → 断点序列字典序最小），不是逐行贪心。
 * 无解或含尖括号标签的条目保留原文并显示原因，不参与应用；
 * 字幕或参数变化时由 App 立即重算预览。
 */
export default function ReflowPanel(p: ReflowPanelProps) {
  const plan = p.plan;
  const options = p.options;

  return (
    <aside className="reflow-panel">
      <div className="reflow-head">
        断行排版
        <span className="hint" title="只调整字幕文本中的换行与空白，时间码不变">
          纯文本重排
        </span>
      </div>

      <div className="reflow-params">
        <label
          className="reflow-param"
          title="每行最大显示宽度：汉字及全角字符宽 2，其余宽 1（含空格）；连续 ASCII 字母数字不可拆开"
        >
          每行最大宽度
          <input
            type="number"
            min={1}
            max={200}
            step={1}
            value={options.maxWidth}
            onChange={(e) => {
              const v = Math.floor(Number(e.target.value));
              p.onOptionsChange({ ...options, maxWidth: Number.isFinite(v) && v >= 1 ? v : 1 });
            }}
          />
        </label>
        <label
          className="reflow-param"
          title="最多行数 1～4：先取满足宽度与禁则的最少行数"
        >
          最多行数
          <select
            value={options.maxLines}
            onChange={(e) => p.onOptionsChange({ ...options, maxLines: Number(e.target.value) })}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n} disabled={n < REFLOW_MIN_LINES || n > REFLOW_MAX_LINES}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="reflow-summary">
        {p.cueCount === 0
          ? '尚未导入 SRT 文件'
          : plan
            ? `共 ${plan.entries.length} 条 · 可排版 ${plan.entries.length - plan.skippedCount} 条 · 将改 ${plan.changedCount} 条 · 保留原文 ${plan.skippedCount} 条`
            : ''}
      </div>

      <div className="reflow-body">
        {p.cueCount === 0 && <div className="empty">导入 SRT 后，这里预览全部字幕在当前宽度 / 行数下的新旧文本</div>}
        {plan?.entries.map((e) => (
          <div
            key={e.cueId}
            className={['reflow-row', e.ok ? 'ok' : 'skip', e.newText === e.oldText && e.ok && 'same'].filter(Boolean).join(' ')}
            onClick={() => p.onLocate(e.cueId)}
            title="点击定位到该字幕"
          >
            <div className="reflow-row-top">
              <span className="reflow-idx">#{e.index}</span>
              {e.ok ? (
                <span className="reflow-badge ok">
                  {e.newText === e.oldText ? '无需改动' : `${e.lines.length} 行 · 宽 ${e.widths.join('/')}`}
                </span>
              ) : (
                <span className="reflow-badge skip" title={e.reason ?? ''}>
                  保留原文
                </span>
              )}
            </div>
            <div className="reflow-pair">
              <div className="reflow-text old" title="原文本">
                {e.oldText}
              </div>
              {e.ok ? (
                <div className="reflow-text new" title="排版后文本（应用后写入字幕，仅改文本）">
                  {e.lines.length === 0 ? <span className="reflow-blank">（空文本）</span> : e.newText}
                </div>
              ) : (
                <div className="reflow-reason">⛔ {e.reason}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="reflow-foot">
        <button
          className="btn primary mini"
          disabled={!plan || plan.changedCount === 0}
          onClick={p.onApply}
          title={
            plan && plan.changedCount > 0
              ? `把 ${plan.changedCount} 条可排版字幕的文本替换为预览结果（时间码不变，作为一次历史操作，可撤销/重做）`
              : '当前没有文本会发生变化的可排版条目'
          }
        >
          应用全部可排版条目{plan && plan.changedCount > 0 ? `（${plan.changedCount}）` : ''}
        </button>
        <span className="reflow-foot-hint">
          仅改文本 · 一次历史操作可撤销/重做 · 现有 SRT 导出使用新文本
        </span>
      </div>
    </aside>
  );
}
