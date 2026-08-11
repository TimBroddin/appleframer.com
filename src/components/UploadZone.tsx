import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';

interface UploadZoneProps {
  onFilesSelected: (files: File[]) => void;
}

const UploadZone = ({ onFilesSelected }: UploadZoneProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Accept a drop anywhere on the page, not just on the dashed box — the copy
  // promises as much, and aiming for a target is needless work. Bound to the
  // window so the whole document is live, including the content below the fold.
  useEffect(() => {
    // dragenter/dragleave fire for every element crossed, so count depth rather
    // than clearing the state on the first leave.
    let depth = 0;

    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setIsDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      // Without this the browser navigates to the dropped file.
      event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setIsDragging(false);
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setIsDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) onFilesSelected(files);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFilesSelected]);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      onFilesSelected(Array.from(e.target.files));
    }
    // Allow re-selecting the same file after a removal.
    e.target.value = '';
  };

  return (
    // Two columns inside one viewport: the drop target on the left, the
    // explanation on the right. Stacks on narrow screens, where a side-by-side
    // split would leave both halves too cramped to read. Height comes from the
    // flex parent rather than a viewport calc, so it stays correct if the
    // header or footer height changes.
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-[22px] lg:flex-row lg:gap-8">
      <div
        className={`flex min-h-[340px] flex-1 flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border-2 border-dashed transition-colors lg:min-h-0 ${
          isDragging ? 'border-accent bg-accent-wash' : 'border-hairline bg-surface'
        }`}
      >
        <BeforeAfter />

        <h1 className="m-0 mt-1 max-w-[24ch] text-center text-[26px] font-bold leading-tight tracking-[-0.025em] text-ink">
          Put your screenshots and videos in an iPhone
        </h1>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="mt-1 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-deep"
        >
          Choose screenshots
        </button>

        {/* The input has accepted video since framing shipped, but every visible
            word said "screenshots", so nobody had reason to try one. Naming it
            here is the only place a first-time visitor would find out.

            Kept to one short clause: the longer phrasing wrapped on a 390px
            viewport and pushed past the dashed drop target's edge. */}
        <span className="max-w-full px-4 text-center text-[13px] text-ink-faint">
          or drag them anywhere — recordings too
        </span>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          // Videos are framed too, so an image-only filter would let them be
          // dropped but not chosen through the picker.
          accept="image/*,video/*"
          className="hidden"
          onChange={handleFileInputChange}
        />
      </div>

      <LandingContent />
    </div>
  );
};

/**
 * Shows the transformation instead of describing it: a bare screenshot, an
 * arrow, and the same screenshot inside a real device frame. Landing on the
 * page with no text read, this is what tells you what the tool does.
 *
 * The right-hand side composites the actual frame asset over the same image the
 * left side shows, so it is a genuine example rather than an illustration.
 */
/**
 * Both images are real: a screenshot at true iPhone 16 Pro Max dimensions
 * (1320x2868), and that same file after being run through this tool, frame
 * asset and all. The "after" is literally the app's own output rather than a
 * drawing of it.
 *
 * items-end aligns the two devices on a shared baseline so the captions line up
 * despite the different heights.
 */
const BeforeAfter = () => (
  <div className="flex items-end gap-5 sm:gap-8" aria-hidden="true">
    {/* Smaller and squared-off, so it reads as a bare file next to the framed
        version rather than as a second phone. */}
    <div className="flex flex-col items-center gap-2.5">
      <img
        src="/hero-screenshot.png"
        alt=""
        width={134}
        height={291}
        className="h-[13vh] max-h-[142px] min-h-[86px] w-auto rounded-[2px] ring-1 ring-hairline"
      />
      <span className="font-mono text-2xs text-ink-faint">your screenshot</span>
    </div>

    <ArrowRight className="mb-10 h-5 w-5 flex-none text-ink-faint" />

    <div className="flex flex-col items-center gap-2.5">
      <img
        src="/hero-framed.png"
        alt=""
        width={210}
        height={436}
        className="h-[19.5vh] max-h-[212px] min-h-[128px] w-auto"
      />
      <span className="font-mono text-2xs text-accent">what you get</span>
    </div>
  </div>
);

/**
 * Short facts, not paragraphs. Six equal-weight feature blocks read as a wall
 * of grey; a tight list with the claim in front and the detail after scans in
 * a fraction of the time.
 */
const FACTS: Array<{ claim: string; detail: string }> = [
  {
    claim: 'Picks the device for you',
    detail: 'matched on the screenshot’s exact dimensions',
  },
  {
    claim: 'Takes a whole set at once',
    detail: 'mixed devices, downloaded as one ZIP',
  },
  // Named as "screen recordings" rather than "video": that is the file people
  // actually have, and it says what the input is instead of what the feature is.
  {
    claim: 'Frames screen recordings too',
    detail: 'exported as an MP4 with the sound kept',
  },
  {
    claim: 'iPhone, iPad and Apple Watch',
    detail: 'iPhone 8 through 17 and Air, every current iPad, Series and Ultra',
  },
  {
    claim: 'Never leaves your machine',
    detail: 'there is no server to upload to',
  },
  {
    claim: 'Free, no account, no watermark',
    detail: 'open source and MIT licensed',
  },
];

const STEPS = [
  'Drop your screenshots or screen recordings in, or paste them from the clipboard.',
  'Each one gets matched to a device. Change any of them in the panel on the right.',
  'Pick a background and how files are named, then download one or the whole batch.',
];

/**
 * Below-the-fold content. The app is a single view with almost no text, which
 * leaves search engines nothing to rank; this gives them the terms people
 * actually search for without cluttering the tool.
 */
const LandingContent = () => (
  // Scrolls within its own column so the page as a whole stays one screen tall.
  <div className="flex flex-col gap-8 lg:w-[400px] lg:flex-none lg:overflow-y-auto lg:pr-2 xl:w-[440px]">
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-[21px] font-bold leading-tight tracking-[-0.025em] text-ink">
        Device frames for App&nbsp;Store screenshots
      </h2>
      {/* One lead sentence at larger size carries the pitch; the supporting
          detail drops back so the two are not competing. */}
      <p className="m-0 text-[15.5px] leading-[1.6] text-ink">
        A screenshot on its own is just a rectangle. Put it in the phone it came
        from and it reads as a real app.
      </p>
      <p className="m-0 text-[14px] leading-relaxed text-ink-soft">
        AppleFramer does that for iPhone, iPad and Apple Watch, and exports a PNG
        on a transparent or solid background. Screen recordings work the same
        way and come back as an MP4.
      </p>
    </section>

    <section className="flex flex-col gap-3.5">
      <h3 className="m-0 font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
        How it works
      </h3>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {STEPS.map((step, index) => (
          <li
            key={step}
            className="flex gap-3 text-[14px] leading-relaxed text-ink-soft"
          >
            <span className="mt-px flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-accent font-mono text-2xs font-semibold text-white">
              {index + 1}
            </span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
    </section>

    {/* A checked list rather than six paragraphs: the claim reads first, the
        detail sits behind it in lighter type for anyone who wants it. */}
    <section className="flex flex-col gap-3 border-t border-hairline pt-6">
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {FACTS.map((fact) => (
          <li key={fact.claim} className="flex gap-2.5">
            <Check
              className="mt-[3px] h-3.5 w-3.5 flex-none text-accent"
              strokeWidth={3}
            />
            <span className="text-[14px] leading-snug">
              <span className="font-semibold text-ink">{fact.claim}</span>
              <span className="text-ink-faint"> — {fact.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  </div>
);

export default UploadZone;
