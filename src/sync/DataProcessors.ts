/**
 * 🎯 Data Processors - Consolidated
 * All platform-specific data processing logic
 */

import { Platform } from 'react-native';
import { devLog } from '@/utils/loggingHelper';
import { DataAggregator } from '../utils';
import { HealthCalculator } from './HealthCalculator';
import { getVietnamStartOfDayUTC, getVietnamEndOfDayUTC } from '@/utils/date-time';
import type { DeviceFieldMapping } from './types';

// ==================== Types ====================

interface StepsResult {
  steps: number;
  calories: number;
  distance: number;
}

interface CaloriesResult {
  calories: number;
}

interface ProcessorConfig {
  [key: string]: any;
}

// ==================== Platform Utils ====================

export class PlatformUtils {
  static isIOS(): boolean {
    return Platform.OS === 'ios';
  }

  static isAndroid(): boolean {
    return Platform.OS === 'android';
  }

  static getFieldValue(data: any, iosField: string, androidField: string): any {
    return this.isIOS() ? data?.[iosField] : data?.[androidField];
  }

  static selectField<T>(iosValue: T, androidValue: T): T {
    return this.isIOS() ? iosValue : androidValue;
  }

  static roundValue(value: any): number {
    const num = Number(value);
    return isNaN(num) ? 0 : Math.round(num);
  }

  static sumArray(arr: any[], key: string): number {
    if (!Array.isArray(arr)) return 0;
    return arr.reduce((sum, item) => {
      const val = Number(item?.[key]);
      return sum + (isNaN(val) ? 0 : val);
    }, 0);
  }

  static maxValue(...values: any[]): number {
    const nums = values.map(Number).filter((n) => !isNaN(n) && isFinite(n));
    return nums.length > 0 ? Math.max(...nums) : 0;
  }

  static avgValue(...values: any[]): number {
    const nums = values.map(Number).filter((n) => !isNaN(n) && isFinite(n));
    return nums.length > 0 ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
  }

  // Advanced methods for step processing
  static extractCombinedData(dataArray: any[]): any[] {
    return dataArray.filter((record) => record.combinedData === true || record.isCombined === true);
  }

  static filterStepRecords(dataArray: any[]): any[] {
    return dataArray.filter((record) => {
      const hasSteps = !!(record.step || record.steps || record.sportStep || record.value);
      const hasOnlySteps = !this.hasHealthMetrics(record);
      return hasSteps && hasOnlySteps;
    });
  }

  static hasHealthMetrics(record: any): boolean {
    return !!(
      record.heartValue > 0 ||
      record.heartRate > 0 ||
      record.heart_rate > 0 ||
      record.OOValue > 0 ||
      record.spo2 > 0 ||
      record.bloodOxygen > 0 ||
      record.SBPValue > 0 ||
      record.DBPValue > 0 ||
      record.systolic > 0 ||
      record.diastolic > 0 ||
      record.tempFloatValue > 0 ||
      record.temperature > 0 ||
      record.respiratoryRateValue > 0 ||
      record.respirationRate > 0
    );
  }

  static extractTimestamp(record: any): number {
    const timeFields = [
      'sportStartTime',
      'startTime',
      'time',
      'timestamp',
      'sportEndTime',
      'endTime',
      'endTimestamp',
    ];

    for (const field of timeFields) {
      const value = record[field];
      if (value) {
        const ms = this.toMilliseconds(value);
        if (ms > 0) return ms;
      }
    }
    return 0;
  }

  static extractSteps(record: any): number {
    return this.roundValue(
      record.sportStep || record.step || record.steps || record.value || record.stepValue || 0,
    );
  }

  static toMilliseconds(value: any): number {
    if (typeof value === 'number') {
      return value < 10000000000 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  static isWithinCurrentDayGMT7(timestampMs: number): boolean {
    if (!timestampMs) return false;
    const startOfDay = getVietnamStartOfDayUTC();
    const endOfDay = getVietnamEndOfDayUTC();
    const date = new Date(timestampMs);
    return date >= startOfDay && date <= endOfDay;
  }
}

// ==================== iOS Steps Processor ====================

class IOSStepsProcessor {
  private calculator: HealthCalculator;

  constructor() {
    this.calculator = new HealthCalculator();
  }

  process(dataArray: any[], _config?: ProcessorConfig): StepsResult {
    try {
      if (!Array.isArray(dataArray) || dataArray.length === 0) {
        devLog.warn('🚶 [IOSStepsProcessor] No data array', { length: dataArray?.length });
        return { steps: 0, calories: 0, distance: 0 };
      }

      // Only use step records, filter by current day
      const stepRecords = PlatformUtils.filterStepRecords(dataArray);

      devLog.info('🚶 [IOSStepsProcessor] Filtered step records', {
        totalRecords: dataArray.length,
        stepRecordsCount: stepRecords.length,
      });

      if (stepRecords.length === 0) {
        devLog.warn('🚶 [IOSStepsProcessor] No step records after filter');
        return { steps: 0, calories: 0, distance: 0 };
      }

      // Sum steps, calories, distance for current day only
      let totalSteps = 0;
      let totalCalories = 0;
      let totalDistance = 0;
      let recordsInCurrentDay = 0;

      for (const record of stepRecords) {
        const time = PlatformUtils.extractTimestamp(record);

        if (PlatformUtils.isWithinCurrentDayGMT7(time)) {
          recordsInCurrentDay++;
          totalSteps += PlatformUtils.extractSteps(record);
          totalCalories += PlatformUtils.roundValue(
            record.calories || record.sportCalorie || record.cal || 0,
          );
          totalDistance += PlatformUtils.roundValue(record.distance || record.sportDistance || 0);
        }
      }

      devLog.info('🚶 [IOSStepsProcessor] Current day filter result', {
        stepRecordsCount: stepRecords.length,
        recordsInCurrentDay,
        totalSteps,
        totalCalories,
        totalDistance,
      });

      // If no calories data, calculate from steps
      let calories =
        totalCalories > 0 ? totalCalories : this.calculator.calculateCaloriesFromSteps(totalSteps);

      // Validate data consistency: if steps is 0, calories must be 0
      // This ensures data integrity even if device returns inconsistent data
      if (totalSteps === 0) {
        calories = 0;
        devLog.warn('🚶 [IOSStepsProcessor] Steps is 0 but calories > 0 - forcing calories to 0', {
          totalSteps,
          totalCalories,
          validatedCalories: calories,
        });
      }

      const distance =
        totalDistance > 0 ? totalDistance : this.calculator.calculateDistanceFromSteps(totalSteps);

      return { steps: totalSteps, calories, distance };
    } catch (error) {
      devLog.error('❌ [IOSStepsProcessor] Error:', error);
      return { steps: 0, calories: 0, distance: 0 };
    }
  }
}

// ==================== iOS Calories Processor ====================

class IOSCaloriesProcessor {
  private calculator: HealthCalculator;

  constructor() {
    this.calculator = new HealthCalculator();
  }

  process(dataArray: any[], _config?: ProcessorConfig): CaloriesResult {
    try {
      if (!Array.isArray(dataArray) || dataArray.length === 0) {
        return { calories: 0 };
      }

      // Only use step records, filter by current day
      const calorieRecords = PlatformUtils.filterStepRecords(dataArray);

      if (calorieRecords.length === 0) {
        return { calories: 0 };
      }

      // Sum calories for current day only
      let totalCalories = 0;

      for (const record of calorieRecords) {
        const calories = PlatformUtils.roundValue(
          record.calories || record.sportCalorie || record.cal || 0,
        );
        const time = PlatformUtils.extractTimestamp(record);

        if (PlatformUtils.isWithinCurrentDayGMT7(time)) {
          totalCalories += calories;
        }
      }

      return { calories: totalCalories };
    } catch (error) {
      devLog.error('❌ [IOSCaloriesProcessor] Error:', error);
      return { calories: 0 };
    }
  }
}

// ==================== Main Processor Orchestrator ====================

export class DataProcessors {
  private static iosStepsProcessor = new IOSStepsProcessor();
  private static iosCaloriesProcessor = new IOSCaloriesProcessor();

  /**
   * YC/RW specific step processing
   */
  static processYCStepsData(dataArray: any[], _config?: DeviceFieldMapping['steps']): StepsResult {
    return this.iosStepsProcessor.process(dataArray, _config);
  }

  static processRWStepsData(dataArray: any[], _config?: DeviceFieldMapping['steps']): StepsResult {
    return this.iosStepsProcessor.process(dataArray, _config);
  }

  /**
   * YC/RW specific calorie processing
   */
  static processYCCaloriesData(
    dataArray: any[],
    _config?: DeviceFieldMapping['steps'],
  ): CaloriesResult {
    return this.iosCaloriesProcessor.process(dataArray, _config);
  }

  static processRWCaloriesData(
    dataArray: any[],
    _config?: DeviceFieldMapping['steps'],
  ): CaloriesResult {
    return this.iosCaloriesProcessor.process(dataArray, _config);
  }

  /**
   * Process steps data - platform-agnostic
   */
  static processSteps(rawData: any, latestSteps?: number): any {
    if (PlatformUtils.isIOS()) {
      const steps = rawData?.steps || rawData?.step || [];
      if (!Array.isArray(steps) || steps.length === 0) {
        return {
          current: latestSteps || 0,
          total: latestSteps || 0,
        };
      }

      const processedSteps = steps.map((step: any) => ({
        sportStartTime: step.sportStartTime || step.startTime,
        sportEndTime: step.sportEndTime || step.endTime,
        sportStep: PlatformUtils.roundValue(
          step.sportStep || step.step || step.steps || step.value,
        ),
        sportCalorie: PlatformUtils.roundValue(step.sportCalorie || step.calories || step.cal),
        sportDistance: PlatformUtils.roundValue(step.sportDistance || step.distance),
      }));

      const totalSteps = PlatformUtils.sumArray(processedSteps, 'sportStep');
      const currentSteps = PlatformUtils.maxValue(totalSteps, latestSteps);

      return {
        current: currentSteps,
        total: totalSteps,
      };
    }

    // Android fallback
    const steps = rawData?.steps || rawData?.step || rawData?.value || latestSteps || 0;
    return {
      current: PlatformUtils.roundValue(steps),
      total: PlatformUtils.roundValue(steps),
    };
  }

  /**
   * Process calories data - platform-agnostic
   */
  static processCalories(rawData: any, latestCalories?: number): any {
    if (PlatformUtils.isIOS()) {
      const stepsData = rawData?.steps || rawData?.step || [];
      const caloriesData = rawData?.calories || [];

      if (!Array.isArray(stepsData) && !Array.isArray(caloriesData)) {
        return {
          fullCaloriesData: [],
          current: latestCalories || 0,
          total: latestCalories || 0,
        };
      }

      let processedCalories: any[] = [];
      let totalCalories = 0;

      if (Array.isArray(stepsData) && stepsData.length > 0) {
        processedCalories = stepsData.map((step: any) => ({
          startTime: step.sportStartTime || step.startTime,
          endTime: step.sportEndTime || step.endTime,
          calories: PlatformUtils.roundValue(step.sportCalorie || step.calories || step.cal),
          steps: PlatformUtils.roundValue(step.sportStep || step.step || step.steps),
          distance: PlatformUtils.roundValue(step.sportDistance || step.distance),
        }));
        totalCalories = PlatformUtils.sumArray(processedCalories, 'calories');
      }

      if (Array.isArray(caloriesData) && caloriesData.length > 0) {
        const explicitCalories = caloriesData.map((cal: any) => ({
          startTime: cal.startTime || cal.time,
          endTime: cal.endTime,
          calories: PlatformUtils.roundValue(cal.calories || cal.value || cal.cal),
          steps: PlatformUtils.roundValue(cal.steps || cal.step),
          distance: PlatformUtils.roundValue(cal.distance),
        }));
        const explicitTotal = PlatformUtils.sumArray(explicitCalories, 'calories');

        if (explicitTotal > totalCalories) {
          processedCalories = explicitCalories;
          totalCalories = explicitTotal;
        }
      }

      const currentCalories = PlatformUtils.maxValue(totalCalories, latestCalories);

      return {
        fullCaloriesData: processedCalories,
        current: currentCalories,
        total: totalCalories,
      };
    }

    // Android fallback
    const calories = rawData?.calories || rawData?.cal || rawData?.value || latestCalories || 0;
    return {
      fullCaloriesData: [],
      current: PlatformUtils.roundValue(calories),
      total: PlatformUtils.roundValue(calories),
    };
  }

  /**
   * Process heart rate data
   */
  static processHeartRate(rawData: any, latestHeartRate?: number): any {
    try {
      const heartRateArray = rawData?.heartRate || rawData?.heart_rate || [];

      if (!Array.isArray(heartRateArray) || heartRateArray.length === 0) {
        const singleValue =
          rawData?.heartRate || rawData?.heart_rate || rawData?.heartValue || latestHeartRate;
        return {
          current: PlatformUtils.roundValue(singleValue),
        };
      }

      const processedData = heartRateArray.map((hr: any) => ({
        heartStartTime: hr.heartStartTime || hr.startTime || hr.time || hr.timestamp,
        heartValue: PlatformUtils.roundValue(
          hr.heartValue || hr.value || hr.heartRate || hr.heart_rate,
        ),
      }));

      const avgHeartRate = PlatformUtils.avgValue(...processedData.map((d: any) => d.heartValue));
      const currentHeartRate = PlatformUtils.maxValue(avgHeartRate, latestHeartRate);

      return {
        current: currentHeartRate,
        average: avgHeartRate,
      };
    } catch (error) {
      devLog.error('❌ [DataProcessors] processHeartRate error:', error);
      return {
        current: latestHeartRate || 0,
      };
    }
  }

  /**
   * Process sleep data
   */
  static processSleep(rawData: any, latestSleep?: number): any {
    try {
      const sleepArray = rawData?.sleep || rawData?.sleepData || [];

      if (!Array.isArray(sleepArray) || sleepArray.length === 0) {
        return {
          totalMinutes: latestSleep || 0,
          current: latestSleep || 0,
        };
      }

      const processedData = sleepArray.map((sleep: any) => {
        const deepMin = Math.round((sleep.deepSleepTotal || sleep.deepSleepMinutes || 0) / 60);
        const lightMin = Math.round((sleep.lightSleepTotal || sleep.lightSleepMinutes || 0) / 60);
        const remMin = Math.round((sleep.remSleepTotal || sleep.remSleepMinutes || 0) / 60);
        const totalMin = deepMin + lightMin + remMin;

        return {
          startTime: sleep.startTime || sleep.sleepStartTime,
          endTime: sleep.endTime || sleep.sleepEndTime,
          deepSleepMinutes: deepMin,
          lightSleepMinutes: lightMin,
          remSleepMinutes: remMin,
          totalMinutes: totalMin,
          sleepData: sleep.sleepData || sleep.sleepDetails || [],
        };
      });

      const totalMinutes = PlatformUtils.sumArray(processedData, 'totalMinutes');

      return {
        totalMinutes,
        current: totalMinutes,
      };
    } catch (error) {
      devLog.error('❌ [DataProcessors] processSleep error:', error);
      return {
        totalMinutes: latestSleep || 0,
        current: latestSleep || 0,
      };
    }
  }

  /**
   * Process SpO2 data
   */
  static processSpO2(rawData: any, latestSpO2?: number): any {
    const spo2 = rawData?.spo2 || rawData?.bloodOxygen || rawData?.OOValue || latestSpO2 || 0;
    return {
      current: PlatformUtils.roundValue(spo2),
    };
  }

  /**
   * Process temperature data
   */
  static processTemperature(rawData: any, latestTemp?: number): any {
    const temp =
      rawData?.temperature ||
      rawData?.tempFloatValue ||
      rawData?.body_temperature ||
      latestTemp ||
      0;
    return {
      current: Number(temp).toFixed(1),
    };
  }

  /**
   * Process blood pressure data
   */
  static processBloodPressure(rawData: any, latestBP?: any): any {
    const systolic = PlatformUtils.roundValue(
      rawData?.systolic || rawData?.SBPValue || latestBP?.systolic || 0,
    );
    const diastolic = PlatformUtils.roundValue(
      rawData?.diastolic || rawData?.DBPValue || latestBP?.diastolic || 0,
    );

    return {    
      systolic,
      diastolic,
    };
  }

  /**
   * Process battery data
   */
  static processBattery(rawData: any, latestBattery?: number): any {
    const battery = rawData?.battery || rawData?.batteryLevel || latestBattery || 0;
    return {
      current: PlatformUtils.roundValue(battery),
    };
  }

  /**
   * Process distance data
   */
  static processDistance(rawData: any): number {
    const walking = rawData?.walking_distance || 0;
    const running = rawData?.running_distance || 0;
    const cycling = rawData?.cycling_distance || 0;
    const total = rawData?.distance || walking + running + cycling;
    return PlatformUtils.roundValue(total);
  }
}
