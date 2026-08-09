const Footer = () => (
  <footer className="flex h-9 flex-none items-center justify-between gap-4 border-t border-hairline bg-surface px-5 font-mono text-2xs text-ink-soft">
    <p className="m-0 truncate">
      Processed locally — your images never leave the browser.
    </p>

    <div className="hidden flex-none items-center gap-3 sm:flex">
      <p className="m-0 truncate">
        By{' '}
        <a href="https://www.titansofindustry.be/" className="text-accent hover:underline">
          Tim Broddin
        </a>
        , after the{' '}
        <a
          href="https://www.macstories.net/ios/apple-frames-3-2-brings-iphone-15-pro-frames-files-picker-and-adjustable-spacing/"
          className="text-accent hover:underline"
        >
          Apple Frames
        </a>{' '}
        shortcut
      </p>
      {/* A plain link rather than react-github-btn: that renders a fixed-height
          iframe which overflows this 36px status bar. */}
      <a
        href="https://github.com/timbroddin/appleframer.com"
        target="_blank"
        rel="noreferrer"
        className="flex-none text-accent hover:underline"
      >
        GitHub
      </a>
    </div>
  </footer>
);

export default Footer;
