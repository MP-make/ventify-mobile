# `nextjs-mobile-route` (solo referencia)

Copia de la implementación móvil que vivía dentro del repositorio web de Ventify, en:

```
src/app/(operational)/mobile/
```

## Importante

- **No forma parte del build** de este proyecto. `tsconfig.json` excluye `legacy/`.
- **No compila de forma aislada**: importa componentes, contextos, servicios y estilos del
  proyecto Next.js original (`@/components/...`, `@/contexts/...`, `@/hooks/...`).
- Se conserva únicamente como referencia funcional para portar pantallas y lógica hacia la
  app Vite + Capacitor (`src/`).

## Contenido

| Ruta | Descripción |
| --- | --- |
| `page.tsx` | Punto de entrada / POS |
| `layout.tsx` | Layout móvil |
| `pos/`, `catalog/`, `inventory/`, `history/`, `settings/` | Pantallas por pestaña |
| `components/` | Header, nav, login, PIN lock, quick stock, shoot-to-scan, weight quantity |
| `contexts/` | Carrito móvil y contexto de impresora |
| `services/mobile-cache-service.ts` | Caché local de datos |
