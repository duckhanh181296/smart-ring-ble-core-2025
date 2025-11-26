import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { devLog } from '@/utils/loggingHelper';
import { StorageServiceManager, STORAGE_KEYS } from '@/services/StorageService';

export { detectDeviceType, scanDevices, stopScan } from '../sync/DeviceScanner';

export { ensureBluetoothEnabled } from './BluetoothManager';
export { initSDK } from './SDKManager';

import { initSDK } from './SDKManager';
import { getBatteryLevel, getBatteryLevelByDeviceType } from './BatteryManager';
import {
  ycConnect,
  ycDisconnect,
  ycFetchAllHealthData,
  ycIsAvailable,
  ycGetConnectionStatus,
  ycIsConnected,
  ycIsUuidConnected,
  ycStartScan,
} from './YCProductBridge';
import { runAutoDeviceSync, getLastAutoSyncSkipReason } from '../sync/DeviceHealthSync';
import { dataNormalizer } from '@/services/sync-device/data-transform/DataNormalizerService';
import { resetScanState } from '../sync/DeviceScanner';
import { refreshBluetoothState } from './BluetoothManager';
import NetworkManager from '../../APIServiceManager';
import apiConfig from '@/configs/api-config';

const { RWRingManager, YCRingManager } = NativeModules as any;

// Timeout constants - JS timeout must be >= native timeout + buffer to prevent JS timeout before native
// Android native: 10s initial, 30s retry, 40s final safety → JS needs 45s
// iOS native: 75s → JS needs 80s (use max for both platforms)
const CONNECTION_TIMEOUT_MS = 45000; // 45s to match Android native final safety timeout (40s) + buffer
const ADD_DEVICE_TIMEOUT_MS = 15000;
const DEVICE_INFO_TIMEOUT_MS = 9000; // 9s to be > Android native 8s timeout + buffer
const RETRY_DELAY_MS = 1000;
const SDK_RESET_DELAY_MS = 500;
const CONNECTION_CHECK_TIMEOUT_MS = 9000; // 9s to be > Android native 8s timeout + buffer
const DEVICE_INFO_REUSE_TIMEOUT_MS = 7000; // 7s to be < Android native 8s timeout (for reuse check)
const CONNECTION_CHECK_CACHE_TTL = 2000;
const YC_SDK_WARNING_THROTTLE_MS = 30000;

let _isConnecting = false;
let _isHealthDataOperationInProgress = false;
let _connectionAttempts = new Set<string>();
let _lastYCSDKWarningTime = 0;
// Track pending device info requests to prevent duplicate calls
let _pendingDeviceInfoRequest: Promise<any> | null = null;
let _pendingDeviceInfoAbortController: AbortController | null = null;

const formatUuidForLog = (uuid: any): string => {
  if (!uuid) return 'undefined...';
  return String(uuid).substring(0, 8) + '...';
};

const addDeviceToServer = async (
  deviceUuid: string,
  deviceType: string,
  deviceName?: string,
): Promise<number | null> => {
  try {
    const addPayload = {
      name: deviceName || `Device ${deviceUuid.substring(0, 8)}`,
      type: deviceType,
      uuid: deviceUuid,
    };

    const response: any = await Promise.race([
      NetworkManager.request(apiConfig.devices.addNewDevice(addPayload)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Add-device API timeout')), ADD_DEVICE_TIMEOUT_MS),
      ),
    ]);

    const serverDeviceId = response?.data?.id || response?.id;
    return serverDeviceId && Number.isFinite(Number(serverDeviceId))
      ? Number(serverDeviceId)
      : null;
  } catch (error) {
    devLog.error('[DeviceConnection] Add-device API failed', {
      deviceUuid: formatUuidForLog(deviceUuid),
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
};

export const resetSDKState = async (skipDelay: boolean = false): Promise<void> => {
  try {
    if (!skipDelay) {
      await new Promise((resolve) => setTimeout(resolve, SDK_RESET_DELAY_MS));
    }
  } catch (error) {
    devLog.warn('[DeviceConnection] SDK reset error:', error);
  }
};

const clearOldDeviceData = (targetUuid: string) => {
  try {
    const storedDevice = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
    if (storedDevice) {
      const parsed = JSON.parse(storedDevice);
      if (parsed.uuid && parsed.uuid !== targetUuid) {
        devLog.info('[DeviceConnection] Clearing old device data', {
          oldUuid: parsed.uuid?.substring(0, 8),
          newUuid: targetUuid?.substring(0, 8),
        });
        StorageServiceManager.removeItem(STORAGE_KEYS.CONNECTED_DEVICE);
        StorageServiceManager.removeItem(STORAGE_KEYS.DASHBOARD_PRIORITY_HEALTH_DATA);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
};

export const isConnectionInProgress = () => _isConnecting;
export const isHealthDataOperationInProgress = () => _isHealthDataOperationInProgress;
export const forceStopHealthDataOperation = () => {
  _isHealthDataOperationInProgress = false;
};
export const clearStuckConnection = (uuid: string) => {
  const clean = uuid?.trim().toUpperCase() || '';
  if (_connectionAttempts.has(clean)) {
    _connectionAttempts.delete(clean);
    _isConnecting = false;
    return true;
  }
  return false;
};

// Cancel all pending operations (device info, health data, etc.)
export const cancelAllPendingOperations = () => {
  devLog.info('[DeviceConnection] Canceling all pending operations');

  // Cancel pending device info request
  if (_pendingDeviceInfoAbortController) {
    try {
      _pendingDeviceInfoAbortController.abort();
      devLog.info('[DeviceConnection] AbortController aborted for pending device info request');
    } catch (abortError) {
      devLog.warn('[DeviceConnection] Error aborting device info request:', abortError);
    }
    _pendingDeviceInfoAbortController = null;
    _pendingDeviceInfoRequest = null;
    devLog.info('[DeviceConnection] Canceled pending device info request');
  } else {
    devLog.info('[DeviceConnection] No pending device info request to cancel');
  }
};

export const resetAllOperationLocks = () => {
  _isConnecting = false;
  _connectionAttempts.clear();

  // Cancel all pending operations
  cancelAllPendingOperations();

  try {
    require('./DeviceHealthSync')?.resetAllLocks?.();
  } catch {}
  try {
    require('../AutoSyncService').default?.resetLocks?.();
  } catch {}
  try {
    require('./DeviceScanner')?.resetScanLocks?.();
  } catch {}
};
export const clearHealthDataOperationLock = () => {
  _isHealthDataOperationInProgress = false;
};

export const setHealthDataOperationLock = (value: boolean) => {
  _isHealthDataOperationInProgress = value;
};
export const resetConnectionState = () => {
  _isConnecting = false;
};

const cleanUuid = (uuid?: string): string => (typeof uuid === 'string' ? uuid.trim() : '');
export const upsertConnectedDeviceInfo = (
  uuid: string,
  deviceType: string,
  name?: string,
  serverId?: number,
  battery?: number | null,
): void => {
  try {
    const clean = cleanUuid(uuid);
    if (!clean) return;
    const type = (deviceType || 'yc').toLowerCase();
    const nowIso = new Date().toISOString();

    const currentStr = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
    const current = currentStr ? JSON.parse(currentStr) : {};

    const numericId = ((): number | undefined => {
      const n = Number(serverId ?? current?.serverId ?? current?.id ?? current?.deviceId);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })();

    const updated = {
      ...current,
      uuid: clean,
      deviceType: type,
      type, // backward compatibility
      name: name ?? current?.name,
      isActive: true,
      isCurrentDevice: true,
      syncStatus: true,
      connectedAt: current?.connectedAt ?? nowIso,
      lastSync: current?.lastSync ?? nowIso,
      battery: battery ?? current?.battery ?? null,
      ...(numericId ? { id: numericId, serverId: numericId, deviceId: numericId } : {}),
      healthData: current?.healthData ?? { latest: {} },
    };

    StorageServiceManager.setString(STORAGE_KEYS.CONNECTED_DEVICE, JSON.stringify(updated));

    StorageServiceManager.setString(STORAGE_KEYS.HAS_EVER_CONNECTED_DEVICE, 'true');

    const shouldEmitEvent = !current?.uuid || current.uuid !== clean || !current?.connectedAt;
    if (shouldEmitEvent) {
      DeviceEventEmitter.emit('DEVICE_DATA_UPDATED', {
        uuid: updated.uuid,
        deviceType: type,
        action: 'connected',
        timestamp: updated.connectedAt,
      });
    }
  } catch (e) {
    devLog.warn('[DeviceConnection] Failed to upsert CONNECTED_DEVICE', e);
  }
};

export const connectDevice = async (
  uuid: string,
  deviceType?: string,
  _retryCount: number = 0,
  _bypassHealthOpLock: boolean = false,
  _name?: string,
  _forceSDKConnection: boolean = false,
  disableRetry: boolean = false,
  skipPreConnectionCheck: boolean = false,
): Promise<boolean> => {
  const clean = cleanUuid(uuid);
  if (!clean) {
    devLog.warn('[DeviceConnection] Invalid UUID provided', { uuid, clean });
    return false;
  }
  const type = (deviceType || 'yc').toLowerCase();

  // Cancel all pending operations before starting new connection
  cancelAllPendingOperations();

  await resetSDKState(skipPreConnectionCheck);

  try {
    const currentDevice = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
    if (currentDevice) {
      const parsed = JSON.parse(currentDevice);
      if (parsed.uuid !== clean) {
        clearOldDeviceData(clean);
      }
    } else {
      clearOldDeviceData(clean);
    }
  } catch {
    clearOldDeviceData(clean);
  }

  if (_connectionAttempts.has(clean)) {
    _connectionAttempts.delete(clean);
    if (!skipPreConnectionCheck) {
      await new Promise((resolve) => setTimeout(resolve, SDK_RESET_DELAY_MS));
    }
  }

  if (!skipPreConnectionCheck) {
    try {
      const isConnected = await isDeviceConnectedByUUID(clean, type);
      if (isConnected) {
        _connectionAttempts.delete(clean);
        return true;
      }
    } catch {}

    _connectionAttempts.add(clean);

    try {
      const storedDevice = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
      if (storedDevice) {
        const storedDeviceData = JSON.parse(storedDevice);
        const storedUuid = storedDeviceData?.uuid;
        if (storedUuid !== clean) {
          const isConnected = await Promise.race([
            isDeviceConnectedByUUID(clean, type),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), CONNECTION_CHECK_CACHE_TTL),
            ),
          ]);
          if (isConnected) {
            _connectionAttempts.delete(clean);
            return true;
          }
        }
      }
    } catch {}
  } else {
    _connectionAttempts.add(clean);
  }

  try {
    _isConnecting = true;
    await initSDK().catch(() => undefined);

    // Emit event when starting SDK connection to trigger animation
    try {
      DeviceEventEmitter.emit('DEVICE_CONNECTION_STARTED', {
        uuid: clean,
        deviceType: type,
      });
    } catch (emitError) {
      // Ignore emit errors
    }

    if (type === 'yc') {
      if (Platform.OS === 'ios' && ycIsAvailable()) {
        // iOS native timeout is 75s, so use 80s for JS to have buffer
        const iOS_CONNECTION_TIMEOUT_MS = 80000;
        const connectionResult = await Promise.race([
          ycConnect(clean),
          new Promise<boolean>((_, reject) =>
            setTimeout(
              () => reject(new Error('iOS connection timeout')),
              iOS_CONNECTION_TIMEOUT_MS,
            ),
          ),
        ]);

        if (!connectionResult) {
          clearOldDeviceData(clean);
          await resetSDKState();
          return false;
        }
        return true;
      }

      if (YCRingManager?.connectDevice) {
        const maxRetries = disableRetry ? 1 : 3;
        let lastError = null;

        for (let retryCount = 0; retryCount < maxRetries; retryCount++) {
          try {
            const connected = await Promise.race([
              YCRingManager.connectDevice(clean),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_TIMEOUT_MS),
              ),
            ]);

            if (!connected) {
              lastError = new Error('YCRingManager.connectDevice returned false');
              if (retryCount < maxRetries - 1) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
              }
              break;
            }

            if (Platform.OS === 'android' && YCRingManager?.getDeviceInfoRaw) {
              try {
                if (_pendingDeviceInfoAbortController) {
                  _pendingDeviceInfoAbortController.abort();
                }

                _pendingDeviceInfoAbortController = new AbortController();
                const abortSignal = _pendingDeviceInfoAbortController.signal;

                _pendingDeviceInfoRequest = Promise.race([
                  YCRingManager.getDeviceInfoRaw(),
                  new Promise((_, reject) => {
                    if (abortSignal.aborted) {
                      reject(new Error('Request canceled'));
                      return;
                    }
                    const timeoutId = setTimeout(
                      () => reject(new Error('Device info timeout')),
                      DEVICE_INFO_TIMEOUT_MS,
                    );
                    abortSignal.addEventListener('abort', () => {
                      clearTimeout(timeoutId);
                      reject(new Error('Request canceled'));
                    });
                  }),
                ]).finally(() => {
                  const currentRequest = _pendingDeviceInfoRequest;
                  if (currentRequest === _pendingDeviceInfoRequest) {
                    _pendingDeviceInfoRequest = null;
                    _pendingDeviceInfoAbortController = null;
                  }
                });

                await _pendingDeviceInfoRequest;
              } catch (error: any) {
                if (error?.message !== 'Request canceled') {
                  devLog.warn('[DeviceConnection] Device info fetch failed:', error);
                }
              }
            }
            return true;
          } catch (connectError: any) {
            lastError = connectError;
            const errorCode = connectError?.code || '';
            const errorMessage = connectError?.message || '';

            devLog.warn('[DeviceConnection] Connection attempt failed', {
              attempt: retryCount + 1,
              maxRetries,
              errorCode,
              errorMessage: errorMessage.substring(0, 100),
            });

            // GATT_ERROR (status 133) usually indicates Bluetooth stack issue
            // Should retry with longer delay
            const isGattError =
              errorMessage?.includes('133') ||
              errorMessage?.includes('GATT_ERROR') ||
              errorCode === 'CONNECT_FAILED';

            const isRetryable =
              errorCode === 'CONNECT_FAILED' ||
              errorCode === 'CONNECT_TIMEOUT' ||
              errorCode === 'not_found' ||
              errorMessage?.includes('timeout') ||
              errorMessage?.includes('Peripheral not found') ||
              isGattError;

            if (isRetryable && retryCount < maxRetries - 1) {
              // GATT_ERROR needs longer delay to let Bluetooth stack recover
              const retryDelay = isGattError ? RETRY_DELAY_MS * 2 : RETRY_DELAY_MS;

              devLog.info('[DeviceConnection] Retrying connection', {
                attempt: retryCount + 1,
                nextAttempt: retryCount + 2,
                delayMs: retryDelay,
                isGattError,
              });

              if (errorCode === 'not_found' || errorMessage?.includes('Peripheral not found')) {
                // Only scan if device is really not found
                try {
                  const isStillConnected = await isDeviceConnectedByUUID(clean, type);
                  if (!isStillConnected) {
                    const { ycStartScan } = await import('./YCProductBridge');
                    await ycStartScan(3).catch(() => undefined);
                  }
                } catch {}
              }

              // For GATT_ERROR, reset SDK state before retry
              if (isGattError && retryCount === 0) {
                try {
                  await resetSDKState(false);
                  devLog.info('[DeviceConnection] SDK state reset before GATT_ERROR retry');
                } catch {}
              }

              await new Promise((resolve) => setTimeout(resolve, retryDelay));
              continue;
            }
            break;
          }
        }

        if (lastError) {
          const connectError = lastError as any;
          if (
            connectError?.code === 'INVALID_BLUETOOTH_ADDRESS' ||
            connectError?.code === 'INIT_ERROR' ||
            connectError?.code === 'INVALID_DEVICE_ID'
          ) {
            devLog.error('[DeviceConnection] Connection failed:', connectError?.code);
          }
          clearOldDeviceData(clean);
          await resetSDKState();
          return false;
        }

        return true;
      }

      return false;
    }

    if (RWRingManager?.connectDevice) {
      return (await RWRingManager.connectDevice(clean)) === true;
    }

    return false;
  } catch (e) {
    devLog.error('[DeviceConnection] connectDevice failed', e);
    clearOldDeviceData(clean);
    return false;
  } finally {
    _isConnecting = false;
    _connectionAttempts.delete(clean);
  }
};

export const disconnectDevice = async (deviceType?: string, uuid?: string) => {
  try {
    const type = (deviceType || '').toLowerCase();
    if (uuid && type) {
      const isConnected = await isDeviceConnectedByUUID(uuid, type);
      if (!isConnected) {
        return true;
      }
    }

    let result = false;
    if (type === 'yc') {
      if (Platform.OS === 'ios' && ycIsAvailable()) {
        result = await ycDisconnect();
        if (result) {
          await resetSDKState(false);
          await new Promise((resolve) => setTimeout(resolve, Platform.OS === 'ios' ? 2000 : 500));
        }
      } else if (YCRingManager?.disconnectDevice) {
        await YCRingManager.disconnectDevice(uuid || null);
        result = true;
      }
    } else if (type === 'rw' && RWRingManager?.disconnectDevice) {
      await RWRingManager.disconnectDevice(uuid || null);
      result = true;
    } else {
      try {
        await RWRingManager?.disconnectDevice?.(uuid || null);
        result = true;
      } catch {
        try {
          await YCRingManager?.disconnectDevice?.(uuid || null);
          result = true;
        } catch {}
      }
    }

    if (result) {
      StorageServiceManager.removeItem(STORAGE_KEYS.CONNECTED_DEVICE);
      StorageServiceManager.removeItem(STORAGE_KEYS.HAS_EVER_CONNECTED_DEVICE);
      invalidateConnectionCache(uuid);

      if (Platform.OS !== 'ios' || type !== 'yc') {
        await Promise.all([resetScanState(), refreshBluetoothState(), resetSDKState()]);
      } else {
        await Promise.all([resetScanState(), refreshBluetoothState()]);
      }

      DeviceEventEmitter.emit('DEVICE_DATA_UPDATED', {
        uuid: uuid || null,
        deviceType: type,
        action: 'disconnected',
        timestamp: new Date().toISOString(),
      });
    }

    return result;
  } catch (e) {
    devLog.warn('[DeviceConnection] disconnect failed', e);
    return false;
  }
};

export const getHealthDataByDeviceType = async (deviceType: string, uuid: string): Promise<any> => {
  const type = (deviceType || 'yc').toLowerCase();
  const clean = cleanUuid(uuid);
  try {
    const { AutoSyncService } = await import('../AutoSyncService');
    if (AutoSyncService.isInDetailDevice()) {
      throw new Error('getHealthDataByDeviceType blocked in Detail Device screen');
    }

    let serverIdHint: number | undefined;
    let deviceName: string | undefined;
    try {
      const stored = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
      if (stored) {
        const parsed = JSON.parse(stored);
        const sid = parsed?.serverId ?? parsed?.id;
        if (sid && Number.isFinite(Number(sid))) serverIdHint = Number(sid);
        deviceName = parsed?.name;
      }
    } catch {}

    const result = await runAutoDeviceSync(
      {
        uuid: clean,
        deviceType: type,
        serverId: serverIdHint,
        name: deviceName,
      },
      true,
    );

    if (!result) {
      const skipReason = getLastAutoSyncSkipReason() || 'unknown';
      throw new Error(`Failed to get health data: ${skipReason}`);
    }

    devLog.info('Raw data: ', result?.raw);

    if (result?.normalized) {
      return result.normalized;
    }

    const out = result?.raw ?? {};
    if (out && typeof out === 'object' && Object.keys(out).length === 0) {
      throw new Error('SDK returned empty data - device may not have synced yet');
    }

    const withSource =
      out && typeof out === 'object' && !Array.isArray(out)
        ? { ...out, source: 'device', __source: 'device' }
        : out;

    return withSource;
  } catch (error) {
    devLog.error('[DeviceConnection] getHealthDataByDeviceType failed', error);
    throw error;
  }
};

export const getAllHealthData = async (
  deviceType?: string,
  fromManualSync?: boolean,
): Promise<any> => {
  const type = (deviceType || '').toLowerCase();

  const { AutoSyncService } = await import('../AutoSyncService');
  if (AutoSyncService.isInDetailDevice() && !fromManualSync) {
    throw new Error('getAllHealthData blocked in Detail Device screen - use manual sync');
  }

  try {
    // When invoked from manual sync on detail screen, avoid routing through
    // getHealthDataByDeviceType because it is intentionally blocked there.
    // Instead, fetch raw data directly from the native managers.
    if (!fromManualSync) {
      const stored = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          const uuid = cleanUuid(parsed?.uuid || parsed?.id);
          const dtype = (parsed?.deviceType || type || 'yc').toLowerCase();
          if (uuid) {
            return await getHealthDataByDeviceType(dtype, uuid);
          }
        } catch {}
      }
    }

    let rawData: any = {};
    if (type === 'yc') {
      if (Platform.OS === 'ios' && ycIsAvailable()) {
        rawData = await ycFetchAllHealthData();
      } else if (YCRingManager?.getAllHealthData) {
        rawData = await YCRingManager.getAllHealthData();
      } else {
        return {};
      }
    } else if (type === 'rw' && RWRingManager?.getAllHealthData) {
      rawData = await RWRingManager.getAllHealthData();
    } else {
      return {};
    }

    const withSource =
      rawData && typeof rawData === 'object' && !Array.isArray(rawData)
        ? { ...rawData, source: 'device', __source: 'device' }
        : rawData;

    return withSource;
  } catch (error) {
    devLog.error('[DeviceConnection] getAllHealthData failed', error);
    throw error;
  }
};

export { getBatteryLevel, getBatteryLevelByDeviceType };

export const isDeviceConnected = async (deviceType?: string): Promise<boolean> => {
  const type = (deviceType || '').toLowerCase();
  if (type === 'yc' && Platform.OS === 'ios' && ycIsAvailable()) {
    return ycIsConnected();
  }
  try {
    const value = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
    return !!value;
  } catch {
    return false;
  }
};

export const getConnectionStatus = async (deviceType?: string): Promise<any> => {
  const type = (deviceType || '').toLowerCase();
  if (type === 'yc' && Platform.OS === 'ios' && ycIsAvailable()) {
    const st = ycGetConnectionStatus();
    return { ...st, deviceType: 'yc' };
  }
  try {
    const value = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
    if (!value) return { connected: false };
    const parsed = JSON.parse(value);
    return {
      connected: true,
      uuid: parsed?.uuid,
      deviceType: parsed?.deviceType,
    };
  } catch {
    return { connected: false };
  }
};

export const cleanup = async (_deviceType?: string) => {
  return true;
};

const _connectionCheckCache = new Map<string, { result: boolean; timestamp: number }>();
const _inflightRequests = new Map<string, Promise<boolean>>();

export const invalidateConnectionCache = (uuid?: string) => {
  if (uuid) {
    const clean = cleanUuid(uuid);
    _connectionCheckCache.delete(`${clean}_yc`);
    _connectionCheckCache.delete(`${clean}_dh`);
    _connectionCheckCache.delete(`${clean}_jl`);
  } else {
    _connectionCheckCache.clear();
  }
};

const _extractDeviceUuid = (deviceInfo: any): string | null => {
  return (
    cleanUuid(deviceInfo?.data?.uuid) ||
    cleanUuid(deviceInfo?.uuid) ||
    cleanUuid(deviceInfo?.data?.macAddress) ||
    cleanUuid(deviceInfo?.macAddress) ||
    null
  );
};

const _checkDeviceConnection = async (uuid: string, deviceType?: string): Promise<boolean> => {
  const type = (deviceType || 'yc').toLowerCase();
  const id = cleanUuid(uuid);
  if (!id) return false;

  if (type === 'yc' && Platform.OS === 'android') {
    const { ensureSDKsInitialized } = await import('./SDKManager');
    await ensureSDKsInitialized();
  }

  if (type === 'yc' && Platform.OS === 'ios' && ycIsAvailable()) {
    return await ycIsUuidConnected(id);
  }

  if (Platform.OS === 'android') {
    try {
      if (type === 'yc' && YCRingManager?.getDeviceInfoRaw) {
        let deviceInfo;

        if (_pendingDeviceInfoRequest) {
          try {
            deviceInfo = await Promise.race([
              _pendingDeviceInfoRequest,
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error('Device info timeout')),
                  DEVICE_INFO_REUSE_TIMEOUT_MS,
                ),
              ),
            ]);
          } catch (error) {
            devLog.warn('[DeviceConnection] Reusing pending device info request failed:', error);
            deviceInfo = null;

            if (_pendingDeviceInfoRequest) {
              _pendingDeviceInfoRequest = null;
              _pendingDeviceInfoAbortController = null;
            }
          }
        }

        if (!deviceInfo) {
          if (_pendingDeviceInfoAbortController) {
            _pendingDeviceInfoAbortController.abort();
          }

          _pendingDeviceInfoAbortController = new AbortController();
          const abortSignal = _pendingDeviceInfoAbortController.signal;

          _pendingDeviceInfoRequest = Promise.race([
            YCRingManager.getDeviceInfoRaw(),
            new Promise((_, reject) => {
              if (abortSignal.aborted) {
                reject(new Error('Request canceled'));
                return;
              }
              const timeoutId = setTimeout(
                () => reject(new Error('Device info timeout')),
                CONNECTION_CHECK_TIMEOUT_MS,
              );
              abortSignal.addEventListener('abort', () => {
                clearTimeout(timeoutId);
                reject(new Error('Request canceled'));
              });
            }),
          ]).finally(() => {
            const currentRequest = _pendingDeviceInfoRequest;
            if (currentRequest === _pendingDeviceInfoRequest) {
              _pendingDeviceInfoRequest = null;
              _pendingDeviceInfoAbortController = null;
            }
          });

          deviceInfo = await _pendingDeviceInfoRequest;
        }

        if (!deviceInfo || deviceInfo.code !== 0) {
          return false;
        }

        const deviceUuid = _extractDeviceUuid(deviceInfo);
        if (deviceUuid) {
          return cleanUuid(deviceUuid) === cleanUuid(id);
        }

        try {
          const storedDevice = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
          if (storedDevice) {
            const parsed = JSON.parse(storedDevice);
            const storedUuid = cleanUuid(parsed?.uuid);
            if (storedUuid && storedUuid === cleanUuid(id)) {
              return true;
            }
          }
        } catch {}

        return _connectionAttempts.has(cleanUuid(id));
      } else {
        const battery = await getBatteryLevelByDeviceType(type, id, { skipReconnect: true });
        return typeof battery === 'number' && battery >= 0;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isNullPointerError =
        errorMessage.includes('java.util.concurrent.CopyOnWriteArrayList.size()') ||
        errorMessage.includes('null object reference') ||
        errorMessage.includes('NullPointerException');

      if (isNullPointerError) {
        const now = Date.now();
        if (now - _lastYCSDKWarningTime > YC_SDK_WARNING_THROTTLE_MS) {
          _lastYCSDKWarningTime = now;
          devLog.warn('[DeviceConnection] Android YC SDK not properly initialized');
        }
      }
      return false;
    }
  }

  if (type === 'rw' && Platform.OS === 'ios') {
    try {
      const battery = await getBatteryLevelByDeviceType(type, id, { skipReconnect: true });
      return typeof battery === 'number' && battery >= 0;
    } catch {
      return false;
    }
  }

  return false;
};

export const isDeviceConnectedByUUID = async (
  uuid: string,
  deviceType?: string,
  skipCache: boolean = false,
): Promise<boolean> => {
  const id = cleanUuid(uuid);
  if (!id) return false;

  const type = (deviceType || 'yc').toLowerCase().trim();
  const cacheKey = `${id}_${type}`;

  if (!skipCache) {
    const cached = _connectionCheckCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < CONNECTION_CHECK_CACHE_TTL) {
      return cached.result;
    }

    const inflight = _inflightRequests.get(cacheKey);
    if (inflight) {
      try {
        return await Promise.race([
          inflight,
          new Promise<boolean>((resolve) => {
            setTimeout(() => {
              _inflightRequests.delete(cacheKey);
              resolve(false);
            }, CONNECTION_CHECK_TIMEOUT_MS);
          }).then(() => {
            throw new Error('Inflight timeout');
          }),
        ]);
      } catch {
        // Continue with new check
      }
    }
  }

  const checkPromise = _checkDeviceConnection(uuid, deviceType)
    .then((result) => {
      if (!skipCache) {
        _connectionCheckCache.set(cacheKey, { result, timestamp: Date.now() });
      }
      return result;
    })
    .finally(() => {
      _inflightRequests.delete(cacheKey);
    });

  if (!skipCache) {
    _inflightRequests.set(cacheKey, checkPromise);
  }

  return checkPromise;
};

export const syncHealthDataFromConnectedDevice = async (
  deviceType?: string,
  deviceUuid?: string,
  deviceId?: number,
  deviceName?: string,
  skipToast: boolean = false,
): Promise<any> => {
  const type = (deviceType || 'yc').toLowerCase();

  try {
    let finalDeviceUuid = deviceUuid;
    let finalDeviceId = deviceId;
    let finalDeviceName = deviceName;

    if (!finalDeviceUuid) {
      const stored = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          finalDeviceId = parsed?.serverId || parsed?.deviceId;
          finalDeviceUuid = parsed?.uuid || parsed?.id;
          finalDeviceName = parsed?.name;
        } catch {}
      }
    }

    if (!finalDeviceUuid) {
      throw new Error('No connected device UUID found in storage or provided');
    }

    let rawData: any = {};
    if (type === 'yc') {
      if (Platform.OS === 'ios' && ycIsAvailable()) {
        rawData = await ycFetchAllHealthData();
      } else if (YCRingManager?.getAllHealthData) {
        rawData = await YCRingManager.getAllHealthData();
      } else {
        throw new Error('YC native module not available');
      }
    } else if (type === 'rw') {
      if (RWRingManager?.getAllHealthData) {
        rawData = await RWRingManager.getAllHealthData();
      } else {
        throw new Error('RW native module not available');
      }
    } else {
      throw new Error(`Unknown device type: ${type}`);
    }

    let actualDeviceId = finalDeviceId;
    if (!actualDeviceId) {
      actualDeviceId =
        (await addDeviceToServer(finalDeviceUuid, type, finalDeviceName)) || undefined;
    }

    const shouldSyncToBackend = !!actualDeviceId;
    if (shouldSyncToBackend && actualDeviceId) {
      try {
        upsertConnectedDeviceInfo(finalDeviceUuid, type, finalDeviceName, actualDeviceId, null);
      } catch {}
    }

    return await dataNormalizer.normalizeAndSaveHealthData(
      { ...rawData, deviceUuid: finalDeviceUuid, deviceType: type },
      type,
      Platform.OS as 'ios' | 'android',
      actualDeviceId,
      shouldSyncToBackend,
      false,
      skipToast,
    );
  } catch (error) {
    devLog.error('[DeviceConnection] syncHealthDataFromConnectedDevice failed', error);
    throw error;
  }
};
