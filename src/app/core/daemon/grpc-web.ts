import { IConversionOptions, Method, Root, Service, Type } from 'protobufjs/light';
import definitions from './daemon.proto.json';

/** gRPC status codes that the UI cares about. */
export const GrpcStatus = {
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

const CONVERSION: IConversionOptions = { longs: Number, enums: String, defaults: true, arrays: true };

let service: Service | undefined;
function startedService(): Service {
  service ??= Root.fromJSON(definitions as never).lookupService('daemon.StartedService');
  return service;
}

/**
 * Minimal gRPC-Web client (binary protobuf, HTTP/1.1) for sing-box's API service
 * (`daemon.StartedService`). Unary and server-streaming calls are supported; client streaming
 * is not possible from a browser, so those calls go through the sing-box CLI instead.
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
    const rpc = this.method(method);
    const requestType = rpc.resolvedRequestType as Type;
    const responseType = rpc.resolvedResponseType as Type;

    const payload = requestType.encode(requestType.fromObject(request)).finish();
    const body = new Uint8Array(5 + payload.length);
    new DataView(body.buffer).setUint32(1, payload.length);
    body.set(payload, 5);

    const response = await fetch(`${this.baseUrl}/daemon.StartedService/${method}`, {
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
    const headerStatus = response.headers.get('grpc-status');
    if (headerStatus && headerStatus !== '0') {
      throw new GrpcWebError(Number(headerStatus), decodeURIComponent(response.headers.get('grpc-message') ?? ''));
    }

    const reader = response.body!.getReader();
    let buffer: Uint8Array = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer = concat(buffer, value);
      // Each frame: 1 flag byte (0x80 = trailers), 4-byte big-endian length, payload.
      while (buffer.length >= 5) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
        if (buffer.length < 5 + length) break;
        const flag = buffer[0];
        const frame = buffer.subarray(5, 5 + length);
        buffer = buffer.subarray(5 + length);
        if (flag & 0x80) {
          const trailers = parseTrailers(new TextDecoder().decode(frame));
          const status = Number(trailers['grpc-status'] ?? 0);
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

  private method(name: string): Method {
    const rpc = startedService().methods[name];
    if (!rpc) throw new Error(`Unknown API method ${name}`);
    rpc.resolve();
    return rpc;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function parseTrailers(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\r\n')) {
    const index = line.indexOf(':');
    if (index > 0) result[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return result;
}
