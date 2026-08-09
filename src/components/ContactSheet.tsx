import { Check, Plus } from 'lucide-react';
import { QueueItem, frameLabel } from '../lib/queue';

interface ContactSheetProps {
  items: QueueItem[];
  selectedIds: Set<string>;
  groupByDevice: boolean;
  /** Mirrored behind each thumbnail so cards match the exported PNG. */
  backgroundColor: string | null;
  onToggleSelect: (id: string, event: React.MouseEvent) => void;
  onAddMore: () => void;
}

const STATUS_TEXT: Record<QueueItem['status'], string> = {
  detecting: 'detecting…',
  queued: 'queued',
  rendering: 'rendering',
  done: 'done',
  error: 'failed',
  unmatched: 'no matching device',
};

const STATUS_CLASS: Record<QueueItem['status'], string> = {
  detecting: 'text-ink-faint',
  queued: 'text-ink-faint',
  rendering: 'text-accent',
  done: 'text-ink-soft',
  error: 'text-danger',
  unmatched: 'text-danger',
};

const Card = ({
  item,
  selected,
  backgroundColor,
  onToggleSelect,
}: {
  item: QueueItem;
  selected: boolean;
  backgroundColor: string | null;
  onToggleSelect: (id: string, event: React.MouseEvent) => void;
}) => {
  // Show the framed render once it exists, falling back to the raw screenshot
  // so a card is never empty while the queue works through the batch.
  const src = item.blobUrl ?? item.sourceUrl;

  return (
    <button
      type="button"
      onClick={(event) => onToggleSelect(item.id, event)}
      aria-pressed={selected}
      className={`flex flex-col gap-2.5 rounded-card p-3 text-left transition-shadow ${
        selected
          ? 'border-2 border-accent bg-surface shadow-card'
          : 'border border-hairline bg-surface hover:shadow-card'
      }`}
    >
      <div
        className={`relative flex flex-1 items-center justify-center rounded-lg py-2.5 ${
          backgroundColor ? '' : 'bg-checker'
        }`}
        style={backgroundColor ? { background: backgroundColor } : undefined}
      >
        <span
          className={`absolute left-1.5 top-1.5 flex h-[17px] w-[17px] items-center justify-center rounded-md ${
            selected
              ? 'bg-accent text-white'
              : 'border-[1.5px] border-hairline bg-surface'
          }`}
        >
          {selected && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>

        <img
          src={src}
          alt={item.file.name}
          className={`max-h-[184px] w-auto max-w-full object-contain transition-opacity ${
            item.blobUrl ? 'opacity-100' : 'opacity-40'
          }`}
        />

        {item.status === 'rendering' && (
          <span className="absolute inset-x-2.5 bottom-2 h-[5px] overflow-hidden rounded-full bg-hairline">
            <span className="block h-full w-2/5 animate-af-pulse bg-accent" />
          </span>
        )}
      </div>

      <div className="min-w-0">
        <div className="truncate font-mono text-xs-plus text-ink" title={item.file.name}>
          {item.file.name}
        </div>
        <div className={`mt-0.5 truncate font-mono text-2xs ${STATUS_CLASS[item.status]}`}>
          {/* Without a frame there is no device name to pair with the status,
              so show the status alone rather than "Detecting… · detecting…". */}
          {item.frame
            ? `${frameLabel(item.frame)} · ${STATUS_TEXT[item.status]}`
            : STATUS_TEXT[item.status]}
        </div>
      </div>
    </button>
  );
};

const AddMoreTile = ({ onAddMore }: { onAddMore: () => void }) => (
  <button
    type="button"
    onClick={onAddMore}
    className="flex min-h-[240px] flex-col items-center justify-center gap-1.5 rounded-card border-2 border-dashed border-hairline text-ink-faint transition-colors hover:border-accent hover:text-accent"
  >
    <Plus className="h-5 w-5" />
    <span className="font-mono text-xs-plus">add more</span>
  </button>
);

const ContactSheet = ({
  items,
  selectedIds,
  groupByDevice,
  backgroundColor,
  onToggleSelect,
  onAddMore,
}: ContactSheetProps) => {
  const gridClass =
    'grid grid-cols-2 content-start gap-4 sm:grid-cols-3 xl:grid-cols-4';

  if (!groupByDevice) {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        <div className={gridClass}>
          {items.map((item) => (
            <Card
              key={item.id}
              item={item}
              selected={selectedIds.has(item.id)}
              backgroundColor={backgroundColor}
              onToggleSelect={onToggleSelect}
            />
          ))}
          <AddMoreTile onAddMore={onAddMore} />
        </div>
      </div>
    );
  }

  // Preserve first-appearance order so grouping doesn't reshuffle unexpectedly.
  const groups = new Map<string, QueueItem[]>();
  items.forEach((item) => {
    const key = frameLabel(item.frame);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  });

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-5">
      <div className="flex flex-col gap-6">
        {Array.from(groups.entries()).map(([label, groupItems]) => (
          <section key={label} className="flex flex-col gap-3">
            <h3 className="font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
              {label} · {groupItems.length}
            </h3>
            <div className={gridClass}>
              {groupItems.map((item) => (
                <Card
                  key={item.id}
                  item={item}
                  selected={selectedIds.has(item.id)}
                  backgroundColor={backgroundColor}
                  onToggleSelect={onToggleSelect}
                />
              ))}
            </div>
          </section>
        ))}
        <div className={gridClass}>
          <AddMoreTile onAddMore={onAddMore} />
        </div>
      </div>
    </div>
  );
};

export default ContactSheet;
