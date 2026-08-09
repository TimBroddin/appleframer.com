import React, { useRef, useState } from 'react';

interface UploadZoneProps {
  onFilesSelected: (files: File[]) => void;
}

const UploadZone = ({ onFilesSelected }: UploadZoneProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire for every child element, so track depth rather
  // than clearing the state on the first leave.
  const dragDepth = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    if (e.dataTransfer.files?.length) {
      onFilesSelected(Array.from(e.dataTransfer.files));
    }
  };

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
          onDragEnter={handleDragEnter}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed transition-colors ${
            isDragging ? 'border-accent bg-accent-wash' : 'border-hairline bg-surface'
          }`}
        >
          <div className="mb-1 flex gap-2">
            <span className="h-[62px] w-[34px] rounded-[7px] border border-hairline bg-surface-muted" />
            <span className="h-[62px] w-[34px] rounded-[7px] border border-hairline bg-surface-muted" />
            <span className="h-[62px] w-[34px] rounded-[7px] border border-accent-edge bg-accent-wash" />
          </div>

          <h1 className="m-0 max-w-[22ch] text-center text-[27px] font-bold leading-tight tracking-[-0.025em] text-ink">
            App Store screenshots in real device frames
          </h1>
          <p className="m-0 max-w-[46ch] text-center font-mono text-[12.5px] leading-[1.7] text-ink-soft">
            drop the whole set — every shot is matched to its own iPhone, iPad or
            Apple Watch automatically
          </p>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-1.5 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-deep"
          >
            Browse files
          </button>

          <span className="font-mono text-[11.5px] text-ink-faint">
            or drag them in, or paste from the clipboard
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

const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: 'Automatic device detection',
    body: 'Screenshots are matched to a device by their pixel dimensions, so an iPhone 16 Pro Max shot lands in an iPhone 16 Pro Max frame without you picking anything.',
  },
  {
    title: 'Built for batches',
    body: 'A full App Store set is ten screenshots per device across several devices. Drop them all at once, mixed, and download the lot as a ZIP.',
  },
  {
    title: 'Nothing is uploaded',
    body: 'Framing happens on a canvas in your browser. Your unreleased screenshots never touch a server, because there is no server.',
  },
  {
    title: 'Free and open source',
    body: 'No account, no watermark, no export limit. The source is on GitHub under the MIT licence.',
  },
];

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'Which devices are supported?',
    a: 'iPhone (8 through 17, Air and the SE), iPad (Pro, Air, mini and the base model) and Apple Watch (Series and Ultra), in portrait and landscape where Apple ships both.',
  },
  {
    q: 'Does Apple require device frames on App Store screenshots?',
    a: 'No. Apple accepts bare screenshots, and frames are a presentation choice. Many developers use them because a framed shot reads as a real device in a crowded search result.',
  },
  {
    q: 'What size should my screenshots be?',
    a: 'Use the untouched screenshot straight from the device or simulator. AppleFramer matches on exact pixel dimensions, so resized or cropped images will not be detected.',
  },
  {
    q: 'Are my screenshots uploaded anywhere?',
    a: 'No. Everything runs locally in your browser — the images are read from disk, drawn onto a canvas, and downloaded again. Nothing is sent over the network.',
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
          Free device frames for App Store and Google Play screenshots
        </h2>
        <p className="m-0 text-[15px] leading-relaxed text-ink-soft">
          AppleFramer wraps your iPhone, iPad and Apple Watch screenshots in
          realistic Apple device bezels — the mockups you need for App Store
          product pages, press kits, landing pages and portfolio shots. Upload a
          whole set at once and each image is matched to the right device
          automatically, then exported as a transparent or coloured PNG.
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
            'Each one is matched to its device — override any of them in the inspector.',
            'Pick a background and a filename pattern, then download one image or the whole batch as a ZIP.',
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

      <section className="flex flex-col gap-5">
        <h2 className="m-0 text-xl font-bold tracking-[-0.02em] text-ink">
          Frequently asked questions
        </h2>
        {/* Generated from the same FAQ array the page renders, so the rich
            result can never drift from the visible answers. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: FAQ.map((entry) => ({
                '@type': 'Question',
                name: entry.q,
                acceptedAnswer: { '@type': 'Answer', text: entry.a },
              })),
            }),
          }}
        />
        <div className="flex flex-col gap-5">
          {FAQ.map((entry) => (
            <div key={entry.q} className="flex flex-col gap-1.5">
              <h3 className="m-0 text-[15px] font-semibold text-ink">{entry.q}</h3>
              <p className="m-0 text-[14px] leading-relaxed text-ink-soft">{entry.a}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  </div>
);

export default UploadZone;
