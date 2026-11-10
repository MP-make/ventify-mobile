# Ventify Mobile 📱

App móvil de **Ventify POS**: cliente React + Vite empaquetado con Capacitor para Android.
Es un proyecto **independiente** del repositorio web principal (`Arcay322/Ventify`), pensado
para iterar la app móvil sin tocar el código del portal Next.js.

---

## Stack

| Capa | Tecnología |
| --- | --- |
| UI | React 18 + TypeScript |
| Bundler | Vite 8 |
| Estilos | TailwindCSS 3 (+ `tailwindcss-animate`) |
| Backend | Firebase Auth / Firestore (persistencia local habilitada) |
| Escaneo | `@zxing/browser` (cámara) |
| Nativo | Capacitor 8 → Android (Kotlin/Java) |
| Impresión | Plugin nativo propio `ThermalPrinter` (ESC/POS, Bluetooth) |

---

## Estructura

```
.
├── index.html                 # Entry point de Vite
├── vite.config.mts            # Build web → dist/
├── capacitor.config.ts        # Config de Capacitor (webDir: dist)
├── src/
│   ├── App.tsx                # Shell principal (tabs, PIN lock, listeners)
│   ├── main.tsx
│   ├── firebase.ts            # Init de Firebase (cache persistente)
│   ├── components/            # Header, BottomNav, modales, scanner…
│   ├── context/               # Auth, Cart, Products, Settings
│   ├── views/                 # POS, Catálogo, Inventario, Historial, Ajustes, Login
│   ├── services/              # Impresora térmica, notificaciones
│   └── lib/printing/          # escpos-builder.ts (generador ESC/POS)
├── public/                    # Assets estáticos
├── android/                   # Proyecto Android generado por Capacitor
│   └── app/src/main/java/pe/com/ventify/pos/
│       ├── MainActivity.java
│       └── ThermalPrinterPlugin.java
└── releases/                  # APKs compilados
```

`android/capacitor.settings.gradle` apunta a `../node_modules/@capacitor/*`, por eso
`node_modules` **debe** estar en la raíz del repo (estructura ya preparada así).

---

## Puesta en marcha

```bash
npm install
cp .env.example .env      # completar credenciales de Firebase
npm run dev               # http://localhost:5173
```

### Compilar la web

```bash
npm run build             # genera dist/
npm run preview           # sirve dist/ para probar
```

### Android

Requisitos: **JDK 21** (Capacitor 8 lo exige al compilar los plugins), Android SDK
(`ANDROID_HOME`) y `android/local.properties` con `sdk.dir=/ruta/al/Android/Sdk`.
Si tienes varias JDKs instaladas, exporta `JAVA_HOME` apuntando a la 21 antes de Gradle:

```bash
export JAVA_HOME=$HOME/jdks/jdk-21.0.13+9   # ajusta a tu ruta
```

```bash
npm run cap:sync          # build web + copia assets y regenera plugins Android
npm run apk:debug         # APK de depuración → android/app/build/outputs/apk/debug/
npm run apk:release       # APK de release (requiere keystore configurado)
npm run cap:open          # abre Android Studio
```

> `cap:sync` es obligatorio al menos una vez (y después de cambiar plugins): genera
> `android/capacitor-cordova-android-plugins/`, que no se versiona. Sin ese paso Gradle
> falla con `cordova.variables.gradle ... does not exist`.

> El APK compilado del último build está en `releases/`.

---

## Variables de entorno

Se inyectan en **tiempo de build** vía `define` en `vite.config.ts` (por eso el prefijo
`NEXT_PUBLIC_`, para mantener compatibilidad con el `.env` del proyecto web):

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`
- `NEXT_PUBLIC_APP_URL` (opcional)

⚠️ Las claves de Firebase quedan embebidas en el bundle. Son claves públicas de cliente;
la seguridad real depende de `firestore.rules` (que vive en el repo web).

---

## Notas de migración

- `mobile/src` importaba `@/lib/printing/escpos-builder` del repo web; el archivo se copió
  a `src/lib/printing/escpos-builder.ts` y el alias `@` ahora resuelve a `./src`.
  Ese generador depende de `../invoicing/types`, así que también se copió a
  `src/lib/invoicing/types.ts` (archivo autónomo, solo tipos y constantes SUNAT).
- `vite.config.ts` pasó a `vite.config.mts` para cargarse como ESM (sin `__dirname`).
- El build ya no escribe en `../out` ni depende de la raíz del repo web: usa `./dist`
  (y `capacitor.config.ts` apunta a `dist`).
- Se agregó la animación `shake` faltante (usada en el modal de PIN) al
  `tailwind.config.js`.
- Se quitó de `android/build.gradle` el bloque `subprojects { compileOptions 17 }`:
  los plugins de Capacitor 8 exigen Java 21 + `jvmToolchain(21)` y el override a 17
  rompía el build (`Inconsistent JVM-target compatibility`).
- Versiones de Capacitor: `@capacitor/core` y `@capacitor/android` **8.6.0**,
  `@capacitor/cli` **7.x**. Es la combinación con la que se generó y compiló el
  proyecto Android actual; si se sube el CLI a 8 conviene regenerar `android/` con
  `npx cap sync` y validar el build.
