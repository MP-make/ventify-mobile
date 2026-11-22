# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# React Native TurboModules
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:

# React Native Bridge Methods
-keepclassmembers class * {
    @com.facebook.react.bridge.ReactMethod *;
    @com.facebook.react.bridge.ReactMethodSync *;
}

# Ventify POS native modules & classes (ThermalPrinterModule, ThermalPrinterPackage, etc.)
-keep class pe.com.ventify.pos.** { *; }

# react-native-svg
-keep class com.horcrux.svg.** { *; }

# Expo Modules Core & Kotlin Modules
-keep class expo.modules.** { *; }
-keep class * extends expo.modules.kotlin.modules.Module { *; }

# Hermes Engine Unicode
-keep class com.facebook.hermes.unicode.** { *; }

# React Native Screens
-keep class com.swmansion.rnscreens.** { *; }

# MMKV Storage
-keep class com.mrousavy.mmkv.** { *; }

# Expo Image
-keep class expo.modules.image.** { *; }

# Safe Area Context, SplashScreen, FlashList & React Native UI/JNI
-keep class com.th3rdwave.safeareacontext.** { *; }
-keep class androidx.core.splashscreen.** { *; }
-keep class com.shopify.reactnative.flash_list.** { *; }
-keep class com.reactnativecommunity.netinfo.** { *; }
-keep class com.reactnativeasyncstorage.** { *; }
-keep class com.facebook.react.uimanager.** { *; }
-keep class com.facebook.react.views.** { *; }
-keep class com.facebook.jni.** { *; }
