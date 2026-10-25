import { Injectable, computed, inject, signal } from '@angular/core';
import { CoreBinaryService } from '../core-binary.service';
import { NativeService } from '../native.service';
import { CorePlatform } from '../platform/core-platform';
import { DaemonClient, GrpcStatus, GrpcWebError } from './grpc-web';
import { downloadTaildropFile as downloadToFile } from './taildrop-download';
import {
  TaildropInbox,
  TaildropSendServerMessage,
  TailscaleEndpointStatus,
  TailscalePingResponse,
} from './models';

export interface DaemonEndpoint {
  baseUrl: string;
  secret: string;
}

const RESUBSCRIBE_DELAY = 2000;
/**
 * sing-box's API service (daemon.StartedService), the same API SFA's Tools screens use.
 * Available with sing-box 1.14+; BoxService adds the service to the runtime config.
 */
@Injectable({ providedIn: 'root' })
export class DaemonService {
  private readonly native = inject(NativeService);
  private readonly platform = inject(CorePlatform);
  private readonly core = inject(CoreBinaryService);

  private client: DaemonClient | null = null;
  private endpoint: DaemonEndpoint | null = null;
  private session: AbortController | null = null;

  readonly connected = signal(false);
  /** Latest Tailscale status of every Tailscale endpoint in the running profile. */
  readonly tailscale = signal<TailscaleEndpointStatus[]>([]);
  readonly hasTailscale = computed(() => this.tailscale().length > 0);

  connect(endpoint: DaemonEndpoint): void {
    this.disconnect();
    this.endpoint = endpoint;
    this.client = new DaemonClient(endpoint.baseUrl, endpoint.secret);
    this.session = new AbortController();
    this.connected.set(true);
    void this.watchTailscale(this.session.signal);
  }

  disconnect(): void {
    this.session?.abort();
    this.session = null;
    this.client = null;
    this.endpoint = null;
    this.connected.set(false);
    this.tailscale.set([]);
  }

  tailscaleEndpoint(tag: string): TailscaleEndpointStatus | undefined {
    return this.tailscale().find((e) => e.endpointTag === tag);
  }

  /** Continuous ping; resolves when the stream ends or `signal` aborts. */
  ping(endpointTag: string, peerIP: string, onResult: (r: TailscalePingResponse) => void, signal: AbortSignal) {
    return this.require().stream<TailscalePingResponse>('StartTailscalePing', { endpointTag, peerIP }, onResult, signal);
  }

  /** Selects an exit node by stable ID; an empty ID clears it. */
  async setExitNode(endpointTag: string, stableID: string): Promise<void> {
    await this.require().unary('SetTailscaleExitNode', { endpointTag, stableID });
  }

  async logout(endpointTag: string): Promise<void> {
    await this.require().unary('TailscaleLogout', { endpointTag });
  }

  subscribeTaildropInbox(endpointTag: string, onInbox: (inbox: TaildropInbox) => void, signal: AbortSignal) {
    return this.require().stream<TaildropInbox>('SubscribeTaildropInbox', { endpointTag }, onInbox, signal);
  }

  /** Current inbox once: the first message of SubscribeTaildropInbox. */
  async fetchTaildropInbox(endpointTag: string): Promise<TaildropInbox> {
    const abort = new AbortController();
    let inbox: TaildropInbox | undefined;
    await this.subscribeTaildropInbox(
      endpointTag,
      (message) => {
        inbox = message;
        abort.abort();
      },
      abort.signal,
    ).catch((e) => {
      if (!inbox) throw e;
    });
    if (!inbox) throw new Error('Taildrop inbox unavailable');
    return inbox;
  }

  async markTaildropInboxRead(endpointTag: string): Promise<void> {
    await this.require().unary('MarkTaildropInboxRead', { endpointTag });
  }

  async deleteTaildropFile(endpointTag: string, name: string): Promise<void> {
    await this.require().unary('DeleteTaildropFile', { endpointTag, name });
  }

  async cancelTaildropReceiving(endpointTag: string, senderID: string, name: string): Promise<void> {
    await this.require().unary('CancelTaildropReceiving', { endpointTag, senderID, name });
  }

  /** Streams a received file into `target` (a native path chosen by the user); see taildrop-download.ts. */
  async downloadTaildropFile(
    endpointTag: string,
    name: string,
    size: number,
    target: string,
    onProgress?: (written: number, total: number) => void,
  ): Promise<void> {
    const tempDir = await this.native.path('taildrop-incoming');
    await this.native.ensureDir(tempDir);
    await downloadToFile(this.require(), endpointTag, name, size, tempDir, target, onProgress);
  }

  /** Opens a SendTaildropFiles stream (start, chunks, fileDone…) — used by TaildropSendService. */
  sendTaildropStream(onMessage: (message: TaildropSendServerMessage) => void) {
    return this.require().bidi<object, TaildropSendServerMessage>('SendTaildropFiles', onMessage);
  }

  /** Opens `sing-box api tailscale ssh` in a terminal window (needs a TUN inbound to route to the peer). */
  async openSsh(endpointTag: string, target: string): Promise<void> {
    const command = [await this.cliPrefix(), 'tailscale', 'ssh', '--endpoint', this.platform.quote(endpointTag), target].join(' ');
    await this.platform.openTerminal(command, `SSH ${target}`);
  }

  private async cliPrefix(): Promise<string> {
    const endpoint = this.endpoint;
    if (!endpoint) throw new Error('Service is not running');
    const p = this.platform;
    return [
      p.quote(p.nativePath(await this.core.binary())),
      'api',
      '--url',
      p.quote(endpoint.baseUrl),
      '--secret',
      p.quote(endpoint.secret),
    ].join(' ');
  }

  private require(): DaemonClient {
    if (!this.client) throw new Error('Service is not running');
    return this.client;
  }

  /** Keeps a SubscribeTailscaleStatus stream open for the whole session, resubscribing on drops. */
  private async watchTailscale(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.client) {
      try {
        await this.client.stream<{ endpoints: TailscaleEndpointStatus[] }>(
          'SubscribeTailscaleStatus',
          {},
          (update) => this.tailscale.set(update.endpoints),
          signal,
        );
      } catch (e) {
        if (signal.aborted) return;
        // Profiles without Tailscale endpoints answer UNIMPLEMENTED / UNAVAILABLE: nothing to show.
        if (e instanceof GrpcWebError && e.code === GrpcStatus.UNIMPLEMENTED) {
          this.tailscale.set([]);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_DELAY));
    }
  }
}

/** Strips the log prefix ("FATAL[0000] ") the CLI puts in front of errors. */
function cleanCliError(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^(FATAL|ERROR)\[\d+\]\s*/gm, '')
    .trim();
}
