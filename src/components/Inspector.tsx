import { useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { DeviceFrame } from '../hooks/useFrames';
import { QueueItem, findSibling, frameLabelDetailed } from '../lib/queue';
import { NameToken } from '../lib/filename';
import DevicePicker from './DevicePicker';
import NamingComposer from './NamingComposer';

interface InspectorProps {
  frames: DeviceFrame[];
  items: QueueItem[];
  selectedItems: QueueItem[];
  onSetFrame: (frame: DeviceFrame) => void;
  backgroundColor: string | null;
  onSetBackgroundColor: (color: string | null) => void;
  tokens: NameToken[];
  onSetTokens: (tokens: NameToken[]) => void;
  namePreview: string;
  onDownloadAll: () => void;
  onDownloadSelected: () => void;
  onCopyImage: () => void;
  isDownloading: boolean;
}

const SWATCHES: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'Transparent' },
  { value: '#ffffff', label: 'White' },
  { value: '#101418', label: 'Black' },
  { value: '#4b31d4', label: 'Indigo' },
];

/** Clipboard image writing is unsupported in Firefox and older Safari. */
const canCopyImage =
  typeof window !== 'undefined' &&
  typeof ClipboardItem !== 'undefined' &&
  Boolean(navigator.clipboard?.write);

const Inspector = ({
  frames,
  items,
  selectedItems,
  onSetFrame,
  backgroundColor,
  onSetBackgroundColor,
  tokens,
  onSetTokens,
  namePreview,
  onDownloadAll,
  onDownloadSelected,
  onCopyImage,
  isDownloading,
}: InspectorProps) => {
  const hexInputRef = useRef<HTMLInputElement>(null);
  const [hexDraft, setHexDraft] = useState('');

  // A single frame only when every selected image agrees; otherwise the
  // controls show a mixed state rather than lying about one of them.
  const commonFrame = useMemo(() => {
    if (selectedItems.length === 0) return null;
    const first = selectedItems[0].frame;
    return selectedItems.every((item) => item.frame.id === first.id) ? first : null;
  }, [selectedItems]);

  const categories = useMemo(
    () => Array.from(new Set(frames.map((frame) => frame.category))),
    [frames]
  );

  const colors = useMemo(() => {
    if (!commonFrame) return [];
    return Array.from(
      new Set(
        frames
          .filter(
            (f) =>
              f.category === commonFrame.category &&
              f.model === commonFrame.model &&
              f.version === commonFrame.version &&
              f.variant === commonFrame.variant &&
              f.color
          )
          .map((f) => f.color as string)
      )
    );
  }, [frames, commonFrame]);

  const orientations = useMemo(() => {
    if (!commonFrame) return [];
    return Array.from(
      new Set(
        frames
          .filter(
            (f) =>
              f.category === commonFrame.category &&
              f.model === commonFrame.model &&
              f.version === commonFrame.version &&
              f.variant === commonFrame.variant &&
              f.color === commonFrame.color &&
              f.orientation
          )
          .map((f) => f.orientation as 'Portrait' | 'Landscape')
      )
    );
  }, [frames, commonFrame]);

  const selectCategory = (category: string) => {
    const target = frames.find((frame) => frame.category === category);
    if (target) onSetFrame(target);
  };

  const applyHex = () => {
    const value = hexDraft.trim();
    const normalised = value.startsWith('#') ? value : `#${value}`;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalised)) {
      onSetBackgroundColor(normalised);
      setHexDraft('');
    }
  };

  const hasSelection = selectedItems.length > 0;

  return (
    // relative + z-10 gives the inspector its own stacking context so its
    // popovers paint above the contact sheet, which is a sibling flex child.
    <aside className="relative z-10 flex w-[316px] flex-none flex-col border-l border-hairline bg-surface">
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-[18px] pb-2">
        <div className="rounded-lg border border-accent-edge bg-accent-wash px-3 py-2.5">
          <div className="font-mono text-2xs uppercase tracking-[0.12em] text-accent">
            {hasSelection ? `editing ${selectedItems.length} selected` : 'nothing selected'}
          </div>
          <div className="mt-1 text-[13.5px] text-ink">
            {!hasSelection
              ? 'Select a card to edit its device'
              : commonFrame
                ? `${selectedItems.length > 1 ? 'all ' : ''}${frameLabelDetailed(commonFrame)}${
                    commonFrame.orientation ? ` · ${commonFrame.orientation}` : ''
                  }`
                : 'Mixed devices'}
          </div>
        </div>

        <fieldset
          disabled={!hasSelection}
          className="flex flex-col gap-[18px] disabled:opacity-50"
        >
          <div className="flex flex-col gap-2.5">
            <div className="font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
              device
            </div>
            <div className="flex gap-1 rounded-lg bg-surface-muted p-[3px]">
              {categories.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => selectCategory(category)}
                  className={`flex-1 rounded-md py-1.5 text-sm-minus transition-colors ${
                    commonFrame?.category === category
                      ? 'bg-accent font-semibold text-white'
                      : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {category}
                </button>
              ))}
            </div>

            <DevicePicker frames={frames} current={commonFrame} onSelect={onSetFrame} />

            {colors.length > 0 && commonFrame && (
              <div className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2.5 text-[13px]">
                <span className="text-ink-soft">Finish</span>
                <span className="flex items-center gap-1.5">
                  {colors.map((color) => {
                    const sibling = findSibling(frames, commonFrame, { color });
                    const active = commonFrame.color === color;
                    return (
                      <button
                        key={color}
                        type="button"
                        title={color}
                        disabled={!sibling}
                        onClick={() => sibling && onSetFrame(sibling)}
                        style={{ background: colorSwatch(color) }}
                        className={`h-[18px] w-[18px] rounded-full transition-shadow ${
                          active ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''
                        } ${sibling ? '' : 'cursor-not-allowed opacity-40'}`}
                      />
                    );
                  })}
                </span>
              </div>
            )}

            {orientations.length > 1 && commonFrame && (
              <div className="flex gap-1.5">
                {orientations.map((orientation) => {
                  const sibling = findSibling(frames, commonFrame, { orientation });
                  const active = commonFrame.orientation === orientation;
                  return (
                    <button
                      key={orientation}
                      type="button"
                      disabled={!sibling}
                      onClick={() => sibling && onSetFrame(sibling)}
                      className={`flex-1 rounded-lg py-2 text-sm-minus transition-colors ${
                        active
                          ? 'border-[1.5px] border-accent bg-accent-wash font-semibold text-accent-deep'
                          : 'border border-hairline text-ink-soft hover:border-accent'
                      } ${sibling ? '' : 'cursor-not-allowed opacity-40'}`}
                    >
                      {orientation}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </fieldset>

        <div className="flex flex-col gap-2.5">
          <div className="font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
            background
          </div>
          <div className="flex flex-wrap items-center gap-[7px]">
            {SWATCHES.map((swatch) => {
              const active = backgroundColor === swatch.value;
              return (
                <button
                  key={swatch.label}
                  type="button"
                  title={swatch.label}
                  onClick={() => onSetBackgroundColor(swatch.value)}
                  style={swatch.value ? { background: swatch.value } : undefined}
                  className={`h-[30px] w-[30px] rounded-lg transition-shadow ${
                    swatch.value === null ? 'bg-checker' : ''
                  } ${
                    active
                      ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface'
                      : 'border border-hairline'
                  }`}
                />
              );
            })}

            <div className="flex items-center">
              <input
                ref={hexInputRef}
                value={hexDraft}
                onChange={(event) => setHexDraft(event.target.value)}
                onBlur={applyHex}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyHex();
                }}
                placeholder="hex"
                aria-label="Custom background colour"
                className="h-[30px] w-[68px] rounded-lg border border-dashed border-hairline bg-transparent px-2 font-mono text-xs-plus text-ink placeholder:text-ink-faint focus:border-solid focus:border-accent focus:outline-none"
              />
            </div>
          </div>
        </div>

        <NamingComposer tokens={tokens} onChange={onSetTokens} preview={namePreview} />
      </div>

      <div className="flex flex-none flex-col gap-2 border-t border-hairline bg-surface-sunken p-[18px] pt-3.5">
        <button
          type="button"
          onClick={onDownloadAll}
          disabled={items.length === 0 || isDownloading}
          className="w-full rounded-[9px] bg-accent py-3 text-[14.5px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDownloading
            ? 'Preparing…'
            : `Download ${items.length} as zip`}
        </button>
        <div className="flex gap-[7px]">
          <button
            type="button"
            onClick={onDownloadSelected}
            disabled={!hasSelection || isDownloading}
            className="flex-1 rounded-[9px] border border-hairline bg-surface py-2.5 text-sm-minus font-semibold text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-1.5">
              <Download className="h-3.5 w-3.5" />
              Selected only
            </span>
          </button>
          <button
            type="button"
            onClick={onCopyImage}
            disabled={selectedItems.length !== 1 || !canCopyImage}
            title={
              !canCopyImage
                ? 'Your browser does not support copying images to the clipboard'
                : selectedItems.length !== 1
                  ? 'Select exactly one image to copy'
                  : undefined
            }
            className="flex-1 rounded-[9px] border border-hairline bg-surface py-2.5 text-sm-minus font-semibold text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            Copy image
          </button>
        </div>
      </div>
    </aside>
  );
};

/** Maps Apple finish names onto approximate swatch colours. */
function colorSwatch(color: string): string {
  const key = color.toLowerCase();
  if (key.includes('orange')) return '#c9622d';
  if (key.includes('blue')) return '#3f4a72';
  if (key.includes('silver')) return '#c9c3b6';
  if (key.includes('black') || key.includes('space')) return '#23211f';
  if (key.includes('white') || key.includes('starlight')) return '#e8e3da';
  if (key.includes('gold')) return '#b99a67';
  if (key.includes('titanium') || key.includes('natural')) return '#9d968a';
  return '#6d6862';
}

export default Inspector;
