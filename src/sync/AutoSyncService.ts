import { devLog } from '@/utils/loggingHelper';
import { StorageServiceManager, STORAGE_KEYS } from '../StorageService';
import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  getHealthDataByDeviceType,
  forceStopHealthDataOperation,
  isDeviceConnectedByUUID,
  resetSDKState,
  clearHealthDataOperationLock,
  resetConnectionState,
} from './device-connect/DeviceConnectionService';
import { hasOSHealthPermissions } from '@/utils/healthPermissionHelper';
import ToastService from '../ToastService';
import { isBluetoothEnabled, getBluetoothStateRaw } from './device-connect/BluetoothManager';

const { YCRingManager, RWRingManager } = NativeModules;

const DEVICE_SYNC_TIMEOUT_MS = 90000;
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 3;

export class AutoSyncService {
  private static instance: AutoSyncService;
  private static isDeviceSyncRunning = false;
  private static isOSSyncRunning = false;
  private static activeDeviceSyncPromise: Promise<any> | null = null;
  private static activeOSSyncPromise: Promise<any> | null = null;
  private static animationStopTimeout: NodeJS.Timeout | null = null;
  private static osSync: (() => Promise<any>) | null = null;
  private static deviceSync: (() => Promise<any>) | null = null;
  private static osRefetch: (() => Promise<void>) | null = null;
  private static syncCallbacks: {
    onSyncComplete?: (data: any, source: string) => void;
    onSyncError?: (error: any, source: string) => void;
  } = {};
  private static syncInterval: NodeJS.Timeout | null = null;
  private static lastSyncTime: string | null = null;
  private static isInDetailDeviceScreen = false;
  private static pendingStartTimeout: NodeJS.Timeout | null = null;
  private static pendingStopTimeout: NodeJS.Timeout | null = null;
  private static lastSyncSource: 'device' | 'os' | null = null;
  private static isInitializing = false;
  private static lastErrorTime: string | null = null;
  private static consecutiveErrorCount = 0;
  private static isPaused = false;
  static isRunning: boolean = false;

  private static shouldAbort(): boolean {
    return this.isPaused || this.isInDetailDeviceScreen;
  }

  private static isValidDeviceUuid(uuid: any): boolean {
    if (!uuid || typeof uuid !== 'string' || uuid.trim().length === 0) {
      return false;
    }
    return uuid !== 'temp-device' && !uuid.startsWith('temp');
  }

  private static getDeviceNameFromStorage(deviceUuid: string): string {
    try {
      const connectedDevice = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
      if (connectedDevice) {
        const device = JSON.parse(connectedDevice);
        return device.name || 'Thiết bị';
      }
    } catch (error) {
      devLog.warn('[AutoSyncService] Failed to get device name from storage:', error);
    }
    return 'Thiết bị';
  }

  private static isUserLoggedIn(): boolean {
    try {
      const accessToken = StorageServiceManager.getString(STORAGE_KEYS.ACCESS_TOKEN);

      if (!accessToken || accessToken.length === 0) {
        devLog.warn('[AutoSyncService] User not logged in');
        return false;
      }

      return true;
    } catch (error) {
      devLog.warn('[AutoSyncService] Failed to check login state:', error);
      return false;
    }
  }

  private static classifyError(errorMessage: string): {
    isBluetooth: boolean;
    isTimeout: boolean;
    isNullPointer: boolean;
    isConnection: boolean;
    isLocked: boolean;
    isEmptyData: boolean;
  } {
    const lower = errorMessage.toLowerCase();
    return {
      isBluetooth:
        lower.includes('bluetooth') ||
        lower.includes('noclassdeffounderror') ||
        lower.includes('mqttcallback') ||
        lower.includes('aliagentsdk'),
      isTimeout: lower.includes('timed out') || lower.includes('timeout'),
      isNullPointer:
        lower.includes('null') ||
        lower.includes('undefined') ||
        lower.includes('cannot read property') ||
        lower.includes('cannot read properties'),
      isConnection:
        lower.includes('connect failed') ||
        lower.includes('cannot connect') ||
        lower.includes('connection failed') ||
        lower.includes('device not connected') ||
        lower.includes('out of range') ||
        lower.includes('error 1') ||
        lower.includes('error code 1') ||
        lower.includes('state: 7') ||
        lower.includes('device out of range'),
      isLocked: lower.includes('locked'),
      isEmptyData:
        lower.includes('empty_data') ||
        lower.includes('empty data') ||
        lower.includes('payload is empty'),
    };
  }

  private static handleDeviceSyncError(error: any, connectionTimeout: NodeJS.Timeout | null): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const { isBluetooth, isTimeout, isNullPointer, isConnection, isLocked, isEmptyData } =
      this.classifyError(errorMessage);

    if (connectionTimeout) clearTimeout(connectionTimeout);

    const stopAnimation = () => {
      try {
        DeviceEventEmitter.emit('TOAST_ANIMATION_STOP');
      } catch {}
    };

    if (isLocked) {
      devLog.warn('[AutoSyncService] Device is locked - stopping sync immediately without retry');
      this.isDeviceSyncRunning = false;
      this.consecutiveErrorCount = MAX_CONSECUTIVE_ERRORS;
      this.lastErrorTime = new Date().toISOString();
      forceStopHealthDataOperation();
      this.syncCallbacks.onSyncError?.(error, 'device');
      stopAnimation();
      return;
    }

    if (isEmptyData) {
      devLog.warn('[AutoSyncService] Health data is empty - stopping sync and animation');
      this.isDeviceSyncRunning = false;
      this.consecutiveErrorCount = MAX_CONSECUTIVE_ERRORS;
      this.lastErrorTime = new Date().toISOString();
      forceStopHealthDataOperation();
      this.syncCallbacks.onSyncError?.(error, 'device');
      stopAnimation();
      return;
    }

    if (isBluetooth) {
      this.isDeviceSyncRunning = false;
      forceStopHealthDataOperation();
      stopAnimation();
      return;
    }

    if (isConnection) {
      if (this.consecutiveErrorCount >= 2) {
        this.lastErrorTime = new Date().toISOString();
        this.isDeviceSyncRunning = false;
        stopAnimation();
        return;
      }
      if (this.consecutiveErrorCount < 3) {
        this.consecutiveErrorCount++;
      }
      this.lastErrorTime = new Date().toISOString();
      this.isDeviceSyncRunning = false;
      stopAnimation();
      return;
    }

    if (isNullPointer) {
      if (this.consecutiveErrorCount >= 1) {
        this.lastErrorTime = new Date().toISOString();
        this.isDeviceSyncRunning = false;
        stopAnimation();
        return;
      }
      if (this.consecutiveErrorCount < 2) {
        this.consecutiveErrorCount++;
      }
      this.lastErrorTime = new Date().toISOString();
      this.isDeviceSyncRunning = false;
      stopAnimation();
      return;
    }

    if (isTimeout) {
      if (this.consecutiveErrorCount >= 2) {
        this.lastErrorTime = new Date().toISOString();
        this.isDeviceSyncRunning = false;
        forceStopHealthDataOperation();
        stopAnimation();
        return;
      }
      if (this.consecutiveErrorCount < 1) {
        this.consecutiveErrorCount++;
      }
      this.lastErrorTime = new Date().toISOString();
      this.syncCallbacks.onSyncError?.(error, 'device');
      stopAnimation();
      return;
    }

    if (this.consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
      this.lastErrorTime = new Date().toISOString();
      this.isDeviceSyncRunning = false;
      forceStopHealthDataOperation();
      stopAnimation();
      return;
    }

    this.consecutiveErrorCount++;
    this.lastErrorTime = new Date().toISOString();
    devLog.error(
      `AutoSyncService: Device sync failed (${this.consecutiveErrorCount} consecutive errors):`,
      error,
    );
    this.syncCallbacks.onSyncError?.(error, 'device');

    // Stop animation for any error to give user feedback
    stopAnimation();
  }

  static setDetailDeviceScreenState(isInDetailScreen: boolean): void {
    const wasInDetailScreen = this.isInDetailDeviceScreen;
    this.isInDetailDeviceScreen = isInDetailScreen;

    if (isInDetailScreen && !wasInDetailScreen) {
      if (this.isRunning && !this.isPaused) {
        this.pause();
      }
      this.forceInterruptSyncOperations();
    } else if (!isInDetailScreen && wasInDetailScreen) {
      if (this.isRunning && this.isPaused) {
        this.resume();
      }
    }
  }

  static forceInterruptSyncOperations(): void {
    if (this.isDeviceSyncRunning || this.isOSSyncRunning || this.activeDeviceSyncPromise) {
      this.isDeviceSyncRunning = false;
      this.isOSSyncRunning = false;
      this.activeDeviceSyncPromise = null;
      this.activeOSSyncPromise = null;

      // Clear animation stop timeout if exists
      if (this.animationStopTimeout) {
        clearTimeout(this.animationStopTimeout);
        this.animationStopTimeout = null;
      }

      try {
        forceStopHealthDataOperation();
      } catch {}
      try {
        require('./device-connect/DeviceHealthSync')?.resetAllLocks?.();
      } catch {}
    }
  }

  static isInDetailDevice(): boolean {
    return this.isInDetailDeviceScreen;
  }

  static clearPendingOperations(): void {
    if (this.pendingStartTimeout) {
      clearTimeout(this.pendingStartTimeout);
      this.pendingStartTimeout = null;
    }
    if (this.pendingStopTimeout) {
      clearTimeout(this.pendingStopTimeout);
      this.pendingStopTimeout = null;
    }
  }

  static resetLocks(): void {
    this.isDeviceSyncRunning = false;
    this.isOSSyncRunning = false;
    this.isInitializing = false;
    this.consecutiveErrorCount = 0;
    this.lastErrorTime = null;

    // Clear animation stop timeout if exists
    if (this.animationStopTimeout) {
      clearTimeout(this.animationStopTimeout);
      this.animationStopTimeout = null;
    }
  }

  static forceReset(): void {
    this.clearPendingOperations();
    this.isRunning = false;
    this.isDeviceSyncRunning = false;
    this.isOSSyncRunning = false;
    this.isInitializing = false;
    this.consecutiveErrorCount = 0;
    this.lastErrorTime = null;
    this.isPaused = false;
    this.isInDetailDeviceScreen = false;

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  private static syncDataSuccessToastListener: any = null;

  private static setupEventListeners(): void {
    if (this.syncDataSuccessToastListener) {
      devLog.info('[AutoSyncService] Event listener already set up, skipping');
      return; // Already set up
    }

    devLog.info('[AutoSyncService] Setting up event listeners...');
    (async () => {
      try {
        const { DeviceEventEmitter } = await import('react-native');

        // Listen for when success toast is shown to set timeout from that point
        this.syncDataSuccessToastListener = DeviceEventEmitter.addListener(
          'SYNC_DATA_SUCCESS_TOAST_SHOWN',
          (eventData?: { timestamp?: number }) => {
            devLog.info('[AutoSyncService] Received SYNC_DATA_SUCCESS_TOAST_SHOWN event', {
              eventData,
              hasListener: !!this.syncDataSuccessToastListener,
            });

            const toastShownTime = eventData?.timestamp || Date.now();

            // Clear any existing timeout
            if (this.animationStopTimeout) {
              clearTimeout(this.animationStopTimeout);
              this.animationStopTimeout = null;
              devLog.info('[AutoSyncService] Cleared previous animation stop timeout');
            }

            // Set timeout from when toast is shown
            // Toast delay: 8s, Toast duration: 3s, Buffer: 1s = 12s total
            const timeoutDelay = 12000;
            devLog.info(
              '[AutoSyncService] showSyncDataSuccess called, setting animation stop timeout',
              {
                toastShownTime: new Date(toastShownTime).toISOString(),
                timeoutDelay,
                timeoutWillFireAt: new Date(toastShownTime + timeoutDelay).toISOString(),
                note: 'Toast will be visible from ~4s, animation will stop at ~8s',
              },
            );

            this.animationStopTimeout = setTimeout(() => {
              try {
                const timeoutFiredTime = Date.now();
                const actualDelay = timeoutFiredTime - toastShownTime;
                devLog.info('[AutoSyncService] Animation stop timeout fired', {
                  expectedDelay: timeoutDelay,
                  actualDelay,
                  toastShownTime: new Date(toastShownTime).toISOString(),
                  timeoutFiredTime: new Date(timeoutFiredTime).toISOString(),
                });

                // Emit multiple times to ensure it's received
                DeviceEventEmitter.emit('TOAST_ANIMATION_STOP');
                setTimeout(() => {
                  DeviceEventEmitter.emit('TOAST_ANIMATION_STOP');
                }, 500);
                devLog.info('[AutoSyncService] Stopping animation after success toast shown');
              } catch (error) {
                devLog.error('[AutoSyncService] Error in animation stop timeout:', error);
              }
              this.animationStopTimeout = null;
            }, timeoutDelay);
          },
        );

        devLog.info('[AutoSyncService] Event listener set up for SYNC_DATA_SUCCESS_TOAST_SHOWN', {
          hasListener: !!this.syncDataSuccessToastListener,
        });
      } catch (error) {
        devLog.error('[AutoSyncService] Failed to set up event listener:', error);
      }
    })();
  }

  static start(manualSync: boolean = false): void {
    devLog.info('[AutoSyncService] start() called', {
      isRunning: this.isRunning,
      isInitializing: this.isInitializing,
      isInDetailDeviceScreen: this.isInDetailDeviceScreen,
      manualSync,
    });

    if (!this.isUserLoggedIn()) {
      devLog.warn('[AutoSyncService] User not logged in - preventing AutoSync start');
      return;
    }

    // Check if user is logged out - prevent AutoSync from starting after logout
    try {
      const { AuthSessionService } = require('../auth/AuthSessionService');
      if (AuthSessionService.isLoggedOut) {
        devLog.warn('[AutoSyncService] User is logged out - preventing AutoSync start');
        return;
      }
    } catch (error) {
      devLog.warn('[AutoSyncService] Failed to check logout state:', error);
    }

    // Set up event listeners if not already set up
    this.setupEventListeners();

    (async () => {
      try {
        const { DeviceEventEmitter } = await import('react-native');
        DeviceEventEmitter.emit('AUTOSYNC_SERVICE_STARTED', {
          timestamp: new Date().toISOString(),
          manualSync,
        });
        devLog.info('[AutoSyncService] AUTOSYNC_SERVICE_STARTED event emitted');
      } catch (error) {
        devLog.error('[AutoSyncService] Failed to emit AUTOSYNC_SERVICE_STARTED:', error);
      }
    })();

    // For manual sync when service is already running, perform sync directly
    if (manualSync && this.isRunning && !this.isInitializing) {
      devLog.info(
        '[AutoSyncService] Manual sync requested while service running - performing sync directly',
        {
          isPaused: this.isPaused,
          isInDetailDeviceScreen: this.isInDetailDeviceScreen,
        },
      );
      // Always perform manual sync, even if paused or in detail device screen
      this.performSafeSync(true).catch((error) => {
        devLog.error('[AutoSyncService] Manual sync failed:', error);
      });
      return;
    }

    if (this.isInDetailDeviceScreen || this.isRunning || this.isInitializing) {
      return;
    }

    this.clearPendingOperations();
    this.isInitializing = true;

    this.pendingStartTimeout = setTimeout(async () => {
      try {
        if (this.isInDetailDeviceScreen) {
          this.isInitializing = false;
          this.pendingStartTimeout = null;
          return;
        }

        const sdkReady = await this.checkSDKReadiness();
        if (!sdkReady) {
          devLog.warn('AutoSyncService: Device SDKs not ready, continuing with OS-only mode');
        }

        if (this.isInDetailDeviceScreen) {
          this.isInitializing = false;
          this.pendingStartTimeout = null;
          return;
        }

        if (!this.isInitializing) {
          this.isInitializing = true;
        }

        await this.initializeWithSafetyChecks();

        this.isRunning = true;
        this.isInitializing = false;
        this.pendingStartTimeout = null;

        if (!this.isPaused) {
          try {
            await this.performSafeSync();
          } catch (error) {
            devLog.error('AutoSyncService: Initial sync failed:', error);
          }
        }

        if (!this.isPaused) {
          this.startSyncIntervals();
        }
      } catch (error) {
        this.isInitializing = false;
        this.isRunning = false;
        this.pendingStartTimeout = null;
        devLog.error('AutoSyncService: Failed to start:', error);
      }
    }, 1000);
  }

  private static async checkSDKReadiness(): Promise<boolean> {
    try {
      return !!(YCRingManager?.getAllHealthData || RWRingManager?.getAllHealthData);
    } catch {
      return false;
    }
  }

  private static async initializeWithSafetyChecks(): Promise<void> {
    try {
      const isYCAvailable = YCRingManager && YCRingManager.getAllHealthData;
      const isRWAvailable = RWRingManager && RWRingManager.getAllHealthData;
      if (!isYCAvailable && !isRWAvailable) {
        devLog.warn('AutoSyncService: No native modules available, OS-only mode');
      }
    } catch {}
  }

  private static startSyncIntervals(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    this.syncInterval = setInterval(async () => {
      if (!this.isRunning || this.shouldAbort()) {
        return;
      }

      try {
        await this.performSafeSync();
      } catch (error) {
        devLog.error('AutoSyncService: Sync interval error:', error);
        this.syncCallbacks.onSyncError?.(error, 'interval');

        if (this.consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
          this.stop();
          setTimeout(() => this.start(), 10000);
        }
      }
    }, SYNC_INTERVAL_MS);
  }

  private static async performSafeSync(isManualSync: boolean = false): Promise<void> {
    if (!this.isUserLoggedIn()) {
      devLog.warn('[AutoSyncService] User not logged in - aborting sync');
      return;
    }

    // Check if user is logged out - prevent sync after logout
    try {
      const { AuthSessionService } = require('../auth/AuthSessionService');
      if (AuthSessionService.isLoggedOut) {
        devLog.warn('[AutoSyncService] User is logged out - aborting sync');
        return;
      }
    } catch (error) {
      devLog.warn('[AutoSyncService] Failed to check logout state:', error);
    }

    // Clear any existing animation stop timeout from previous syncs
    // This ensures we don't have overlapping timeouts stopping animation prematurely
    if (this.animationStopTimeout) {
      clearTimeout(this.animationStopTimeout);
      this.animationStopTimeout = null;
      devLog.info(
        '[AutoSyncService] Cleared previous animation stop timeout at start of performSafeSync',
      );
    }
    devLog.info('[AutoSyncService] performSafeSync called', {
      shouldAbort: this.shouldAbort(),
      isDeviceSyncRunning: this.isDeviceSyncRunning,
      isOSSyncRunning: this.isOSSyncRunning,
      isPaused: this.isPaused,
      isInDetailDeviceScreen: this.isInDetailDeviceScreen,
      isManualSync,
      isManualSyncType: typeof isManualSync,
      isManualSyncValue: isManualSync === true,
    });

    // For manual sync, only abort if in detail device screen (not if paused)
    // Manual sync should always run even if service is paused
    if (isManualSync === true) {
      devLog.info('[AutoSyncService] Manual sync detected, bypassing pause check');
      if (this.isInDetailDeviceScreen) {
        devLog.warn(
          '[AutoSyncService] performSafeSync aborted (manual sync but in detail device screen)',
        );
        return;
      }
      // For manual sync, resume if paused
      if (this.isPaused) {
        devLog.info('[AutoSyncService] Manual sync: Service is paused, resuming...');
        this.resume(false);
      }
      // Continue with sync for manual sync
    } else {
      // For automatic sync, check shouldAbort
      if (this.shouldAbort()) {
        devLog.warn('[AutoSyncService] performSafeSync aborted (shouldAbort=true)');
        return;
      }
    }

    // Bluetooth check moved to device sync only (OS sync doesn't need Bluetooth)

    // For manual sync, allow running even if sync is already running (but skip if same type)
    if (!isManualSync && (this.isDeviceSyncRunning || this.isOSSyncRunning)) {
      devLog.warn('[AutoSyncService] performSafeSync skipped (sync already running)', {
        isDeviceSyncRunning: this.isDeviceSyncRunning,
        isOSSyncRunning: this.isOSSyncRunning,
      });
      return;
    }

    // For manual sync, if device sync is running, skip device sync but allow OS sync
    if (isManualSync && this.isDeviceSyncRunning) {
      devLog.info(
        '[AutoSyncService] Manual sync: Device sync already running, skipping device sync',
      );
    }

    try {
      if (isManualSync) {
        devLog.info('[AutoSyncService] Manual sync detected - skipping error cooldown check');
      } else if (this.consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
        const timeSinceLastError = this.lastErrorTime
          ? Date.now() - new Date(this.lastErrorTime).getTime()
          : 0;
        if (timeSinceLastError < ERROR_COOLDOWN_MS) {
          devLog.warn('[AutoSyncService] In error cooldown period - skipping sync', {
            consecutiveErrorCount: this.consecutiveErrorCount,
            timeSinceLastError,
            cooldownRemaining: ERROR_COOLDOWN_MS - timeSinceLastError,
          });
          try {
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('TOAST_ANIMATION_STOP');
          } catch {}
          return;
        }
        this.consecutiveErrorCount = 0;
        this.lastErrorTime = null;
      }

      const syncPromises: Promise<void>[] = [];
      let deviceSyncSkipped = false;

      // Start OS sync immediately (doesn't need Bluetooth)
      if (this.osSync && !this.isOSSyncRunning) {
        devLog.info('[AutoSyncService] Adding OS sync to promises');
        syncPromises.push(this.runOSSync());
      } else {
        devLog.info('[AutoSyncService] OS sync skipped', {
          hasOsSync: !!this.osSync,
          isOSSyncRunning: this.isOSSyncRunning,
        });
      }

      // Start device sync (needs Bluetooth, but run in parallel with OS sync)
      if (!this.isDeviceSyncRunning && !this.isInDetailDeviceScreen) {
        devLog.info('[AutoSyncService] Starting device sync');
        const deviceSyncPromise = (async () => {
          // Check Bluetooth only for device sync
          const bluetoothEnabled = await isBluetoothEnabled();
          if (!bluetoothEnabled) {
            devLog.warn('AutoSyncService: Bluetooth is not enabled, skipping device sync');
            if (Platform.OS === 'ios') {
              try {
                let bluetoothState = await getBluetoothStateRaw();
                if (bluetoothState === 'Unknown') {
                  await new Promise((resolve) => setTimeout(resolve, 2000));
                  bluetoothState = await getBluetoothStateRaw();
                  if (bluetoothState === 'PoweredOn') {
                    await isBluetoothEnabled();
                  } else if (bluetoothState === 'Unknown') {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    bluetoothState = await getBluetoothStateRaw();
                    if (bluetoothState !== 'PoweredOn') {
                      return;
                    }
                    await isBluetoothEnabled();
                  } else if (bluetoothState !== 'PoweredOn') {
                    return;
                  }
                } else if (bluetoothState !== 'PoweredOn') {
                  return;
                }
              } catch {
                return;
              }
            } else {
              return;
            }
          }
          return this.runDeviceSync();
        })();

        this.activeDeviceSyncPromise = deviceSyncPromise;

        const wrappedPromise = deviceSyncPromise
          .then(() => {
            devLog.info('[AutoSyncService] Device sync promise resolved');
          })
          .catch((error) => {
            devLog.error('[AutoSyncService] Device sync promise rejected', error);
            throw error;
          })
          .finally(() => {
            this.activeDeviceSyncPromise = null;
          });

        syncPromises.push(wrappedPromise);
      } else {
        deviceSyncSkipped = true;
        devLog.info('[AutoSyncService] Device sync skipped', {
          isDeviceSyncRunning: this.isDeviceSyncRunning,
          isInDetailDeviceScreen: this.isInDetailDeviceScreen,
        });
      }

      devLog.info('[AutoSyncService] Sync promises count', {
        count: syncPromises.length,
        willAwait: syncPromises.length > 0,
      });

      if (syncPromises.length > 0) {
        const results = await Promise.allSettled(syncPromises);
        const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
        const rejectedCount = results.filter((r) => r.status === 'rejected').length;
        devLog.info('[AutoSyncService] All sync promises completed', {
          total: results.length,
          fulfilled: fulfilledCount,
          rejected: rejectedCount,
        });

        // Don't set timeout here - wait for SYNC_DATA_SUCCESS_TOAST_SHOWN event
        // This ensures we calculate timeout from when toast is actually shown, not from when promises complete
        devLog.info(
          '[AutoSyncService] Sync promises completed, waiting for showSyncDataSuccess to be called',
          {
            fulfilledCount,
            rejectedCount,
            total: results.length,
            note: 'Timeout will be set when SYNC_DATA_SUCCESS_TOAST_SHOWN event is received',
          },
        );
      } else {
        devLog.warn(
          '[AutoSyncService] No sync promises to execute - performSafeSync returning early',
        );
        if (deviceSyncSkipped) {
          try {
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('TOAST_ANIMATION_STOP');
            devLog.info('[AutoSyncService] Stopping animation - device sync was skipped');
          } catch {}
        } else {
          devLog.info('[AutoSyncService] Keeping animation - sync may be in progress');
        }
      }
    } catch (syncError) {
      devLog.error('AutoSyncService: Critical error in performSafeSync:', syncError);
      this.consecutiveErrorCount++;
      this.lastErrorTime = new Date().toISOString();
    }
  }

  private static async runOSSync(): Promise<void> {
    if (this.shouldAbort()) {
      return;
    }

    const syncStatusString = StorageServiceManager.getString(STORAGE_KEYS.SYNC_DATA_STATUS);
    let syncDataStatus = false;

    if (syncStatusString !== null && syncStatusString !== undefined) {
      try {
        syncDataStatus = JSON.parse(syncStatusString);
      } catch {
        syncDataStatus = syncStatusString === 'true' || syncStatusString === '1';
      }
    }

    if (!syncDataStatus) {
      this.isOSSyncRunning = false;
      return;
    }

    const hasPermissions = await hasOSHealthPermissions();
    if (!hasPermissions) {
      this.isOSSyncRunning = false;
      return;
    }

    if (this.shouldAbort()) {
      this.isOSSyncRunning = false;
      return;
    }

    this.isOSSyncRunning = true;

    try {
      const result = await this.osSync!();
      this.lastSyncTime = new Date().toISOString();
      this.lastSyncSource = 'os';
      this.consecutiveErrorCount = 0;
      this.lastErrorTime = null;
      this.syncCallbacks.onSyncComplete?.(result, 'os');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isPermissionError =
        errorMessage.toLowerCase().includes('permission') ||
        errorMessage.toLowerCase().includes('unauthorized') ||
        errorMessage.toLowerCase().includes('not authorized');

      if (isPermissionError) {
        this.consecutiveErrorCount++;

        if (this.consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
          StorageServiceManager.setString(STORAGE_KEYS.SYNC_DATA_STATUS, JSON.stringify(false));
          try {
            const { DeviceEventEmitter } = await import('react-native');
            DeviceEventEmitter.emit('SYNC_DATA_STATUS_CHANGED', {
              status: false,
              reason: 'permission_denied_persistent',
            });
          } catch {}
        }

        this.lastErrorTime = new Date().toISOString();
        this.isOSSyncRunning = false;
        return;
      }

      if (this.consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
        this.lastErrorTime = new Date().toISOString();
        this.isOSSyncRunning = false;
        return;
      }

      this.consecutiveErrorCount++;
      this.lastErrorTime = new Date().toISOString();
      devLog.error(
        `AutoSyncService: OS sync failed (${this.consecutiveErrorCount} consecutive errors):`,
        error,
      );
      this.syncCallbacks.onSyncError?.(error, 'os');
    } finally {
      this.isOSSyncRunning = false;
    }
  }

  private static async runDeviceSync(): Promise<void> {
    devLog.info('[AutoSyncService] runDeviceSync started');

    if (this.shouldAbort()) {
      devLog.warn('[AutoSyncService] runDeviceSync aborted (shouldAbort=true)');
      this.isDeviceSyncRunning = false;
      return;
    }

    let connectionTimeout: NodeJS.Timeout | null = null;
    let device: any = null;

    try {
      const connectedDeviceString = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
      if (!connectedDeviceString) {
        devLog.warn('[AutoSyncService] runDeviceSync aborted - no connected device in storage');
        this.isDeviceSyncRunning = false;
        return;
      }

      device = JSON.parse(connectedDeviceString);

      if (device.isTemporary) {
        devLog.warn('[AutoSyncService] runDeviceSync aborted - device is temporary');
        this.isDeviceSyncRunning = false;
        return;
      }

      const deviceUuid = device.uuid || device.id;
      const deviceType = device.deviceType || device.type || 'unknown';

      devLog.info('[AutoSyncService] runDeviceSync device info', {
        uuid: deviceUuid ? `${deviceUuid.substring(0, 8)}...` : 'missing',
        deviceType,
        name: device.name,
      });

      if (!this.isValidDeviceUuid(deviceUuid)) {
        devLog.warn('[AutoSyncService] runDeviceSync aborted - invalid device UUID', {
          deviceUuid,
        });
        this.isDeviceSyncRunning = false;
        return;
      }

      if (this.shouldAbort()) {
        devLog.warn('[AutoSyncService] runDeviceSync aborted (shouldAbort=true after checks)');
        this.isDeviceSyncRunning = false;
        return;
      }

      const alreadyConnected = await isDeviceConnectedByUUID(deviceUuid, deviceType);

      await resetSDKState(true);

      const deviceName = this.getDeviceNameFromStorage(deviceUuid) || device.name || 'Thiết bị';
      try {
        devLog.info('[AutoSyncService] Showing device connecting toast early', {
          deviceName,
        });
        if (!alreadyConnected) {
          ToastService.showDeviceConnecting(deviceName);
        }
        DeviceEventEmitter.emit('TOAST_ANIMATION_START', {
          deviceName,
        });
      } catch (error) {
        devLog.error('[AutoSyncService] Failed to show device connecting toast:', error);
      }

      devLog.info('[AutoSyncService] runDeviceSync proceeding with connection');

      const connected = await this.ensureDeviceConnected(deviceUuid, deviceType, alreadyConnected);
      if (!connected || this.shouldAbort()) {
        this.isDeviceSyncRunning = false;
        ToastService.showDeviceConnectionError(device.name || 'Thiết bị');
        return;
      }

      if (!alreadyConnected) {
        ToastService.showDeviceConnectionSuccess(device.name || 'Thiết bị');
      }

      this.isDeviceSyncRunning = true;

      connectionTimeout = setTimeout(async () => {
        try {
          clearHealthDataOperationLock();
          forceStopHealthDataOperation();
          resetConnectionState();
          this.isDeviceSyncRunning = false;
          setTimeout(() => this.start(), 5000);
        } catch {}
      }, DEVICE_SYNC_TIMEOUT_MS);

      if (this.shouldAbort()) {
        this.isDeviceSyncRunning = false;
        this.activeDeviceSyncPromise = null;
        if (connectionTimeout) clearTimeout(connectionTimeout);
        return;
      }

      const bluetoothStillEnabled = await isBluetoothEnabled();
      if (!bluetoothStillEnabled) {
        devLog.warn('[AutoSyncService] Bluetooth turned off during sync, aborting device sync');
        this.isDeviceSyncRunning = false;
        this.activeDeviceSyncPromise = null;
        if (connectionTimeout) clearTimeout(connectionTimeout);
        return;
      }

      let result;
      try {
        result = await getHealthDataByDeviceType(deviceType, deviceUuid);

        if (this.shouldAbort()) {
          this.isDeviceSyncRunning = false;
          this.activeDeviceSyncPromise = null;
          if (connectionTimeout) clearTimeout(connectionTimeout);
          return;
        }

        this.lastSyncTime = new Date().toISOString();
        this.lastSyncSource = 'device';
        this.consecutiveErrorCount = 0;
        this.lastErrorTime = null;

        this.syncCallbacks.onSyncComplete?.(result, 'device');

        try {
          const { DeviceEventEmitter } = await import('react-native');
          DeviceEventEmitter.emit('DEVICE_SYNC_COMPLETED', {
            source: 'device',
            timestamp: this.lastSyncTime,
            hasResult: !!result,
          });
        } catch {}

        if (connectionTimeout) clearTimeout(connectionTimeout);
      } catch (syncError) {
        const syncErrorMessage = syncError instanceof Error ? syncError.message : String(syncError);

        if (syncErrorMessage.includes('Connection already in progress')) {
          try {
            const { resetConnectionState } = await import(
              './device-connect/DeviceConnectionService'
            );
            resetConnectionState();
          } catch {}
        }

        if (!this.classifyError(syncErrorMessage).isBluetooth) {
          throw syncError;
        }
      }
    } catch (error) {
      this.handleDeviceSyncError(error, connectionTimeout);
    } finally {
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
      }
      this.isDeviceSyncRunning = false;
      forceStopHealthDataOperation();
    }
  }

  private static async ensureDeviceConnected(
    deviceUuid: string,
    deviceType: string,
    alreadyConnected: boolean = false,
  ): Promise<boolean> {
    try {
      const { isDeviceConnectedByUUID, connectDevice, scanDevices, stopScan } = await import(
        './device-connect/DeviceConnectionService'
      );

      if (this.shouldAbort()) {
        return false;
      }

      let connected = alreadyConnected;

      if (!connected) {
        connected = await isDeviceConnectedByUUID(deviceUuid, deviceType);
      }

      if (!connected) {
        if (this.shouldAbort()) {
          return false;
        }

        try {
          connected = await connectDevice(deviceUuid, deviceType, 0, true);
        } catch {}

        if (!connected && !this.shouldAbort()) {
          try {
            await scanDevices(deviceType, 0, true);
          } catch {}
          await new Promise((r) => setTimeout(r, 1500));

          if (this.shouldAbort()) {
            try {
              await stopScan(deviceType);
            } catch {}
            return false;
          }

          try {
            connected = await connectDevice(deviceUuid, deviceType, 0, true);
          } catch {}
          try {
            await stopScan(deviceType);
          } catch {}
        }

        if (this.shouldAbort()) {
          return false;
        }

        connected = connected || (await isDeviceConnectedByUUID(deviceUuid, deviceType));
      }

      return connected;
    } catch {
      return false;
    }
  }

  static stop(): void {
    this.clearPendingOperations();
    this.isRunning = false;
    this.isDeviceSyncRunning = false;
    this.isOSSyncRunning = false;

    // Clear animation stop timeout if exists
    if (this.animationStopTimeout) {
      clearTimeout(this.animationStopTimeout);
      this.animationStopTimeout = null;
    }
    this.isInitializing = false;
    this.consecutiveErrorCount = 0;
    this.lastErrorTime = null;

    // Remove event listener
    if (this.syncDataSuccessToastListener) {
      this.syncDataSuccessToastListener.remove();
      this.syncDataSuccessToastListener = null;
      devLog.info('[AutoSyncService] Removed SYNC_DATA_SUCCESS_TOAST_SHOWN event listener');
    }

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  static pause(): void {
    if (this.isPaused) {
      return;
    }
    this.isPaused = true;
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  static resume(triggerSyncImmediately: boolean = false): void {
    if (!this.isPaused || !this.isRunning) {
      return;
    }

    this.isPaused = false;

    (async () => {
      try {
        const { DeviceEventEmitter } = await import('react-native');
        DeviceEventEmitter.emit('AUTOSYNC_SERVICE_STARTED', {
          timestamp: new Date().toISOString(),
          manualSync: triggerSyncImmediately,
          reason: 'resume',
        });
        devLog.info('[AutoSyncService] AUTOSYNC_SERVICE_STARTED event emitted (resume)');
      } catch (error) {
        devLog.error('[AutoSyncService] Failed to emit AUTOSYNC_SERVICE_STARTED on resume:', error);
      }
    })();

    if (!this.syncInterval) {
      this.startSyncIntervals();
    }

    if (triggerSyncImmediately && !this.isInDetailDeviceScreen) {
      this.performSafeSync().catch((error) => {
        devLog.error('AutoSyncService: Immediate sync after resume failed:', error);
      });
    }
  }

  static getStatus() {
    const timeSinceLastSync = this.lastSyncTime
      ? Date.now() - new Date(this.lastSyncTime).getTime()
      : null;

    return {
      isRunning: this.isRunning,
      isDeviceSyncRunning: this.isDeviceSyncRunning,
      isOSSyncRunning: this.isOSSyncRunning,
      isBothSyncRunning: this.isDeviceSyncRunning && this.isOSSyncRunning,
      lastSyncTime: this.lastSyncTime,
      lastSyncSource: this.lastSyncSource,
      hasOSSync: !!this.osSync,
      hasDeviceSync: !!this.deviceSync,
      consecutiveErrorCount: this.consecutiveErrorCount,
      lastErrorTime: this.lastErrorTime,
      intervalActive: !!this.syncInterval,
      timeSinceLastSync,
      isInDetailDevice: this.isInDetailDeviceScreen,
      isInitializing: this.isInitializing,
      isPaused: this.isPaused,
    };
  }

  static isAutoSyncRunning(): boolean {
    return this.isRunning;
  }

  static isDeviceSyncActive(): boolean {
    return this.isDeviceSyncRunning;
  }

  static isOSSyncActive(): boolean {
    return this.isOSSyncRunning;
  }

  static isSyncActive(): boolean {
    return this.isDeviceSyncRunning || this.isOSSyncRunning;
  }

  static isServicePaused(): boolean {
    return this.isPaused;
  }

  static registerOSSync(callback: () => Promise<any>): void {
    this.osSync = callback;
  }

  static registerOSRefetch(callback: () => Promise<void>): void {
    this.osRefetch = callback;
  }

  static registerSyncCallbacks(callbacks: {
    onSyncComplete?: (data: any, source: string) => void;
    onSyncError?: (error: any, source: string) => void;
  }): void {
    this.syncCallbacks = callbacks;
  }

  static async performManualSync(): Promise<void> {
    devLog.info('[AutoSyncService] performManualSync called', {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      isInDetailDeviceScreen: this.isInDetailDeviceScreen,
      isDeviceSyncRunning: this.isDeviceSyncRunning,
      isOSSyncRunning: this.isOSSyncRunning,
    });

    if (!this.isUserLoggedIn()) {
      devLog.warn('[AutoSyncService] User not logged in - aborting manual sync');
      return;
    }

    try {
      const {
        checkAndRequestBluetoothPermissions,
        showBluetoothSettingsDialog,
        resetBluetoothEnableCooldown,
      } = await import('@/hooks/useBluetoothPermission');
      const { checkBlePermissions, requestBlePermissionsViaBluetoothStateManager } = await import(
        '@/hooks/blePermission'
      );

      resetBluetoothEnableCooldown();

      devLog.info('[AutoSyncService] Manual sync: Checking and requesting Bluetooth permissions');

      if (Platform.OS === 'android') {
        const hasPermissions = await checkBlePermissions();

        if (!hasPermissions) {
          devLog.info(
            '[AutoSyncService] Manual sync: Requesting Bluetooth enable via BluetoothStateManager',
          );
          try {
            const granted = await requestBlePermissionsViaBluetoothStateManager();
            if (!granted) {
              throw new Error('BLUETOOTH_PERMISSION_DENIED');
            }
            devLog.info(
              '[AutoSyncService] Manual sync: Permissions granted via BluetoothStateManager',
            );
          } catch (permissionError: any) {
            if (
              permissionError.message === 'USER_DENIED_BLUETOOTH_PERMISSION' ||
              permissionError.message === 'BLUETOOTH_PERMISSION_DENIED'
            ) {
              devLog.warn('[AutoSyncService] Manual sync: User denied Bluetooth permission');
              throw new Error('Bluetooth permissions denied by user');
            }
            devLog.error(
              '[AutoSyncService] Manual sync: Permission request failed',
              permissionError,
            );
            throw new Error('Bluetooth permission request failed');
          }
        }

        const permissionResult = await checkAndRequestBluetoothPermissions();
        if (!permissionResult.granted) {
          if (permissionResult.shouldShowSettings) {
            showBluetoothSettingsDialog();
          }
          throw new Error('Bluetooth permissions not granted or Bluetooth not enabled');
        }
      } else {
        devLog.info('[AutoSyncService] Manual sync: Checking iOS Bluetooth permissions');
        const permissionResult = await checkAndRequestBluetoothPermissions();

        devLog.info('[AutoSyncService] Manual sync: Permission result', {
          granted: permissionResult.granted,
          shouldShowSettings: permissionResult.shouldShowSettings,
        });

        if (!permissionResult.granted) {
          devLog.warn('[AutoSyncService] Manual sync: Bluetooth permissions not granted');
          if (permissionResult.shouldShowSettings) {
            showBluetoothSettingsDialog();
          }
          throw new Error('Bluetooth permissions not granted or Bluetooth not enabled');
        }

        devLog.info('[AutoSyncService] Manual sync: Bluetooth permissions granted and enabled');
      }
    } catch (error) {
      devLog.error('[AutoSyncService] Manual sync: Bluetooth permission check failed', error);
      throw error;
    }

    if (!this.isRunning) {
      devLog.info('[AutoSyncService] Manual sync: Service not running, starting it...');
      this.start();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!this.isRunning) {
        const error = new Error('AutoSyncService failed to start');
        devLog.error('[AutoSyncService] performManualSync failed', error);
        throw error;
      }
    }

    if (this.isPaused) {
      devLog.info('[AutoSyncService] Manual sync: Service is paused, resuming...');
      this.resume(false);
    }

    devLog.info('[AutoSyncService] Calling performSafeSync for manual sync');
    await this.performSafeSync(true);
    devLog.info('[AutoSyncService] performManualSync completed');
  }
}

export default AutoSyncService;
