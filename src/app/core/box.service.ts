import { Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ClashApiService, ClashEndpoint } from './clash-api.service';
import { CoreBinaryService, compareVersions } from './core-binary.service';
import { DaemonEndpoint, DaemonService } from './daemon/daemon.service';
import { parseConfig } from './json';
import { LogService } from './log.service';
import { NativeService, ProcessEvent } from './native.service';
import { CorePlatform, TunPrivilegeResult } from './platform/core-platform';
import { ProfileService } from './profile.service';
import { SettingsService } from './settings.service';

export type ServiceStatus = 'stopped' | 'starting' | 'started' | 'stopping';

export type AlertType =
  | 'coreMissing'
  | 'emptyConfiguration'
  | 'invalidConfiguration'
  | 'needElevation'
  | 'startService'
  | 'unexpectedExit';

export interface ServiceAlert {
  type: AlertType;
  message?: string;
}

export interface SystemProxyStatus {
  available: boolean;
  enabled: boolean;
}

const START_TIMEOUT = 30_000;
const STOP_TIMEOUT = 5_000;
const SYSTEM_PROXY_INBOUNDS = new Set(['mixed', 'http']);
/** First sing-box release with the `api` service (daemon.StartedService over gRPC/gRPC-Web). */
const API_SERVICE_MIN_VERSION = '1.14.0-alpha';
const API_SERVICE_TAG = 'sing-box-client-api';

/** Runs sing-box as a child process; the desktop counterpart of SFA's BoxService. */
@Injectable({ providedIn: 'root' })
export class BoxService {
  private readonly native = inject(NativeService);
  private readonly platform = inject(CorePlatform);
  private readonly core = inject(CoreBinaryService);
  private readonly profiles = inject(ProfileService);
  private readonly settings = inject(SettingsService);
  private readonly clash = inject(ClashApiService);
  private readonly logs = inject(LogService);
  private readonly daemon = inject(DaemonService);

  readonly status = signal<ServiceStatus>('stopped');
  readonly systemProxy = signal<SystemProxyStatus>({ available: false, enabled: false });
  /** Outbound tags in configuration order, used to order groups like SFA does. */
  readonly outboundOrder = signal<string[]>([]);
  readonly alerts = new Subject<ServiceAlert>();

  private process: { id: number; pid: number } | null = null;
  /** PID of sing-box itself, which can differ from the spawned (shell) PID. */
  private corePid: number | null = null;
  private exitWaiters: (() => void)[] = [];
  private listening = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.profiles.contentChanged.subscribe((id) => {
      if (id === this.profiles.selectedId() && this.status() === 'started') {
        void this.restart();
      }
    });
  }

  start(): Promise<void> {
    return this.enqueue(() => this.doStart());
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  restart(): Promise<void> {
    return this.enqueue(async () => {
      await this.doStop();
      await this.doStart();
    });
  }

  toggle(): Promise<void> {
    return this.status() === 'stopped' ? this.start() : this.stop();
  }

  async setSystemProxyEnabled(enabled: boolean): Promise<void> {
    await this.settings.update({ systemProxyEnabled: enabled });
    if (this.status() === 'started') await this.restart();
  }

  /**
   * Obtains TUN privileges the platform's way. On `granted` the service is started again;
   * on `relaunch` an elevated copy is starting and the caller should quit this one.
   */
  async acquireTunPrivileges(): Promise<TunPrivilegeResult> {
    const result = await this.platform.acquireTunPrivileges(await this.core.binary());
    if (result === 'granted') await this.start();
    return result;
  }

  /** Serialises start/stop so rapid clicks cannot interleave process management. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private alert(type: AlertType, message?: string): void {
    this.alerts.next({ type, message });
  }

  private async doStart(): Promise<void> {
    if (this.status() !== 'stopped') return;
    await this.listen();
    this.status.set('starting');
    try {
      if (!(await this.core.refresh())) {
        this.fail('coreMissing');
        return;
      }
      const profile = this.profiles.selected();
      if (!profile) {
        this.fail('emptyConfiguration');
        return;
      }
      const content = await this.profiles.readContent(profile.id);
      if (!content.trim()) {
        this.fail('emptyConfiguration');
        return;
      }
      let config: Record<string, any>;
      try {
        config = parseConfig(content);
      } catch (e) {
        this.fail('invalidConfiguration', (e as Error).message);
        return;
      }

      const endpoint = this.applyOverrides(config);
      const daemonEndpoint = this.applyApiService(config);
      const needsTun = (config['inbounds'] ?? []).some((i: { type?: string }) => i.type === 'tun');
      if (needsTun && !(await this.platform.hasTunPrivileges(await this.core.binary()))) {
        this.fail('needElevation', this.platform.tunPrivilegeHint);
        return;
      }

      const workDir = await this.native.path('work');
      await this.native.ensureDir(workDir);
      const configPath = `${workDir}/config.json`;
      await this.native.writeJson(configPath, config);

      this.logs.clear();
      this.clash.resetHistory();
      this.logs.system(`Starting profile "${profile.name}" with sing-box ${this.core.version()}`);
      const p = this.platform;
      const command = [
        p.quote(p.nativePath(await this.core.binary())),
        'run',
        '-c',
        p.quote(p.nativePath(configPath)),
        '-D',
        p.quote(p.nativePath(workDir)),
        '--disable-color',
      ].join(' ');
      this.process = await this.native.spawn(command, workDir);

      if (!(await this.waitUntilReady(endpoint))) {
        if (this.process) {
          await this.terminate();
          this.fail('startService', this.logs.lastErrors() || 'sing-box did not start in time');
        } else {
          this.fail('startService', this.logs.lastErrors() || 'sing-box exited during startup');
        }
        return;
      }
      this.corePid = await this.platform.resolveCorePid(this.process!.pid);
      this.clash.connect(endpoint);
      if (daemonEndpoint) this.daemon.connect(daemonEndpoint);
      this.status.set('started');
    } catch (e) {
      await this.terminate();
      this.fail('startService', (e as Error).message);
    }
  }

  private async doStop(): Promise<void> {
    if (this.status() === 'stopped') return;
    this.status.set('stopping');
    this.clash.disconnect();
    this.daemon.disconnect();
    await this.terminate();
    this.status.set('stopped');
  }

  private fail(type: AlertType, message?: string): void {
    this.status.set('stopped');
    this.alert(type, message);
  }

  /**
   * Same idea as SFA's OverrideOptions: the client owns the Clash API endpoint
   * and the system proxy switch; everything else in the profile is left as is.
   */
  private applyOverrides(config: Record<string, any>): ClashEndpoint {
    const experimental = (config['experimental'] ??= {});
    const clashApi = (experimental['clash_api'] ??= {});
    if (!clashApi['external_controller']) {
      clashApi['external_controller'] = `127.0.0.1:${this.settings.get('clashApiPort')}`;
      clashApi['secret'] = crypto.randomUUID();
    }
    const [host, port] = splitHostPort(String(clashApi['external_controller']));
    const connectHost = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

    const enabled = this.settings.get('systemProxyEnabled');
    let available = false;
    for (const inbound of config['inbounds'] ?? []) {
      if (SYSTEM_PROXY_INBOUNDS.has(inbound.type) && inbound['set_system_proxy']) {
        available = true;
        inbound['set_system_proxy'] = enabled;
      }
    }
    this.systemProxy.set({ available, enabled: available && enabled });
    this.outboundOrder.set(
      [...(config['outbounds'] ?? []), ...(config['endpoints'] ?? [])].map((o: { tag?: string }) => o.tag ?? ''),
    );

    return {
      baseUrl: `http://${connectHost.includes(':') ? `[${connectHost}]` : connectHost}:${port}`,
      secret: clashApi['secret'] ?? '',
    };
  }

  /**
   * Adds sing-box's API service (used by the Tools screens) on loopback with a fresh secret.
   * A profile that already declares an `api` service keeps it and the client connects to that.
   */
  private applyApiService(config: Record<string, any>): DaemonEndpoint | null {
    const version = this.core.version();
    if (!version || compareVersions(version, API_SERVICE_MIN_VERSION) < 0) return null;
    const services: Record<string, any>[] = (config['services'] ??= []);
    let service = services.find((s) => s['type'] === 'api');
    if (!service) {
      service = {
        type: 'api',
        tag: API_SERVICE_TAG,
        listen: '127.0.0.1',
        listen_port: this.settings.get('apiServicePort'),
        secret: crypto.randomUUID(),
      };
      services.push(service);
    }
    const listen = String(service['listen'] ?? '127.0.0.1');
    const host = !listen || listen === '0.0.0.0' || listen === '::' ? '127.0.0.1' : listen;
    return {
      baseUrl: `http://${host.includes(':') ? `[${host}]` : host}:${service['listen_port']}`,
      secret: service['secret'] ?? '',
    };
  }

  private async waitUntilReady(endpoint: ClashEndpoint): Promise<boolean> {
    const deadline = Date.now() + START_TIMEOUT;
    while (this.process && Date.now() < deadline) {
      if (await this.clash.ping(endpoint)) return true;
      await delay(300);
    }
    return false;
  }

  /** Graceful stop first (so sing-box restores the system proxy), then a forced kill. */
  private async terminate(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    const corePid = this.corePid ?? (await this.platform.resolveCorePid(proc.pid).catch(() => proc.pid));
    const exited = this.waitForExit(STOP_TIMEOUT + 2000);
    const stopped = await this.platform.stopGracefully(corePid, STOP_TIMEOUT).catch(() => false);
    if (!stopped) {
      this.logs.system('sing-box did not stop gracefully, killing it', 'warn');
      await this.platform.forceKill(corePid).catch(() => undefined);
      await this.platform.forceKill(proc.pid).catch(() => undefined);
    }
    if (!(await exited)) {
      await this.native.kill(proc.id).catch(() => undefined);
      await this.waitForExit(STOP_TIMEOUT);
    }
    this.process = null;
    this.corePid = null;
  }

  private waitForExit(timeout: number): Promise<boolean> {
    if (!this.process) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.exitWaiters = this.exitWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeout);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.exitWaiters.push(done);
    });
  }

  private async listen(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    await this.native.onProcessEvent((event) => this.onProcessEvent(event));
  }

  private onProcessEvent(event: ProcessEvent): void {
    if (!this.process || event.id !== this.process.id) return;
    switch (event.action) {
      case 'stdOut':
      case 'stdErr':
        this.logs.append(String(event.data));
        break;
      case 'exit': {
        this.logs.flush();
        this.logs.system(`sing-box exited with code ${event.data}`, Number(event.data) === 0 ? 'info' : 'error');
        this.process = null;
        this.corePid = null;
        const waiters = this.exitWaiters;
        this.exitWaiters = [];
        waiters.forEach((w) => w());
        if (this.status() === 'started') {
          // Crashed or killed externally, not stopped by us.
          this.clash.disconnect();
          this.daemon.disconnect();
          this.fail('unexpectedExit', this.logs.lastErrors() || `Exit code ${event.data}`);
        }
        break;
      }
    }
  }
}

function splitHostPort(address: string): [string, string] {
  const index = address.lastIndexOf(':');
  if (index < 0) return [address, '9090'];
  return [address.slice(0, index).replace(/^\[|\]$/g, ''), address.slice(index + 1)];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
