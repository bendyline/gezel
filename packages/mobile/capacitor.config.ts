import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bendyline.gezel.mobile',
  appName: 'Gezel',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  ios: { contentInset: 'never' },
};

export default config;
