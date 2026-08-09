import { Check } from 'lucide-react';

interface SelectionBarProps {
  selectedCount: number;
  totalCount: number;
  groupByDevice: boolean;
  onToggleGroupByDevice: () => void;
  onSelectAll: () => void;
  onRemoveSelected: () => void;
  doneCount: number;
  isRendering: boolean;
}

const SelectionBar = ({
  selectedCount,
  totalCount,
  groupByDevice,
  onToggleGroupByDevice,
  onSelectAll,
  onRemoveSelected,
  doneCount,
  isRendering,
}: SelectionBarProps) => {
  const allSelected = selectedCount === totalCount && totalCount > 0;
  const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;

  return (
    <div className="flex h-11 flex-none items-center justify-between gap-4 border-b border-hairline bg-surface-sunken px-5 text-[13px] text-ink-soft">
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="flex flex-none items-center gap-1.5 font-semibold text-ink">
          <span className="flex h-[15px] w-[15px] items-center justify-center rounded bg-accent text-[10px] text-white">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
          {selectedCount} selected
        </span>

        <span className="h-[18px] w-px flex-none bg-hairline" aria-hidden="true" />

        <button
          type="button"
          onClick={onSelectAll}
          className="flex-none transition-colors hover:text-ink"
        >
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>

        <button
          type="button"
          onClick={onToggleGroupByDevice}
          aria-pressed={groupByDevice}
          className={`flex-none transition-colors hover:text-ink ${
            groupByDevice ? 'font-semibold text-accent' : ''
          }`}
        >
          Group by device
        </button>

        <button
          type="button"
          onClick={onRemoveSelected}
          disabled={selectedCount === 0}
          className="flex-none text-danger transition-opacity hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Remove
        </button>
      </div>

      {isRendering && (
        <div className="flex flex-none items-center gap-2.5 font-mono text-[11.5px]">
          <span>
            rendering {doneCount} / {totalCount}
          </span>
          <span
            className="h-[5px] w-[120px] overflow-hidden rounded-full bg-hairline"
            role="progressbar"
            aria-valuenow={doneCount}
            aria-valuemin={0}
            aria-valuemax={totalCount}
            aria-label="Rendering progress"
          >
            <span
              className="block h-full bg-accent transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </span>
        </div>
      )}
    </div>
  );
};

export default SelectionBar;
