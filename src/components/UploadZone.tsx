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
    <div className="flex flex-1 p-[22px]">
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

        <h2 className="m-0 text-[27px] font-bold tracking-[-0.025em] text-ink">
          Drop the whole set
        </h2>
        <p className="m-0 text-center font-mono text-[12.5px] leading-[1.7] text-ink-soft">
          every shot is matched to its own device automatically
          <br />
          10 screenshots or 100 — same three clicks
        </p>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="mt-1.5 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-deep"
        >
          Browse files
        </button>

        <span className="font-mono text-[11.5px] text-ink-faint">
          or paste from the clipboard
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
  );
};

export default UploadZone;
