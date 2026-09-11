import { test, expect } from 'bun:test';
import {
  FILE_ACCEPT_ATTRIBUTE,
  findFrameByScreenshotSize,
  findSibling,
  frameLabel,
  frameLabelDetailed,
  isFramableFile,
  isUnsupportedVideoFile,
  isVideoFile,
  orientationsFor,
  screensFor,
} from './queue';
import { DeviceFrame } from '../hooks/useFrames';

const make = (over: Partial<DeviceFrame>): DeviceFrame => ({
  id: 'x',
  category: 'iPhone',
  deviceType: '16',
  model: '16',
  coordinates: { x: '0', y: '0', name: 'fallback' },
  ...over,
});

test('iPhone labels lead with the category', () => {
  // "16 Pro" alone does not read as a product name.
  expect(frameLabel(make({ model: '16', version: 'Pro' }))).toBe('iPhone 16 Pro');
  expect(frameLabel(make({ model: '16', version: 'Pro Max' }))).toBe('iPhone 16 Pro Max');
});

test('"Standard" is dropped as a data placeholder', () => {
  expect(frameLabel(make({ model: '16', version: 'Standard' }))).toBe('iPhone 16');
});

test('iPad does not repeat its category', () => {
  expect(
    frameLabel(
      make({ category: 'iPad', model: 'Pro', version: '2024', variant: '13' })
    )
  ).toBe('iPad Pro 2024 13');
});

test('bare iPad keeps its version', () => {
  expect(
    frameLabel(make({ category: 'iPad', model: 'Standard', version: '2021' }))
  ).toBe('iPad 2021');
});

test('Watch is labelled Apple Watch', () => {
  expect(
    frameLabel(
      make({ category: 'Watch', model: 'Ultra', version: '2024' })
    )
  ).toBe('Apple Watch Ultra 2024');
});

test('undefined frame reads as detecting', () => {
  expect(frameLabel(undefined)).toBe('Detecting…');
  expect(frameLabelDetailed(undefined)).toBe('Detecting…');
});

test('detailed label appends the colour', () => {
  expect(
    frameLabelDetailed(make({ model: '17', version: 'Pro', color: 'Cosmic Orange' }))
  ).toBe('iPhone 17 Pro · Cosmic Orange');
});

test('falls back to the coordinate name when nothing else is set', () => {
  const frame = make({ category: '', model: '', version: undefined });
  expect(frameLabel(frame)).toBe('fallback');
});

const sized = (over: Partial<DeviceFrame>, width: number, height: number): DeviceFrame =>
  make({
    ...over,
    coordinates: { x: '0', y: '0', name: 'x', screenshotWidth: width, screenshotHeight: height },
  });

test('a screenshot size shared across generations resolves to the newest iPhone', () => {
  // 1206x2622 is the 16 Pro, 17 Pro and 18 Pro alike. The list is sorted oldest
  // first, so taking the first match labelled every new screenshot a 16 Pro.
  const frames = [
    sized({ id: '16-pro', model: '16', version: 'Pro' }, 1206, 2622),
    sized({ id: '17-pro', model: '17', version: 'Pro', color: 'Cosmic Orange' }, 1206, 2622),
    sized({ id: '18-pro-black', model: '18', version: 'Pro', color: 'Black' }, 1206, 2622),
    sized({ id: '18-pro-silver', model: '18', version: 'Pro', color: 'Silver' }, 1206, 2622),
  ];
  // Among the newest, list order still decides, so the first finish wins.
  expect(findFrameByScreenshotSize(frames, 1206, 2622)?.id).toBe('18-pro-black');
});

test('the newest iPhone wins wherever it sits in the list', () => {
  const frames = [
    sized({ id: '18-pro', model: '18', version: 'Pro' }, 1206, 2622),
    sized({ id: '16-pro', model: '16', version: 'Pro' }, 1206, 2622),
    sized({ id: '12-13-pro', model: '12-13', version: 'Pro' }, 1206, 2622),
  ];
  expect(findFrameByScreenshotSize(frames, 1206, 2622)?.id).toBe('18-pro');
});

test('ties outside iPhone keep list order', () => {
  // Watch Series 10 46mm and Ultra 2024 share 410x502. There is no generation
  // number to compare, so detection keeps its existing first-match answer.
  const frames = [
    sized(
      { id: 'series-10-46', category: 'Watch', model: 'Series', version: '10', variant: '46' },
      410,
      502
    ),
    sized({ id: 'ultra-2024', category: 'Watch', model: 'Ultra', version: '2024' }, 410, 502),
  ];
  expect(findFrameByScreenshotSize(frames, 410, 502)?.id).toBe('series-10-46');
});

test('a size no device uses finds nothing', () => {
  expect(findFrameByScreenshotSize([sized({}, 1206, 2622)], 1000, 1000)).toBeUndefined();
});

const duo = (
  screen: string,
  color: string,
  orientation: 'Portrait' | 'Landscape',
  width: number,
  height: number
) =>
  sized(
    { id: `duo-${screen}-${color}-${orientation}`, model: 'Duo', version: screen, color, orientation },
    width,
    height
  );

// Same shape and order as Frames.json: Outer Open exists in portrait only.
const DUO = [
  duo('Inner', 'Night Sky', 'Portrait', 2007, 2853),
  duo('Inner', 'Night Sky', 'Landscape', 2853, 2007),
  duo('Inner', 'Star White', 'Portrait', 2007, 2853),
  duo('Inner', 'Star White', 'Landscape', 2853, 2007),
  duo('Outer', 'Night Sky', 'Portrait', 1398, 2034),
  duo('Outer', 'Night Sky', 'Landscape', 2034, 1398),
  duo('Outer', 'Star White', 'Portrait', 1398, 2034),
  duo('Outer', 'Star White', 'Landscape', 2034, 1398),
  duo('Outer Open', 'Night Sky', 'Portrait', 1398, 2034),
  duo('Outer Open', 'Star White', 'Portrait', 1398, 2034),
];
const duoFrame = (id: string) => DUO.find((frame) => frame.id === id)!;

test('the Duo offers its screens; other devices offer none', () => {
  expect(screensFor(DUO, duoFrame('duo-Inner-Night Sky-Portrait'))).toEqual([
    'Inner',
    'Outer',
    'Outer Open',
  ]);
  // Pro and Pro Max are sizes of different phones, not screens of one phone.
  const pro = sized({ model: '18', version: 'Pro', color: 'Black', orientation: 'Portrait' }, 1206, 2622);
  const proMax = sized({ model: '18', version: 'Pro Max', color: 'Black', orientation: 'Portrait' }, 1320, 2868);
  expect(screensFor([pro, proMax], pro)).toEqual([]);
});

test('switching the Duo screen keeps the finish and the orientation', () => {
  expect(
    findSibling(DUO, duoFrame('duo-Inner-Star White-Landscape'), { version: 'Outer' })?.id
  ).toBe('duo-Outer-Star White-Landscape');
});

test('a screen without the current orientation falls back but keeps the finish', () => {
  expect(
    findSibling(DUO, duoFrame('duo-Inner-Star White-Landscape'), { version: 'Outer Open' })?.id
  ).toBe('duo-Outer Open-Star White-Portrait');
});

test('the Duo keeps both orientations on offer, even on a portrait-only screen', () => {
  // Hiding the row on Outer Open would make Landscape vanish rather than read
  // as unavailable, and the row would jump in and out as the screen changes.
  expect(orientationsFor(DUO, duoFrame('duo-Outer Open-Night Sky-Portrait'))).toEqual([
    'Portrait',
    'Landscape',
  ]);
  // Landscape has no Outer Open frame to switch to, which is what greys it out.
  expect(
    findSibling(DUO, duoFrame('duo-Outer Open-Night Sky-Portrait'), { orientation: 'Landscape' })
      ?.orientation
  ).toBe('Portrait');
});

test('other devices only offer the orientations their own model has', () => {
  const portraitOnly = sized({ model: '8', version: 'Standard', orientation: 'Portrait' }, 750, 1334);
  const otherModel = sized({ model: '8', version: 'Plus', orientation: 'Landscape' }, 1920, 1080);
  expect(orientationsFor([portraitOnly, otherModel], portraitOnly)).toEqual(['Portrait']);
});

test('Duo screenshots detect the screen they were taken on', () => {
  expect(findFrameByScreenshotSize(DUO, 2007, 2853)?.version).toBe('Inner');
  expect(findFrameByScreenshotSize(DUO, 2034, 1398)?.version).toBe('Outer');
  // Outer and Outer Open share the outer display, so list order makes the
  // plain folded phone the default.
  expect(findFrameByScreenshotSize(DUO, 1398, 2034)?.version).toBe('Outer');
});

const fileOf = (name: string, type: string) => new File([], name, { type });

test('video MIME types are recognised', () => {
  expect(isVideoFile(fileOf('demo.mp4', 'video/mp4'))).toBe(true);
  expect(isVideoFile(fileOf('demo.mov', 'video/quicktime'))).toBe(true);
});

test('images are not videos', () => {
  expect(isVideoFile(fileOf('shot.png', 'image/png'))).toBe(false);
});

test('falls back to the extension when the MIME type is missing', () => {
  // Screen recordings dragged from some tools arrive with an empty type.
  expect(isVideoFile(fileOf('demo.mp4', ''))).toBe(true);
  expect(isVideoFile(fileOf('demo.MOV', ''))).toBe(true);
  expect(isVideoFile(fileOf('shot.png', ''))).toBe(false);
});

test('a dropped video is accepted, not filtered out with the junk', () => {
  // The regression this guards: filtering a drop to image/* silently discarded
  // every screen recording before it reached the queue.
  expect(isFramableFile(fileOf('demo.mp4', 'video/mp4'))).toBe(true);
  expect(isFramableFile(fileOf('demo.mov', 'video/quicktime'))).toBe(true);
  // Including the empty-type case, which is how some tools hand over a
  // recording and which a MIME-only filter would reject.
  expect(isFramableFile(fileOf('demo.mp4', ''))).toBe(true);
});

test('images are accepted and everything else is refused', () => {
  expect(isFramableFile(fileOf('shot.png', 'image/png'))).toBe(true);
  expect(isFramableFile(fileOf('shot.heic', 'image/heic'))).toBe(true);
  expect(isFramableFile(fileOf('notes.pdf', 'application/pdf'))).toBe(false);
  expect(isFramableFile(fileOf('.DS_Store', ''))).toBe(false);
});

test('containers the demuxer cannot read are refused at the door', () => {
  // The regression this guards: a .webm probes fine through a <video> element,
  // so it used to be accepted, matched to a device and queued, and only failed
  // once the mp4box-only demuxer reached it mid-encode.
  expect(isVideoFile(fileOf('demo.webm', 'video/webm'))).toBe(false);
  expect(isFramableFile(fileOf('demo.webm', 'video/webm'))).toBe(false);
  // The MIME check is an allow-list, so a webm carrying no extension is
  // refused on its type alone rather than slipping through.
  expect(isFramableFile(fileOf('recording', 'video/webm'))).toBe(false);
  // And an extension-only webm, which is how a typeless drop arrives.
  expect(isFramableFile(fileOf('demo.webm', ''))).toBe(false);
});

test('refused videos are distinguishable from junk so they can be explained', () => {
  // A .webm must not be lumped in with the .DS_Store files the drop filter
  // silently discards: the user picked a video deliberately and is owed a
  // reason naming what would have worked.
  expect(isUnsupportedVideoFile(fileOf('demo.webm', 'video/webm'))).toBe(true);
  expect(isUnsupportedVideoFile(fileOf('demo.webm', ''))).toBe(true);
  expect(isUnsupportedVideoFile(fileOf('demo.mkv', ''))).toBe(true);
  // Formats that DO work are not reported as unsupported.
  expect(isUnsupportedVideoFile(fileOf('demo.mp4', 'video/mp4'))).toBe(false);
  expect(isUnsupportedVideoFile(fileOf('demo.mov', 'video/quicktime'))).toBe(false);
  // Nor is ordinary junk, which keeps the generic message for the generic case.
  expect(isUnsupportedVideoFile(fileOf('notes.pdf', 'application/pdf'))).toBe(false);
  expect(isUnsupportedVideoFile(fileOf('.DS_Store', ''))).toBe(false);
  expect(isUnsupportedVideoFile(fileOf('shot.png', 'image/png'))).toBe(false);
});

test('the picker advertises only formats that will be accepted', () => {
  // A dialog that offered .webm and then rejected the choice would read as a
  // bug in the app rather than a limit of the format.
  expect(FILE_ACCEPT_ATTRIBUTE).toContain('image/*');
  expect(FILE_ACCEPT_ATTRIBUTE).toContain('video/mp4');
  expect(FILE_ACCEPT_ATTRIBUTE).toContain('.mov');
  expect(FILE_ACCEPT_ATTRIBUTE).not.toContain('video/*');
  expect(FILE_ACCEPT_ATTRIBUTE).not.toContain('webm');
});
