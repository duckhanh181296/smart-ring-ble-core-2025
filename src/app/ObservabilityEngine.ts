import { AccountLockedBottomSheet } from '@/components/AccountLockedBottomSheet';
import { ForceLogoutBottomSheet } from '@/components/ForceLogoutBottomSheet';
import { GlobalLoadingOverlay } from '@/components/GlobalLoadingOverlay';
import CustomToast from '@/components/toast';
import { ActivityDateProvider } from '@/contexts/ActivityDateProvider';
import { AppPreferencesProvider } from '@/contexts/AppPreferencesContext';
import { AuthProvider } from '@/contexts/AuthContext';
import { GlobalLoadingProvider } from '@/contexts/GlobalLoadingContext';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { SyncOSDataProvider } from '@/contexts/SyncOSDataContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { navigationRef, useNavigationPersistence } from '@/navigation/navigation-utils';
import { PersistQueryClientProvider } from '@/react-query/PersistQueryClientProvider';
import { persistOptions, queryClient } from '@/react-query/queryClient';
import { NotificationOverlay } from '@/screens/main/notification/NotificationOverlay';
import FirebaseService from '@/services/FirebaseServiceManager';
import { initializeBluetoothMonitoring } from '@/services/sync-device/device-connect/BluetoothManager';
import { useAppState } from '@/hooks';
import { useToastService } from '@/hooks/useToastService';
import { devLog } from '@/utils/loggingHelper';
import { parseFirebaseMessageToModel } from '@/utils/notification';
import { getApp } from '@react-native-firebase/app';
import {
  FirebaseMessagingTypes,
  getInitialNotification,
  getMessaging,
  onMessage,
  onNotificationOpenedApp,
} from '@react-native-firebase/messaging';
import { NavigationContainer } from '@react-navigation/native';
import { useEffect } from 'react';
import { I18nextProvider } from 'react-i18next';
import { Text, TextInput, Platform, InteractionManager } from 'react-native';
import 'react-native-gesture-handler';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';
import { ToastProvider } from 'react-native-toast-notifications';
import i18n from './src/locales/i18n';
import { AppStack } from './src/navigation/app-navigators';
import { requestBlePermissions } from '@/hooks/blePermission';
import logger from '@/utils/loggingHelper';
import * as Sentry from '@sentry/react-native';
import DeviceInfo from 'react-native-device-info';
import { User } from '@/types/models/user-model';
import { StorageServiceManager, STORAGE_KEYS } from '@/services/StorageService';

const getCurrentUser = (): User | null => {
  try {
    const raw = StorageServiceManager.getString(STORAGE_KEYS.USER_DATA);
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
};

const currentUser = getCurrentUser();

Sentry.init({
  dsn: process.env.SENTRY_DSN || '___HIDDEN_FOR_PUBLIC___',

  release: `SmartRingApp@${DeviceInfo.getVersion()}+${DeviceInfo.getBuildNumber()}`,
  dist: DeviceInfo.getBuildNumber(),
  environment: __DEV__ ? 'development' : 'production',
  enabled: !__DEV__,

  tracesSampleRate: 0.1,
  profilesSampleRate: 0.05,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  attachScreenshot: true,
  attachViewHierarchy: Platform.OS === 'ios',

  enableCaptureFailedRequests: true,

  maxBreadcrumbs: 100,

  sendDefaultPii: false,

  enableAutoSessionTracking: true,
  sessionTrackingIntervalMillis: 30_000,

  beforeSend(event) {
    // if (__DEV__) return null;
    if (event.exception?.values?.[0]?.value?.includes('Network request failed')) return null;
    if (event.exception?.values?.[0]?.type === 'Warning') return null;
    return event;
  },

  beforeBreadcrumb(breadcrumb) {
    if (breadcrumb.category === 'http' && breadcrumb.data?.url) {
      try {
        const url = new URL(breadcrumb.data.url);
        ['token', 'access_token', 'refresh_token', 'email', 'phone', 'password'].forEach(p =>
          url.searchParams.delete(p)
        );
        breadcrumb.data.url = url.toString();
      } catch { }
    }
    if (
      breadcrumb.category === 'console' &&
      breadcrumb.message &&
      /token|password|email|phone/i.test(breadcrumb.message)
    ) {
      return null;
    }
    return breadcrumb;
  },

  integrations: [
    Sentry.mobileReplayIntegration({
      maskAllText: false,
    }),
    Sentry.feedbackIntegration(),
  ],
});

Sentry.setTag('platform', Platform.OS);
Sentry.setTag('env', __DEV__ ? 'development' : 'production');
Sentry.setTag('appVersion', DeviceInfo.getVersion());
Sentry.setExtra('buildNumber', DeviceInfo.getBuildNumber());
Sentry.setExtra('deviceId', DeviceInfo.getUniqueIdSync());

if (currentUser) {
  Sentry.setUser({
  id: currentUser.id?.toString() ?? undefined,
  email: currentUser.email ?? undefined,
  username: currentUser.fullName ?? undefined,
  });
}

// Enable react-native-screens
enableScreens();

// Disable font scaling globally - Method 1
if ((Text as any).defaultProps) {
  (Text as any).defaultProps.allowFontScaling = false;
} else {
  (Text as any).defaultProps = { allowFontScaling: false };
}

if ((TextInput as any).defaultProps) {
  (TextInput as any).defaultProps.allowFontScaling = false;
} else {
  (TextInput as any).defaultProps = { allowFontScaling: false };
}

const RootNavigator = () => {
  const { onNavigationStateChange } = useNavigationPersistence();
  return (
    <NavigationContainer ref={navigationRef} onStateChange={onNavigationStateChange}>
      <AppStack />
      <ForceLogoutBottomSheet />
      <AccountLockedBottomSheet />
    </NavigationContainer>
  );
};

const AppBase = () => {
  // Track app state and auto-restart AutoSync when app returns to foreground
  useAppState({
    enableAutoSyncRestart: true,
  });

  // Initialize toast service for AutoSync notifications
  useToastService();

  return (
    <GlobalLoadingProvider>
      <AuthProvider>
        <SyncOSDataProvider>
          <ActivityDateProvider>
            <AppPreferencesProvider>
              <RootNavigator />
              <GlobalLoadingOverlay />
            </AppPreferencesProvider>
          </ActivityDateProvider>
        </SyncOSDataProvider>
      </AuthProvider>
    </GlobalLoadingProvider>
  );
};

function App() {
  useEffect(() => {
    InteractionManager.runAfterInteractions(() => {
      async function initBle() {
        try {
          const granted = await requestBlePermissions();
          if (granted) {
            await initializeBluetoothMonitoring();
          } else {
            logger.warn('BLE permissions not granted, skip connect');
          }
        } catch (err) {
          if (!__DEV__) {
            Sentry.captureException(err);
          }
          logger.error('BLE connect failed', err);
        }
      }
      initBle();
    });
  }, []);

  const app = getApp();
  const messagingInstance = getMessaging(app);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const fcmTokenListener = async () => {
      await FirebaseService.initialize();
      const messaging = FirebaseService.messaging;
      unsubscribe = messaging?.onTokenRefresh((token) => {
        devLog.info(`🐞 Updated FCM Token: ${token}`);
      });
    };

    fcmTokenListener();

    return () => {
      unsubscribe?.();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <I18nextProvider i18n={i18n}>
        <ToastProvider
          placement="top"
          duration={3000}
          animationType="slide-in"
          renderToast={(toastOptions) => (
            <CustomToast
              text={toastOptions.message}
              onHide={toastOptions.onHide}
              type={toastOptions.type}
              action={toastOptions.onPress}
              id={toastOptions.id}
            />
          )}
        >
          <NotificationProvider
            parseRawToModel={(raw) =>
              parseFirebaseMessageToModel(raw as FirebaseMessagingTypes.RemoteMessage)
            }
            subscribeForeground={(cb) =>
              onMessage(messagingInstance, (m) => {
                devLog.debug('🐞 Raw Foreground:', m);
                cb(m as any);
              })
            }
            subscribeOpenedApp={(cb) =>
              onNotificationOpenedApp(messagingInstance, (m) => {
                devLog.debug('🐞 Raw Opened App:', m);
                cb(m as any);
              })
            }
            getInitialNotification={() =>
              getInitialNotification(messagingInstance).then((m) => {
                devLog.debug('🐞 Raw Initial Notification:', m);
                return m;
              })
            }
            options={{
              showDurationMs: 5000,
              minGapMs: 800,
            }}
          >
            <ThemeProvider>
              <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
                <GestureHandlerRootView>
                  <KeyboardProvider statusBarTranslucent>
                    <AppBase />
                  </KeyboardProvider>
                  <NotificationOverlay />
                </GestureHandlerRootView>
              </PersistQueryClientProvider>
            </ThemeProvider>
          </NotificationProvider>
        </ToastProvider>
      </I18nextProvider>
    </SafeAreaProvider>
  );
}

export default Sentry.wrap(App);
