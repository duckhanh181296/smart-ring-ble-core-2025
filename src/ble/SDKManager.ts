import { Platform, NativeModules } from 'react-native';
import { devLog } from '@/utils/loggingHelper';
import { StorageServiceManager, STORAGE_KEYS } from '@/services/StorageService';
import { BluetoothStateManager } from 'react-native-bluetooth-state-manager';
import { isBluetoothEnabled } from './BluetoothManager';

const { RWRingManager, YCRingManager } = NativeModules as any;
const SDK_CONFIG = {
  STORAGE_KEY: STORAGE_KEYS.DEVICE_SDK_INITIALIZED,
  INIT_TIMEOUT_MS: 50000,
} as const;

// Bluetooth state constants
const BLUETOOTH_STATE = {
  POWERED_ON: 'PoweredOn',
  POWERED_OFF: 'PoweredOff',
  UNAUTHORIZED: 'Unauthorized',
  UNKNOWN: 'Unknown',
} as const;

// Prevent multiple initializations
let _isInitializing = false;
let _initializationPromise: Promise<void> | null = null;
let _ycSDKInitialized = false; // Track YC SDK initialization in memory

/**
 * Checks Bluetooth permission/state before initializing SDK
 * Prevents automatic permission dialogs from appearing
 * @returns true if SDK can be safely initialized, false otherwise
 */
const checkBluetoothPermissionBeforeInit = async (): Promise<boolean> => {
  try {
    if (Platform.OS === 'android') {
      // On Android, check if Bluetooth is enabled
      const bluetoothEnabled = await isBluetoothEnabled();
      if (!bluetoothEnabled) {
        devLog.warn('⚠️ [SDKManager] Bluetooth not enabled, skipping SDK initialization to prevent permission dialog');
        return false;
      }
      return true;
    }

    if (Platform.OS === 'ios') {
      // On iOS, check Bluetooth state to ensure permission is granted
      // Use same robust logic as useBluetoothPermission to handle Unknown states
      try {
        let bluetoothState = await BluetoothStateManager.getState();
        devLog.info(`[SDKManager] iOS Bluetooth state (initial): ${bluetoothState}`);

        // Handle null state - wait and recheck (iOS can return null initially)
        if (!bluetoothState) {
          devLog.info('[SDKManager] iOS: Initial state is null, waiting and rechecking...');
          await new Promise((resolve) => setTimeout(resolve, 2000));
          bluetoothState = await BluetoothStateManager.getState();
          devLog.info(`[SDKManager] iOS: Bluetooth state after null wait: ${bluetoothState}`);
          
          if (!bluetoothState) {
            devLog.warn('⚠️ [SDKManager] iOS: Bluetooth state still null after wait, skipping SDK initialization');
            return false;
          }
        }

        // Only allow initialization if Bluetooth is powered on (permission granted)
        if (bluetoothState === BLUETOOTH_STATE.POWERED_ON) {
          devLog.info('[SDKManager] iOS: Bluetooth is PoweredOn, allowing SDK initialization');
          return true;
        }

        // If state is Unauthorized, user hasn't granted permission yet
        if (bluetoothState === BLUETOOTH_STATE.UNAUTHORIZED) {
          devLog.warn('⚠️ [SDKManager] Bluetooth permission not granted (Unauthorized), skipping SDK initialization to prevent automatic permission dialog');
          return false;
        }

        // If Bluetooth is off, don't initialize (will trigger permission dialog)
        if (bluetoothState === BLUETOOTH_STATE.POWERED_OFF) {
          devLog.warn('⚠️ [SDKManager] Bluetooth is powered off, skipping SDK initialization to prevent permission dialog');
          return false;
        }

        // If state is Unknown, wait multiple times and recheck (iOS sometimes returns Unknown when Bluetooth is actually on)
        if (bluetoothState === BLUETOOTH_STATE.UNKNOWN) {
          devLog.info('⚠️ [SDKManager] Bluetooth state is Unknown, waiting and rechecking (first attempt)...');
          await new Promise((resolve) => setTimeout(resolve, 2000));
          let stateAfterWait = await BluetoothStateManager.getState();
          devLog.info(`[SDKManager] iOS: State after first wait: ${stateAfterWait}`);

          if (stateAfterWait === BLUETOOTH_STATE.POWERED_ON) {
            devLog.info('[SDKManager] iOS: Bluetooth is PoweredOn after first wait, allowing SDK initialization');
            return true;
          }

          // If still Unknown or null, wait one more time (iOS can be slow to update state)
          if (!stateAfterWait || stateAfterWait === BLUETOOTH_STATE.UNKNOWN) {
            devLog.info('[SDKManager] iOS: State still Unknown/null, waiting again (second attempt)...');
            await new Promise((resolve) => setTimeout(resolve, 2000));
            stateAfterWait = await BluetoothStateManager.getState();
            devLog.info(`[SDKManager] iOS: State after second wait: ${stateAfterWait}`);

            if (stateAfterWait === BLUETOOTH_STATE.POWERED_ON) {
              devLog.info('[SDKManager] iOS: Bluetooth is PoweredOn after second wait, allowing SDK initialization');
              return true;
            }
          }

          // If state is PoweredOff or Unauthorized after waits, deny initialization
          if (stateAfterWait === BLUETOOTH_STATE.POWERED_OFF || stateAfterWait === BLUETOOTH_STATE.UNAUTHORIZED) {
            devLog.warn(`⚠️ [SDKManager] iOS: Bluetooth state is ${stateAfterWait} after waits - permission not granted or Bluetooth is off, skipping SDK initialization`);
            return false;
          }

          // Still Unknown or null after multiple waits - deny initialization
          devLog.warn(`⚠️ [SDKManager] iOS: Bluetooth state still unclear after waits: ${stateAfterWait}, skipping SDK initialization`);
          return false;
        }

        // Default: don't initialize if state is unclear
        devLog.warn(`⚠️ [SDKManager] Unknown Bluetooth state: ${bluetoothState}, skipping SDK initialization`);
        return false;
      } catch (error) {
        devLog.error('❌ [SDKManager] Error checking iOS Bluetooth state:', error);
        return false;
      }
    }

    // Default: allow initialization for other platforms
    return true;
  } catch (error) {
    devLog.error('❌ [SDKManager] Error in checkBluetoothPermissionBeforeInit:', error);
    return false;
  }
};

export const ensureSDKsInitialized = async (): Promise<void> => {
  try {
    // If already initializing, wait for the existing initialization
    if (_isInitializing && _initializationPromise) {
      await _initializationPromise;
      return;
    }

    // Check if already initialized from storage and memory for Android
    const isInitialized = StorageServiceManager.getString(SDK_CONFIG.STORAGE_KEY) === 'true';
    if (isInitialized && (Platform.OS !== 'android' || _ycSDKInitialized)) {
      devLog.info('🔧 [SDKManager] SDKs already initialized, skipping');
      return;
    }

    await initializeDeviceSDKs();
    devLog.info('✅ [SDKManager] SDKs initialization completed');
  } catch (error) {
    devLog.warn('⚠️ [SDKManager] Error ensuring SDK initialization:', error);
  }
};
export const initializeDeviceSDKs = async (): Promise<void> => {
  // Check if already initialized in this session
  if (_ycSDKInitialized && Platform.OS === 'android') {
    devLog.info('🔧 Android SDKs already initialized in this session, skipping');
    return;
  }

  if (_isInitializing) {
    devLog.info('🔄 SDK initialization already in progress, waiting...');
    if (_initializationPromise) {
      await _initializationPromise;
    }
    return;
  }

  _isInitializing = true;

  try {
    _initializationPromise = (async () => {
      // Check if we've already initialized successfully
      const alreadyInitialized = StorageServiceManager.getString(SDK_CONFIG.STORAGE_KEY) === 'true';
      if (alreadyInitialized && _ycSDKInitialized) {
        devLog.info('🔧 SDKs already initialized based on storage and session, skipping');
        return;
      }

      devLog.info('🚀 Starting device SDK initialization...');

      // Check Bluetooth permission before initializing any SDK
      const hasPermission = await checkBluetoothPermissionBeforeInit();
      if (!hasPermission) {
        devLog.warn('⚠️ [SDKManager] Bluetooth permission check failed, skipping SDK initialization to prevent automatic permission dialog');
        // Don't mark as initialized if permission check fails
        return;
      }

      // Initialize SDK based on platform
      if (Platform.OS === 'ios') {
        // Initialize RW SDK for iOS
        const rwResult = await initializeRWSDK();
        if (rwResult && rwResult.success) {
          devLog.info('✅ iOS RW SDK initialized');
          StorageServiceManager.setString(SDK_CONFIG.STORAGE_KEY, 'true');
          devLog.info('🎉 iOS SDK initialization completed');
        } else {
          devLog.warn('⚠️ iOS RW SDK initialization issue');
        }
      } else if (Platform.OS === 'android') {
        // Initialize YC SDK for Android
        const ycResult = await initializeYCSDK();
        if (ycResult && ycResult.success && _ycSDKInitialized) {
          devLog.info('✅ Android YC SDK initialized');
          StorageServiceManager.setString(SDK_CONFIG.STORAGE_KEY, 'true');
          devLog.info('🎉 Android SDK initialization completed');
        } else {
          devLog.warn('⚠️ Android YC SDK initialization issue');
        }
      }
    })();

    await _initializationPromise;
  } catch (error) {
    devLog.error('❌ SDK initialization failed:', error);
    throw error;
  } finally {
    _isInitializing = false;
    _initializationPromise = null;
  }
};

/**
 * Initialize RW SDK (iOS only)
 * Only called after Bluetooth permission check passes
 */
const initializeRWSDK = async (): Promise<any> => {
  try {
    if (Platform.OS !== 'ios') {
      devLog.warn('⚠️ [SDKManager] initializeRWSDK called on non-iOS platform');
      return {
        success: false,
        platform: Platform.OS,
        sdkType: 'RW',
        error: 'iOS only',
      };
    }

    devLog.info('🔧 Initializing RW SDK...');
    const result = await RWRingManager.initSDK();
    if (result) {
      devLog.info('✅ RW SDK initialized successfully');
      return {
        success: true,
        platform: Platform.OS,
        sdkType: 'RW',
        result,
      };
    } else {
      devLog.warn('⚠️ RW SDK returned false/null but may still work');
      return {
        success: true,
        platform: Platform.OS,
        sdkType: 'RW',
        note: 'RW SDK returned false/null but may still work',
      };
    }
  } catch (error) {
    devLog.error('❌ RW SDK initialization failed:', error);
    return {
      success: false,
      platform: Platform.OS,
      sdkType: 'RW',
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Initialize YC SDK (Android only)
 * Only called after Bluetooth permission check passes
 */
const initializeYCSDK = async (): Promise<any> => {
  // Check if already initialized in this session
  if (_ycSDKInitialized) {
    devLog.info('🔧 YC SDK already initialized in this session, skipping');
    return {
      success: true,
      platform: Platform.OS,
      sdkType: 'YC',
      note: 'Already initialized in session',
    };
  }

  try {
    // Permission check is already done in initializeDeviceSDKs before calling this function
    // No need to check again here

    devLog.info('🔧 Initializing YC SDK...');
    const result = await YCRingManager.initSDK();
    if (result) {
      devLog.info('✅ YC SDK initialized successfully');
      _ycSDKInitialized = true; // Mark as initialized
      return {
        success: true,
        platform: Platform.OS,
        sdkType: 'YC',
        result,
      };
    } else {
      devLog.warn('⚠️ YC SDK returned false/null but may still work');
      _ycSDKInitialized = true; // Still mark as initialized to prevent retries
      return {
        success: true,
        platform: Platform.OS,
        sdkType: 'YC',
        note: 'YC SDK returned false/null but may still work',
      };
    }
  } catch (error) {
    devLog.error('❌ YC SDK initialization failed:', error);
    return null;
  }
};
export const initSDK = async (): Promise<boolean> => {
  if (Platform.OS === 'android') {
    try {
      const result = await RWRingManager.initSDK();
      return !!result;
    } catch (error) {
      return false;
    }
  } else {
    return true;
  }
};

