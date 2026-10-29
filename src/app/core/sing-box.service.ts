import { Service, WritableSignal, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { errorMessage } from '../shared/errors';
import { ClashApiService, ClashEndpoint } from './clash-api.service';
import { CoreBinaryService, compareVersions } from './core-binary.service';
import { DaemonEndpoint, DaemonService } from './daemon/daemon.service';
import { InstanceService } from './instance.service';
import { parseConfig } from './json';
import { LogService } from './log.service';
import { NativeService, ProcessEvent } from './native.service';
import { CorePlatform, TunPrivilegeResult } from './platform/core-platform';
import { Profile, ProfileService } from './profile.service';
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

/** The shell Neutralino spawned for sing-box. */
interface CoreProcess {
  id: number;
  pid: number;
}

export interface SystemProxyStatus {
  available: boolean;
  enabled: boolean;
}

const START_TIMEOUT: number = 30_000;
const STOP_TIMEOUT: number = 5_000;
const SYSTEM_PROXY_INBOUNDS: Set<string> = new Set(['mixed', 'http']);
/** First sing-box release with the `api` service (daemon.StartedService over gRPC/gRPC-Web). */
const API_SERVICE_MIN_VERSION: string = '1.14.0-alpha';
const API_SERVICE_TAG: string = 'sing-box-client-api';

/** Runs sing-box as a child process; the desktop counterpart of SFA's BoxService. */
@Service()
export class SingBoxService {
  private readonly nativeService: NativeService = inject(NativeService);
  private readonly platform: CorePlatform = inject(CorePlatform);
  private readonly coreBinaryService: CoreBinaryService = inject(CoreBinaryService);
  private readonly profileService: ProfileService = inject(ProfileService);
  private readonly settingsService: SettingsService = inject(SettingsService);
  private readonly clashApiService: ClashApiService = inject(ClashApiService);
  private readonly logService: LogService = inject(LogService);
  private readonly daemonService: DaemonService = inject(DaemonService);
  private readonly instanceService: InstanceService = inject(InstanceService);

  readonly status: WritableSignal<ServiceStatus> = signal<ServiceStatus>('stopped');
  readonly systemProxy: WritableSignal<SystemProxyStatus> = signal<SystemProxyStatus>({ available: false, enabled: false });
  /** Outbound tags in configuration order, used to order groups like SFA does. */
  readonly outboundOrder: WritableSignal<string[]> = signal<string[]>([]);
  readonly alerts: Subject<ServiceAlert> = new Subject<ServiceAlert>();

  private process: CoreProcess | null = null;
  /** PID of sing-box itself, which can differ from the spawned (shell) PID. */
  private corePid: number | null = null;
  private exitWaiters: (() => void)[] = [];
  private listening: boolean = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.profileService.contentChanged.subscribe((id) => {
      if (id === this.profileService.selectedId() && this.status() === 'started') {
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
    await this.settingsService.update({ systemProxyEnabled: enabled });
    if (this.status() === 'started') await this.restart();
  }

  /**
   * Obtains TUN privileges the platform's way. On `granted` the service is started again;
   * on `relaunch` an elevated copy is starting and the caller should quit this one.
   */
  async acquireTunPrivileges(): Promise<TunPrivilegeResult> {
    const result: TunPrivilegeResult = await this.platform.acquireTunPrivileges(await this.coreBinaryService.binary());
    if (result === 'granted') await this.start();
    return result;
  }

  /** Serialises start/stop so rapid clicks cannot interleave process management. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next: Promise<void> = this.queue.then(task, task);
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
      if (!(await this.coreBinaryService.refresh())) {
        this.fail('coreMissing');
        return;
      }
      const profile: Profile | null = this.profileService.selected();
      if (!profile) {
        this.fail('emptyConfiguration');
        return;
      }
      const content: string = await this.profileService.readContent(profile.id);
      if (!content.trim()) {
        this.fail('emptyConfiguration');
        return;
      }
      let config: Record<string, any>;
      try {
        config = parseConfig(content);
      } catch (e) {
        this.fail('invalidConfiguration', errorMessage(e));
        return;
      }

      const endpoint: ClashEndpoint = this.applyOverrides(config);
      const daemonEndpoint: DaemonEndpoint | null = this.applyApiService(config);
      const needsTun: boolean = (config['inbounds'] ?? []).some((i: { type?: string }) => i.type === 'tun');
      if (needsTun && !(await this.platform.hasTunPrivileges(await this.coreBinaryService.binary()))) {
        this.fail('needElevation', this.platform.tunPrivilegeHint);
        return;
      }

      const workDir: string = await this.nativeService.path('work');
      await this.nativeService.ensureDir(workDir);
      const configPath: string = `${workDir}/config.json`;
      await this.nativeService.writeJson(configPath, config);

      this.logService.clear();
      this.clashApiService.resetHistory();
      this.logService.system(`Starting profile "${profile.name}" with sing-box ${this.coreBinaryService.version()}`);
      const p: CorePlatform = this.platform;
      const commandLine: string = [
        p.quote(p.nativePath(await this.coreBinaryService.binary())),
        'run',
        '-c',
        p.quote(p.nativePath(configPath)),
        '-D',
        p.quote(p.nativePath(workDir)),
        '--disable-color',
      ].join(' ');
      this.process = await this.nativeService.spawn(p.coreCommand(commandLine), workDir);

      if (!(await this.waitUntilReady(endpoint))) {
        if (this.process) {
          await this.terminate();
          this.fail('startService', this.logService.lastErrors() || 'sing-box did not start in time');
        } else {
          this.fail('startService', this.logService.lastErrors() || 'sing-box exited during startup');
        }
        return;
      }
      this.corePid = await this.platform.resolveCorePid(this.process!.pid);
      void this.instanceService.setCorePid(this.corePid).catch(() => undefined);
      void this.platform.prepareStop(this.corePid, STOP_TIMEOUT).catch(() => undefined);
      this.clashApiService.connect(endpoint);
      if (daemonEndpoint) this.daemonService.connect(daemonEndpoint);
      this.status.set('started');
    } catch (e) {
      await this.terminate();
      this.fail('startService', errorMessage(e));
    }
  }

  private async doStop(): Promise<void> {
    if (this.status() === 'stopped') return;
    this.status.set('stopping');
    this.clashApiService.disconnect();
    this.daemonService.disconnect();
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
    const experimental: Record<string, any> = (config['experimental'] ??= {});
    const clashApi: Record<string, any> = (experimental['clash_api'] ??= {});
    if (!clashApi['external_controller']) {
      clashApi['external_controller'] = `127.0.0.1:${this.settingsService.get('clashApiPort')}`;
      clashApi['secret'] = crypto.randomUUID();
    }
    const [host, port]: [string, string] = splitHostPort(String(clashApi['external_controller']));
    const connectHost: string = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

    const enabled: boolean = this.settingsService.get('systemProxyEnabled');
    let available: boolean = false;
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
    const version: string | null = this.coreBinaryService.version();
    if (!version || compareVersions(version, API_SERVICE_MIN_VERSION) < 0) return null;
    const services: Record<string, any>[] = (config['services'] ??= []);
    let service: Record<string, any> | undefined = services.find((s) => s['type'] === 'api');
    if (!service) {
      service = {
        type: 'api',
        tag: API_SERVICE_TAG,
        listen: '127.0.0.1',
        listen_port: this.settingsService.get('apiServicePort'),
        secret: crypto.randomUUID(),
      };
      services.push(service);
    }
    const listen: string = String(service['listen'] ?? '127.0.0.1');
    const host: string = !listen || listen === '0.0.0.0' || listen === '::' ? '127.0.0.1' : listen;
    return {
      baseUrl: `http://${host.includes(':') ? `[${host}]` : host}:${service['listen_port']}`,
      secret: service['secret'] ?? '',
    };
  }

  private async waitUntilReady(endpoint: ClashEndpoint): Promise<boolean> {
    const deadline: number = Date.now() + START_TIMEOUT;
    while (this.process && Date.now() < deadline) {
      if (await this.clashApiService.ping(endpoint)) return true;
      await delay(300);
    }
    return false;
  }

  /** Last resort when quitting hangs: kills sing-box and its shell, bypassing the task queue. */
  async kill(): Promise<void> {
    const proc: CoreProcess | null = this.process;
    if (!proc) return;
    void this.platform.cancelPreparedStop().catch(() => undefined);
    await this.platform.forceKill(this.corePid ?? proc.pid).catch(() => undefined);
    await this.platform.forceKill(proc.pid).catch(() => undefined);
  }

  /** Graceful stop first (so sing-box restores the system proxy), then a forced kill. */
  private async terminate(): Promise<void> {
    const proc: CoreProcess | null = this.process;
    if (!proc) return;
    const corePid: number = this.corePid ?? (await this.platform.resolveCorePid(proc.pid).catch(() => proc.pid));
    const exited: Promise<boolean> = this.waitForExit(STOP_TIMEOUT + 2000);
    void this.instanceService.logEvent(`stop: sing-box ${corePid} (shell ${proc.pid})`);
    const startedAt: number = Date.now();
    const stopped: boolean = await this.platform.stopGracefully(corePid, STOP_TIMEOUT).catch(() => false);
    void this.instanceService.logEvent(`stop: graceful ${stopped ? 'ok' : 'failed'} in ${Date.now() - startedAt} ms`);
    if (!stopped) {
      this.logService.system('sing-box did not stop gracefully, killing it', 'warn');
      await this.platform.forceKill(corePid).catch(() => undefined);
      await this.platform.forceKill(proc.pid).catch(() => undefined);
    }
    if (!(await exited)) {
      await this.nativeService.kill(proc.id).catch(() => undefined);
      await this.waitForExit(STOP_TIMEOUT);
    }
    this.process = null;
    this.corePid = null;
    void this.instanceService.setCorePid(null).catch(() => undefined);
  }

  private waitForExit(timeout: number): Promise<boolean> {
    if (!this.process) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer: number = setTimeout(() => {
        this.exitWaiters = this.exitWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeout);
      const done: () => void = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.exitWaiters.push(done);
    });
  }

  private async listen(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    await this.nativeService.onProcessEvent((event) => this.onProcessEvent(event));
  }

  private onProcessEvent(event: ProcessEvent): void {
    if (!this.process || event.id !== this.process.id) return;
    switch (event.action) {
      case 'stdOut':
      case 'stdErr':
        this.logService.append(String(event.data));
        break;
      case 'exit': {
        this.logService.flush();
        this.logService.system(`sing-box exited with code ${event.data}`, Number(event.data) === 0 ? 'info' : 'error');
        this.process = null;
        this.corePid = null;
        void this.instanceService.setCorePid(null).catch(() => undefined);
        void this.platform.cancelPreparedStop().catch(() => undefined);
        const waiters: (() => void)[] = this.exitWaiters;
        this.exitWaiters = [];
        waiters.forEach((w) => w());
        if (this.status() === 'started') {
          // Crashed or killed externally, not stopped by us.
          this.clashApiService.disconnect();
          this.daemonService.disconnect();
          this.fail('unexpectedExit', this.logService.lastErrors() || `Exit code ${event.data}`);
        }
        break;
      }
    }
  }
}

function splitHostPort(address: string): [string, string] {
  const index: number = address.lastIndexOf(':');
  if (index < 0) return [address, '9090'];
  return [address.slice(0, index).replace(/^\[|\]$/g, ''), address.slice(index + 1)];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
