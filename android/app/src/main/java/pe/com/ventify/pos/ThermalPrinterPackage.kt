package pe.com.ventify.pos

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class ThermalPrinterPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == ThermalPrinterModule.NAME) {
      ThermalPrinterModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        ThermalPrinterModule.NAME to ReactModuleInfo(
          ThermalPrinterModule.NAME,
          ThermalPrinterModule::class.java.name,
          false,
          false,
          false,
          false
        )
      )
    }
  }
}
