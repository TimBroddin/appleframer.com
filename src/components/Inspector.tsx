import { useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { DeviceFrame } from '../hooks/useFrames';
import { QueueItem, findSibling, frameLabelDetailed, isVideoFile } from '../lib/queue';
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
    const framed = selectedItems.filter((item) => item.frame);
    if (framed.length === 0) return null;
    const first = framed[0].frame;
    return framed.every((item) => item.frame?.id === first?.id) ? first ?? null : null;
  }, [selectedItems]);

  const categories = useMemo(
    () => Array.from(new Set(frames.map((frame) => frame.category))),
    [frames]
  );

  /**
   * Physical device sizes for the current model — iPad Pro 13" vs 11", Watch
   * 45mm vs 41mm. The old settings modal surfaced this as its own "Size"
   * section; it deserves a row here rather than only living in the model
   * popover's third column.
   */
  const sizes = useMemo(() => {
    if (!commonFrame) return [];
    return Array.from(
      new Set(
        frames
          .filter(
            (f) =>
              f.category === commonFrame.category &&
              f.model === commonFrame.model &&
              f.version === commonFrame.version &&
              f.variant
          )
          .map((f) => f.variant as string)
      )
    );
  }, [frames, commonFrame]);

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

  /**
   * Whether the transparent swatch is currently promising something an MP4
   * cannot deliver. H.264 carries no alpha, so a video exported with
   * transparency selected gets an opaque background regardless; saying so here
   * is what keeps the control from quietly meaning two different things
   * depending on the file type. Stills are unaffected — a transparent PNG is a
   * real deliverable — so the note appears only when a video is actually queued.
   */
  const transparentVideoNote = backgroundColor === null && items.some((item) => isVideoFile(item.file));
  // Unmatched images never render, so promising to zip them would be a lie. A
  // video whose encode FAILED is the same lie by a different route: it has a
  // device, so it counted here, but there is no MP4 to put in the archive and
  // the zip drops it. Excluding it is what makes this number match what the
  // download actually contains. A still that errored is left in — its render is
  // retried at export time and usually succeeds, so it is not a certain miss.
  const downloadableCount = items.filter(
    (item) =>
      item.status !== 'unmatched' && !(item.status === 'error' && isVideoFile(item.file))
  ).length;

  return (
    // relative + z-10 gives the inspector its own stacking context so its
    // popovers paint above the contact sheet, which is a sibling flex child.
    // Stacked full-width below lg, a fixed side column above it. Without this
    // the 316px width squeezed the sheet to nothing on a phone.
    <aside className="relative z-10 flex max-h-[55vh] w-full flex-none flex-col border-t border-hairline bg-surface lg:max-h-none lg:w-[316px] lg:border-l lg:border-t-0">
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

            {sizes.length > 1 && commonFrame && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-2 text-[13px]">
                <span className="flex-none text-ink-soft">Size</span>
                <span className="flex flex-wrap justify-end gap-1">
                  {sizes.map((size) => {
                    const active = commonFrame.variant === size;
                    return (
                      <button
                        key={size}
                        type="button"
                        onClick={() => {
                          const sibling = findSibling(frames, commonFrame, {
                            variant: size,
                          });
                          if (sibling) onSetFrame(sibling);
                        }}
                        className={`rounded-md px-2 py-1 text-sm-minus transition-colors ${
                          active
                            ? 'bg-accent font-semibold text-white'
                            : 'bg-surface-muted text-ink-soft hover:text-ink'
                        }`}
                      >
                        {size}
                      </button>
                    );
                  })}
                </span>
              </div>
            )}

            {colors.length > 0 && commonFrame && (
              // The selected finish is named rather than left to a tooltip:
              // three unlabelled swatches do not read as a colour control, and
              // "Cosmic Orange" is not guessable from an 18px circle.
              <div className="flex flex-col gap-2 rounded-lg border border-hairline px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="flex-none text-ink-soft">Finish</span>
                  <span className="truncate font-semibold text-ink" title={commonFrame.color}>
                    {commonFrame.color}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {colors.map((color) => {
                    const sibling = findSibling(frames, commonFrame, { color });
                    const active = commonFrame.color === color;
                    return (
                      <button
                        key={color}
                        type="button"
                        title={color}
                        aria-label={color}
                        aria-pressed={active}
                        disabled={!sibling}
                        onClick={() => sibling && onSetFrame(sibling)}
                        style={{ background: colorSwatch(color) }}
                        className={`h-[22px] w-[22px] rounded-full border border-black/10 transition-shadow ${
                          active
                            ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface'
                            : 'hover:ring-2 hover:ring-hairline hover:ring-offset-2 hover:ring-offset-surface'
                        } ${sibling ? '' : 'cursor-not-allowed opacity-40'}`}
                      />
                    );
                  })}
                </div>
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

          {transparentVideoNote && (
            <p className="text-xs-plus leading-snug text-ink-faint">
              Video has no transparency — MP4 exports get a white background. PNGs stay
              transparent.
            </p>
          )}
        </div>

        <NamingComposer tokens={tokens} onChange={onSetTokens} preview={namePreview} />
      </div>

      <div className="flex flex-none flex-col gap-2 border-t border-hairline bg-surface-sunken p-[18px] pt-3.5">
        <button
          type="button"
          onClick={onDownloadAll}
          disabled={downloadableCount === 0 || isDownloading}
          className="w-full rounded-[9px] bg-accent py-3 text-[14.5px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDownloading ? 'Preparing…' : `Download ${downloadableCount} as zip`}
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
/**
 * Approximate swatch colour for an Apple finish name.
 *
 * Exact names come first: several finishes share a word ("Mist Blue" vs "Sky
 * Blue" vs "Deep Blue") and would otherwise collapse to one indistinguishable
 * swatch. The keyword fallbacks below cover finishes added to Frames.json
 * later.
 */
const FINISH_SWATCHES: Record<string, string> = {
  // iPhone 17 Pro / Pro Max
  'cosmic orange': '#c8622b',
  'deep blue': '#3b4a6b',
  silver: '#d5d3ce',
  // iPhone 17
  black: '#2a2a2c',
  lavender: '#cdc3e0',
  'mist blue': '#c2d3e0',
  sage: '#c3cfbd',
  white: '#f0eeea',
  // iPhone Air
  'cloud white': '#eae7e0',
  'light gold': '#d8c095',
  'sky blue': '#a8c4d9',
  'space black': '#26262a',
};

function colorSwatch(color: string): string {
  const key = color.toLowerCase().trim();
  const exact = FINISH_SWATCHES[key];
  if (exact) return exact;

  if (key.includes('orange')) return '#c8622b';
  if (key.includes('blue')) return '#3b4a6b';
  if (key.includes('silver')) return '#d5d3ce';
  if (key.includes('black') || key.includes('space')) return '#26262a';
  if (key.includes('white') || key.includes('starlight')) return '#eae7e0';
  if (key.includes('gold')) return '#d8c095';
  if (key.includes('titanium') || key.includes('natural')) return '#9d968a';
  return '#6d6862';
}

export default Inspector;
