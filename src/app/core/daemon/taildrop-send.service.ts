import { Injectable, computed, inject, signal } from '@angular/core';
import { filesystem } from '@neutralinojs/lib';
import { Dialogs } from '../../shared/dialogs';
import { errorMessage } from '../../shared/errors';
import { DaemonService } from './daemon.service';
import { GrpcStatus, GrpcWebError } from './grpc-web';

/** sing-box's TaildropChunkSize: one chunk message fits a single 16 KiB HTTP/2 frame. */
const CHUNK_SIZE = 16 * 1024 - 64;
/** Files chosen by path are read from disk in blocks of this size. */
const READ_BLOCK = 4 * 1024 * 1024;
/** Backpressure: unsent WebSocket bytes, and bytes sent but not yet acknowledged by sing-box. */
const MAX_BUFFERED = 2 * 1024 * 1024;
const MAX_UNACKNOWLEDGED = 8 * 1024 * 1024;

/** Something that can be uploaded: a file chosen by path, or a File dropped onto the window. */
export interface SendSource {
  name: string;
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export async function sourceFromPath(path: string): Promise<SendSource> {
  const normalized = path.replace(/\\/g, '/');
  const { size } = await filesystem.getStats(normalized);
  return {
    name: normalized.split('/').pop()!,
    size,
    read: async (pos, length) => new Uint8Array(await filesystem.readBinaryFile(normalized, { pos, size: length })),
  };
}

export function sourceFromFile(file: File): SendSource {
  return {
    name: file.name,
    size: file.size,
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

export type TransferState = 'sending' | 'done' | 'failed' | 'cancelled';

export interface OutgoingFile {
  name: string;
  size: number;
  /** Bytes delivered to the peer, as reported by sing-box. */
  sent: number;
  done: boolean;
}

export interface OutgoingTransfer {
  id: number;
  endpointTag: string;
  peerStableID: string;
  peerName: string;
  files: OutgoingFile[];
  state: TransferState;
  error?: string;
  startedAt: number;
}

/**
 * Sends files with Taildrop through the API service's SendTaildropFiles stream
 * (over sing-box's grpc-websockets bridge) and tracks per-file progress for the UI.
 */
@Injectable({ providedIn: 'root' })
export class TaildropSendService {
  private readonly daemon = inject(DaemonService);
  private readonly dialogs = inject(Dialogs);
  private nextId = 1;
  private readonly cancels = new Map<number, () => void>();

  /** All transfers of this session, newest first. */
  readonly transfers = signal<OutgoingTransfer[]>([]);

  /** Overall progress of transfers still sending, or null. */
  readonly active = computed(() => {
    const sending = this.transfers().filter((t) => t.state === 'sending');
    if (!sending.length) return null;
    const files = sending.flatMap((t) => t.files);
    const total = files.reduce((sum, f) => sum + f.size, 0);
    const sent = files.reduce((sum, f) => sum + f.sent, 0);
    return {
      transfer: sending[0],
      fileCount: files.length,
      percent: total ? Math.min(100, (sent / total) * 100) : 0,
    };
  });

  forPeer(peerStableID: string): OutgoingTransfer[] {
    return this.transfers().filter((t) => t.peerStableID === peerStableID);
  }

  /** Starts sending; progress is reported through {@link transfers}. */
  send(endpointTag: string, peerStableID: string, peerName: string, sources: SendSource[]): void {
    const transfer: OutgoingTransfer = {
      id: this.nextId++,
      endpointTag,
      peerStableID,
      peerName,
      files: sources.map((s) => ({ name: s.name, size: s.size, sent: 0, done: false })),
      state: 'sending',
      startedAt: Date.now(),
    };
    this.transfers.update((list) => [transfer, ...list]);
    void this.run(transfer.id, endpointTag, peerStableID, sources);
  }

  cancel(id: number): void {
    this.cancels.get(id)?.();
  }

  /** Removes finished (done, failed or cancelled) transfers from the list. */
  clearFinished(peerStableID?: string): void {
    this.transfers.update((list) =>
      list.filter((t) => t.state === 'sending' || (peerStableID !== undefined && t.peerStableID !== peerStableID)),
    );
  }

  private update(id: number, change: (t: OutgoingTransfer) => OutgoingTransfer): void {
    this.transfers.update((list) => list.map((t) => (t.id === id ? change(t) : t)));
  }

  private async run(id: number, endpointTag: string, peerStableID: string, sources: SendSource[]): Promise<void> {
    let acknowledged = 0;
    let uploaded = 0;
    let cancelled = false;
    let wake: (() => void) | null = null;
    const nudge = () => {
      wake?.();
      wake = null;
    };

    try {
      const stream = await this.daemon.sendTaildropStream((message) => {
        if (message.progress) {
          const { fileIndex = 0, sentBytes = 0, fileCompleted = false } = message.progress;
          this.update(id, (t) => ({
            ...t,
            files: t.files.map((f, i) => (i === fileIndex ? { ...f, sent: fileCompleted ? f.size : sentBytes, done: fileCompleted || f.done } : f)),
          }));
        } else if (message.receivedBytes !== undefined) {
          acknowledged = message.receivedBytes;
          nudge();
        }
      });
      this.cancels.set(id, () => {
        cancelled = true;
        stream.cancel();
        nudge();
      });

      stream.send({
        start: { endpointTag, peerStableID, files: sources.map((s) => ({ name: s.name, size: s.size })) },
      });

      // Wait for the server to keep up instead of queueing whole files in memory.
      const waitForRoom = async () => {
        while (!cancelled && (stream.bufferedAmount > MAX_BUFFERED || uploaded - acknowledged > MAX_UNACKNOWLEDGED)) {
          await Promise.race([new Promise<void>((resolve) => (wake = resolve)), new Promise((r) => setTimeout(r, 50))]);
        }
      };

      for (const source of sources) {
        for (let offset = 0; offset < source.size && !cancelled; offset += READ_BLOCK) {
          const block = await source.read(offset, Math.min(READ_BLOCK, source.size - offset));
          for (let i = 0; i < block.length && !cancelled; i += CHUNK_SIZE) {
            await waitForRoom();
            const chunk = block.subarray(i, i + CHUNK_SIZE);
            stream.send({ chunk: { data: chunk } });
            uploaded += chunk.length;
          }
        }
        if (cancelled) break;
        stream.send({ fileDone: {} });
      }
      if (!cancelled) stream.halfClose();

      await stream.done;
      this.update(id, (t) => ({ ...t, state: 'done', files: t.files.map((f) => ({ ...f, sent: f.size, done: true })) }));
      const transfer = this.transfers().find((t) => t.id === id)!;
      const what = transfer.files.length === 1 ? transfer.files[0].name : `${transfer.files.length} files`;
      this.dialogs.toast(`Sent ${what} to ${transfer.peerName}`);
    } catch (e) {
      const wasCancelled = cancelled || (e instanceof GrpcWebError && e.code === GrpcStatus.CANCELLED);
      this.update(id, (t) => ({ ...t, state: wasCancelled ? 'cancelled' : 'failed', error: wasCancelled ? undefined : errorMessage(e) }));
      if (!wasCancelled) void this.dialogs.error('Taildrop send failed', e);
    } finally {
      this.cancels.delete(id);
    }
  }
}
