import { Platform, NativeModules, NativeEventEmitter } from 'react-native';
import { devLog } from '@/utils/loggingHelper';
import { ensureBluetoothEnabled } from '../ble/BluetoothManager';
import {
  ycGetBatteryLevel,
  ycGetBatteryLevelByUUID,
  ycIsAvailable,
  ycIsUuidConnected,
  ycStartScan,
} from './YCProductBridge';

const { RWRingManager, YCRingManager } = NativeModules;
const CONNECTION_CONFIG = {
  TIMEOUT_MS: 50000, // 50s timeout for battery checks
} as const;
let batteryRetryCount = 0;
const MAX_BATTERY_RETRIES = 2;
const isTimeoutError = (error: any): boolean => {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('timeout') || msg.includes('TIMEOUT');
};
const handleBatteryRetry = (
  deviceType: string,
  retryCount: number,
  maxRetries: number,
): boolean => {
  if (retryCount > maxRetries) {
    devLog.warn(
      `⚠️ [BatteryManager] ${deviceType} battery check max retries exceeded, giving up and waiting for next auto sync interval`,
      {
        retryCount: retryCount,
        maxRetries: maxRetries,
        nextInterval: '2 minutes',
      },
    );
    batteryRetryCount = 0; // Reset for next attempt
    return false; // Should give up
  }
  return true; // Should continue retry
};
const resetRetryCount = (): void => {
  batteryRetryCount = 0;
};
const incrementRetryCount = (): number => {
  return ++batteryRetryCount;
};
const performYCScanRefresh = async (): Promise<any> => {
  try {
    if (Platform.OS === 'ios' && ycIsAvailable()) {
      const devices = await withTimeout(ycStartScan(3), 10000);
      devLog.info(
        `📡 [BatteryManager] iOS YC scan refresh complete, found ${
          devices ? devices.length : 0
        } devices`,
      );
      if (eventEmitter) {
        eventEmitter.emit('scanComplete', {
          devices: devices || [],
          deviceType: 'yc',
          platform: 'ios',
          source: 'battery-timeout-scan-refresh',
        });
      }
      return devices;
    }
    try {
      await withTimeout(YCRingManager?.stopScan?.(), 10000);
    } catch (stopError) {
      devLog.warn('⚠️ [BatteryManager] stopScan failed:', stopError);
    }
    const refresh = await withTimeout(Promise.resolve(YCRingManager?.scanDevices?.()), 10000);
    devLog.info(
      `📡 [BatteryManager] Android YC scan refresh complete, found ${
        refresh ? refresh.length : 0
      } devices`,
    );
    if (eventEmitter) {
      eventEmitter.emit('scanComplete', {
        devices: refresh || [],
        deviceType: 'yc',
        platform: Platform.OS,
        source: 'battery-timeout-scan-refresh',
      });
    }
    return refresh;
  } catch (e) {
    devLog.warn('⚠️ [BatteryManager] YC scan-refresh failed', e);
    return [];
  }
};
const performDeviceReconnection = async (deviceType: string, uuid?: string): Promise<boolean> => {
  const { connectDevice } = await import('./DeviceConnectionService');
  const reconnectResult = await connectDevice(uuid || '', deviceType, 0, true);
  if (reconnectResult) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return true;
  } else {
    devLog.warn(`⚠️ [BatteryManager] ${deviceType} device reconnection failed`);
    return false;
  }
};
// Khởi tạo eventEmitter an toàn với defensive checks
const createSafeEventEmitter = (): NativeEventEmitter | null => {
  try {
    // Kiểm tra RWRingManager trước
    if (
      RWRingManager !== null &&
      RWRingManager !== undefined &&
      typeof RWRingManager === 'object' &&
      typeof RWRingManager.addListener === 'function'
    ) {
      devLog.info('[BatteryManager] Creating NativeEventEmitter with RWRingManager');
      return new NativeEventEmitter(RWRingManager);
    }

    // Fallback sang YCRingManager cho iOS
    if (
      Platform.OS === 'ios' &&
      YCRingManager !== null &&
      YCRingManager !== undefined &&
      typeof YCRingManager === 'object' &&
      typeof YCRingManager.addListener === 'function'
    ) {
      devLog.info('[BatteryManager] Creating NativeEventEmitter with YCRingManager');
      return new NativeEventEmitter(YCRingManager);
    }

    devLog.warn('[BatteryManager] No valid native module found for NativeEventEmitter', {
      hasRWRingManager: !!RWRingManager,
      hasYCRingManager: !!YCRingManager,
      RWHasAddListener: RWRingManager && typeof RWRingManager.addListener === 'function',
      YCHasAddListener: YCRingManager && typeof YCRingManager.addListener === 'function',
      platform: Platform.OS,
    });
    return null;
  } catch (error) {
    devLog.error('[BatteryManager] Failed to create NativeEventEmitter:', error);
    return null;
  }
};

const eventEmitter: NativeEventEmitter | null = createSafeEventEmitter();

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
};
export const getBatteryLevelByDeviceType = async (
  deviceType: string,
  uuid: string,
  options: { skipReconnect?: boolean } = {},
): Promise<number | null> => {
  return performBatteryCheck(deviceType, uuid, options);
};
const performBatteryCheck = async (
  deviceType: string,
  uuid: string,
  options: { skipReconnect?: boolean } = {},
): Promise<number | null> => {
  const TIMEOUT_MS = CONNECTION_CONFIG.TIMEOUT_MS;

  if (!uuid || uuid === 'temp-device' || uuid.startsWith('temp-')) {
    return null;
  }

  try {
    const bluetoothReady = await ensureBluetoothEnabled(false);
    if (!bluetoothReady) {
      devLog.warn(`🔋 [BatteryManager] Bluetooth is not available for battery check`);
      return null;
    }
    if (deviceType === 'yc' && Platform.OS === 'ios') {
      try {
        const connected = await ycIsUuidConnected(uuid);
        if (!connected) {
          devLog.warn('[BatteryManager] YC device not connected, attempting reconnect', {
            uuid: uuid.slice(0, 8) + '...',
          });
          const reconnected = await performDeviceReconnection('yc', uuid);
          if (!reconnected) {
            devLog.warn('⚠️ [BatteryManager] YC device reconnect failed, skipping battery');
            return null;
          }
        }
      } catch (e) {
        devLog.warn('⚠️ [BatteryManager] isDeviceConnectedByUUID check failed', e);
      }
    }

    if (options.skipReconnect && Platform.OS === 'android') {
      devLog.info(
        '[BatteryManager] skipReconnect enabled on Android, returning null without battery check',
        {
          uuid: uuid?.slice(0, 8) + '...',
        },
      );
      return null;
    }

    devLog.info('[BatteryManager] Getting battery level', {
      deviceType,
      uuid: uuid ? uuid.slice(0, 8) + '...' : 'none',
      platform: Platform.OS,
    });

    let result;
    try {
      if (deviceType === 'yc') {
        result = await getYCBatteryLevel(uuid, TIMEOUT_MS);
      } else {
        result = await getRWBatteryLevel(TIMEOUT_MS);
      }
    } catch (batteryError) {
      const msg = batteryError instanceof Error ? batteryError.message : String(batteryError);
      const isTimeout = msg.includes('timeout') || msg.includes('TIMEOUT');

      if (isTimeout) {
        devLog.warn('⚠️ [BatteryManager] Battery check timeout, returning null');
        return null;
      } else {
        devLog.warn('⚠️ [BatteryManager] Battery check failed, returning null:', batteryError);
        return null;
      }
    }
    if (typeof result === 'number' && result >= 0 && result <= 100) {
      return result;
    } else {
      devLog.warn('⚠️ [BatteryManager] Invalid battery value', {
        result,
        type: typeof result,
        deviceType,
      });
      return null;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    devLog.error('❌ [BatteryManager] Battery error (NON-CRASHING)', {
      deviceType,
      uuid: uuid ? String(uuid).substring(0, 8) + '...' : 'none',
      error: errorMessage,
    });
    return null;
  }
};
const getYCBatteryLevel = async (uuid: string, timeoutMs: number): Promise<any> => {
  if (Platform.OS === 'ios') {
    if (ycIsAvailable()) {
      let battery = await ycGetBatteryLevel();
      if (typeof battery === 'number') {
        resetRetryCount();
        return battery;
      }
      battery = await ycGetBatteryLevelByUUID(uuid);
      if (typeof battery === 'number') {
        resetRetryCount();
        return battery;
      }
      devLog.warn('⚠️ [BatteryManager] YCProductModule battery returned null');
      return null;
    }
    try {
      const res = await withTimeout((YCRingManager as any)?.getBatteryLevel?.(uuid), timeoutMs);
      const val = typeof res === 'object' && res !== null ? (res as any).battery : res;
      if (typeof val === 'number') {
        resetRetryCount();
        return val;
      }
    } catch (e) {
      devLog.warn('⚠️ [BatteryManager] iOS YC legacy getBatteryLevel failed', e);
    }
    devLog.warn('⚠️ [BatteryManager] YCProductModule not available on iOS, battery unavailable');
    return null;
  } else {
    return await withTimeout(YCRingManager.getBatteryLevel(), timeoutMs);
  }
};
const getRWBatteryLevel = async (timeoutMs: number): Promise<any> => {
  try {
    const result = await withTimeout(RWRingManager.getBatteryLevel(), timeoutMs);
    resetRetryCount(); // Reset retry count on success
    return result;
  } catch (error) {
    if (isTimeoutError(error)) {
      const retryCount = incrementRetryCount();

      if (!handleBatteryRetry('RW', retryCount, MAX_BATTERY_RETRIES)) {
        throw error;
      }

      devLog.warn(
        '⚠️ [BatteryManager] RW battery check timeout, attempting reconnection and retry',
        {
          retryCount: retryCount,
          maxRetries: MAX_BATTERY_RETRIES,
        },
      );
      try {
        const reconnectSuccess = await performDeviceReconnection('RW');
        if (reconnectSuccess) {
          let result = await withTimeout(
            RWRingManager.getBatteryLevel(),
            15000, // 15s timeout for retry
          );
          resetRetryCount(); // Reset retry count on success
          return result;
        } else {
          throw error; // Throw original error
        }
      } catch (retryErr) {
        devLog.warn('⚠️ [BatteryManager] RW battery check retry failed:', retryErr);
        throw error; // Throw original error
      }
    } else {
      devLog.warn('⚠️ [BatteryManager] RW battery check failed:', error);
    }

    throw error;
  }
};
export const getBatteryLevel = async (
  uuid?: string,
  deviceType?: string,
): Promise<number | null> => {
  try {
    if (deviceType) {
      return await getBatteryLevelByDeviceType(deviceType, uuid || '');
    }
    let result;
    try {
      if (Platform.OS === 'ios') {
        const val = await ycGetBatteryLevel();
        return typeof val === 'number' ? val : null;
      }
      result = await RWRingManager.getBatteryLevel();
      return result;
    } catch (rwError) {
      if (Platform.OS !== 'ios') {
        return await YCRingManager.getBatteryLevel();
      }
      return null;
    }
  } catch (error) {
    devLog.error('❌ [BatteryManager] getBatteryLevel error:', error);
    throw error;
  }
};
