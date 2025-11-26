import { Platform } from 'react-native';
import { BluetoothStateManager } from 'react-native-bluetooth-state-manager';
import { devLog } from '@/utils/loggingHelper';
import { showBluetoothSettingsDialog } from '@/hooks/useBluetoothPermission';

// ============================================================================
// Constants
// ============================================================================

const REQUEST_ENABLE_COOLDOWN_MS = 30 * 1000; // 30 seconds cooldown between requests
const BLUETOOTH_STATE_STABLE_MAX_RETRIES = 8;
const BLUETOOTH_STATE_STABLE_RETRY_DELAY_MS = 1500;
const BLUETOOTH_STATE_STABLE_MIN_RETRIES_FOR_POWERED_OFF = 3;
const BLUETOOTH_RECHECK_DELAY_MS = 2000;

// ============================================================================
// State Variables
// ============================================================================

let bluetoothEnabled = false;
let bluetoothStateListener: any = null;
let isCheckingBluetooth = false;
let bluetoothCheckPromise: Promise<boolean> | null = null;
let lastRequestEnableTime: number = 0;

// ============================================================================
// Helper Functions - Cooldown Management
// ============================================================================

/**
 * Checks if we're still in cooldown period for Bluetooth enable requests
 * @returns true if in cooldown, false otherwise
 */
const isInCooldownPeriod = (): boolean => {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestEnableTime;
  return timeSinceLastRequest < REQUEST_ENABLE_COOLDOWN_MS;
};

/**
 * Gets cooldown information for logging
 */
const getCooldownInfo = () => {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestEnableTime;
  return {
    timeSinceLastRequest: `${Math.round(timeSinceLastRequest / 1000)}s`,
    cooldownRemaining: `${Math.round((REQUEST_ENABLE_COOLDOWN_MS - timeSinceLastRequest) / 1000)}s`,
  };
};

/**
 * Resets the cooldown timer (called when Bluetooth is successfully enabled)
 */
const resetBluetoothDialogCooldown = (): void => {
  lastRequestEnableTime = 0;
};

// ============================================================================
// Helper Functions - State Checking
// ============================================================================

/**
 * Checks Bluetooth state without updating cached value
 * Note: On Android, getState() may trigger permission dialog if permissions are not granted
 */
export const getBluetoothStateRaw = async (): Promise<string | null> => {
  try {
    if (!BluetoothStateManager || typeof BluetoothStateManager.getState !== 'function') {
      devLog.warn('[BluetoothManager] BluetoothStateManager.getState is not available');
      return null;
    }
    
    // On Android, check permissions first to avoid automatic permission dialog
    if (Platform.OS === 'android') {
      try {
        const { checkBlePermissions } = await import('@/hooks/blePermission');
        const hasPermissions = await checkBlePermissions();
        if (!hasPermissions) {
          devLog.warn('[BluetoothManager] Bluetooth permissions not granted, skipping getState() to avoid auto permission dialog');
          return null;
        }
      } catch (permError) {
        devLog.warn('[BluetoothManager] Error checking permissions before getState():', permError);
        // Continue anyway, but log the warning
      }
    }
    
    devLog.info('[BluetoothManager] Calling BluetoothStateManager.getState()');
    const state = await BluetoothStateManager.getState();
    devLog.info('[BluetoothManager] BluetoothStateManager.getState() returned', { state });
    return state;
  } catch (error) {
    devLog.error('[BluetoothManager] State check failed:', error);
    return null;
  }
};

/**
 * Updates the cached Bluetooth enabled state
 */
const updateBluetoothEnabledState = (enabled: boolean): void => {
  bluetoothEnabled = enabled;
};

/**
 * Checks Bluetooth state and updates cache
 * NOTE: This function only checks state, it does NOT request Bluetooth enable
 */
const checkBluetoothState = async (): Promise<void> => {
  try {
    devLog.info('[BluetoothManager] checkBluetoothState called');
    const state = await getBluetoothStateRaw();
    const isEnabled = state === 'PoweredOn';
    devLog.info('[BluetoothManager] Bluetooth state check result', { state, isEnabled });
    updateBluetoothEnabledState(isEnabled);
    
    // If Bluetooth is off, ensure cache is updated immediately
    // This prevents subsequent checks from triggering enable requests
    if (!isEnabled && state === 'PoweredOff') {
      devLog.info('[BluetoothManager] Bluetooth is off - cache updated, no automatic enable request');
    }
  } catch (error) {
    devLog.error('[BluetoothManager] State check failed:', error);
    updateBluetoothEnabledState(false);
  }
};

/**
 * Checks Bluetooth state only (doesn't update cache) - internal helper
 */
const checkBluetoothStateOnlyInternal = async (): Promise<boolean> => {
  const state = await getBluetoothStateRaw();
  return state === 'PoweredOn';
};

// ============================================================================
// Platform-Specific Functions - Android
// ============================================================================

/**
 * Requests Bluetooth enable on Android with cooldown protection
 */
const requestBtPermissionsAndroid = async (): Promise<void> => {
  try {
    devLog.info('[BluetoothManager] requestBtPermissionsAndroid called');
    
    if (Platform.OS !== 'android') {
      devLog.info('[BluetoothManager] Not Android, skipping');
      return;
    }

    devLog.info('[BluetoothManager] Checking current Bluetooth state');
    const currentState = await getBluetoothStateRaw();
    if (currentState === 'PoweredOn') {
      devLog.info('[BluetoothManager] Bluetooth already PoweredOn, no need to request');
      return;
    }

    // Check cooldown to prevent repeated permission dialogs
    if (isInCooldownPeriod()) {
      devLog.info('[BluetoothManager] Skipping Bluetooth enable request - cooldown active', getCooldownInfo());
      return;
    }

    devLog.warn('[BluetoothManager] ⚠️ Requesting Bluetooth enable via BluetoothStateManager.requestToEnable()');
    devLog.warn('[BluetoothManager] ⚠️ This will show the Bluetooth enable dialog to the user');
    lastRequestEnableTime = Date.now();
    await BluetoothStateManager.requestToEnable();
    devLog.info('[BluetoothManager] BluetoothStateManager.requestToEnable() completed');
  } catch (error: any) {
    if (
      error?.message?.includes('NullPointerException') ||
      error?.message?.includes('getCurrentActivity')
    ) {
      // Check cooldown before retry
      if (isInCooldownPeriod()) {
        devLog.info('[BluetoothManager] Skipping Bluetooth enable retry - cooldown active');
        return;
      }

      try {
        lastRequestEnableTime = Date.now();
        await BluetoothStateManager.requestToEnable();
      } catch (enableError) {
        devLog.warn('[BluetoothManager] Enable failed:', enableError);
      }
    }
  }
};

/**
 * Handles Android Bluetooth enable flow
 * NOTE: This function should NOT automatically request Bluetooth enable
 * to avoid unwanted permission dialogs. It should only check state.
 */
const handleAndroidBluetooth = async (): Promise<boolean> => {
  try {
    // Only check state, don't automatically request enable
    // This prevents unwanted permission dialogs when Bluetooth is off
    const state = await getBluetoothStateRaw();
    if (state === 'PoweredOn') {
      updateBluetoothEnabledState(true);
      resetBluetoothDialogCooldown();
      return true;
    }

    devLog.info('[BluetoothManager] Bluetooth is off, not automatically requesting enable to avoid unwanted dialogs');
    updateBluetoothEnabledState(false);
    return false;
  } catch (error) {
    devLog.error('[BluetoothManager] Android Bluetooth handling failed:', error);
    updateBluetoothEnabledState(false);
    return false;
  }
};

// ============================================================================
// Platform-Specific Functions - iOS
// ============================================================================

/**
 * Shows Bluetooth enable dialog on iOS
 */
const showBluetoothEnableDialog = async (): Promise<void> => {
  try {
    const currentState = await getBluetoothStateRaw();

    if (currentState === 'PoweredOn') {
      updateBluetoothEnabledState(true);
      return;
    }

    showBluetoothSettingsDialog();
  } catch (error) {
    devLog.warn('[BluetoothManager] Failed to show dialog:', error);
  }
};

/**
 * Waits for stable Bluetooth state (handles transient states)
 */
const waitForStableBluetoothState = async (): Promise<string> => {
  let lastState = 'Unknown';

  for (let i = 0; i < BLUETOOTH_STATE_STABLE_MAX_RETRIES; i++) {
    try {
      const state = await getBluetoothStateRaw();
      if (!state) {
        continue;
      }

      if (state === 'PoweredOn') {
        return state;
      }

      if (state === 'PoweredOff' && i >= BLUETOOTH_STATE_STABLE_MIN_RETRIES_FOR_POWERED_OFF) {
        return state;
      }

      lastState = state;

      if (i < BLUETOOTH_STATE_STABLE_MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, BLUETOOTH_STATE_STABLE_RETRY_DELAY_MS));
      }
    } catch (error) {
      devLog.error('[BluetoothManager] State check error:', error);
    }
  }

  return lastState;
};

/**
 * Tries to enable Bluetooth on iOS
 */
const tryEnableIOSBluetooth = async (): Promise<boolean> => {
  try {
    const currentState = await getBluetoothStateRaw();
    if (currentState === 'PoweredOn') {
      updateBluetoothEnabledState(true);
      return true;
    }

    await showBluetoothEnableDialog();
    updateBluetoothEnabledState(false);
    return false;
  } catch (error) {
    updateBluetoothEnabledState(false);
    return false;
  }
};

/**
 * Handles iOS Bluetooth enable flow
 */
const handleIOSBluetooth = async (): Promise<boolean> => {
  const stableState = await waitForStableBluetoothState();

  if (stableState === 'PoweredOn') {
    updateBluetoothEnabledState(true);
    return true;
  }

  if (stableState === 'PoweredOff') {
    await new Promise((resolve) => setTimeout(resolve, BLUETOOTH_RECHECK_DELAY_MS));

    const recheckState = await getBluetoothStateRaw();

    if (recheckState === 'PoweredOn') {
      updateBluetoothEnabledState(true);
      return true;
    }

    updateBluetoothEnabledState(false);
    return await tryEnableIOSBluetooth();
  }

  updateBluetoothEnabledState(false);
  return false;
};

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Sets up Bluetooth state listener (iOS only)
 */
export const setupBluetoothListener = (): void => {
  try {
    if (bluetoothStateListener) {
      return;
    }

    if (Platform.OS === 'ios') {
      if (BluetoothStateManager && typeof BluetoothStateManager.addListener === 'function') {
        bluetoothStateListener = BluetoothStateManager.addListener((state) => {
          updateBluetoothEnabledState(state === 'PoweredOn');
        });
      }
    }
  } catch (error) {
    devLog.error('[BluetoothManager] Listener setup failed:', error);
  }
};

/**
 * Checks if Bluetooth is enabled (uses cache if available)
 */
export const isBluetoothEnabled = async (): Promise<boolean> => {
  try {
    devLog.info('[BluetoothManager] isBluetoothEnabled called', { cachedValue: bluetoothEnabled });
    if (bluetoothEnabled) {
      devLog.info('[BluetoothManager] Using cached Bluetooth enabled state: true');
      return true;
    }
    devLog.info('[BluetoothManager] Cache miss, checking Bluetooth state');
    await checkBluetoothState();
    devLog.info('[BluetoothManager] Bluetooth state check completed', { bluetoothEnabled });
    return bluetoothEnabled;
  } catch (error) {
    devLog.error('[BluetoothManager] isBluetoothEnabled error:', error);
    return false;
  }
};

/**
 * Checks Bluetooth state only (doesn't update cache)
 */
export const checkBluetoothStateOnly = async (): Promise<boolean> => {
  return await checkBluetoothStateOnlyInternal();
};

/**
 * Requests Bluetooth to be enabled
 */
export const requestBluetoothEnable = async (): Promise<boolean> => {
  try {
    devLog.info('[BluetoothManager] requestBluetoothEnable called');
    const isEnabled = await isBluetoothEnabled();
    if (isEnabled) {
      devLog.info('[BluetoothManager] Bluetooth already enabled, no request needed');
      return true;
    }

    devLog.info('[BluetoothManager] Bluetooth not enabled, requesting enable', { platform: Platform.OS });
    if (Platform.OS === 'android') {
      devLog.info('[BluetoothManager] Calling requestBtPermissionsAndroid');
      await requestBtPermissionsAndroid();
    } else {
      devLog.info('[BluetoothManager] Calling showBluetoothEnableDialog');
      await showBluetoothEnableDialog();
    }

    await checkBluetoothState();
    devLog.info('[BluetoothManager] requestBluetoothEnable completed', { bluetoothEnabled });
    return bluetoothEnabled;
  } catch (error) {
    devLog.error('[BluetoothManager] requestBluetoothEnable error:', error);
    return false;
  }
};

/**
 * Performs platform-specific Bluetooth check
 * NOTE: This function should only be called when explicitly requesting Bluetooth enable
 * (e.g., from manual sync). It should NOT be called automatically in background.
 */
const performBluetoothCheck = async (): Promise<boolean> => {
  try {
    devLog.info('[BluetoothManager] Performing Bluetooth check');
    devLog.warn('[BluetoothManager] ⚠️ performBluetoothCheck called - this should only happen for explicit user actions');
    setupBluetoothListener();

    if (Platform.OS === 'android') {
      return await handleAndroidBluetooth();
    } else {
      return await handleIOSBluetooth();
    }
  } catch (error) {
    devLog.error('[BluetoothManager] Check failed:', error);
    return false;
  }
};

/**
 * Ensures Bluetooth is enabled, with optional permission request
 * @param shouldRequestPermission - Whether to request permission if not enabled
 */
export const ensureBluetoothEnabled = async (
  shouldRequestPermission: boolean = true,
): Promise<boolean> => {
  devLog.info('[BluetoothManager] ensureBluetoothEnabled called', {
    shouldRequestPermission,
    bluetoothEnabled,
    isCheckingBluetooth,
  });

  // Return existing promise if already checking
  if (isCheckingBluetooth && bluetoothCheckPromise) {
    devLog.info('[BluetoothManager] Already checking Bluetooth, returning existing promise');
    return bluetoothCheckPromise;
  }

  // Return early if already enabled
  if (bluetoothEnabled) {
    devLog.info('[BluetoothManager] Bluetooth already enabled, returning true');
    return true;
  }

  // If not requesting permission, just check state
  if (!shouldRequestPermission) {
    devLog.info('[BluetoothManager] Not requesting permission, checking state only');
    return await checkBluetoothStateOnlyInternal();
  }

  // Perform full check with permission request
  devLog.info('[BluetoothManager] Starting Bluetooth check with permission request');
  isCheckingBluetooth = true;
  bluetoothCheckPromise = performBluetoothCheck();

  try {
    const result = await bluetoothCheckPromise;
    devLog.info('[BluetoothManager] Bluetooth check completed', { result });
    return result;
  } finally {
    isCheckingBluetooth = false;
    bluetoothCheckPromise = null;
  }
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Gets cached Bluetooth state
 */
export const getBluetoothState = (): boolean => {
  return bluetoothEnabled;
};

/**
 * Resets Bluetooth cache
 */
export const resetBluetoothCache = (): void => {
  bluetoothEnabled = false;
  bluetoothCheckPromise = null;
  // Don't reset lastRequestEnableTime - keep cooldown active
};


/**
 * Refreshes Bluetooth state by clearing cache and re-checking
 * NOTE: Does NOT automatically request Bluetooth enable to avoid unwanted dialogs
 */
export const refreshBluetoothState = async (): Promise<boolean> => {
  try {
    updateBluetoothEnabledState(false);
    // Only check state, don't request enable
    const refreshedState = await ensureBluetoothEnabled(false);
    return refreshedState;
  } catch (error) {
    return false;
  }
};

/**
 * Cleans up Bluetooth monitoring (removes listeners)
 */
export const cleanupBluetoothMonitoring = (): void => {
  try {
    if (bluetoothStateListener) {
      bluetoothStateListener.remove();
      bluetoothStateListener = null;
    }
  } catch (error) {
    devLog.error('[BluetoothManager] Cleanup failed:', error);
  }
};

/**
 * Initializes Bluetooth monitoring (placeholder for future implementation)
 */
export const initializeBluetoothMonitoring = (): void => {
  try {
    // Placeholder for future initialization logic
  } catch (error) {
    devLog.error('[BluetoothManager] Init failed:', error);
  }
};