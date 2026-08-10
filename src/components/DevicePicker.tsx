import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { DeviceFrame } from '../hooks/useFrames';
import { frameLabel } from '../lib/queue';

interface DevicePickerProps {
  frames: DeviceFrame[];
  /** The frame to show as current, or null when the selection is mixed. */
  current: DeviceFrame | null;
  onSelect: (frame: DeviceFrame) => void;
}

const uniq = <T,>(values: T[]): T[] => Array.from(new Set(values));

/**
 * Model chooser for the inspector.
 *
 * The frame data is a 5-level cascade (category → model → version → variant →
 * colour → orientation) which is too wide for the 316px inspector column, so
 * the row opens a popover. Category and orientation are handled by the
 * inspector's own segmented controls; this popover covers the middle levels.
 */
const DevicePicker = ({ frames, current, onSelect }: DevicePickerProps) => {
  const [open, setOpen] = useState(false);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState<string | null>(null);

  // With a mixed selection there is no meaningful current category, so browse
  // from the category the user last had, defaulting to iPhone rather than
  // whichever category happens to sort first.
  const category =
    current?.category ??
    (frames.some((f) => f.category === 'iPhone') ? 'iPhone' : frames[0]?.category);

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const PANEL_WIDTH = 440;

  // The panel is wider than the 316px inspector and the inspector scrolls, so
  // it renders in a portal and is positioned against the trigger rather than
  // being clipped by the panel's own overflow.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = rootRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
      setPosition({
        top: trigger.bottom + 6,
        left: Math.max(8, Math.min(trigger.right - width, window.innerWidth - width - 8)),
      });
    };
    place();
    window.addEventListener('resize', place);
    // The inspector scrolls, so the trigger moves under a stationary panel.
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Close on Escape or on a pointer press outside. A full-screen click-away
  // overlay would be simpler but sits in the same stacking context as the
  // panel, where it intercepts clicks on the panel's own options.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The panel is portaled, so it is not inside rootRef.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const openPicker = () => {
    // Drafts are per-visit; keeping them across openings shows a cascade that
    // no longer matches the current selection.
    setDraftModel(null);
    setDraftVersion(null);
    setOpen((value) => !value);
  };

  // Each level lists the distinct values available given the levels above it.
  const models = useMemo(
    () => uniq(frames.filter((f) => f.category === category).map((f) => f.model)),
    [frames, category]
  );

  const activeModel = draftModel ?? current?.model ?? models[0];

  const versions = useMemo(
    () =>
      uniq(
        frames
          .filter((f) => f.category === category && f.model === activeModel)
          .map((f) => f.version)
          .filter((v): v is string => Boolean(v))
      ),
    [frames, category, activeModel]
  );

  const activeVersion =
    draftVersion ??
    (versions.includes(current?.version ?? '') ? current?.version ?? null : versions[0] ?? null);

  const variants = useMemo(
    () =>
      uniq(
        frames
          .filter(
            (f) =>
              f.category === category &&
              f.model === activeModel &&
              (versions.length === 0 || f.version === activeVersion)
          )
          .map((f) => f.variant)
          .filter((v): v is string => Boolean(v))
      ),
    [frames, category, activeModel, activeVersion, versions.length]
  );

  /**
   * Resolves a concrete frame from the chosen levels, preferring to keep the
   * current orientation and colour so switching model doesn't silently flip
   * a landscape image back to portrait.
   */
  const commit = (model: string, version: string | null, variant: string | null) => {
    const candidates = frames.filter(
      (f) =>
        f.category === category &&
        f.model === model &&
        (version === null || f.version === version) &&
        (variant === null || f.variant === variant)
    );
    if (candidates.length === 0) return;

    const preferred =
      candidates.find(
        (f) =>
          (!current?.orientation || f.orientation === current.orientation) &&
          (!current?.color || f.color === current.color)
      ) ??
      candidates.find((f) => !current?.orientation || f.orientation === current.orientation) ??
      candidates[0];

    onSelect(preferred);
    setOpen(false);
    setDraftModel(null);
    setDraftVersion(null);
  };

  const rowLabel = current ? frameLabel(current) : 'Mixed';

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={openPicker}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg border border-hairline px-3 py-2.5 text-[13px] transition-colors hover:border-accent"
      >
        <span className="text-ink-soft">Model</span>
        <span className="flex items-center gap-1 font-semibold text-ink">
          {rowLabel}
          <ChevronDown className="h-3.5 w-3.5" />
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{ top: position.top, left: position.left, width: PANEL_WIDTH }}
            className="fixed z-50 flex max-w-[calc(100vw-1rem)] animate-fadeIn rounded-panel border border-hairline bg-surface shadow-panel"
          >
            <Column
              title="model"
              values={models}
              active={activeModel}
              onSelect={(model) => {
                setDraftModel(model);
                setDraftVersion(null);
                const nextVersions = uniq(
                  frames
                    .filter((f) => f.category === category && f.model === model)
                    .map((f) => f.version)
                    .filter((v): v is string => Boolean(v))
                );
                const nextVariants = uniq(
                  frames
                    .filter((f) => f.category === category && f.model === model)
                    .map((f) => f.variant)
                    .filter((v): v is string => Boolean(v))
                );
                // Commit immediately when there is nothing left to disambiguate.
                if (nextVersions.length <= 1 && nextVariants.length === 0) {
                  commit(model, nextVersions[0] ?? null, null);
                }
              }}
            />
            {versions.length > 0 && (
              <Column
                title="version"
                values={versions}
                active={activeVersion}
                onSelect={(version) => {
                  setDraftVersion(version);
                  const nextVariants = uniq(
                    frames
                      .filter(
                        (f) =>
                          f.category === category &&
                          f.model === activeModel &&
                          f.version === version
                      )
                      .map((f) => f.variant)
                      .filter((v): v is string => Boolean(v))
                  );
                  if (nextVariants.length === 0) commit(activeModel, version, null);
                }}
              />
            )}
            {variants.length > 0 && (
              <Column
                title="size"
                values={variants}
                active={current?.variant ?? null}
                onSelect={(variant) => commit(activeModel, activeVersion, variant)}
              />
            )}
          </div>,
          document.body
        )}
    </div>
  );
};

const Column = ({
  title,
  values,
  active,
  onSelect,
}: {
  title: string;
  values: string[];
  active: string | null;
  onSelect: (value: string) => void;
}) => (
  <div className="max-h-[280px] flex-1 overflow-y-auto border-r border-hairline p-1.5 last:border-r-0">
    <div className="px-1.5 pb-1 font-mono text-2xs uppercase tracking-[0.12em] text-ink-faint">
      {title}
    </div>
    {values.map((value) => (
      <button
        key={value}
        type="button"
        onClick={() => onSelect(value)}
        className={`block w-full truncate rounded px-1.5 py-1 text-left text-[13px] transition-colors ${
          value === active
            ? 'bg-accent-wash font-semibold text-accent-deep'
            : 'text-ink hover:bg-surface-muted'
        }`}
      >
        {value}
      </button>
    ))}
  </div>
);

export default DevicePicker;
