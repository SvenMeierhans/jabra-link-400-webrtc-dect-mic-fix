export {
  acquireWorkingMic,
  releaseMic,
  hasSignal,
  noteMicStop,
  waitUntilDongleIdle,
  configureGuard,
  prepareDongle,
  releaseDongle,
  markMicActive,
  markMicInactive,
} from './guard';
export type { AcquireOptions, AcquireResult, PrepareOptions, StatusEvent } from './guard';

export {
  hookSupported,
  findHookDevice,
  requestHookPermission,
  setOffHook,
  getLastHookInfo,
  configureHook,
} from './hook';
export type { HookInfo, HookTarget } from './hook';

export { onMicStatus, getMicStatus } from './status';
export type { MicState, MicStatus, MicStatusListener } from './status';
