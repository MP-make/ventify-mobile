package pe.com.ventify.pos

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
import java.io.InterruptedIOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class ThermalPrinterModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "ThermalPrinter"
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private const val CONNECT_TIMEOUT_MS = 4000L
    private const val WRITE_CHUNK_SIZE = 512
    private const val CHUNK_PAUSE_MS = 15L
    private const val DRAIN_PAUSE_MS = 120L
  }

  private val printExecutorDelegate = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
    Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "VentifyThermalPrinter").apply { isDaemon = true }
    }
  }
  private val printExecutor: ExecutorService
    get() = printExecutorDelegate.value

  private val connectExecutorDelegate = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
    Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "VentifyBtConnect").apply { isDaemon = true }
    }
  }
  private val connectExecutor: ExecutorService
    get() = connectExecutorDelegate.value

  @Volatile private var activeSocket: BluetoothSocket? = null
  @Volatile private var isInvalidated = false

  override fun getName(): String = NAME

  override fun invalidate() {
    isInvalidated = true
    super.invalidate()
    closeActiveSocket()
    if (printExecutorDelegate.isInitialized()) {
      printExecutorDelegate.value.shutdownNow()
    }
    if (connectExecutorDelegate.isInitialized()) {
      connectExecutorDelegate.value.shutdownNow()
    }
  }

  private fun closeSocketQuietly(socket: BluetoothSocket?) {
    try {
      socket?.close()
    } catch (_: Exception) {}
  }

  private fun closeActiveSocket() {
    val socket = activeSocket
    activeSocket = null
    closeSocketQuietly(socket)
  }

  private fun clearActiveSocketIfSame(socket: BluetoothSocket?) {
    if (socket != null && activeSocket === socket) {
      activeSocket = null
    }
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
  private fun connectAttemptWithTimeout(
    adapter: BluetoothAdapter,
    device: BluetoothDevice,
    secure: Boolean,
    timeoutMs: Long
  ): BluetoothSocket {
    if (isInvalidated || Thread.currentThread().isInterrupted) {
      throw InterruptedIOException("Operación de impresión cancelada.")
    }

    val candidate = if (secure) {
      device.createRfcommSocketToServiceRecord(SPP_UUID)
    } else {
      device.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
    }
    activeSocket = candidate
    adapter.cancelDiscovery()

    var future: Future<Unit>? = null
    try {
      future = connectExecutor.submit(Callable {
        candidate.connect()
      })
      future.get(timeoutMs, TimeUnit.MILLISECONDS)
      if (isInvalidated) {
        closeSocketQuietly(candidate)
        clearActiveSocketIfSame(candidate)
        throw InterruptedIOException("El módulo de impresión fue cerrado.")
      }
      return candidate
    } catch (te: TimeoutException) {
      future?.cancel(true)
      closeSocketQuietly(candidate)
      clearActiveSocketIfSame(candidate)
      throw IOException("Tiempo de espera agotado al conectar con la impresora (${timeoutMs}ms)", te)
    } catch (ie: InterruptedException) {
      future?.cancel(true)
      closeSocketQuietly(candidate)
      clearActiveSocketIfSame(candidate)
      Thread.currentThread().interrupt()
      throw InterruptedIOException("Conexión Bluetooth cancelada.")
    } catch (e: Exception) {
      future?.cancel(true)
      closeSocketQuietly(candidate)
      clearActiveSocketIfSame(candidate)
      val rootCause = e.cause ?: e
      if (rootCause is Exception) throw rootCause
      throw IOException(rootCause.message ?: "Error al conectar socket Bluetooth", rootCause)
    }
  }

  @SuppressLint("MissingPermission")
  private fun connectWithTimeout(
    adapter: BluetoothAdapter,
    device: BluetoothDevice,
    timeoutMs: Long
  ): BluetoothSocket {
    return try {
      connectAttemptWithTimeout(adapter, device, secure = true, timeoutMs = timeoutMs)
    } catch (secureErr: Exception) {
      if (secureErr is SecurityException || secureErr is InterruptedIOException || isInvalidated) {
        throw secureErr
      }
      connectAttemptWithTimeout(adapter, device, secure = false, timeoutMs = timeoutMs)
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

    val base64Payload = if (params.hasKey("base64Data")) params.getString("base64Data") else null
    if (base64Payload.isNullOrEmpty()) {
      promise.reject("E_INVALID_ARGS", "Datos Base64 ESC/POS requeridos.")
      return
    }

    if (isInvalidated || (printExecutorDelegate.isInitialized() && printExecutor.isShutdown)) {
      promise.reject("E_MODULE_DESTROYED", "El módulo de impresión fue cerrado.")
      return
    }

    try {
      printExecutor.execute {
        var socket: BluetoothSocket? = null
        try {
          val bytes: ByteArray = try {
            Base64.decode(base64Payload, Base64.DEFAULT)
          } catch (e: IllegalArgumentException) {
            promise.reject("E_INVALID_DATA", "Datos Base64 ESC/POS inválidos.", e)
            return@execute
          }

          if (bytes.isEmpty()) {
            promise.reject("E_INVALID_DATA", "El buffer ESC/POS está vacío.")
            return@execute
          }

          if (isInvalidated) {
            promise.reject("E_MODULE_DESTROYED", "El módulo de impresión fue cerrado.")
            return@execute
          }

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
          closeSocketQuietly(socket)
          clearActiveSocketIfSame(socket)
        }
      }
    } catch (re: RejectedExecutionException) {
      promise.reject("PRINT_ERROR", "Cola de impresión no disponible.", re)
    }
  }
}
