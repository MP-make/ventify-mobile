package pe.com.ventify.pos

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.util.Base64
import com.facebook.react.bridge.*
import java.io.OutputStream
import java.util.UUID

class ThermalPrinterModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
  }

  override fun getName(): String = "ThermalPrinter"

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun getPairedPrinters(promise: Promise) {
    try {
      val adapter = BluetoothAdapter.getDefaultAdapter()
      val devicesArray = Arguments.createArray()

      if (adapter != null && adapter.isEnabled) {
        val bondedDevices: Set<BluetoothDevice> = adapter.bondedDevices ?: emptySet()
        for (device in bondedDevices) {
          val map = Arguments.createMap()
          map.putString("name", device.name ?: "Impresora Bluetooth")
          map.putString("address", device.address)
          devicesArray.pushMap(map)
        }
      }

      val result = Arguments.createMap()
      result.putArray("devices", devicesArray)
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("BLUETOOTH_ERROR", e.message, e)
    }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun printRaw(params: ReadableMap, promise: Promise) {
    Thread {
      var socket: BluetoothSocket? = null
      try {
        val address = params.getString("address")
          ?: throw IllegalArgumentException("Dirección MAC de impresora requerida")
        val base64Data = params.getString("base64Data")
          ?: throw IllegalArgumentException("Datos Base64 ESC/POS requeridos")

        val adapter = BluetoothAdapter.getDefaultAdapter()
          ?: throw IllegalStateException("Bluetooth no soportado en este dispositivo")

        if (!adapter.isEnabled) {
          throw IllegalStateException("Bluetooth está desactivado")
        }

        val device = adapter.getRemoteDevice(address)
        socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
        adapter.cancelDiscovery()
        socket.connect()

        val bytes = Base64.decode(base64Data, Base64.DEFAULT)
        val out: OutputStream = socket.outputStream
        out.write(bytes)
        out.flush()
        Thread.sleep(350)

        val res = Arguments.createMap()
        res.putBoolean("success", true)
        promise.resolve(res)
      } catch (e: Exception) {
        promise.reject("PRINT_ERROR", e.message, e)
      } finally {
        try {
          socket?.close()
        } catch (_: Exception) {}
      }
    }.start()
  }
}
