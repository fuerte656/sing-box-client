/** Shapes of daemon.StartedService messages (see daemon.proto.json), as decoded by protobufjs. */

export interface TailscalePeer {
  hostName: string;
  dnsName: string;
  os: string;
  tailscaleIPs: string[];
  online: boolean;
  /** This peer is the current exit node. */
  exitNode: boolean;
  /** This peer offers itself as an exit node. */
  exitNodeOption: boolean;
  active: boolean;
  rxBytes: number;
  txBytes: number;
  /** Unix seconds; 0 when key expiry is disabled. */
  keyExpiry: number;
  stableID: string;
  expired: boolean;
  sshHostKeys: string[];
  /** Shared into this tailnet from another one. */
  shareeNode: boolean;
  /** Unix seconds. */
  lastSeen: number;
  canReceiveFiles: boolean;
}

export interface TailscaleUserGroup {
  userID: number;
  loginName: string;
  displayName: string;
  profilePicURL: string;
  peers: TailscalePeer[];
}

export interface TailscaleEndpointStatus {
  endpointTag: string;
  /** Tailscale ipn backend state: NoState, NeedsLogin, NeedsMachineAuth, Stopped, Starting, Running. */
  backendState: string;
  stateText: string;
  authURL: string;
  networkName: string;
  magicDNSSuffix: string;
  self: TailscalePeer | null;
  userGroups: TailscaleUserGroup[];
  exitNode: TailscalePeer | null;
  keyAuth: boolean;
  canShareFiles: boolean;
  waitingFileCount: number;
  receivingFileCount: number;
  unreadFileCount: number;
  certDomains: string[];
}

export interface TailscalePingResponse {
  latencyMs: number;
  isDirect: boolean;
  endpoint: string;
  derpRegionID: number;
  derpRegionCode: string;
  error: string;
  peerRelay: string;
}

export interface TaildropFile {
  name: string;
  size: number;
  senderName: string;
  /** Unix seconds. */
  modifiedAt: number;
}

export interface TaildropReceivingFile {
  name: string;
  size: number;
  receivedBytes: number;
  senderID: string;
  senderName: string;
}

export interface TaildropInbox {
  endpointTag: string;
  files: TaildropFile[];
  receiving: TaildropReceivingFile[];
}

export interface DownloadTaildropFileChunk {
  size: number;
  data: Uint8Array;
}
