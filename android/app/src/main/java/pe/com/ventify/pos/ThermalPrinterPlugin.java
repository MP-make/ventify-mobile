package pe.com.ventify.pos;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(name = "ThermalPrinter")
public class ThermalPrinterPlugin extends Plugin {
    // UUID estándar para Serial Port Profile (SPP) / RFCOMM empleado por todas las ticketeras térmicas Bluetooth
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    @PluginMethod
    public void getPairedPrinters(PluginCall call) {
        try {
            BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
            if (adapter == null) {
                call.reject("El dispositivo no cuenta con adaptador Bluetooth");
                return;
            }

            if (!adapter.isEnabled()) {
                JSObject ret = new JSObject();
                ret.put("enabled", false);
                ret.put("devices", new JSArray());
                call.resolve(ret);
                return;
            }

            Set<BluetoothDevice> pairedDevices = adapter.getBondedDevices();
            JSArray devicesArray = new JSArray();

            if (pairedDevices != null) {
                for (BluetoothDevice device : pairedDevices) {
                    JSObject devObj = new JSObject();
                    String name = device.getName();
                    devObj.put("name", name != null && !name.isEmpty() ? name : "Ticketera Bluetooth (" + device.getAddress() + ")");
                    devObj.put("address", device.getAddress());
                    devicesArray.put(devObj);
                }
            }

            JSObject ret = new JSObject();
            ret.put("enabled", true);
            ret.put("devices", devicesArray);
            call.resolve(ret);
        } catch (SecurityException se) {
            call.reject("Permiso de Bluetooth no concedido en el teléfono: " + se.getMessage());
        } catch (Exception e) {
            call.reject("Error obteniendo impresoras vinculadas: " + e.getMessage());
        }
    }

    @PluginMethod
    public void printRaw(PluginCall call) {
        String address = call.getString("address");
        String base64Data = call.getString("base64Data");

        if (address == null || address.trim().isEmpty()) {
            call.reject("Dirección Bluetooth de la ticketera no especificada");
            return;
        }

        if (base64Data == null || base64Data.trim().isEmpty()) {
            call.reject("Datos de impresión ESC/POS vacíos");
            return;
        }

        new Thread(() -> {
            BluetoothSocket socket = null;
            try {
                BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
                if (adapter == null || !adapter.isEnabled()) {
                    call.reject("Bluetooth apagado o no disponible");
                    return;
                }

                BluetoothDevice device = adapter.getRemoteDevice(address.trim());
                if (device == null) {
                    call.reject("No se encontró el dispositivo Bluetooth con dirección: " + address);
                    return;
                }

                try {
                    adapter.cancelDiscovery();
                } catch (Exception ignored) {}

                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);

                // Crear socket RFCOMM hacia el servicio SPP de la impresora
                socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                socket.connect();

                OutputStream out = socket.getOutputStream();
                out.write(bytes);
                out.flush();

                // Pausa para asegurar la transmisión de bytes al cabezal térmico
                try {
                    Thread.sleep(400);
                } catch (InterruptedException ignored) {}

                socket.close();
                socket = null;

                JSObject res = new JSObject();
                res.put("success", true);
                call.resolve(res);
            } catch (Exception e) {
                if (socket != null) {
                    try { socket.close(); } catch (Exception ignored) {}
                }
                call.reject("No se pudo conectar con la ticketera: " + e.getMessage());
            }
        }).start();
    }
}
