import { filesystem } from '@neutralinojs/lib';
import { DaemonClient } from './grpc-web';
import { DownloadTaildropFileChunk } from './models';

/** Received data is written in blocks of this size rather than per 16 KB chunk. */
const WRITE_BLOCK: number = 4 * 1024 * 1024;
const RETRY_DELAYS: number[] = [200, 500, 1000, 2000, 4000];

/**
 * Streams a received Taildrop file to `target`.
 *
 * The file is assembled in `tempDir` and moved to `target` only once complete, in large blocks
 * with retries: reopening a fresh file in Downloads for every 16 KB chunk collides with
 * antivirus/indexer scans there and made large files fail midway. `size` comes from the inbox
 * listing, since the chunks' own size field is 0 in sing-box 1.14.
 */
export async function downloadTaildropFile(
  client: DaemonClient,
  endpointTag: string,
  name: string,
  size: number,
  tempDir: string,
  target: string,
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  const temp: string = `${tempDir}/${Date.now()}-${Math.random().toString(36).slice(2)}.part`;
  let buffered: Uint8Array[] = [];
  let bufferedBytes: number = 0;
  let received: number = 0;
  let written: number = 0;
  let created: boolean = false;
  let pending: Promise<void> = Promise.resolve();

  // Writes are chained so blocks land in order even though the stream does not wait for them.
  const flush: () => void = () => {
    if (!bufferedBytes && created) return;
    const block: ArrayBuffer = concatChunks(buffered, bufferedBytes);
    buffered = [];
    bufferedBytes = 0;
    const append: boolean = created;
    created = true;
    pending = pending.then(async () => {
      await retry(() => (append ? filesystem.appendBinaryFile(temp, block) : filesystem.writeBinaryFile(temp, block)));
      written += block.byteLength;
      onProgress?.(written, size);
    });
  };

  try {
    await client.stream<DownloadTaildropFileChunk>('DownloadTaildropFile', { endpointTag, name }, (chunk) => {
      if (!chunk.data.length) return;
      buffered.push(chunk.data.slice());
      bufferedBytes += chunk.data.length;
      received += chunk.data.length;
      if (bufferedBytes >= WRITE_BLOCK) flush();
    });
    flush();
    await pending;
    if (size && received !== size) {
      throw new Error(`Incomplete download: received ${received} of ${size} bytes`);
    }
    await moveIntoPlace(temp, target.replace(/\\/g, '/'));
  } catch (e) {
    await pending.catch(() => undefined);
    await filesystem.remove(temp).catch(() => undefined);
    throw e;
  }
}

function concatChunks(chunks: Uint8Array[], total: number): ArrayBuffer {
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(total);
  let offset: number = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

/** Moves a finished file into place; copies instead when a move is not possible (another drive). */
async function moveIntoPlace(source: string, target: string): Promise<void> {
  try {
    await retry(() => filesystem.move(source, target));
  } catch {
    await retry(() => filesystem.copy(source, target));
    await filesystem.remove(source).catch(() => undefined);
  }
}

/** Retries a filesystem call that can fail while another program briefly holds the file. */
async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt: number = 0; ; attempt++) {
    try {
      return await operation();
    } catch (e) {
      if (attempt >= RETRY_DELAYS.length) throw e;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
  }
}
