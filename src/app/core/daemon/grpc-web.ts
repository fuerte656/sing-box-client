import { IConversionOptions, Method, Root, Service, Type } from 'protobufjs/light';
import definitions from './daemon.proto.json';

/** gRPC status codes that the UI cares about. */
export const GrpcStatus: {
  readonly OK: 0;
  readonly CANCELLED: 1;
  readonly UNIMPLEMENTED: 12;
  readonly UNAVAILABLE: 14;
  readonly UNAUTHENTICATED: 16;
} = {
  OK: 0,
  CANCELLED: 1,
  UNIMPLEMENTED: 12,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

export class GrpcWebError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message || `gRPC status ${code}`);
  }
}

const CRLF: string = String.fromCharCode(13, 10);
const CONVERSION: IConversionOptions = { longs: Number, enums: String, defaults: true, arrays: true };

let service: Service | undefined;
function startedService(): Service {
  service ??= Root.fromJSON(definitions as never).lookupService('daemon.StartedService');
  return service;
}

/** A client- or bidi-streaming call in progress (see {@link DaemonClient.bidi}). */
export interface BidiStream<Req> {
  send(message: Req): void;
  /** Signals that no more messages follow. */
  halfClose(): void;
  /** Bytes queued in the WebSocket but not yet sent, for backpressure. */
  readonly bufferedAmount: number;
  cancel(): void;
  /** Resolves when the server ends the call with OK, rejects with a {@link GrpcWebError} otherwise. */
  readonly done: Promise<void>;
}

/**
 * Minimal gRPC-Web client (binary protobuf) for sing-box's API service (`daemon.StartedService`).
 * Unary and server-streaming calls use HTTP POST; client/bidi streaming uses sing-box's
 * `grpc-websockets` bridge, since plain gRPC-Web cannot stream requests from a browser.
 */
export class DaemonClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async unary<T = Record<string, unknown>>(method: string, request: object = {}, signal?: AbortSignal): Promise<T> {
    let result: T | undefined;
    await this.stream<T>(method, request, (message) => (result = message), signal);
    if (result === undefined) throw new GrpcWebError(GrpcStatus.UNAVAILABLE, `${method}: empty response`);
    return result;
  }

  /** Server-streaming call; resolves when the stream ends, rejects on gRPC errors. */
  async stream<T = Record<string, unknown>>(
    method: string,
    request: object,
    onMessage: (message: T) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const rpc: Method = this.method(method);
    const requestType: Type = rpc.resolvedRequestType as Type;
    const responseType: Type = rpc.resolvedResponseType as Type;

    const payload: Uint8Array<ArrayBufferLike> = requestType.encode(requestType.fromObject(request)).finish();
    const body: Uint8Array<ArrayBuffer> = new Uint8Array(5 + payload.length);
    new DataView(body.buffer).setUint32(1, payload.length);
    body.set(payload, 5);

    const response: Response = await fetch(`${this.baseUrl}/daemon.StartedService/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/grpc-web+proto',
        'X-Grpc-Web': '1',
        ...(this.secret ? { Authorization: `Bearer ${this.secret}` } : {}),
      },
      body,
      signal,
    });
    if (!response.ok) {
      throw new GrpcWebError(GrpcStatus.UNAVAILABLE, `${method}: HTTP ${response.status}`);
    }
    // "Trailers-only" responses carry the status in the headers.
    const headerStatus: string | null = response.headers.get('grpc-status');
    if (headerStatus && headerStatus !== '0') {
      throw new GrpcWebError(Number(headerStatus), decodeURIComponent(response.headers.get('grpc-message') ?? ''));
    }

    const reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> = response.body!.getReader();
    let buffer: Uint8Array = new Uint8Array(0);
    for (;;) {
      const { value, done }: ReadableStreamReadResult<Uint8Array<ArrayBuffer>> = await reader.read();
      if (value) buffer = concat(buffer, value);
      // Each frame: 1 flag byte (0x80 = trailers), 4-byte big-endian length, payload.
      while (buffer.length >= 5) {
        const length: number = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
        if (buffer.length < 5 + length) break;
        const flag: number = buffer[0];
        const frame: Uint8Array<ArrayBufferLike> = buffer.subarray(5, 5 + length);
        buffer = buffer.subarray(5 + length);
        if (flag & 0x80) {
          const trailers: Record<string, string> = parseTrailers(new TextDecoder().decode(frame));
          const status: number = Number(trailers['grpc-status'] ?? 0);
          if (status !== GrpcStatus.OK) {
            throw new GrpcWebError(status, decodeURIComponent(trailers['grpc-message'] ?? ''));
          }
        } else {
          onMessage(responseType.toObject(responseType.decode(frame), CONVERSION) as T);
        }
      }
      if (done) return;
    }
  }

  /**
   * Opens a bidirectional stream over sing-box's WebSocket bridge. Protocol: the first binary
   * message holds the request headers; every later one is 0x00 + a gRPC frame, or a single 0x01
   * to half-close. The server answers with gRPC-Web frames (0x80 = headers/trailers).
   */
  bidi<Req extends object, Res = Record<string, unknown>>(method: string, onMessage: (message: Res) => void): Promise<BidiStream<Req>> {
    const rpc: Method = this.method(method);
    const requestType: Type = rpc.resolvedRequestType as Type;
    const responseType: Type = rpc.resolvedResponseType as Type;
    const ws: WebSocket = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/daemon.StartedService/${method}`, 'grpc-websockets');
    ws.binaryType = 'arraybuffer';

    let buffer: Uint8Array = new Uint8Array(0);
    let status: { code: number; message: string } | null = null;
    let cancelled: boolean = false;
    let settle!: { resolve: () => void; reject: (e: unknown) => void };
    const done: Promise<void> = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    done.catch(() => undefined); // observed by the caller; avoid unhandled-rejection noise

    ws.onmessage = (event) => {
      buffer = concat(buffer, new Uint8Array(event.data as ArrayBuffer));
      while (buffer.length >= 5) {
        const length: number = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
        if (buffer.length < 5 + length) break;
        const flag: number = buffer[0];
        const frame: Uint8Array<ArrayBufferLike> = buffer.subarray(5, 5 + length);
        buffer = buffer.subarray(5 + length);
        if (flag & 0x80) {
          const metadata: Record<string, string> = parseTrailers(new TextDecoder().decode(frame));
          if (metadata['grpc-status'] !== undefined) {
            status = { code: Number(metadata['grpc-status']), message: decodeURIComponent(metadata['grpc-message'] ?? '') };
          }
        } else {
          onMessage(responseType.toObject(responseType.decode(frame), CONVERSION) as Res);
        }
      }
    };
    ws.onclose = () => {
      if (cancelled) settle.reject(new GrpcWebError(GrpcStatus.CANCELLED, 'Cancelled'));
      else if (!status) settle.reject(new GrpcWebError(GrpcStatus.UNAVAILABLE, `${method}: connection closed`));
      else if (status.code !== GrpcStatus.OK) settle.reject(new GrpcWebError(status.code, status.message));
      else settle.resolve();
    };

    const frame: (prefix: number, payload: Uint8Array) => Uint8Array<ArrayBuffer> = (prefix: number, payload: Uint8Array) => {
      const message: Uint8Array<ArrayBuffer> = new Uint8Array(6 + payload.length);
      message[0] = prefix;
      new DataView(message.buffer).setUint32(2, payload.length);
      message.set(payload, 6);
      return message;
    };
    const stream: BidiStream<Req> = {
      send: (message) => ws.send(frame(0, requestType.encode(requestType.fromObject(message)).finish())),
      halfClose: () => ws.send(Uint8Array.of(1)),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      cancel: () => {
        cancelled = true;
        ws.close();
      },
      done,
    };

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        // MIME header block; the server appends the terminating empty line.
        const lines: string[] = ['content-type: application/grpc-web+proto', 'x-grpc-web: 1'];
        if (this.secret) lines.push(`authorization: Bearer ${this.secret}`);
        const headers: string = lines.map((line) => line + CRLF).join('');
        ws.send(new TextEncoder().encode(headers));
        resolve(stream);
      };
      ws.onerror = () => reject(new GrpcWebError(GrpcStatus.UNAVAILABLE, `${method}: WebSocket connection failed`));
    });
  }

  private method(name: string): Method {
    const rpc: Method = startedService().methods[name];
    if (!rpc) throw new Error(`Unknown API method ${name}`);
    rpc.resolve();
    return rpc;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function parseTrailers(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\r\n')) {
    const index: number = line.indexOf(':');
    if (index > 0) result[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return result;
}
