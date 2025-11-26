import { NativeModules, Platform } from 'react-native';
import { devLog } from '@/utils/loggingHelper';
import { NormalizedHealthData } from '../data-transform/types';
import { dataNormalizer } from '@/services/sync-device/data-transform/DataNormalizerService';
import { ensureSDKsInitialized } from '../ble/SDKManager';
import { ensureBluetoothEnabled } from '../ble/BluetoothManager';
import {
  connectDevice,
  disconnectDevice,
  isConnectionInProgress,
  clearHealthDataOperationLock,
  forceStopHealthDataOperation,
  setHealthDataOperationLock,
  upsertConnectedDeviceInfo,
  isDeviceConnectedByUUID,
} from '../ble/DeviceConnectionService';
import { ycFetchAllHealthData, ycIsAvailable } from '../ble/YCProductBridge';
import { StorageServiceManager, STORAGE_KEYS } from '@/services/StorageService';
import { DataAggregator, FieldExtractor } from '../utils';

const { RWRingManager, YCRingManager } = NativeModules as any;

const HEALTH_SYNC_TIMEOUT_MS = 65_000;
const DATA_RETRY_ATTEMPTS = 3;
const RECOVERY_DELAY_MS = 2_000;

export interface AutoDeviceSyncResult {
  normalized: NormalizedHealthData | null;
  raw: any;
}

interface DeviceContext {
  uuid: string;
  deviceType: string;
  name?: string;
  deviceId?: number;
  serverId?: number;
}

let autoSyncLock = false;
let lastSkipReason: string | null = null;

export const getLastAutoSyncSkipReason = (): string | null => lastSkipReason;

export const resetAllLocks = (): void => {
  autoSyncLock = false;
  lastSkipReason = null;
  clearHealthDataOperationLock();
  forceStopHealthDataOperation();
};

export const runAutoDeviceSync = async (
  device: DeviceContext,
  isAlreadyConnected: boolean = false,
): Promise<AutoDeviceSyncResult | null> => {
  try {
    const AutoSyncService = require('../AutoSyncService').default;
    if (AutoSyncService.isInDetailDevice()) {
      lastSkipReason = 'IN_DETAIL_DEVICE_SCREEN';
      return null;
    }
  } catch {}

  if (!device || !device.uuid) {
    lastSkipReason = 'MISSING_DEVICE_INFO';
    return null;
  }

  if (autoSyncLock) {
    lastSkipReason = 'LOCKED';
    return null;
  }

  if (isScanInProgress() || isConnectionInProgress()) {
    lastSkipReason = 'OPERATION_CONFLICT';
    return null;
  }

  autoSyncLock = true;
  setHealthDataOperationLock(true);

  try {
    await ensureSDKsInitialized();

    const bluetoothReady = await ensureBluetoothEnabled(false);
    if (!bluetoothReady) {
      throw createSyncError('BLUETOOTH_DISABLED', 'Bluetooth is not available');
    }

    const normalizedType = normalizeDeviceType(device.deviceType);
    const sanitizedUuid = sanitizeUuid(device.uuid);
    if (!sanitizedUuid) {
      devLog.warn('[AutoDeviceSync] Invalid UUID after sanitization, skipping sync');
      lastSkipReason = 'INVALID_UUID';
      return null;
    }

    const syncResult = await fetchHealthDataWithRetry({
      deviceType: normalizedType,
      uuid: sanitizedUuid,
      name: device.name,
      deviceIdHint: device.deviceId ?? device.serverId,
      isAlreadyConnected,
    });

    return {
      normalized: syncResult.normalized,
      raw: syncResult.raw,
    };
  } finally {
    autoSyncLock = false;
    lastSkipReason = null;
    clearHealthDataOperationLock();
    forceStopHealthDataOperation();
  }
};

const normalizeDeviceType = (deviceType?: string): 'yc' | 'rw' => {
  const value = (deviceType || 'yc').toLowerCase();
  return value === 'rw' ? 'rw' : 'yc';
};

const sanitizeUuid = (uuid?: string): string | null => {
  if (!uuid || typeof uuid !== 'string') {
    return null;
  }
  const trimmed = uuid.trim();
  if (!trimmed || trimmed === 'temp-device' || trimmed.startsWith('temp')) {
    return null;
  }
  return trimmed;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number) => {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(createSyncError('TIMEOUT', `Operation timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchHealthDataWithRetry = async ({
  deviceType,
  uuid,
  name,
  deviceIdHint,
  isAlreadyConnected = false,
}: {
  deviceType: 'yc' | 'rw';
  uuid: string;
  name?: string;
  deviceIdHint?: number;
  isAlreadyConnected?: boolean;
}): Promise<{ raw: any; normalized: NormalizedHealthData | null }> => {
  try {
    const { cancelAllPendingOperations } = await import('../ble/DeviceConnectionService');
    cancelAllPendingOperations();
    devLog.info('[AutoDeviceSync] Canceled pending operations before health data sync');
  } catch {}

  let lastError: unknown = null;

  let finalDeviceName = name;
  if (!finalDeviceName) {
    try {
      const stored = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
      if (stored) {
        const parsed = JSON.parse(stored);
        finalDeviceName = parsed?.name;
      }
    } catch {}
  }

  for (let attempt = 0; attempt < DATA_RETRY_ATTEMPTS; attempt++) {
    try {
      let alreadyConnected = isAlreadyConnected;

      if (!alreadyConnected) {
        alreadyConnected = await isDeviceConnectedByUUID(uuid, deviceType);
      }

      if (alreadyConnected) {
        try {
          upsertConnectedDeviceInfo(uuid, deviceType, finalDeviceName, deviceIdHint, null);
        } catch {}
        devLog.info('[AutoDeviceSync] Device already connected - proceeding to sync');

        // Show connection success toast (với delay 2s để show sau "Đang kết nối")
        try {
          const ToastService = require('../../ToastService').default;
          devLog.info('[AutoDeviceSync] Showing device connection success toast', {
            deviceName: finalDeviceName || 'Thiết bị',
          });
          ToastService.showDeviceConnectionSuccess(finalDeviceName || 'Thiết bị');
        } catch (error) {
          devLog.error('[AutoDeviceSync] Failed to show connection success toast:', error);
        }

        // Wait ngắn hơn để toast có thể hiển thị
        await wait(100);
      } else {
        const connected = await connectDevice(
          uuid,
          deviceType,
          0,
          true,
          undefined,
          false,
          false,
          true,
        );
        if (!connected) {
          const errorMsg = `Failed to connect to device before health data fetch. UUID: ${anonymizeUuid(
            uuid,
          )}, DeviceType: ${deviceType}, Platform: ${Platform.OS}`;
          devLog.error('[AutoDeviceSync] Connection failed', {
            uuid: anonymizeUuid(uuid),
            deviceType,
            platform: Platform.OS,
            error: errorMsg,
          });
          throw createSyncError('CONNECTION_FAILED', errorMsg);
        }

        try {
          upsertConnectedDeviceInfo(uuid, deviceType, finalDeviceName, deviceIdHint, null);
        } catch {}

        try {
          const ToastService = require('../../ToastService').default;
          ToastService.showDeviceConnectionSuccess(finalDeviceName || 'Thiết bị');
        } catch {}

        devLog.info('[AutoDeviceSync] Device connected - proceeding to sync');
        // Wait ngắn hơn để toast có thể hiển thị
        await wait(100);
      }

      try {
        const AutoSyncService = require('../AutoSyncService').default;
        if (AutoSyncService.isInDetailDevice()) {
          throw createSyncError(
            'IN_DETAIL_DEVICE_SCREEN',
            'Sync blocked - in detail device screen',
          );
        }
      } catch {}

      // Show sync start toast (với delay 5s để show sau "Kết nối thành công")
      try {
        const ToastService = require('../../ToastService').default;
        devLog.info('[AutoDeviceSync] Showing sync data start toast');
        ToastService.showSyncDataStart();
      } catch (error) {
        devLog.error('[AutoDeviceSync] Failed to show sync data start toast:', error);
      }
      await wait(100);

      const raw = await pullRawHealthData(deviceType, uuid);
      if (!hasMeaningfulData(raw)) {
        throw createSyncError('EMPTY_DATA', 'Health data payload is empty');
      }

      try {
        const AutoSyncService = require('../AutoSyncService').default;
        if (AutoSyncService.isInDetailDevice()) {
          throw createSyncError(
            'IN_DETAIL_DEVICE_SCREEN',
            'Sync blocked - in detail device screen',
          );
        }
      } catch {}

      const normalized = await dataNormalizer.normalizeAndSaveHealthData(
        { ...raw, deviceUuid: uuid, deviceType },
        deviceType,
        Platform.OS as 'ios' | 'android',
        deviceIdHint,
        true,
      );

      devLog.info('[AutoDeviceSync] normalizeAndSaveHealthData completed');

      return { raw, normalized };
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      devLog.warn('[AutoDeviceSync] Health data attempt failed', {
        attempt,
        uuid: anonymizeUuid(uuid),
        deviceType,
        error: msg,
      });

      if (msg.toLowerCase().includes('locked')) {
        devLog.warn('[AutoDeviceSync] Device is locked - stopping immediately without retry');
        break;
      }

      if (
        msg.toLowerCase().includes('empty_data') ||
        msg.toLowerCase().includes('empty data') ||
        msg.toLowerCase().includes('payload is empty')
      ) {
        devLog.warn('[AutoDeviceSync] Health data is empty - stopping immediately without retry');
        lastError = createSyncError('EMPTY_DATA', 'Health data payload is empty - sync failed');
        break;
      }

      if (attempt === DATA_RETRY_ATTEMPTS - 1) {
        break;
      }
      await attemptRecovery(deviceType, uuid, msg);
      await wait(RECOVERY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError ?? createSyncError('UNKNOWN', 'Unable to complete health data sync');
};

const pullRawHealthData = async (deviceType: 'yc' | 'rw', uuid: string): Promise<any> => {
  if (deviceType === 'yc') {
    if (Platform.OS === 'ios' && ycIsAvailable()) {
      return await withTimeout(ycFetchAllHealthData(), HEALTH_SYNC_TIMEOUT_MS);
    }

    if (!YCRingManager?.getAllHealthData) {
      devLog.error('[AutoDeviceSync] YCRingManager.getAllHealthData not available', {
        YCRingManager: !!YCRingManager,
        getAllHealthData: !!YCRingManager?.getAllHealthData,
        availableMethods: YCRingManager ? Object.keys(YCRingManager) : [],
      });
      throw createSyncError('NATIVE_MISSING', 'YC native module is not available');
    }

    try {
      const call =
        Platform.OS === 'ios'
          ? YCRingManager.getAllHealthData(uuid)
          : YCRingManager.getAllHealthData();
      const result = await withTimeout(Promise.resolve(call), HEALTH_SYNC_TIMEOUT_MS);
      return result;
    } catch (error) {
      devLog.error('[AutoDeviceSync] YCRingManager.getAllHealthData() failed', error);
      throw error;
    }
  }

  if (!RWRingManager?.getAllHealthData) {
    throw createSyncError('NATIVE_MISSING', 'RW native module is not available');
  }

  const call = RWRingManager.getAllHealthData();
  return await withTimeout(Promise.resolve(call), HEALTH_SYNC_TIMEOUT_MS);
};

const calculateStepTotals = (
  stepData: any[],
): { totalSteps: number; totalCalories: number; totalDistance: number } => {
  return DataAggregator.calculateTotals(stepData, {
    steps: ['steps', 'step', 'stepCount'],
    calories: ['calories', 'calorie', 'calorieCount'],
    distance: ['distance', 'dist', 'distanceKm'],
  });
};

const extractLatestValue = (data: any): number | null => {
  if (!data) return null;

  if (typeof data === 'number' && Number.isFinite(data)) {
    return data;
  }

  if (Array.isArray(data) && data.length > 0) {
    const lastItem = data[data.length - 1];

    if (typeof lastItem === 'object' && lastItem !== null) {
      const value =
        lastItem.value ||
        lastItem.current ||
        lastItem.rate ||
        lastItem.level ||
        lastItem.measurement ||
        lastItem.heartRate ||
        lastItem.spo2 ||
        lastItem.bloodOxygen;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }

    if (typeof lastItem === 'number' && Number.isFinite(lastItem)) {
      return lastItem;
    }

    for (let i = data.length - 1; i >= 0; i--) {
      const item = data[i];
      if (typeof item === 'number' && Number.isFinite(item)) {
        return item;
      }
      if (typeof item === 'object' && item !== null) {
        const objValue =
          item.value ||
          item.current ||
          item.rate ||
          item.level ||
          item.measurement ||
          item.heartRate ||
          item.spo2 ||
          item.bloodOxygen;
        if (typeof objValue === 'number' && Number.isFinite(objValue)) {
          return objValue;
        }
      }
    }
  }

  if (typeof data === 'object' && data !== null) {
    const value =
      data.value ||
      data.current ||
      data.rate ||
      data.level ||
      data.measurement ||
      data.heartRate ||
      data.spo2 ||
      data.bloodOxygen;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  devLog.warn('[extractLatestValue] No valid value found', {
    data: data,
    dataType: typeof data,
    isArray: Array.isArray(data),
    arrayLength: Array.isArray(data) ? data.length : 'N/A',
  });

  return null;
};

const hasMeaningfulData = (raw: any): boolean => {
  if (!raw || typeof raw !== 'object') return false;

  const extractArray = (value: any): any[] => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.data)) return value.data;
    if (Array.isArray(value?.list)) return value.list;
    return [];
  };

  const arraysToCheck = [
    raw.combinedData,
    raw.step,
    raw.steps,
    raw.heartRate,
    raw.heartRates,
    raw.sleep,
    raw.sleepData,
    raw.spO2,
    raw.spO2Data,
    raw.bloodPressure,
    raw.bloodOxygen,
  ];

  if (arraysToCheck.some((collection) => extractArray(collection).length > 0)) {
    return true;
  }

  const summary = raw.summary || raw.healthData?.summary;
  if (summary && typeof summary === 'object') {
    const { step, heartRate, bloodOxygen, sleepMinutes, calories } = summary as Record<string, any>;
    if (
      [step, heartRate, bloodOxygen, sleepMinutes, calories].some(
        (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
      )
    ) {
      return true;
    }
  }

  return false;
};

const decorateRawData = (
  raw: any,
  {
    uuid,
    deviceType,
    name,
    deviceIdHint,
  }: {
    uuid: string;
    deviceType: 'yc' | 'rw';
    name?: string;
    deviceIdHint?: number;
  },
) => {
  const decorated: any = {
    ...raw,
    deviceUuid: uuid,
    deviceType,
    deviceName: name,
    source: 'device',
    __source: 'device',
  };
  if (typeof deviceIdHint === 'number' && Number.isFinite(deviceIdHint))
    decorated.deviceId = deviceIdHint;

  if (!raw.combinedData) {
    const stepData = raw.step || raw.steps || [];
    if (Array.isArray(stepData) && stepData.length > 0) {
      const dataToUse = raw.filteredStepData || stepData;
      const totals = calculateStepTotals(dataToUse);
      decorated.totalSteps = totals.totalSteps;
      decorated.totalCalories = totals.totalCalories;
      decorated.totalDistance = totals.totalDistance;
    }
  }

  return decorated;
};

const updateDeviceStorageWithHealthData = async (
  rawData: any,
  uuid: string,
  deviceType: string,
  name?: string,
  battery?: number | null,
): Promise<void> => {
  try {
    const connectedDeviceString = StorageServiceManager.getString(STORAGE_KEYS.CONNECTED_DEVICE);
    if (!connectedDeviceString) {
      devLog.warn('[AutoDeviceSync] No connected device in storage to update');
      return;
    }

    const connectedDevice = JSON.parse(connectedDeviceString);

    const steps = rawData.totalSteps || rawData.step || 0;
    // If steps is 0, calories must be 0
    const calories = steps === 0 ? 0 : rawData.totalCalories || rawData.calories || 0;

    const updatedDevice = {
      ...connectedDevice,
      deviceType,
      name: name || connectedDevice.name,
      lastSync: new Date().toISOString(),
      battery: battery || connectedDevice.battery,
      healthData: {
        ...connectedDevice.healthData,
        latest: {
          step: steps,
          steps: steps,
          calories: calories,
          distance: rawData.totalDistance || rawData.distance || 0,
          heartRate: (() => {
            const extracted = extractLatestValue(rawData.heartRate);
            return extracted || 0;
          })(),
          spo2: (() => {
            const extracted =
              extractLatestValue(rawData.bloodOxygen) || extractLatestValue(rawData.spo2);
            return extracted || 0;
          })(),
          sleep: rawData.sleep || 0,
          bloodPressure: rawData.bloodPressure || { systolic: 0, diastolic: 0 },
          battery: battery || connectedDevice.battery || 0,
        },
        lastUpdated: new Date().toISOString(),
      },
    };

    if (!updatedDevice.healthData) {
      updatedDevice.healthData = {};
    }
    if (!updatedDevice.healthData.latest) {
      updatedDevice.healthData.latest = {};
    }

    StorageServiceManager.setString(STORAGE_KEYS.CONNECTED_DEVICE, JSON.stringify(updatedDevice));
  } catch (error) {
    devLog.error('[AutoDeviceSync] Failed to update device storage:', error);
  }
};

const attemptRecovery = async (deviceType: 'yc' | 'rw', uuid: string, reason: string) => {
  await disconnectDevice(deviceType, uuid).catch(() => undefined);
  await wait(RECOVERY_DELAY_MS);
  await attemptReconnect(deviceType, uuid);
};

const attemptReconnect = async (deviceType: 'yc' | 'rw', uuid: string): Promise<boolean> => {
  try {
    const connected = await connectDevice(uuid, deviceType, 0, true);
    return !!connected;
  } catch (e) {
    devLog.warn('[AutoDeviceSync] reconnect failed', e);
    return false;
  }
};

const anonymizeUuid = (uuid: string) =>
  uuid && uuid.length > 8 ? `${uuid.slice(0, 4)}…${uuid.slice(-4)}` : uuid || 'unknown';

const createSyncError = (code: string, message: string) => {
  const err = new Error(`[AutoDeviceSync:${code}] ${message}`);
  return err;
};

import { isScanInProgress } from './DeviceScanner';
import ToastService from '@/services/ToastService';
