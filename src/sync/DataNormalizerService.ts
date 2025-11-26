import { devLog } from '@/utils/loggingHelper';
import { startOfToday, endOfToday } from '@/utils/date-time';
import { HealthDataRepository } from '@/repositories/HealthDataRepository';
import { healthDataPersistence } from './HealthDataPersistenceService';
import { storageUpdateService } from './StorageUpdateService';
import { APISyncService } from './APISyncService';

import { DeviceFieldMapping, NormalizedHealthData } from './types';
import { DataValidator } from './DataValidator';
import { HealthCalculator } from './HealthCalculator';
import { DeviceMapper } from './DeviceMapper';
import { DataProcessors } from './DataProcessors';

const TIMESTAMP_SECOND_TO_MS_THRESHOLD = 1000000000000;
const TIMESTAMP_SECOND_TO_MS_THRESHOLD_SHORT = 10000000000;
const HEART_RATE_MIN = 0;
const HEART_RATE_MAX = 200;
const SPO2_MIN = 0;
const SPO2_MAX = 100;
const TEMPERATURE_MIN = -10;
const TEMPERATURE_MAX = 100;
const SYSTOLIC_MIN = 50;
const SYSTOLIC_MAX = 300;
const DIASTOLIC_MIN = 30;
const DIASTOLIC_MAX = 200;
const MAX_SLEEP_MINUTES = 24 * 60;

class DataNormalizerService {
  private static instance: DataNormalizerService;
  private validator: DataValidator;
  private calculator: HealthCalculator;
  private deviceMapper: DeviceMapper;
  private platform: string;

  constructor(platform: string = 'android') {
    this.validator = new DataValidator();
    this.calculator = new HealthCalculator();
    this.deviceMapper = new DeviceMapper();
    this.platform = platform;
  }

  static getInstance(platform: string = 'android'): DataNormalizerService {
    if (!DataNormalizerService.instance) {
      DataNormalizerService.instance = new DataNormalizerService(platform);
    }
    return DataNormalizerService.instance;
  }

  private getTodayTimestampRange() {
    return {
      start: startOfToday().getTime(),
      end: endOfToday().getTime(),
    };
  }

  private normalizeTimestamp(timestamp: number | null | undefined): number {
    if (!timestamp) return 0;
    return timestamp < TIMESTAMP_SECOND_TO_MS_THRESHOLD ? timestamp * 1000 : timestamp;
  }

  private extractDataArrayForIOS(
    cleanedData: any,
    combinedPath: string,
    fallbackPath: string,
  ): { dataArray: any[] | null; dataSource: string } {
    const combinedData = this.validator.extractDataArray(cleanedData, combinedPath);
    if (combinedData?.length) {
      return { dataArray: combinedData, dataSource: combinedPath };
    }
    const fallbackData = this.validator.extractDataArray(cleanedData, fallbackPath);
    return { dataArray: fallbackData?.length ? fallbackData : null, dataSource: fallbackPath };
  }

  private findBestValueInTimeRange(
    dataArray: any[],
    valueFields: string[],
    timestampFields: string[],
    validator: (value: number) => boolean,
    range: { start: number; end: number },
  ): { value: number; timestamp: number } | null {
    let bestTimestamp = 0;
    let bestValue = 0;

    for (let i = dataArray.length - 1; i >= 0; i--) {
      const record = dataArray[i];
      const timestampMs = this.normalizeTimestamp(
        this.validator.extractTimestamp(record, timestampFields),
      );

      if (!timestampMs || timestampMs < range.start || timestampMs > range.end) {
        continue;
      }

      const value = this.validator.extractBestValue(record, valueFields, validator);
      if (value > 0 && timestampMs > bestTimestamp) {
        bestTimestamp = timestampMs;
        bestValue = value;
      }
    }

    return bestValue > 0 && bestTimestamp > 0
      ? { value: bestValue, timestamp: bestTimestamp }
      : null;
  }

  async normalizeHealthData(
    rawData: any,
    deviceType: string,
    platform: 'ios' | 'android' = 'ios',
  ): Promise<NormalizedHealthData> {
    if (!rawData) {
      return {
        heartRate: null,
        spo2: null,
        steps: null,
        calories: null,
        distance: null,
        sleep: null,
        bloodPressure: null,
        temperature: null,
        battery: null,
        lastSync: new Date().toISOString(),
        deviceType,
        platform,
      };
    }

    const baseMapping = this.deviceMapper.getDeviceMapping(deviceType);
    const mapping = this.deviceMapper.applyPlatformAdjustments(baseMapping, platform);

    const [heartRate, spo2, steps, sleep, bloodPressure, temperature, battery] = await Promise.all([
      this.normalizeHeartRateMetric(rawData, mapping.heartRate, platform),
      this.normalizeSpo2Metric(rawData, mapping.spo2, platform),
      this.normalizeStepsMetric(rawData, mapping.steps, deviceType, platform),
      this.normalizeSleepMetric(rawData, mapping.sleep),
      this.normalizeBloodPressureMetric(rawData, mapping.bloodPressure),
      this.normalizeTemperatureMetric(rawData, mapping.temperature),
      this.normalizeBatteryMetric(rawData, mapping.battery),
    ]);

    const calories = this.normalizeCaloriesMetric(
      rawData,
      mapping.calories || mapping.steps,
      deviceType,
    );
    const distance = this.normalizeDistanceMetric(
      rawData,
      mapping.distance || mapping.steps,
      deviceType,
    );

    return {
      heartRate,
      spo2,
      steps,
      calories,
      distance,
      sleep,
      bloodPressure,
      temperature,
      battery,
      lastSync: new Date().toISOString(),
      deviceType,
      platform,
      rawData: rawData,
    };
  }

  private normalizeHeartRateMetric(
    rawData: any,
    config: DeviceFieldMapping['heartRate'],
    platform: 'ios' | 'android' = 'ios',
  ): NormalizedHealthData['heartRate'] {
    try {
      const cleanedData = this.validator.validateAndCleanData(rawData);
      const range = this.getTodayTimestampRange();

      let dataArray: any[] | null = null;
      let valueFields: string[];

      if (platform === 'ios') {
        const extracted = this.extractDataArrayForIOS(cleanedData, 'combinedData', config.dataPath);
        dataArray = extracted.dataArray;
        valueFields =
          extracted.dataSource === 'combinedData'
            ? ['heartRate', 'heartValue', 'heart', 'hr', 'bpm', 'value']
            : config.valueFields;
      } else {
        dataArray = this.validator.extractDataArray(cleanedData, config.dataPath);
        valueFields = config.valueFields;
      }

      if (!dataArray?.length) {
        return null;
      }

      const result = this.findBestValueInTimeRange(
        dataArray,
        valueFields,
        config.timestampFields,
        (value) => value > HEART_RATE_MIN && value < HEART_RATE_MAX,
        range,
      );

      return result
        ? {
            current: result.value,
            timestamp: result.timestamp,
            unit: 'bpm' as const,
          }
        : null;
    } catch (error) {
      devLog.error('❌ DataNormalizer: Error processing heart rate:', error);
      return null;
    }
  }

  private normalizeTemperatureMetric(
    rawData: any,
    config: DeviceFieldMapping['temperature'],
  ): NormalizedHealthData['temperature'] {
    try {
      const dataArray = this.validator.extractDataArray(rawData, config.dataPath);
      if (!dataArray?.length) return null;

      let bestTimestamp = 0;
      let bestTemperature = 0;

      for (const record of dataArray) {
        const timestamp = this.validator.extractTimestamp(record, config.timestampFields);
        const temperature = this.validator.extractBestValue(
          record,
          config.valueFields,
          (value) => value > TEMPERATURE_MIN && value < TEMPERATURE_MAX,
        );

        if (temperature > 0 && timestamp > bestTimestamp) {
          bestTimestamp = timestamp;
          bestTemperature = temperature;
        }
      }

      return bestTemperature > 0
        ? {
            current: bestTemperature,
            timestamp: bestTimestamp,
            unit: 'celsius',
          }
        : null;
    } catch {
      return null;
    }
  }

  private normalizeSpo2Metric(
    rawData: any,
    config: DeviceFieldMapping['spo2'],
    platform: 'ios' | 'android' = 'ios',
  ): NormalizedHealthData['spo2'] {
    try {
      const cleanedData = this.validator.validateAndCleanData(rawData);
      const range = this.getTodayTimestampRange();

      let dataArray: any[] | null = null;
      let valueFields: string[];

      if (platform === 'ios') {
        const extracted = this.extractDataArrayForIOS(cleanedData, 'combinedData', config.dataPath);
        dataArray = extracted.dataArray;
        valueFields =
          extracted.dataSource === 'combinedData'
            ? ['bloodOxygen', 'spO2', 'spo2', 'OOValue', 'spo2Value', 'oxygenValue', 'value']
            : config.valueFields;
      } else {
        dataArray = this.validator.extractDataArray(cleanedData, config.dataPath);
        valueFields = config.valueFields;
      }

      if (!dataArray?.length) {
        return null;
      }

      const result = this.findBestValueInTimeRange(
        dataArray,
        valueFields,
        config.timestampFields,
        (value) => value > SPO2_MIN && value <= SPO2_MAX,
        range,
      );

      return result
        ? {
            current: result.value,
            timestamp: result.timestamp,
            unit: '%' as const,
          }
        : null;
    } catch (error) {
      devLog.error('❌ DataNormalizer: Error processing SPO2:', error);
      return null;
    }
  }

  private normalizeStepsMetric(
    rawData: any,
    config: DeviceFieldMapping['steps'],
    deviceType: string,
    platform: 'ios' | 'android' = 'ios',
  ): NormalizedHealthData['steps'] {
    if (platform === 'android') {
      return this.normalizeStepsMetricAndroid(rawData, config, deviceType);
    }
    return this.normalizeStepsMetricIOS(rawData, config, deviceType);
  }

  private normalizeStepsMetricAndroid(
    rawData: any,
    config: DeviceFieldMapping['steps'],
    deviceType: string,
  ): NormalizedHealthData['steps'] {
    try {
      const stepDataArray = this.validator.extractDataArray(rawData, config.dataPath);
      if (!stepDataArray?.length) return null;

      const isCombinedData =
        stepDataArray[0] &&
        (stepDataArray[0].stepValue !== undefined ||
          stepDataArray[0].heartValue !== undefined ||
          stepDataArray[0].SBPValue !== undefined ||
          stepDataArray[0].OOValue !== undefined ||
          stepDataArray[0].respiratoryRateValue !== undefined);

      if (isCombinedData) {
        rawData.combinedData = stepDataArray;
      }

      const isYCDevice =
        deviceType === 'yc' || deviceType === 'android_yc' || deviceType === 'ios_yc';
      const processedData = isYCDevice
        ? DataProcessors.processYCStepsData(stepDataArray, config)
        : DataProcessors.processRWStepsData(stepDataArray, config);

      return {
        current: processedData.steps || 0,
        timestamp: Date.now(),
        unit: 'steps' as const,
      };
    } catch {
      return null;
    }
  }

  private normalizeStepsMetricIOS(
    rawData: any,
    config: DeviceFieldMapping['steps'],
    deviceType: string,
  ): NormalizedHealthData['steps'] {
    try {
      const dataArray = this.validator.extractDataArray(rawData, config.dataPath);
      if (!dataArray?.length) return null;

      const isYCDevice =
        deviceType === 'yc' || deviceType === 'android_yc' || deviceType === 'ios_yc';
      const processedData = isYCDevice
        ? DataProcessors.processYCStepsData(dataArray, config)
        : DataProcessors.processRWStepsData(dataArray, config);

      return {
        current: processedData.steps || 0,
        timestamp: Date.now(),
        unit: 'steps' as const,
      };
    } catch {
      return null;
    }
  }

  private normalizeCaloriesMetric(
    rawData: any,
    config: DeviceFieldMapping['steps'],
    deviceType: string,
  ): number | null {
    try {
      const dataArray = this.validator.extractDataArray(rawData, config.dataPath);
      if (!dataArray?.length) return null;

      const isYCDevice =
        deviceType === 'yc' || deviceType === 'android_yc' || deviceType === 'ios_yc';
      const processedData = isYCDevice
        ? DataProcessors.processYCStepsData(dataArray, config)
        : DataProcessors.processRWStepsData(dataArray, config);

      // Validate data consistency: if steps is 0, calories must be 0
      // This ensures data integrity and prevents incorrect calories display
      const steps = processedData.steps || 0;
      const calories = steps === 0 ? 0 : processedData.calories || 0;

      devLog.info('[DataNormalizer] Calories normalized', {
        steps,
        rawCalories: processedData.calories,
        validatedCalories: calories,
        deviceType,
      });

      return calories;
    } catch {
      return null;
    }
  }

  private normalizeDistanceMetric(
    rawData: any,
    config: DeviceFieldMapping['steps'],
    deviceType: string,
  ): number | null {
    try {
      const dataArray = this.validator.extractDataArray(rawData, config.dataPath);
      if (!dataArray?.length) return null;

      const isYCDevice =
        deviceType === 'yc' || deviceType === 'android_yc' || deviceType === 'ios_yc';
      const processedData = isYCDevice
        ? DataProcessors.processYCStepsData(dataArray, config)
        : DataProcessors.processRWStepsData(dataArray, config);

      return processedData.distance || 0;
    } catch {
      return null;
    }
  }

  private normalizeBatteryMetric(
    rawData: any,
    config: DeviceFieldMapping['battery'],
  ): NormalizedHealthData['battery'] {
    try {
      const dataArray = this.validator.extractDataArray(rawData, config.dataPath);
      if (!dataArray?.length) return null;

      let latestBattery = 0;
      let latestTimestamp = 0;

      for (const record of dataArray) {
        const battery = this.validator.extractBestValue(
          record,
          config.valueFields || ['battery', 'batteryLevel', 'batteryPercent'],
        );
        const timestamp = this.validator.extractTimestamp(record, config.timestampFields);

        if (battery > 0 && timestamp > latestTimestamp) {
          latestBattery = battery;
          latestTimestamp = timestamp;
        }
      }

      return latestBattery > 0
        ? {
            current: Math.round(latestBattery),
            timestamp: latestTimestamp || Date.now(),
            unit: '%' as const,
          }
        : null;
    } catch {
      return null;
    }
  }

  private async normalizeSleepMetric(
    rawData: any,
    config: DeviceFieldMapping['sleep'],
  ): Promise<NormalizedHealthData['sleep']> {
    try {
      const dataArray = this.validator.extractDataArray(rawData, config.dataPath);
      if (!dataArray?.length) {
        return this.createEmptySleepData();
      }

      const { getVietnamStartOfDayUTC, getVietnamEndOfDayUTC } = await import('@/utils/date-time');
      const startOfDayUTC = getVietnamStartOfDayUTC();
      const endOfDayUTC = getVietnamEndOfDayUTC();

      const currentDaySleepSessions = dataArray.filter((session: any) => {
        let finalSessionStartMs = this.validator.extractTimestamp(
          session,
          config.timestampFields || ['startTime', 'time', 'timestamp'],
        );

        if (!finalSessionStartMs) {
          const rawTime =
            session.startTime ||
            session.time ||
            session.timestamp ||
            session.startTimeStamp ||
            session.startTimestamp ||
            0;
          finalSessionStartMs =
            rawTime < TIMESTAMP_SECOND_TO_MS_THRESHOLD_SHORT ? rawTime * 1000 : rawTime;
        }

        if (!finalSessionStartMs) return false;

        const sessionDate = new Date(finalSessionStartMs);
        return sessionDate >= startOfDayUTC && sessionDate <= endOfDayUTC;
      });

      if (currentDaySleepSessions.length === 0) {
        return this.createEmptySleepData();
      }

      let totalDeepSleepSeconds = 0;
      let totalLightSleepSeconds = 0;
      let totalRemSleepSeconds = 0;
      let latestEndTime = 0;

      for (const session of currentDaySleepSessions) {
        const deepSleepSeconds =
          this.validator.extractBestValue(session, config.deepSleepFields) ||
          (session.deepSleepMinutes ? session.deepSleepMinutes * 60 : 0);
        const lightSleepSeconds =
          this.validator.extractBestValue(session, config.lightSleepFields) ||
          (session.lightSleepMinutes ? session.lightSleepMinutes * 60 : 0);
        const remSleepSeconds =
          this.validator.extractBestValue(session, config.remSleepFields) ||
          (session.remSleepMinutes ? session.remSleepMinutes * 60 : 0);

        totalDeepSleepSeconds += deepSleepSeconds;
        totalLightSleepSeconds += lightSleepSeconds;
        totalRemSleepSeconds += remSleepSeconds;

        const sessionEndTime = session.endTime || session.startTime || 0;
        if (sessionEndTime > latestEndTime) {
          latestEndTime = sessionEndTime;
        }
      }

      const totalSeconds = totalDeepSleepSeconds + totalLightSleepSeconds + totalRemSleepSeconds;
      const totalMinutes = Math.round(totalSeconds / 60);

      if (totalMinutes > MAX_SLEEP_MINUTES) {
        const ratio = MAX_SLEEP_MINUTES / totalMinutes;
        const cappedDeepSleepMinutes = Math.round((totalDeepSleepSeconds / 60) * ratio);
        const cappedLightSleepMinutes = Math.round((totalLightSleepSeconds / 60) * ratio);
        const cappedRemSleepMinutes = Math.round((totalRemSleepSeconds / 60) * ratio);

        return {
          totalMinutes: MAX_SLEEP_MINUTES,
          deepSleepMinutes: cappedDeepSleepMinutes,
          lightSleepMinutes: cappedLightSleepMinutes,
          remSleepMinutes: cappedRemSleepMinutes,
          totalDeepSleepSeconds,
          totalLightSleepSeconds,
          totalRemSleepSeconds,
          totalSleepSeconds: Math.round(totalSeconds * ratio),
          timestamp: latestEndTime || Date.now(),
          unit: 'minutes' as const,
        };
      }

      if (totalMinutes > 0) {
        return {
          totalMinutes,
          deepSleepMinutes: Math.round(totalDeepSleepSeconds / 60),
          lightSleepMinutes: Math.round(totalLightSleepSeconds / 60),
          remSleepMinutes: Math.round(totalRemSleepSeconds / 60),
          totalSleepSeconds: totalSeconds,
          totalDeepSleepSeconds,
          totalLightSleepSeconds,
          totalRemSleepSeconds,
          timestamp: latestEndTime || Date.now(),
          unit: 'minutes' as const,
        };
      }

      return null;
    } catch (error) {
      devLog.error('❌ DataNormalizer: Error normalizing sleep data:', error);
      return null;
    }
  }

  private createEmptySleepData(): NormalizedHealthData['sleep'] {
    return {
      totalMinutes: 0,
      deepSleepMinutes: 0,
      lightSleepMinutes: 0,
      remSleepMinutes: 0,
      totalSleepSeconds: 0,
      totalDeepSleepSeconds: 0,
      totalLightSleepSeconds: 0,
      totalRemSleepSeconds: 0,
      timestamp: Date.now(),
      unit: 'minutes',
    };
  }

  private normalizeBloodPressureMetric(
    rawData: any,
    config: DeviceFieldMapping['bloodPressure'],
  ): NormalizedHealthData['bloodPressure'] {
    try {
      const dataArray = this.validator.extractDataArray(rawData, config.dataPath);
      if (!dataArray?.length) return null;

      let bestTimestamp = 0;
      let bestSystolic = 0;
      let bestDiastolic = 0;

      for (const record of dataArray) {
        const timestamp = this.validator.extractTimestamp(record, config.timestampFields);
        const systolic = this.validator.extractBestValue(
          record,
          config.systolicFields,
          (value) => value > SYSTOLIC_MIN && value < SYSTOLIC_MAX,
        );
        const diastolic = this.validator.extractBestValue(
          record,
          config.diastolicFields,
          (value) => value > DIASTOLIC_MIN && value < DIASTOLIC_MAX,
        );

        if (systolic > 0 && diastolic > 0 && timestamp > bestTimestamp) {
          bestTimestamp = timestamp;
          bestSystolic = systolic;
          bestDiastolic = diastolic;
        }
      }

      return bestSystolic > 0 && bestDiastolic > 0
        ? {
            systolic: bestSystolic,
            diastolic: bestDiastolic,
            timestamp: bestTimestamp,
            unit: 'mmHg',
          }
        : null;
    } catch {
      return null;
    }
  }

  async normalizeAndSaveHealthData(
    rawData: any,
    deviceType: string,
    platform: 'ios' | 'android' = 'ios',
    deviceId?: number,
    syncToBackend: boolean = true,
    skipReconnect: boolean = false,
    skipToast: boolean = false,
  ): Promise<NormalizedHealthData> {
    try {
      const normalizedData = await this.normalizeHealthData(rawData, deviceType, platform);

      await healthDataPersistence.saveValidHealthData(normalizedData);

      const deviceUuid = this.extractDeviceUuid(rawData, deviceType);
      await this.saveDeviceSpecificData(normalizedData, deviceUuid, deviceType, rawData);

      // Ensure API sync is completed before updating storage/emitting events
      if (syncToBackend && deviceId) {
        try {
          await APISyncService.performAllSyncs(
            normalizedData,
            deviceId,
            deviceUuid,
            skipReconnect,
            skipToast,
          );
        } catch (syncError) {
          devLog.error('❌ DataNormalizer: Backend sync failed:', syncError);
          // Continue to update storage even if backend sync fails
        }
      }

      if (deviceUuid) {
        await storageUpdateService.updateConnectedDeviceStorage(deviceUuid, normalizedData);
      }

      return normalizedData;
    } catch (error) {
      devLog.error('❌ DataNormalizer: Error in normalizeAndSaveHealthData:', error);
      throw error;
    }
  }

  private extractDeviceUuid(rawData: any, deviceType: string): string {
    return (
      rawData?.deviceUuid ||
      rawData?.uuid ||
      rawData?.device_uuid ||
      rawData?.id ||
      `${deviceType}_${Date.now()}`
    );
  }

  private async saveDeviceSpecificData(
    normalizedData: NormalizedHealthData,
    deviceUuid: string,
    _deviceType: string,
    _rawData: any,
  ): Promise<void> {
    try {
      const batteryValue =
        typeof normalizedData.battery === 'object' && normalizedData.battery?.current
          ? normalizedData.battery.current
          : typeof normalizedData.battery === 'number'
          ? normalizedData.battery
          : 0;

      await HealthDataRepository.saveHealthData({
        deviceUuid,
        timestamp: normalizedData.lastSync || new Date().toISOString(),
        steps: normalizedData.steps?.current || 0,
        calories: normalizedData.calories || 0,
        heartRate: normalizedData.heartRate?.current || 0,
        spo2: normalizedData.spo2?.current || 0,
        distance: normalizedData.distance || 0,
        battery: batteryValue,
      });
    } catch (deviceDataError) {
      devLog.error('❌ DataNormalizer: Failed to save via HealthDataRepository:', deviceDataError);
    }
  }
}

export const dataNormalizer = DataNormalizerService.getInstance();
export default dataNormalizer;
