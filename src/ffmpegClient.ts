import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

// Helper to fetch a file as a blob URL (from ffmpeg.wasm docs)
export async function toBlobURL(url: string, mimeType: string): Promise<string> {
  const buf = await fetch(url).then(res => res.arrayBuffer());
  const blob = new Blob([buf], { type: mimeType });
  return URL.createObjectURL(blob);
}

export class FFmpegClient {
  private ffmpeg: FFmpeg;
  private loaded: boolean = false;

  constructor() {
    this.ffmpeg = new FFmpeg();
  }

  /**
   * Loads ffmpeg.wasm core and wasm from CDN. Call before using exec.
   * @param onProgress Optional progress callback
   */
  async load(onProgress?: (progress: number, time: number) => void, onLog?: (message: string) => void) {
    if (this.loaded) return;
    const baseURL = ' https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
      this.ffmpeg.on('progress', ({ progress, time }) => {
        if(onProgress) {
          onProgress(progress, time);
        }
      });
      this.ffmpeg.on('log', (message) => {
        if(onLog) {
          onLog(message.message);
        }
      });
    await this.ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    //  workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
    });
    this.loaded = true;
  }

  /**
   * Write a file to the ffmpeg virtual FS
   */
  async writeFile(name: string, data: string | Uint8Array) {
    await this.ffmpeg.writeFile(name, data);
  }

  /**
   * Run an ffmpeg command (args as array)
   */
  async exec(args: string[]) {
    await this.ffmpeg.exec(args);
  }

  /**
   * Read a file from the ffmpeg virtual FS
   */
  async readFile(name: string): Promise<string | Uint8Array> {
    return await this.ffmpeg.readFile(name);
  }

  /**
   * Remove a file from the ffmpeg virtual FS
   */
  async unlink(name: string) {
    await this.ffmpeg.deleteFile(name);
  }

  /**
   * Reset the ffmpeg instance (clears FS)
   */
  async reset() {
    this.ffmpeg = new FFmpeg();
    this.loaded = false;
  }
}

// Singleton instance for convenience
export const ffmpegClient = new FFmpegClient();

export { fetchFile }; 