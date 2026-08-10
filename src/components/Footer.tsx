import GitHubButton from 'react-github-btn';

// The button renders a fixed-height iframe (20px at the default size), so the
// bar is tall enough to seat it without clipping.
const Footer = () => (
  <footer className="flex h-11 flex-none items-center justify-between gap-4 border-t border-hairline bg-surface px-5 font-mono text-2xs text-ink-soft">
    {/* Left padding clears the floating project-menu button pinned bottom-left. */}
    <p className="m-0 truncate pl-9">
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
      {/* leading-none keeps the iframe from inheriting the footer's line-height
          and adding phantom descender space below it. */}
      <span className="flex flex-none items-center leading-none">
        <GitHubButton
          href="https://github.com/timbroddin/appleframer.com"
          data-show-count="true"
          aria-label="Star timbroddin/appleframer.com on GitHub"
        >
          Star
        </GitHubButton>
      </span>
    </div>
  </footer>
);

export default Footer;
