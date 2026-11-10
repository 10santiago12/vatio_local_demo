# Stack tecnológico y arquitectura

## Stack y justificación

| Capa | Elección | Por qué |
|---|---|---|
| Runtime | Node.js 24 (fijado en `.nvmrc` y `engines`) | Incluye `node:sqlite`, `node:test` y `node:crypto`; permite no depender de paquetes externos. |
| Servidor HTTP | Módulo `http` de Node, con un enrutador propio (`backend/http/`) | Superficie pequeña y auditable; sin dependencias que mantener ni vulnerabilidades heredadas. |
| Base de datos | SQLite (`node:sqlite`) con migraciones versionadas (`backend/db/migrations/`) | Un solo archivo, sin servidor aparte, adecuado para el piloto de una PyME; permite respaldo en línea. |
| Seguridad | scrypt con sal, consentimiento versionado para activar acceso, cookie HttpOnly y SameSite=Strict, CSRF, clave de dispositivo y 9 roles con permisos en la capa de aplicación | Cumple RNF-10; la autorización nunca depende solo de la interfaz. |
| Cliente | JavaScript sin framework, uPlot para gráficas, iconos Lucide y tipografía Manrope (todo local) | Funciona sin conexión a internet y sin proceso de compilación. |
| Pruebas | `node:test`, Playwright y escenarios de carga locales | Cobertura y resultados en [el informe QA](qa-informe.md). |
| Hardware | ESP32 con firmware Arduino que envía telemetría por HTTP con clave de dispositivo | Prototipo de bajo costo con módulos comerciales; ver RNF-17 sobre seguridad eléctrica. |

## Capas del backend

```
backend/
  domain/      Reglas puras (línea base, costo, alertas, recomendaciones, control seguro,
               ahorro, emisiones, multisede, permisos). Sin HTTP, base de datos ni reloj.
  app/         Casos de uso: ingesta, operaciones, control, valor, reportes, datos, usuarios.
  adapters/    Reloj (real y simulado), simulador con semilla, normalizadores de fabricantes.
  db/          Conexión, migraciones versionadas y repositorios (todo el SQL vive aquí).
  http/        Enrutador y manejadores por área; aplica sesión, CSRF y permisos.
  config.js    Perfiles local y producción, carga de .env, validaciones de seguridad.
```

Reglas de diseño:
- Las reglas de negocio están en `domain/` y se prueban sin servidor ni base de datos.
- Toda decisión de permiso se toma en la capa de aplicación; los intentos denegados quedan en la auditoría.
- Ninguna carga crítica se apaga; las cargas en solo monitoreo nunca ejecutan acciones; sin comunicación por más de 5 minutos la carga sigue energizada y se descartan las acciones pendientes.
- Los datos reales (ESP32) y simulados entran por el mismo caso de uso de ingesta; dos formatos de fabricante se normalizan a un solo modelo (RNF-03).

## Trazabilidad con la rúbrica

| Criterio | Evidencia |
|---|---|
| Stack tecnológico | Este documento, `package.json`, `.nvmrc` |
| Modelo de datos (DER) | `docs/der.md`, `docs/der.svg`, `backend/db/migrations/` |
| Diseño de APIs / Webhooks | `docs/api.md` (todos los endpoints, verificado contra el enrutador por una prueba) |
| Seguridad y Auth | `backend/domain/permissions.js`, `backend/app/auth.js`, `tests/api/rbac.test.js` |
| Despliegue | `render.yaml`, `docs/despliegue.md` |

## Limitaciones conocidas

- La interfaz web todavía muestra lecturas en vivo y datos de ejemplo en varias pantallas; la API ya expone los datos reales de alertas, recomendaciones, control, ahorro y reportes.
- No hay integración con servicios externos (webhook o correo), registro de eventos ni respaldo automático.
- La base de datos no se cifra en reposo; el cifrado en tránsito depende de HTTPS en el hosting (RNF-09).
- El hardware ESP32 no se ha verificado con un dispositivo físico.
