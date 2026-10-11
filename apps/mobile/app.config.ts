/// <reference types="node" />

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * The phone app's configuration. `APP_VARIANT` (set by eas.json's
 * profiles) picks an identity, so a development build, a preview build
 * and the store build install side by side on one phone:
 *
 * | Variant       | Android package / iOS bundle | Name        |
 * | ------------- | ---------------------------- | ----------- |
 * | `development` | `sh.g1t.app.dev`             | g1t (dev)   |
 * | `preview`     | `sh.g1t.app.preview`         | g1t (beta)  |
 * | production    | `sh.g1t.app`                 | g1t         |
 *
 * The EAS project is g1t's on expo.dev; push notifications on Android
 * also need the Firebase credentials uploaded there (README.md).
 */

/** The EAS project's id, from `eas init`. `EAS_PROJECT_ID` overrides it. */
const EAS_PROJECT = "35fb457b-905c-44cd-9b35-0899e12852dd";

const variant = process.env.APP_VARIANT;
const suffix = variant === "development" ? ".dev" : variant === "preview" ? ".preview" : "";
const name = variant === "development" ? "g1t (dev)" : variant === "preview" ? "g1t (beta)" : "g1t";
const id = `sh.g1t.app${suffix}`;
const projectId = process.env.EAS_PROJECT_ID ?? EAS_PROJECT;

/** g1t's background, dark as the site is by default (packages/theme/tokens.css `--g1t-bg`). */
const BACKGROUND = "#0f0f11";
/** The accent, for the notification icon's tint (`--g1t-accent`). */
const ACCENT = "#b6a8ff";

/**
 * Firebase's file for the Android app, which push on Android needs: from
 * an EAS file secret in the cloud (`GOOGLE_SERVICES_JSON`), or a copy
 * beside this file locally (ignored by git). Without one, everything but
 * push works.
 */
const googleServices = process.env.GOOGLE_SERVICES_JSON ?? (existsSync(join(__dirname, "google-services.json")) ? "./google-services.json" : undefined);

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name,
  slug: "g1t",
  owner: process.env.EAS_OWNER,
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  // g1t:// links, as on the desktop, and where sign-in comes back to.
  scheme: "g1t",
  userInterfaceStyle: "automatic",
  backgroundColor: BACKGROUND,
  ios: {
    bundleIdentifier: id,
    supportsTablet: true,
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: id,
    adaptiveIcon: {
      backgroundColor: BACKGROUND,
      foregroundImage: "./assets/images/android-icon-foreground.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: true,
    ...(googleServices ? { googleServicesFile: googleServices } : {}),
    softwareKeyboardLayoutMode: "resize",
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-web-browser",
    [
      "expo-notifications",
      {
        icon: "./assets/images/notification-icon.png",
        color: ACCENT,
        defaultChannel: "messages",
      },
    ],
    [
      "expo-splash-screen",
      {
        backgroundColor: BACKGROUND,
        image: "./assets/images/splash-icon.png",
        imageWidth: 96,
      },
    ],
  ],
  experiments: {
    reactCompiler: true,
  },
  runtimeVersion: { policy: "appVersion" },
  ...(projectId ? { updates: { url: `https://u.expo.dev/${projectId}` } } : {}),
  extra: {
    ...config.extra,
    ...(projectId ? { eas: { projectId } } : {}),
  },
});
