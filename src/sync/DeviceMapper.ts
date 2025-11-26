import { Platform } from 'react-native';
import { devLog } from '@/utils/loggingHelper';
import { DeviceFieldMapping, PLATFORM_ADJUSTMENTS, PlatformAdjustment } from './types';
import { DEVICE_MAPPINGS } from './mappings';

export class DeviceMapper {
  getDeviceMapping(deviceType: string): DeviceFieldMapping {
    const normalizedType = this.normalizeDeviceType(deviceType);

    if (Platform.OS === 'android') {
      const androidMapping = `android_${normalizedType}`;
      if (DEVICE_MAPPINGS[androidMapping]) {
        return DEVICE_MAPPINGS[androidMapping];
      }
      if (DEVICE_MAPPINGS[normalizedType]) {
        return DEVICE_MAPPINGS[normalizedType];
      }
    } else if (Platform.OS === 'ios') {
      const iosMapping = `ios_${normalizedType}`;
      if (DEVICE_MAPPINGS[iosMapping]) {
        return DEVICE_MAPPINGS[iosMapping];
      }
      if (DEVICE_MAPPINGS[normalizedType]) {
        return DEVICE_MAPPINGS[normalizedType];
      }
    }

    if (DEVICE_MAPPINGS[normalizedType]) {
      return DEVICE_MAPPINGS[normalizedType];
    }

    devLog.warn('🔍 getDeviceMapping - Using default mapping for:', normalizedType);
    return DEVICE_MAPPINGS.default || DEVICE_MAPPINGS.yc;
  }

  private normalizeDeviceType(deviceType: string): string {
    if (!deviceType) return 'yc';

    const normalized = deviceType.toLowerCase().trim();

    const typeMap: { [key: string]: string } = {
      yc: 'yc',
      yichuang: 'yc',
      yucheng: 'yc',
      vita: 'yc',
      rw: 'rw',
      ringtech: 'rw',
      ring: 'rw',
    };

    return typeMap[normalized] || normalized;
  }

  applyPlatformAdjustments(
    mapping: DeviceFieldMapping,
    platform: 'ios' | 'android',
  ): DeviceFieldMapping {
    if (!PLATFORM_ADJUSTMENTS[platform]) return mapping;

    const adjustments = PLATFORM_ADJUSTMENTS[platform];
    const adjustedMapping: DeviceFieldMapping = { ...mapping };

    const metricKeys = Object.keys(adjustments) as Array<keyof PlatformAdjustment>;
    metricKeys.forEach((metric) => {
      const adj = adjustments[metric];
      const key = metric as keyof DeviceFieldMapping;
      if (adj && adjustedMapping[key]) {
        adjustedMapping[key] = {
          ...(adjustedMapping[key] as any),
          ...adj,
        } as any;
      }
    });

    return adjustedMapping;
  }

  getAvailableDeviceTypes(): string[] {
    return Object.keys(DEVICE_MAPPINGS).filter(
      (key) => !key.startsWith('android_') && !key.startsWith('ios_') && key !== 'default',
    );
  }

  isDeviceTypeSupported(deviceType: string): boolean {
    const normalizedType = this.normalizeDeviceType(deviceType);
    return (
      !!DEVICE_MAPPINGS[normalizedType] ||
      !!DEVICE_MAPPINGS[`android_${normalizedType}`] ||
      !!DEVICE_MAPPINGS[`ios_${normalizedType}`]
    );
  }
}
