import { NativeModules, NativeEventEmitter, Platform, EmitterSubscription } from 'react-native';
import { devLog } from '@/utils/loggingHelper';
import { formatYCHealthPayload } from '@/services/sync-device/data-transform/YCHealthDataFormatter';

import { FieldExtractor } from '../utils/fieldExtractors';

const extractSpo2FromCombinedData = (combinedData: any[]): any[] => {
  const spo2Fields = ['spO2', 'bloodOxygen', 'OOValue', 'spo2Value', 'oxygenValue', 'value'];
  const timestampFields = [
    'startTime',
    'time',
    'timestamp',
    'measurementTime',
    'recordTime',
    'createTime',
  ];

  const records = FieldExtractor.extractRecordsFromCombinedData(
    combinedData,
    spo2Fields,
    timestampFields,
    (value) => value > 0 && value <= 100,
  );

  return records.map((rec) => ({
    spo2: rec.value,
    spO2: rec.value,
    bloodOxygen: rec.value,
    time: rec.time,
    timestamp: rec.timestamp,
    startTime: rec.startTime,
    _source: rec._source,
    _originalRecord: rec._originalRecord,
  }));
};
const YCProductModule = (NativeModules as any).YCProductModule;
const YCRingManagerLegacy = (NativeModules as any).YCRingManager;
const YCNative: any | undefined = YCProductModule;

// Khởi tạo YCEmitter an toàn với defensive checks
const createSafeYCEmitter = (): NativeEventEmitter | null => {
  if (Platform.OS !== 'ios') {
    return null;
  }

  try {
    if (
      YCProductModule !== null &&
      YCProductModule !== undefined &&
      typeof YCProductModule === 'object' &&
      typeof YCProductModule.addListener === 'function'
    ) {
      devLog.info('[YCBridge] Creating NativeEventEmitter with YCProductModule');
      return new NativeEventEmitter(YCProductModule);
    }

    devLog.warn('[YCBridge] YCProductModule not valid for NativeEventEmitter', {
      hasModule: !!YCProductModule,
      moduleType: typeof YCProductModule,
      hasAddListener: YCProductModule && typeof YCProductModule.addListener === 'function',
    });
    return null;
  } catch (error) {
    devLog.error('[YCBridge] Failed to create NativeEventEmitter:', error);
    return null;
  }
};

const YCEmitter: NativeEventEmitter | null = createSafeYCEmitter();

export const ycIsAvailable = (): boolean => !!YCNative;

export const ycStartScan = async (
  delaySec: number = 3,
): Promise<Array<{ id: string; name: string }>> => {
  const mod = YCNative;
  if (!mod) {
    devLog.warn('[YCBridge] ycStartScan: YCProductModule not available on', Platform.OS);
    return [];
  }
  try {
    devLog.info('[YCBridge] ycStartScan checking available methods', {
      hasStartScan: typeof mod.startScan === 'function',
      hasScanDevices: typeof (mod as any).scanDevices === 'function',
    });
    if (typeof mod.startScan === 'function') {
      const devices = await mod.startScan(delaySec);
      devLog.info('[YCBridge] ycStartScan completed via startScan', {
        count: Array.isArray(devices) ? devices.length : -1,
        isArray: Array.isArray(devices),
      });
      return Array.isArray(devices) ? devices : [];
    }
    if (typeof mod.scanDevices === 'function') {
      const devices = await mod.scanDevices();
      devLog.info('[YCBridge] ycStartScan completed via scanDevices', {
        count: Array.isArray(devices) ? devices.length : -1,
        isArray: Array.isArray(devices),
      });
      return Array.isArray(devices) ? devices : [];
    }
    devLog.warn('[YCBridge] ycStartScan: no scan method available on YCProductModule');
    return [];
  } catch (e) {
    devLog.warn('[YCBridge] startScan failed', e);
    return [];
  }
};

export const ycConnect = async (uuid: string): Promise<boolean> => {
  const mod = YCNative;
  if (!mod) {
    devLog.warn('[YCBridge] ycConnect: YCNative module not available');
    return false;
  }

  const startTime = Date.now();

  try {
    if (typeof mod.connectDevice === 'function') {
      devLog.info('[YCBridge] ycConnect: Calling native connectDevice...', {
        uuid: uuid.substring(0, 8) + '...',
        platform: Platform.OS,
        timestamp: new Date().toISOString(),
        fullUuid: uuid, // Log full UUID for debugging
      });

      const result = await mod.connectDevice(uuid);

      const elapsedMs = Date.now() - startTime;
      devLog.info('[YCBridge] ycConnect: Native connection successful', {
        uuid: uuid.substring(0, 8) + '...',
        elapsedMs,
        elapsedSec: (elapsedMs / 1000).toFixed(1),
        nativeResult: result,
        resultType: typeof result,
      });
      return true;
    }
    devLog.warn('[YCBridge] ycConnect: connectDevice function not available');
    return false;
  } catch (e: any) {
    const elapsedMs = Date.now() - startTime;
    const errorCode = e?.code || 'unknown';
    const errorMessage = e?.message || String(e);
    const errorDomain = (e as any)?.domain || 'unknown';

    devLog.error('[YCBridge] connectDevice failed', {
      errorCode,
      errorMessage,
      errorDomain,
      uuid: uuid.substring(0, 8) + '...',
      elapsedMs,
      elapsedSec: (elapsedMs / 1000).toFixed(1),
      isTimeout: errorCode === 'timeout' || errorCode === 'connect_timeout',
      fullError: e,
    });

    return false;
  }
};

export const ycDisconnect = async (): Promise<boolean> => {
  const mod = YCNative;
  if (!mod) return false;
  try {
    if (typeof mod.disconnectDevice === 'function') {
      await mod.disconnectDevice();
      try {
        if (typeof mod.setReconnectEnable === 'function') {
          await mod.setReconnectEnable(false);
        }
      } catch (reconnectError) {
        devLog.warn('[YCBridge] Failed to disable auto-reconnect:', reconnectError);
      }

      return true;
    }
    return false;
  } catch (e) {
    devLog.warn('[YCBridge] disconnectDevice failed', e);
    return false;
  }
};

export const ycGetBatteryLevel = async (): Promise<number | null> => {
  const mod = YCNative;
  if (!mod) return null;
  try {
    if (typeof mod.getDeviceBasicInfo === 'function') {
      const info = await mod.getDeviceBasicInfo();
      const battery = info?.batteryPower ?? info?.battery ?? null;
      if (typeof battery === 'number') return battery;
      return Number.isFinite(Number(battery)) ? Number(battery) : null;
    }
    if (typeof mod.getBatteryLevel === 'function') {
      const res = await mod.getBatteryLevel();
      const battery = res?.battery ?? res ?? null;
      if (typeof battery === 'number') return battery;
      return Number.isFinite(Number(battery)) ? Number(battery) : null;
    }
    if (typeof mod.getBatteryLevelByUUID === 'function') {
      const res = await mod.getBatteryLevelByUUID('');
      const battery = res?.battery ?? res ?? null;
      if (typeof battery === 'number') return battery;
      return Number.isFinite(Number(battery)) ? Number(battery) : null;
    }
    return null;
  } catch (e) {
    devLog.warn('[YCBridge] getDeviceBasicInfo/getBatteryLevel failed', e);
    return null;
  }
};

export const ycGetBatteryLevelByUUID = async (uuid: string): Promise<number | null> => {
  const mod = YCNative;
  if (!mod) return null;
  try {
    if (typeof mod.getBatteryLevelByUUID === 'function') {
      const res = await mod.getBatteryLevelByUUID(uuid || '');
      const battery = (res as any)?.battery ?? res ?? null;
      if (typeof battery === 'number') return battery;
      return Number.isFinite(Number(battery)) ? Number(battery) : null;
    }
    if (typeof mod.connectDevice === 'function' && typeof mod.getDeviceBasicInfo === 'function') {
      try {
        await mod.connectDevice(uuid);
      } catch {}
      const info = await mod.getDeviceBasicInfo();
      const battery = info?.batteryPower ?? info?.battery ?? null;
      if (typeof battery === 'number') return battery;
      return Number.isFinite(Number(battery)) ? Number(battery) : null;
    }
    return null;
  } catch (e) {
    devLog.warn('[YCBridge] getBatteryLevelByUUID failed', e);
    return null;
  }
};

export const ycQueryHealthData = async (type: string): Promise<any[]> => {
  const mod = YCNative;
  if (!mod) return [];
  try {
    if (typeof mod.queryHealthData === 'function') {
      const res = await mod.queryHealthData(type);
      if (Array.isArray(res)) {
        devLog.info(`[YCBridge] queryHealthData(${type}) via queryHealthData raw`, {
          res,
        });
        return res;
      } else {
        devLog.warn(`[YCBridge] queryHealthData(${type}) returned non-array`, {
          valueType: typeof res,
          valueKeys: res && typeof res === 'object' ? Object.keys(res) : undefined,
        });
        return [];
      }
    }
    if (typeof mod.getAllHealthData === 'function') {
      const all = await mod.getAllHealthData('');
      const look = all?.[type] ?? [];
      const arr = Array.isArray(look) ? look : [];
      devLog.info(`[YCBridge] queryHealthData(${type}) via getAllHealthData raw`, {
        arr,
      });
      return arr;
    }
    return [];
  } catch (e) {
    devLog.warn(`[YCBridge] queryHealthData(${type}) failed`, e);
    return [];
  }
};

export const ycFetchAllHealthData = async (): Promise<any> => {
  const mod = YCNative;
  if (!mod) return {};

  // Optimization: Skip spO2 query (extracted from combinedData instead)
  const priorityTypes = ['combinedData', 'step', 'heartRate', 'bloodPressure', 'sleep'];
  const results: Record<string, any[]> = {};

  try {
    devLog.info('[YCBridge] Fetching health data (optimized)...');
    const startTime = Date.now();

    // Fetch types in parallel (JS level - native still sequential)
    await Promise.all(
      priorityTypes.map(async (t) => {
        results[t] = await ycQueryHealthData(t);
      }),
    );

    const elapsed = Date.now() - startTime;
    devLog.info(`[YCBridge] ⚡ Fetch completed in ${(elapsed / 1000).toFixed(2)}s`);

    try {
      const counts: Record<string, number> = {};
      for (const t of priorityTypes) {
        counts[t] = Array.isArray(results[t]) ? results[t].length : 0;
      }
      devLog.info('[YCBridge] Data counts:', counts);
    } catch {}

    // iOS: Skip spO2 extraction (not needed, reduces processing time)
    // Note: spO2 data is available in combinedData but not extracted separately

    const normalized = formatYCHealthPayload(results);
    return { ...results, ...normalized };
  } catch (e) {
    devLog.warn('[YCBridge] fetchAllHealthData failed', e);
    return {};
  }
};

export const ycGetConnectedDevice = async (): Promise<{ id: string; name: string } | null> => {
  const mod = YCNative;
  if (!mod || typeof mod.getConnectedDevice !== 'function') return null;
  try {
    const res = await mod.getConnectedDevice();
    if (res && typeof res.id === 'string') return res as any;
    return null;
  } catch (e) {
    devLog.warn('[YCBridge] getConnectedDevice failed', e);
    return null;
  }
};

export const ycGetConnectedPeripherals = async (): Promise<Array<{ id: string; name: string }>> => {
  const mod = YCNative;
  if (!mod || typeof mod.getConnectedPeripherals !== 'function') return [];
  try {
    const res = await mod.getConnectedPeripherals();
    return Array.isArray(res) ? res : [];
  } catch (e) {
    devLog.warn('[YCBridge] getConnectedPeripherals failed', e);
    return [];
  }
};

export const ycSetReconnectEnable = async (enable: boolean): Promise<boolean> => {
  const mod = YCNative as any;
  if (!mod || typeof mod.setReconnectEnable !== 'function') {
    devLog.warn('[YCBridge] setReconnectEnable not available on native module');
    return false;
  }
  try {
    await mod.setReconnectEnable(!!enable);
    return true;
  } catch (e) {
    devLog.warn('[YCBridge] setReconnectEnable failed', e);
    return false;
  }
};

export const ycIsUuidConnected = async (uuid: string): Promise<boolean> => {
  try {
    const mod = YCNative as any;
    if (mod && typeof mod.isDeviceConnectedByUUID === 'function') {
      return await mod.isDeviceConnectedByUUID(uuid);
    }
  } catch (e) {
    devLog.warn('[YCBridge] isDeviceConnectedByUUID (YCProductModule) failed', e);
  }
  try {
    if (
      Platform.OS === 'ios' &&
      YCRingManagerLegacy &&
      typeof YCRingManagerLegacy.isDeviceConnectedByUUID === 'function'
    ) {
      return await YCRingManagerLegacy.isDeviceConnectedByUUID(uuid);
    }
  } catch (e) {
    devLog.warn('[YCBridge] isDeviceConnectedByUUID (YCRingManager) failed', e);
  }
  return false;
};
const YC_DEVICE_STATE_EVENT = 'YCDeviceStateChanged';
let ycDeviceStateLast: number | null = null;
let ycStateSubscription: EmitterSubscription | null = null;

const ensureYCStateListening = () => {
  if (ycStateSubscription) return;
  const emitter = YCEmitter;
  if (!emitter) return;
  try {
    ycStateSubscription = emitter.addListener(YC_DEVICE_STATE_EVENT, (payload: any) => {
      const next = typeof payload?.state === 'number' ? payload.state : null;
      ycDeviceStateLast = next;
    });
  } catch (e) {
    devLog.warn('[YCBridge] Failed to subscribe device state event', e);
  }
};

export const ycAddDeviceStateListener = (
  listener: (state: number | null) => void,
): EmitterSubscription | null => {
  const emitter = YCEmitter;
  if (!emitter) return null;
  ensureYCStateListening();
  try {
    const sub = emitter.addListener(YC_DEVICE_STATE_EVENT, (payload: any) => {
      const st = typeof payload?.state === 'number' ? payload.state : null;
      ycDeviceStateLast = st;
      listener(st);
    });
    listener(ycDeviceStateLast);
    return sub;
  } catch (e) {
    devLog.warn('[YCBridge] addDeviceStateListener failed', e);
    return null;
  }
};

export const ycRemoveDeviceStateListener = (subscription: EmitterSubscription | null) => {
  try {
    subscription?.remove?.();
  } catch {}
};

export const ycGetLastDeviceState = (): number | null => ycDeviceStateLast;

export const ycIsConnected = (): boolean =>
  typeof ycDeviceStateLast === 'number' ? ycDeviceStateLast !== 0 : false;

const YC_STATE_MAP: Record<
  number,
  { code: string; description: string; category: string; isError: boolean }
> = {
  0: {
    code: 'unknown',
    description: 'Bluetooth trạng thái không xác định',
    category: 'bluetooth',
    isError: false,
  },
  1: {
    code: 'resetting',
    description: 'Bluetooth đang khởi động lại',
    category: 'bluetooth',
    isError: false,
  },
  2: {
    code: 'unsupported',
    description: 'Thiết bị không hỗ trợ Bluetooth',
    category: 'bluetooth',
    isError: true,
  },
  3: {
    code: 'unauthorized',
    description: 'Quyền Bluetooth bị từ chối',
    category: 'permission',
    isError: true,
  },
  4: {
    code: 'poweredOff',
    description: 'Bluetooth đang tắt',
    category: 'bluetooth',
    isError: false,
  },
  5: { code: 'poweredOn', description: 'Bluetooth đã bật', category: 'bluetooth', isError: false },
  6: {
    code: 'disconnected',
    description: 'Thiết bị đã ngắt kết nối',
    category: 'connection',
    isError: false,
  },
  7: {
    code: 'connected',
    description: 'Thiết bị đã kết nối',
    category: 'connection',
    isError: false,
  },
  8: {
    code: 'connectFailed',
    description: 'Kết nối Bluetooth thất bại',
    category: 'connection',
    isError: true,
  },
  9: { code: 'succeed', description: 'Thao tác thành công', category: 'operation', isError: false },
  10: { code: 'failed', description: 'Thao tác thất bại', category: 'operation', isError: true },
  11: {
    code: 'unavailable',
    description: 'API không khả dụng',
    category: 'operation',
    isError: true,
  },
  12: {
    code: 'timeout',
    description: 'Hết thời gian (timeout)',
    category: 'operation',
    isError: true,
  },
  13: { code: 'dataError', description: 'Lỗi dữ liệu', category: 'data', isError: true },
  14: { code: 'crcError', description: 'Lỗi CRC', category: 'data', isError: true },
  15: { code: 'dataTypeError', description: 'Lỗi kiểu dữ liệu', category: 'data', isError: true },
  16: { code: 'noRecord', description: 'Không có bản ghi', category: 'data', isError: false },
  17: { code: 'parameterError', description: 'Lỗi tham số', category: 'operation', isError: true },
  18: {
    code: 'alarmNotExist',
    description: 'Báo thức không tồn tại',
    category: 'alarm',
    isError: true,
  },
  19: {
    code: 'alarmAlreadyExist',
    description: 'Báo thức đã tồn tại',
    category: 'alarm',
    isError: true,
  },
  20: {
    code: 'alarmCountLimit',
    description: 'Số lượng báo thức đạt giới hạn',
    category: 'alarm',
    isError: true,
  },
  21: {
    code: 'alarmTypeNotSupport',
    description: 'Loại báo thức không được hỗ trợ',
    category: 'alarm',
    isError: true,
  },
};

export const ycDescribeState = (
  state: number | null | undefined,
): {
  state: number | null;
  code: string;
  description: string;
  category: string;
  connected: boolean;
  isError: boolean;
} => {
  if (typeof state !== 'number') {
    return {
      state: null,
      code: 'unknown',
      description: 'Không xác định',
      category: 'bluetooth',
      connected: false,
      isError: false,
    };
  }
  const meta = YC_STATE_MAP[state] || YC_STATE_MAP[0];
  const connected = state === 7;
  return { state, ...meta, connected };
};

export const ycGetConnectionStatus = (): {
  connected: boolean;
  state: number | null;
  code: string;
  description: string;
  category: string;
} => {
  const info = ycDescribeState(ycDeviceStateLast);
  return {
    connected: info.connected,
    state: info.state,
    code: info.code,
    description: info.description,
    category: info.category,
  };
};

export const ycAddDeviceStatusListener = (
  listener: (payload: {
    state: number | null;
    code: string;
    description: string;
    category: string;
    connected: boolean;
    isError: boolean;
  }) => void,
): EmitterSubscription | null => {
  const emitter = YCEmitter;
  if (!emitter) return null;
  ensureYCStateListening();
  try {
    const sub = emitter.addListener(YC_DEVICE_STATE_EVENT, (payload: any) => {
      const st = typeof payload?.state === 'number' ? payload.state : null;
      ycDeviceStateLast = st;
      listener(ycDescribeState(st));
    });
    listener(ycDescribeState(ycDeviceStateLast));
    return sub;
  } catch (e) {
    devLog.warn('[YCBridge] addDeviceStatusListener failed', e);
    return null;
  }
};
try {
  if (Platform.OS === 'ios' && YCNative) {
    ensureYCStateListening();
  }
} catch {}
