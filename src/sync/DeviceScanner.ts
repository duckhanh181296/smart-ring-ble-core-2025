import { Platform, NativeModules } from 'react-native';
import { requestBlePermissions, checkBlePermissions } from '@/hooks/blePermission';
import { ensureBluetoothEnabled } from '../ble/BluetoothManager';
import { ycIsAvailable, ycStartScan, ycGetConnectedPeripherals } from '../ble/YCProductBridge';
import { ensureSDKsInitialized } from '../ble/SDKManager';
import { isConnectionInProgress, isHealthDataOperationInProgress } from '../ble/DeviceConnectionService';
import { devLog } from '@/utils/loggingHelper';

const withScanTimeout = async <T>(
  promise: Promise<T>,
  scanName: string,
  timeoutMs: number,
): Promise<T | []> => {
  let finished = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

  const timeoutPromise = new Promise<[]>((resolve) => {
    timeoutHandle = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve([]);
      }
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    finished = true;
    clearTimer();
    return result as T | [];
  } catch (error) {
    finished = true;
    clearTimer();
    return [];
  }
};
let scanPromise: Promise<any[]> | null = null;
const { RWRingManager, YCRingManager } = NativeModules;
const IOS_YC_SCAN_DELAY_SEC = 2;
const SCAN_TIMEOUT_MS_DEFAULT = 25000; // 25s to be > Android native 20s timeout + buffer
const MAX_SCAN_RETRIES = 2;

export type DeviceType = 'yc' | 'rw';
export const detectDeviceType = (device: any): DeviceType => {
  if (!device) return 'yc';
  if (device.type) {
    const type = device.type.toLowerCase();
    if (type === 'yc' || type === 'rw') {
      return type as DeviceType;
    }
  }
  if (device.name) {
    const name = device.name.toLowerCase();
    if (name.includes('rw') || name.includes('ring')) {
      return 'rw';
    }
    if (name.includes('yc') || name.includes('yicheng')) {
      return 'yc';
    }
  }
  if (device.uuid || device.id) {
    const identifier = (device.uuid || device.id).toLowerCase();
    if (identifier.includes('rw') || identifier.includes('ring')) {
      return 'rw';
    }
    if (identifier.includes('yc') || identifier.includes('yicheng')) {
      return 'yc';
    }
  }
  return 'yc';
};
export const resetScanLocks = (): void => {
  scanPromise = null;
};

export const isScanInProgress = (): boolean => scanPromise !== null;

export const forceStopScan = (): void => {
  scanPromise = null;
};

export const resetScanState = async (): Promise<void> => {
  scanPromise = null;
  try {
    YCRingManager?.stopScan?.();
    RWRingManager?.stopScan?.();
  } catch { }
  try {
    const { refreshBluetoothState } = await import('../ble/BluetoothManager');
    await refreshBluetoothState();
  } catch { }
  try {
    const { resetAllOperationLocks } = await import('../ble/DeviceConnectionService');
    resetAllOperationLocks();
  } catch { }
};

export const scanDevices = async (
  deviceType?: string,
  retryCount: number = 0,
  bypassLocks: boolean = false,
): Promise<any[]> => {
  if (scanPromise) {
    return scanPromise;
  }

  if (retryCount >= 5) {
    return [];
  }

  if (isConnectionInProgress()) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return scanDevices(deviceType, retryCount + 1, bypassLocks);
  }

  if (!bypassLocks && isHealthDataOperationInProgress()) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return scanDevices(deviceType, retryCount + 1, bypassLocks);
  }

  const SCAN_TIMEOUT_MS = SCAN_TIMEOUT_MS_DEFAULT;

  // Timeout is already handled by withScanTimeout inside performScan
  scanPromise = performScan(deviceType);

  try {
    const result = await scanPromise;
    devLog.info('[DeviceScanner] scanDevices returning result:', {
      count: result?.length || 0,
      devices: result?.map((d: any) => ({ uuid: d.uuid, name: d.name, type: d.type })),
    });
    return result;
  } catch (error) {
    devLog.error('[DeviceScanner] ❌ scanDevices caught error:', error);
    return [];
  } finally {
    scanPromise = null;
  }
};

const performScan = async (deviceType?: string, attempt: number = 0): Promise<any[]> => {
  try {
    const sdkInitPromise = ensureSDKsInitialized();

    if (!(await ensureBluetoothEnabled())) {
      return [];
    }

    if (Platform.OS === 'android') {
      try {
        if (!(await checkBlePermissions())) {
          await requestBlePermissions();
        }
      } catch { }
    }

    await sdkInitPromise;

    await Promise.allSettled([YCRingManager?.stopScan?.(), RWRingManager?.stopScan?.()]);
    const hasYCScanner = (Platform.OS === 'ios' && ycIsAvailable()) || !!YCRingManager?.scanDevices;
    const hasRWScanner = !!RWRingManager?.scanDevices;

    if (deviceType === 'yc' && !hasYCScanner) {
      return [];
    }
    if (deviceType === 'rw' && !hasRWScanner) {
      return [];
    }
    if (!deviceType && !hasYCScanner && !hasRWScanner) {
      return [];
    }
    let devices: any[] = [];
    if (deviceType === 'yc') {
      devices = await scanYCDevices();
    } else if (deviceType === 'rw') {
      devices = await scanRWDevices();
    } else {
      // devices = await scanAllDevices();
      devices = await scanYCDevices();
    }

    // Improved deduplication: normalize to uuid first, then dedupe
    const normalized = devices.map((d) => ({
      ...d,
      uuid: d?.uuid || d?.id, // Ensure uuid is always set
      id: d?.id || d?.uuid, // Ensure id is always set
    }));

    const unique = normalized.filter((d, i, arr) => i === arr.findIndex((x) => x.uuid === d.uuid));

    if (unique.length > 0) {
      devLog.info('[DeviceScanner] Scan completed:', {
        count: unique.length,
        devices: unique.map((d) => ({ uuid: d.uuid, name: d.name, type: d.type })),
      });
    }

    if (unique.length === 0 && attempt + 1 < MAX_SCAN_RETRIES) {
      try {
        try {
          await YCRingManager?.stopScan?.();
          await RWRingManager?.stopScan?.();
        } catch { }
        await new Promise((r) => setTimeout(r, 500));
      } catch { }
      return await performScan(deviceType, attempt + 1);
    }
    return unique;
  } catch {
    return [];
  }
};

const scanYCDevices = async (): Promise<any[]> => {
  const SCAN_TIMEOUT_MS = SCAN_TIMEOUT_MS_DEFAULT;

  try {
    if (Platform.OS === 'ios' && ycIsAvailable()) {
      const [list, connected] = await Promise.all([
        withScanTimeout(ycStartScan(IOS_YC_SCAN_DELAY_SEC), 'YCProductModule', SCAN_TIMEOUT_MS),
        ycGetConnectedPeripherals(),
      ]);

      const connectedSet = new Set((connected || []).map((x) => x.id));
      return (list || [])
        .filter((d: any) => d.name)
        .map((d: any) => ({
          uuid: d.id || d.uuid || d.identifier,
          name: d.name || 'YC Device',
          type: 'yc',
          isConnected: connectedSet.has(d.id || d.uuid || d.identifier),
        }));
    }
    if (!YCRingManager) {
      return [];
    }
    if (YCRingManager.initSDK) {
      try {
        await YCRingManager.initSDK();
      } catch { }
    }
    if (!YCRingManager.scanDevices) {
      return [];
    }

    const legacyScanPromise = new Promise<any[]>((resolve, _reject) => {
      try {
        YCRingManager.scanDevices()
          .then((devices: any[]) => {
            resolve(devices || []);
          })
          .catch(() => {
            resolve([]);
          });
      } catch {
        resolve([]);
      }
    });

    const devices = await withScanTimeout(legacyScanPromise, 'YCRingManager', SCAN_TIMEOUT_MS);
    return (devices || []).filter((item: any) => item.name).map((item: any) => ({ ...item, type: 'yc' }));
  } catch {
    return [];
  }
};

const scanRWDevices = async (): Promise<any[]> => {
  const SCAN_TIMEOUT_MS = SCAN_TIMEOUT_MS_DEFAULT;

  try {
    if (!RWRingManager) {
      return [];
    }
    if (!RWRingManager.scanDevices) {
      return [];
    }

    const rwScanPromise = new Promise<any[]>((resolve, _reject) => {
      try {
        RWRingManager.scanDevices()
          .then((devices: any[]) => {
            resolve(devices || []);
          })
          .catch(() => {
            resolve([]);
          });
      } catch {
        resolve([]);
      }
    });

    const devices = await withScanTimeout(rwScanPromise, 'RWRingManager', SCAN_TIMEOUT_MS);
    return (devices || []).filter((item: any) => item.name).map((item: any) => ({ ...item, type: 'rw' }));
  } catch {
    return [];
  }
};

const scanAllDevices = async (): Promise<any[]> => {
  const scanPromises: Promise<any>[] = [];
  const SCAN_TIMEOUT_MS = SCAN_TIMEOUT_MS_DEFAULT;
  const addTimeoutToScan = (promise: Promise<any>, scanName: string): Promise<any> =>
    withScanTimeout(promise, scanName, SCAN_TIMEOUT_MS);

  if (Platform.OS === 'ios' && ycIsAvailable()) {
    scanPromises.push(addTimeoutToScan(ycStartScan(IOS_YC_SCAN_DELAY_SEC), 'YCProductModule'));
  } else if (YCRingManager?.scanDevices) {
    scanPromises.push(addTimeoutToScan(YCRingManager.scanDevices(), 'YCRingManager'));
  }

  if (RWRingManager?.scanDevices) {
    scanPromises.push(addTimeoutToScan(RWRingManager.scanDevices(), 'RWRingManager'));
  }

  if (scanPromises.length === 0) {
    return [];
  }
  const results = await Promise.allSettled(scanPromises);

  let ycDevices: any[] = [];
  let rwDevices: any[] = [];

  let ycResultIndex = -1;
  let rwResultIndex = -1;

  let currentIndex = 0;
  if (Platform.OS === 'ios' && ycIsAvailable()) {
    ycResultIndex = currentIndex++;
  } else if (YCRingManager?.scanDevices) {
    ycResultIndex = currentIndex++;
  }

  if (RWRingManager?.scanDevices) {
    rwResultIndex = currentIndex++;
  }

  if (ycResultIndex >= 0) {
    if (results[ycResultIndex]?.status === 'fulfilled') {
      const ycResult = results[ycResultIndex] as PromiseFulfilledResult<any>;
      const value = ycResult.value;

      let connectedSet = new Set<string>();
      if (Platform.OS === 'ios' && ycIsAvailable()) {
        try {
          const connected = await ycGetConnectedPeripherals();
          connectedSet = new Set((connected || []).map((x) => x.id));
        } catch { }
      }

      ycDevices = (value || [])
        .filter((d: any) => d.name)
        .map((d: any) => {
          const id = d.id || d.uuid || d.identifier;
          return {
            uuid: id,
            name: d.name || 'YC Device',
            type: 'yc',
            isConnected: connectedSet.has(id),
          };
        });
    } else if (results[ycResultIndex]?.status === 'rejected') {
      const reason = (results[ycResultIndex] as PromiseRejectedResult).reason;
      devLog.warn('[DeviceScanner] YC scan failed:', reason?.message || reason);
    }
  }

  if (rwResultIndex >= 0) {
    if (results[rwResultIndex]?.status === 'fulfilled') {
      const rwResult = results[rwResultIndex] as PromiseFulfilledResult<any>;
      rwDevices = ((rwResult.value || []) as any[])
        .filter((item: any) => item.name)
        .map((item: any) => ({
          ...item,
          type: 'rw',
          uuid: item.uuid || item.id,
          name: item.name || 'RW Device',
        }));
    } else if (results[rwResultIndex]?.status === 'rejected') {
      const reason = (results[rwResultIndex] as PromiseRejectedResult).reason;
      devLog.warn('[DeviceScanner] RW scan failed:', reason?.message || reason);
    }
  }

  const allDevices = [...ycDevices, ...rwDevices];
  return allDevices;
};

export const stopScan = async (deviceType?: string): Promise<boolean> => {
  try {
    if (!(await ensureBluetoothEnabled())) {
      return false;
    }

    if (deviceType === 'yc') {
      return (await YCRingManager?.stopScan?.()) || false;
    } else if (deviceType === 'rw') {
      return (await RWRingManager?.stopScan?.()) || false;
    } else {
      const [rwResult, ycResult] = await Promise.allSettled([
        RWRingManager?.stopScan?.(),
        YCRingManager?.stopScan?.(),
      ]);

      return {
        rw: rwResult.status === 'fulfilled' ? rwResult.value : false,
        yc: ycResult.status === 'fulfilled' ? ycResult.value : false,
      } as any;
    }
  } catch {
    return false;
  }
};
