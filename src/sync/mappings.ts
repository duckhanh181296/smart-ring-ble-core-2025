import { DeviceFieldMapping } from './types';

export const DEVICE_MAPPINGS: Record<string, DeviceFieldMapping> = {
  yc: {
    heartRate: {
      dataPath: 'heartRate',
      valueFields: ['heartValue', 'heartRate', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    spo2: {
      dataPath: 'bloodOxygen',
      valueFields: ['OOValue', 'bloodOxygen', 'spo2', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    bloodOxygen: {
      dataPath: 'bloodOxygen',
      valueFields: ['OOValue', 'bloodOxygen', 'spo2', 'value'],
      timestampFields: ['startTime', 'time', 'timestamp', 'date'],
    },
    steps: {
      dataPath: 'step',
      valueFields: ['stepValue', 'sportStep', 'step', 'steps', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    calories: {
      dataPath: 'step',
      valueFields: ['sportCalorie', 'calories', 'calorie', 'kcal', 'cal', 'value'],
      timestampFields: ['sportStartTime', 'time', 'timestamp', 'date'],
    },
    distance: {
      dataPath: 'step',
      valueFields: ['sportDistance', 'distance', 'dist', 'km', 'meters', 'value'],
      timestampFields: ['sportStartTime', 'time', 'timestamp', 'date'],
    },
    sleep: {
      dataPath: 'sleep',
      deepSleepFields: ['deepSleepSeconds', 'deepSleepMinutes'],
      lightSleepFields: ['lightSleepSeconds', 'lightSleepMinutes'],
      remSleepFields: ['remSleepSeconds', 'remSleepMinutes'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    bloodPressure: {
      dataPath: 'bloodPressure',
      systolicFields: ['systolic', 'sbp', 'high'],
      diastolicFields: ['diastolic', 'dbp', 'low'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    temperature: {
      dataPath: 'temperature',
      valueFields: ['temperature', 'temp', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    battery: {
      dataPath: 'battery',
      valueFields: ['battery', 'batteryLevel', 'batteryPercent'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
  },
  rw: {
    heartRate: {
      dataPath: 'heartRate',
      valueFields: ['heartRate', 'hr', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    spo2: {
      dataPath: 'spo2',
      valueFields: ['spo2', 'oxygen', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    bloodOxygen: {
      dataPath: 'spo2',
      valueFields: ['spo2', 'oxygen', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    calories: {
      dataPath: 'steps',
      valueFields: ['calories', 'calorie', 'kcal', 'cal', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    distance: {
      dataPath: 'steps',
      valueFields: ['distance', 'dist', 'km', 'meters', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    steps: {
      dataPath: 'steps',
      valueFields: ['steps', 'step', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    sleep: {
      dataPath: 'sleep',
      deepSleepFields: ['deepSleep', 'deep'],
      lightSleepFields: ['lightSleep', 'light'],
      remSleepFields: ['remSleep', 'rem'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    bloodPressure: {
      dataPath: 'bloodPressure',
      systolicFields: ['systolic', 'high'],
      diastolicFields: ['diastolic', 'low'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    temperature: {
      dataPath: 'temperature',
      valueFields: ['temperature', 'temp'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    battery: {
      dataPath: 'battery',
      valueFields: ['battery', 'batteryLevel'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
  },
  android_yc: {
    heartRate: {
      dataPath: 'heartRate',
      valueFields: ['heartValue', 'heartRate', 'value'],
      timestampFields: ['heartStartTime', 'time', 'timestamp', 'date'],
    },
    spo2: {
      dataPath: 'bloodOxygen',
      valueFields: ['OOValue', 'bloodOxygen', 'spo2', 'value'],
      timestampFields: ['startTime', 'time', 'timestamp', 'date'],
    },
    bloodOxygen: {
      dataPath: 'bloodOxygen',
      valueFields: ['OOValue', 'bloodOxygen', 'spo2', 'value'],
      timestampFields: ['startTime', 'time', 'timestamp', 'date'],
    },
    calories: {
      dataPath: 'step',
      valueFields: ['sportCalorie', 'calories', 'calorie', 'kcal', 'cal', 'value'],
      timestampFields: ['sportStartTime', 'time', 'timestamp', 'date'],
    },
    distance: {
      dataPath: 'step',
      valueFields: ['sportDistance', 'distance', 'dist', 'km', 'meters', 'value'],
      timestampFields: ['sportStartTime', 'time', 'timestamp', 'date'],
    },
    steps: {
      dataPath: 'step',
      valueFields: ['stepValue', 'sportStep', 'step', 'steps', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    sleep: {
      dataPath: 'sleep',
      deepSleepFields: ['deepSleepTotal', 'deepSleepSeconds', 'deepSleepMinutes'],
      lightSleepFields: ['lightSleepTotal', 'lightSleepSeconds', 'lightSleepMinutes'],
      remSleepFields: ['rapidEyeMovementTotal', 'remSleepSeconds', 'remSleepMinutes'],
      timestampFields: ['startTime', 'endTime', 'time', 'timestamp', 'date'],
    },
    bloodPressure: {
      dataPath: 'bloodPressure',
      systolicFields: ['bloodSBP', 'systolic', 'sbp', 'high'],
      diastolicFields: ['bloodDBP', 'diastolic', 'dbp', 'low'],
      timestampFields: ['bloodStartTime', 'time', 'timestamp', 'date'],
    },
    temperature: {
      dataPath: 'temperature',
      valueFields: ['temperature', 'temp', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    battery: {
      dataPath: 'battery',
      valueFields: ['battery', 'batteryLevel', 'batteryPercent'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
  },
  ios_yc: {
    heartRate: {
      dataPath: 'heartRate',
      valueFields: ['heartValue', 'heartRate', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    spo2: {
      dataPath: 'bloodOxygen',
      valueFields: ['OOValue', 'bloodOxygen', 'spo2', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    bloodOxygen: {
      dataPath: 'bloodOxygen',
      valueFields: ['OOValue', 'bloodOxygen', 'spo2', 'value'],
      timestampFields: ['startTime', 'time', 'timestamp', 'date'],
    },
    calories: {
      dataPath: 'step',
      valueFields: ['sportCalorie', 'calories', 'calorie', 'kcal', 'cal', 'value'],
      timestampFields: ['sportStartTime', 'time', 'timestamp', 'date'],
    },
    distance: {
      dataPath: 'step',
      valueFields: ['sportDistance', 'distance', 'dist', 'km', 'meters', 'value'],
      timestampFields: ['sportStartTime', 'time', 'timestamp', 'date'],
    },
    steps: {
      dataPath: 'step',
      valueFields: ['stepValue', 'sportStep', 'step', 'steps', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    sleep: {
      dataPath: 'sleep',
      deepSleepFields: ['deepSleepSeconds', 'deepSleepMinutes'],
      lightSleepFields: ['lightSleepSeconds', 'lightSleepMinutes'],
      remSleepFields: ['remSleepSeconds', 'remSleepMinutes'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    bloodPressure: {
      dataPath: 'bloodPressure',
      systolicFields: ['systolic', 'sbp', 'high'],
      diastolicFields: ['diastolic', 'dbp', 'low'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    temperature: {
      dataPath: 'temperature',
      valueFields: ['temperature', 'temp', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    battery: {
      dataPath: 'battery',
      valueFields: ['battery', 'batteryLevel', 'batteryPercent'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
  },
  default: {
    heartRate: {
      dataPath: 'heartRate',
      valueFields: ['heartRate', 'hr', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    spo2: {
      dataPath: 'spo2',
      valueFields: ['spo2', 'oxygen', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    bloodOxygen: {
      dataPath: 'spo2',
      valueFields: ['spo2', 'oxygen', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    calories: {
      dataPath: 'steps',
      valueFields: ['calories', 'calorie', 'kcal', 'cal', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    distance: {
      dataPath: 'steps',
      valueFields: ['distance', 'dist', 'km', 'meters', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    steps: {
      dataPath: 'steps',
      valueFields: ['steps', 'step', 'value'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    sleep: {
      dataPath: 'sleep',
      deepSleepFields: ['deepSleep', 'deep'],
      lightSleepFields: ['lightSleep', 'light'],
      remSleepFields: ['remSleep', 'rem'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    bloodPressure: {
      dataPath: 'bloodPressure',
      systolicFields: ['systolic', 'high'],
      diastolicFields: ['diastolic', 'low'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    temperature: {
      dataPath: 'temperature',
      valueFields: ['temperature', 'temp'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
    battery: {
      dataPath: 'battery',
      valueFields: ['battery', 'batteryLevel'],
      timestampFields: ['time', 'timestamp', 'date'],
    },
  },
};
