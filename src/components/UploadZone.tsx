import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';

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
    // The drop target fills the first screen, with supporting content below the
    // fold: search engines get real text to index, without pushing the tool
    // itself down the page. The document scrolls, not this element — App drops
    // its fixed-height shell while the sheet is empty.
    <div className="flex flex-1 flex-col">
      {/* 54px header + 36px footer. */}
      <div className="flex min-h-[calc(100vh-90px)] p-[22px]">
        <div
          className={`flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed transition-colors ${
            isDragging ? 'border-accent bg-accent-wash' : 'border-hairline bg-surface'
          }`}
        >
          <BeforeAfter />

          <h1 className="m-0 mt-1 max-w-[20ch] text-center text-[28px] font-bold leading-tight tracking-[-0.025em] text-ink">
            Put your screenshots in an iPhone
          </h1>
          <p className="m-0 max-w-[42ch] text-center text-[15px] leading-relaxed text-ink-soft">
            Drop in a screenshot and get it back inside the device it came from,
            ready for the App Store. Works for iPad and Apple Watch too.
          </p>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-deep"
          >
            Choose screenshots
          </button>

          <span className="text-[13px] text-ink-faint">
            or drag them anywhere on this page
          </span>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={handleFileInputChange}
          />
        </div>
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
        className="h-[118px] w-auto rounded-[2px] ring-1 ring-hairline sm:h-[142px]"
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
        className="h-[176px] w-auto sm:h-[212px]"
      />
      <span className="font-mono text-2xs text-accent">what you get</span>
    </div>
  </div>
);

const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: 'Picks the device for you',
    body: 'The screenshot’s dimensions say which device it came from, so you rarely have to choose one yourself.',
  },
  {
    title: 'Handles a whole set',
    body: 'Drop in every screenshot at once, mixed devices and all, and download them as a ZIP.',
  },
  {
    title: 'Every current Apple device',
    body: 'iPhone 8 through 17, iPhone Air and the SE; iPad Pro, Air, mini and the base model; Apple Watch Series and Ultra — portrait and landscape.',
  },
  {
    title: 'Stays on your machine',
    body: 'There is no server to upload to. The framing happens in your browser, so unreleased work never leaves your laptop.',
  },
  {
    title: 'No account, no watermark',
    body: 'Nothing to sign up for and no limit on how much you export.',
  },
  {
    title: 'Open source',
    body: 'MIT licensed and on GitHub, so you can read exactly what it does with your images.',
  },
];

/**
 * Below-the-fold content. The app is a single view with almost no text, which
 * leaves search engines nothing to rank; this gives them the terms people
 * actually search for without cluttering the tool.
 */
const LandingContent = () => (
  <div className="border-t border-hairline bg-surface px-6 py-14">
    <div className="mx-auto flex max-w-3xl flex-col gap-12">
      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-xl font-bold tracking-[-0.02em] text-ink">
          Device frames for App Store screenshots
        </h2>
        <p className="m-0 text-[15px] leading-relaxed text-ink-soft">
          A screenshot on its own is just a rectangle. Put it in the phone it
          came from and it reads as a real app. AppleFramer does that for
          iPhone, iPad and Apple Watch screenshots — for App Store pages, press
          kits, or anywhere you want a mockup — and exports a PNG with either a
          transparent or a solid background.
        </p>
      </section>

      <section className="flex flex-col gap-5">
        <h2 className="m-0 text-xl font-bold tracking-[-0.02em] text-ink">
          Why use it
        </h2>
        <div className="grid gap-5 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="flex flex-col gap-1.5">
              <h3 className="m-0 text-[15px] font-semibold text-ink">{feature.title}</h3>
              <p className="m-0 text-[14px] leading-relaxed text-ink-soft">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <h2 className="m-0 text-xl font-bold tracking-[-0.02em] text-ink">
          How it works
        </h2>
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {[
            'Drop your screenshots in, or paste them from the clipboard.',
            'Each one gets matched to a device. Change any of them in the panel on the right.',
            'Pick a background and how the files should be named, then download one or the whole batch.',
          ].map((step, index) => (
            <li key={step} className="flex gap-3 text-[14px] leading-relaxed text-ink-soft">
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-accent-wash font-mono text-2xs font-semibold text-accent-deep">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </section>

    </div>
  </div>
);

export default UploadZone;
