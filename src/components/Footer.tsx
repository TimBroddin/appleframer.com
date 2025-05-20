import React from 'react';
import GitHubButton from 'react-github-btn';
const Footer = () => {
  return (
    <footer className="bg-white/80 backdrop-blur-md py-4 border-t border-gray-200">
      <div className="container mx-auto px-4 flex flex-col items-center text-center text-sm text-gray-500">
        <p>All processing happens locally in your browser. Your images are never uploaded to any server.</p>
        <p className="mt-2">Crafted by <a href="https://www.titansofindustry.be/" className="text-blue-500 hover:text-blue-600">Tim Broddin</a> to scratch an itch.<br />
        Partially based on the <a href="https://www.macstories.net/ios/apple-frames-3-2-brings-iphone-15-pro-frames-files-picker-and-adjustable-spacing/" className="text-blue-500 hover:text-blue-600">Apple Frames shortcut</a>.</p>
        <div className="mt-4">
          <GitHubButton href="https://github.com/timbroddin/appleframer.com" data-size="large" data-show-count="true" aria-label="Star timbroddin/appleframer on GitHub">Star</GitHubButton>
        </div>
      </div>
    </footer>
  );
};

export default Footer;