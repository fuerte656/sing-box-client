import { ServiceAlert } from '../core/box.service';

export interface AlertText {
  title: string;
  message: string;
}

/** Human-readable text for service alerts (mirrors SFA's Alert enum). */
export function alertText(alert: ServiceAlert): AlertText {
  switch (alert.type) {
    case 'coreMissing':
      return {
        title: 'sing-box is not installed',
        message: 'Download the sing-box core in Settings → Core before starting the service.',
      };
    case 'emptyConfiguration':
      return { title: 'Empty configuration', message: 'Select or create a profile with a configuration first.' };
    case 'invalidConfiguration':
      return { title: 'Invalid configuration', message: alert.message ?? '' };
    case 'needElevation':
      return { title: 'TUN permission required', message: alert.message ?? '' };
    case 'unexpectedExit':
      return { title: 'Service stopped unexpectedly', message: alert.message ?? '' };
    case 'startService':
    default:
      return { title: 'Failed to start service', message: alert.message ?? '' };
  }
}
