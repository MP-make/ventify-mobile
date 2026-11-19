const fs = require('fs');
const path = require('path');
const {
  withAndroidManifest,
  withGradleProperties,
  withMainApplication,
  withAppBuildGradle,
  withDangerousMod,
} = require('@expo/config-plugins');

const THERMAL_PRINTER_PACKAGE_KT = `package pe.com.ventify.pos

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class ThermalPrinterPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    return listOf(ThermalPrinterModule(reactContext))
  }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
    return emptyList()
  }
}
`;

const THERMAL_PRINTER_MODULE_KT = `package pe.com.ventify.pos

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class ThermalPrinterModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private const val CONNECT_TIMEOUT_MS = 4000L
    private const val WRITE_CHUNK_SIZE = 512
    private const val CHUNK_PAUSE_MS = 15L
    private const val DRAIN_PAUSE_MS = 120L
  }

  private val printExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "VentifyThermalPrinter").apply { isDaemon = true }
  }

  override fun getName(): String = "ThermalPrinter"

  override fun invalidate() {
    super.invalidate()
    printExecutor.shutdownNow()
  }

  private fun getBluetoothAdapter(): BluetoothAdapter? {
    val manager =
      reactApplicationContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    return manager?.adapter
  }

  private fun hasBluetoothConnectPermission(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.BLUETOOTH_CONNECT
      ) == PackageManager.PERMISSION_GRANTED
    } else {
      ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.BLUETOOTH
      ) == PackageManager.PERMISSION_GRANTED
    }
  }

  @SuppressLint("MissingPermission")
  private fun connectWithTimeout(
    adapter: BluetoothAdapter,
    device: BluetoothDevice,
    timeoutMs: Long
  ): BluetoothSocket {
    val connectExecutor = Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "VentifyBtConnect").apply { isDaemon = true }
    }

    fun attempt(secure: Boolean): BluetoothSocket {
      val candidate = if (secure) {
        device.createRfcommSocketToServiceRecord(SPP_UUID)
      } else {
        device.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
      }
      adapter.cancelDiscovery()

      val future: Future<Unit> = connectExecutor.submit(Callable {
        candidate.connect()
      })

      try {
        future.get(timeoutMs, TimeUnit.MILLISECONDS)
        return candidate
      } catch (te: TimeoutException) {
        future.cancel(true)
        try {
          candidate.close()
        } catch (_: Exception) {}
        throw IOException("Tiempo de espera agotado al conectar con la impresora (\${timeoutMs}ms)", te)
      } catch (e: Exception) {
        try {
          candidate.close()
        } catch (_: Exception) {}
        val rootCause = e.cause ?: e
        if (rootCause is Exception) throw rootCause
        throw IOException(rootCause.message ?: "Error al conectar socket Bluetooth", rootCause)
      }
    }

    try {
      return try {
        attempt(secure = true)
      } catch (secureErr: Exception) {
        if (secureErr is SecurityException) throw secureErr
        attempt(secure = false)
      }
    } finally {
      connectExecutor.shutdownNow()
    }
  }

  private fun writeChunked(out: OutputStream, bytes: ByteArray) {
    var offset = 0
    while (offset < bytes.size) {
      val chunkLength = minOf(WRITE_CHUNK_SIZE, bytes.size - offset)
      out.write(bytes, offset, chunkLength)
      out.flush()
      offset += chunkLength
      if (offset < bytes.size) {
        Thread.sleep(CHUNK_PAUSE_MS)
      }
    }
    out.flush()
    Thread.sleep(DRAIN_PAUSE_MS)
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun getPairedPrinters(promise: Promise) {
    if (!hasBluetoothConnectPermission()) {
      promise.reject(
        "E_PERMISSION_DENIED",
        "Permiso BLUETOOTH_CONNECT requerido. Habilita 'Dispositivos cercanos' en los Ajustes de Android."
      )
      return
    }

    try {
      val adapter = getBluetoothAdapter()
      if (adapter == null) {
        promise.reject(
          "E_BLUETOOTH_UNAVAILABLE",
          "Bluetooth no soportado en este dispositivo."
        )
        return
      }
      if (!adapter.isEnabled) {
        promise.reject(
          "E_BLUETOOTH_DISABLED",
          "Bluetooth está desactivado. Actívalo para listar impresoras vinculadas."
        )
        return
      }

      val devicesArray = Arguments.createArray()
      val bondedDevices: Set<BluetoothDevice> = adapter.bondedDevices ?: emptySet()
      for (device in bondedDevices) {
        val map = Arguments.createMap()
        map.putString("name", device.name ?: "Impresora Bluetooth")
        map.putString("address", device.address)
        devicesArray.pushMap(map)
      }

      val result = Arguments.createMap()
      result.putArray("devices", devicesArray)
      promise.resolve(result)
    } catch (se: SecurityException) {
      promise.reject(
        "E_PERMISSION_DENIED",
        se.message ?: "Permiso Bluetooth denegado por el sistema.",
        se
      )
    } catch (e: Exception) {
      promise.reject("BLUETOOTH_ERROR", e.message ?: "Error al consultar impresoras Bluetooth.", e)
    }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun printRaw(params: ReadableMap, promise: Promise) {
    if (!hasBluetoothConnectPermission()) {
      promise.reject(
        "E_PERMISSION_DENIED",
        "Permiso BLUETOOTH_CONNECT requerido para imprimir por Bluetooth."
      )
      return
    }

    val address = if (params.hasKey("address")) params.getString("address")?.trim() else null
    if (address.isNullOrEmpty()) {
      promise.reject("E_INVALID_ARGS", "Dirección MAC de impresora requerida.")
      return
    }
    if (!BluetoothAdapter.checkBluetoothAddress(address)) {
      promise.reject("E_INVALID_ADDRESS", "Dirección MAC Bluetooth inválida: $address")
      return
    }

    val base64Data = if (params.hasKey("base64Data")) params.getString("base64Data") else null
    if (base64Data.isNullOrEmpty()) {
      promise.reject("E_INVALID_ARGS", "Datos Base64 ESC/POS requeridos.")
      return
    }

    val bytes: ByteArray = try {
      Base64.decode(base64Data, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      promise.reject("E_INVALID_DATA", "Datos Base64 ESC/POS inválidos.", e)
      return
    }

    if (bytes.isEmpty()) {
      promise.reject("E_INVALID_DATA", "El buffer ESC/POS está vacío.")
      return
    }

    if (printExecutor.isShutdown) {
      promise.reject("E_MODULE_DESTROYED", "El módulo de impresión fue cerrado.")
      return
    }

    try {
      printExecutor.execute {
        var socket: BluetoothSocket? = null
        try {
          if (!hasBluetoothConnectPermission()) {
            promise.reject(
              "E_PERMISSION_DENIED",
              "Permiso BLUETOOTH_CONNECT requerido para imprimir por Bluetooth."
            )
            return@execute
          }

          val adapter = getBluetoothAdapter()
            ?: throw IllegalStateException("Bluetooth no soportado en este dispositivo.")

          if (!adapter.isEnabled) {
            throw IllegalStateException("Bluetooth está desactivado.")
          }

          val device = adapter.getRemoteDevice(address)
          socket = connectWithTimeout(adapter, device, CONNECT_TIMEOUT_MS)

          val out: OutputStream = socket.outputStream
          writeChunked(out, bytes)

          val res = Arguments.createMap()
          res.putBoolean("success", true)
          res.putInt("bytesWritten", bytes.size)
          promise.resolve(res)
        } catch (se: SecurityException) {
          promise.reject(
            "E_PERMISSION_DENIED",
            se.message ?: "Permiso Bluetooth denegado al imprimir.",
            se
          )
        } catch (e: Exception) {
          promise.reject("PRINT_ERROR", e.message ?: "Error al imprimir en ticketera Bluetooth.", e)
        } finally {
          try {
            socket?.close()
          } catch (_: Exception) {}
        }
      }
    } catch (re: RejectedExecutionException) {
      promise.reject("PRINT_ERROR", "Cola de impresión no disponible.", re)
    }
  }
}
`;

const PROGUARD_REQUIRED_RULES = [
  '-keep class pe.com.ventify.pos.** { *; }',
  '-keep class com.horcrux.svg.** { *; }',
];

function withVentifyManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const permissions = Array.isArray(manifest['uses-permission'])
      ? manifest['uses-permission']
      : [];

    const ensurePerm = (name, patch) => {
      const existing = permissions.find((p) => p?.$?.['android:name'] === name);
      if (existing) {
        Object.assign(existing.$, patch);
      } else {
        permissions.push({ $: { 'android:name': name, ...patch } });
      }
    };

    ensurePerm('android.permission.BLUETOOTH', { 'android:maxSdkVersion': '30' });
    ensurePerm('android.permission.BLUETOOTH_ADMIN', { 'android:maxSdkVersion': '30' });
    ensurePerm('android.permission.BLUETOOTH_SCAN', {
      'android:usesPermissionFlags': 'neverForLocation',
      'tools:targetApi': 's',
    });
    ensurePerm('android.permission.BLUETOOTH_CONNECT', {});
    manifest['uses-permission'] = permissions;

    manifest.queries = Array.isArray(manifest.queries) && manifest.queries.length > 0
      ? manifest.queries
      : [{}];
    const queryBlock = manifest.queries[0] || {};
    queryBlock.intent = Array.isArray(queryBlock.intent) ? queryBlock.intent : [];
    queryBlock.package = Array.isArray(queryBlock.package) ? queryBlock.package : [];

    const hasWhatsappScheme = queryBlock.intent.some((intent) =>
      Array.isArray(intent?.data) &&
      intent.data.some((d) => d?.$?.['android:scheme'] === 'whatsapp')
    );
    if (!hasWhatsappScheme) {
      queryBlock.intent.push({
        action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
        data: [{ $: { 'android:scheme': 'whatsapp' } }],
      });
    }

    for (const pkgName of ['com.whatsapp', 'com.whatsapp.w4b']) {
      const exists = queryBlock.package.some((p) => p?.$?.['android:name'] === pkgName);
      if (!exists) {
        queryBlock.package.push({ $: { 'android:name': pkgName } });
      }
    }

    manifest.queries[0] = queryBlock;
    return cfg;
  });
}

function withVentifyGradleProperties(config) {
  return withGradleProperties(config, (cfg) => {
    const props = cfg.modResults.filter(
      (item) => !(item.type === 'property' && item.key === 'org.gradle.java.home')
    );

    const setProp = (key, value) => {
      const existing = props.find((p) => p.type === 'property' && p.key === key);
      if (existing) {
        existing.value = value;
      } else {
        props.push({ type: 'property', key, value });
      }
    };

    setProp('reactNativeArchitectures', 'arm64-v8a');
    setProp('android.enableProguardInReleaseBuilds', 'true');
    setProp('android.enableShrinkResourcesInReleaseBuilds', 'true');
    setProp('android.enableR8.fullMode', 'true');

    cfg.modResults = props;
    return cfg;
  });
}

function withVentifyMainApplication(config) {
  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    if (!contents.includes('ThermalPrinterPackage()')) {
      if (contents.includes('PackageList(this).packages.apply {')) {
        contents = contents.replace(
          /PackageList\(this\)\.packages\.apply\s*\{/,
          'PackageList(this).packages.apply {\n              add(ThermalPrinterPackage())'
        );
      } else if (contents.includes('val packages = PackageList(this).packages')) {
        contents = contents.replace(
          /val packages = PackageList\(this\)\.packages/,
          'val packages = PackageList(this).packages\n            packages.add(ThermalPrinterPackage())'
        );
      }
    }

    if (
      contents.includes('ThermalPrinterPackage()') &&
      !contents.includes('package pe.com.ventify.pos') &&
      !contents.includes('import pe.com.ventify.pos.ThermalPrinterPackage')
    ) {
      contents = contents.replace(
        /(package\s+[^\r\n]+)/,
        '$1\n\nimport pe.com.ventify.pos.ThermalPrinterPackage'
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
}

function withVentifyAppBuildGradle(config) {
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;
    if (contents.includes('hasReleaseKeystore')) {
      return cfg;
    }

    const keystoreVars = `    def releaseStoreFile = findProperty('MYAPP_UPLOAD_STORE_FILE') ?: findProperty('VENTIFY_UPLOAD_STORE_FILE') ?: System.getenv('MYAPP_UPLOAD_STORE_FILE') ?: System.getenv('VENTIFY_UPLOAD_STORE_FILE')
    def releaseStorePassword = findProperty('MYAPP_UPLOAD_STORE_PASSWORD') ?: findProperty('VENTIFY_UPLOAD_STORE_PASSWORD') ?: System.getenv('MYAPP_UPLOAD_STORE_PASSWORD') ?: System.getenv('VENTIFY_UPLOAD_STORE_PASSWORD')
    def releaseKeyAlias = findProperty('MYAPP_UPLOAD_KEY_ALIAS') ?: findProperty('VENTIFY_UPLOAD_KEY_ALIAS') ?: System.getenv('MYAPP_UPLOAD_KEY_ALIAS') ?: System.getenv('VENTIFY_UPLOAD_KEY_ALIAS')
    def releaseKeyPassword = findProperty('MYAPP_UPLOAD_KEY_PASSWORD') ?: findProperty('VENTIFY_UPLOAD_KEY_PASSWORD') ?: System.getenv('MYAPP_UPLOAD_KEY_PASSWORD') ?: System.getenv('VENTIFY_UPLOAD_KEY_PASSWORD')
    def hasReleaseKeystore = releaseStoreFile && file(releaseStoreFile).exists() && releaseStorePassword && releaseKeyAlias && releaseKeyPassword

    signingConfigs {`;

    if (contents.includes('signingConfigs {')) {
      contents = contents.replace(/signingConfigs\s*\{/, keystoreVars.trimStart());
      contents = contents.replace(
        /(debug\s*\{[\s\S]*?\n\s*\})(\s*\})/,
        `$1
        if (hasReleaseKeystore) {
            release {
                storeFile file(releaseStoreFile)
                storePassword releaseStorePassword
                keyAlias releaseKeyAlias
                keyPassword releaseKeyPassword
            }
        }$2`
      );
      contents = contents.replace(
        /(release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/,
        '$1signingConfig hasReleaseKeystore ? signingConfigs.release : signingConfigs.debug'
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
}

function withVentifyNativeFilesAndProguard(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const androidRoot = cfg.modRequest.platformProjectRoot;

      // 1. Ensure ThermalPrinterModule.kt & ThermalPrinterPackage.kt exist deterministically
      const pkgDir = path.join(androidRoot, 'app/src/main/java/pe/com/ventify/pos');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'ThermalPrinterPackage.kt'), THERMAL_PRINTER_PACKAGE_KT, 'utf8');
      fs.writeFileSync(path.join(pkgDir, 'ThermalPrinterModule.kt'), THERMAL_PRINTER_MODULE_KT, 'utf8');

      // 2. Ensure ProGuard rules for react-native-svg and Ventify native modules
      const proguardPath = path.join(androidRoot, 'app/proguard-rules.pro');
      let proguardContent = fs.existsSync(proguardPath)
        ? fs.readFileSync(proguardPath, 'utf8')
        : '';

      const missingRules = PROGUARD_REQUIRED_RULES.filter(
        (rule) => !proguardContent.includes(rule)
      );
      if (missingRules.length > 0) {
        const suffix = proguardContent.endsWith('\n') || proguardContent.length === 0 ? '' : '\n';
        proguardContent = `${proguardContent}${suffix}\n# Ventify POS & SVG ProGuard Rules\n${missingRules.join('\n')}\n`;
        fs.writeFileSync(proguardPath, proguardContent, 'utf8');
      }

      return cfg;
    },
  ]);
}

module.exports = function withVentifyAndroid(config) {
  config = withVentifyManifest(config);
  config = withVentifyGradleProperties(config);
  config = withVentifyMainApplication(config);
  config = withVentifyAppBuildGradle(config);
  config = withVentifyNativeFilesAndProguard(config);
  return config;
};
