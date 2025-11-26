export type PlatformType = 'ios' | 'android';

export interface DeviceInfo {
  uuid: string;
  name?: string;
  deviceId?: string | number;
  serverId?: number;
  deviceType: 'yc' | 'rw' | 'x6' | 'circular' | 'ringconn' | 'amazfit' | string;
  rssi?: number;
  battery?: number;
  lastSync?: string;
}

export interface ConnectedDevice extends DeviceInfo {
  serverId: number;
  lastSeen: number;
}

// Raw data from native SDKs (YC / RW / X6)
export interface RawHealthData {
  step?: any[];
  steps?: any[];
  heartRate?: any[];
  heartRates?: any[];
  sleep?: any[];
  sleepData?: any[];
  bloodOxygen?: any[];
  spO2?: any[];
  bloodPressure?: any[];
  temperature?: any[];
  battery?: number;
  combinedData?: any[]; // YC Android style
  deviceUuid?: string;
  deviceType?: string;
  [key: string]: any; // fallback for unknown fields
}

// Normalized health data – unified format for UI + API sync
export interface NormalizedHealthData {
  heartRate: { current: number; timestamp: number; unit: 'bpm' } | null;
  spo2: { current: number; timestamp: number; unit: '%' } | null;
  steps: { current: number; timestamp: number; unit: 'steps' } | null;
  calories: number | null;
  distance: number | null; // meters
  sleep: {
    totalMinutes: number;
    deepSleepMinutes: number;
    lightSleepMinutes: number;
    remSleepMinutes?: number;
    totalSleepSeconds?: number;
    timestamp: number;
    unit: 'minutes';
  } | null;
  bloodPressure: {
    systolic: number;
    diastolic: number;
    timestamp: number;
    unit: 'mmHg';
  } | null;
  temperature: { current: number; timestamp: number; unit: 'celsius' } | null;
  battery: { current: number; timestamp: number; unit: '%' } | null;

  lastSync: string;
  deviceType: string;
  platform: PlatformType;
  deviceUuid?: string;
  rawData?: RawHealthData;
}

// Field mapping for different OEM SDKs
export interface FieldMapping {
  dataPath: string;
  valueFields: string[];
  timestampFields?: string[];
  caloriesFields?: string[];
  distanceFields?: string[];
  deepSleepFields?: string[];
  lightSleepFields?: string[];
  remSleepFields?: string[];
  systolicFields?: string[];
  diastolicFields?: string[];
  valueField?: string;
}

export interface DeviceFieldMapping {
  heartRate: FieldMapping;
  spo2: FieldMapping;
  bloodOxygen: FieldMapping;
  steps: FieldMapping;
  calories: FieldMapping;
  distance: FieldMapping;
  sleep: {
    dataPath: string;
    deepSleepFields: string[];
    lightSleepFields: string[];
    remSleepFields?: string[];
    timestampFields: string[];
  };
  bloodPressure: {
    dataPath: string;
    systolicFields: string[];
    diastolicFields: string[];
    timestampFields: string[];
  };
  temperature: FieldMapping;
  battery: FieldMapping;
}

// Platform-specific adjustments (iOS vs Android differences)
export interface PlatformAdjustment {
  heartRate?: Partial<FieldMapping>;
  spo2?: Partial<FieldMapping>;
  steps?: Partial<FieldMapping>;
  sleep?: Partial<{
    timestampFields: string[];
  }>;
  bloodPressure?: Partial<{
    timestampFields: string[];
  }>;
  temperature?: Partial<FieldMapping>;
}

export const PLATFORM_ADJUSTMENTS: Record<PlatformType, PlatformAdjustment> = {
  ios: {
    heartRate: { timestampFields: ['time', 'heartStartTime', 'timestamp', 'startTime'] },
    spo2: { timestampFields: ['time', 'startTime', 'timestamp'] },
    sleep: { timestampFields: ['time', 'startTime', 'date'] },
  },
  android: {
    heartRate: { timestampFields: ['timestamp', 'time', 'startTime'] },
    spo2: { timestampFields: ['timestamp', 'time', 'startTime'] },
    sleep: { timestampFields: ['timestamp', 'time', 'date'] },
  },
};

// Sync result
export interface SyncResult {
  success: boolean;
  source: 'device' | 'os' | 'manual';
  normalizedData?: NormalizedHealthData;
  error?: any;
  deviceUuid?: string;
  deviceType?: string;
  timestamp: number;
}

// Event emitter payloads
export interface DeviceDataUpdatedEvent {
  uuid: string;
  action: 'sync_completed' | 'battery_updated' | 'connection_changed';
  timestamp: string;
  healthData?: Partial<NormalizedHealthData>;
  syncSuccess?: boolean;
  bypassThrottling?: boolean;
}

export interface BluetoothStateEvent {
  state: 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unknown' | 'resetting';
  previousState?: string;
}

// Battery manager
export interface BatteryLevelResult {
  level: number;
  isCharging?: boolean;
  timestamp: number;
}