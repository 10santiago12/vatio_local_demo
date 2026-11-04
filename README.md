# VATIO - gestión energética para PyMEs (prototipo)

Vatio mide el consumo por equipo, lo traduce a pesos (COP), detecta anomalías y propone ahorros, con control de cargas siempre sujeto a aprobación humana y a reglas de criticidad. Este repositorio contiene el servidor Node.js (sin dependencias npm), la interfaz web, el firmware de un ESP32 que simula ocho medidores y la documentación técnica.

**Estado:** prototipo en desarrollo, no apto para operación real. Consulte [Limitaciones actuales](#limitaciones-actuales) y la matriz en [`docs/09-matriz-cumplimiento.md`](docs/09-matriz-cumplimiento.md).

## Requisitos

- Node.js 24 o superior (versión fijada en `.nvmrc` y `engines`). El servidor usa `node:sqlite`, que no existe en Node 20/22; con una versión anterior el inicio se detiene con un mensaje claro.
- Sin paquetes npm de ejecución: no hace falta `npm install`.
- Para el ESP32: Arduino IDE con el core de ESP32; PC y ESP32 en la misma red Wi-Fi.

## Ejecución local

1. Copie `.env.example` como `.env` y complete `VATIO_ADMIN_PASSWORD` (mínimo 16 caracteres) y `VATIO_DEVICE_KEY`. El servidor carga `.env` solo; las variables ya definidas en el sistema tienen prioridad.
2. Inicie:
   - Windows: doble clic en `start_windows.bat` (verifica Node 24 y avisa si falta `.env`).
   - Terminal: `npm start`.
3. Abra http://127.0.0.1:3000 e ingrese como `admin` con la contraseña de `VATIO_ADMIN_PASSWORD`.

La contraseña inicial solo se usa al crear el usuario: cambiar la variable después no cambia una contraseña existente. La base SQLite se crea y se migra automáticamente al iniciar en `data/vatio.sqlite` (ignorada por Git); no la borre si desea conservar datos.

## Variables de entorno

| Variable | Local | Producción |
|---|---|---|
| `APP_ENV` | `local` (por defecto) | `production` |
| `HOST` | `127.0.0.1` por defecto | `0.0.0.0` por defecto |
| `PORT` | `3000` por defecto | del entorno (por ejemplo `8080`) |
| `VATIO_ADMIN_PASSWORD` | Opcional; si se define, mínimo 16 caracteres | Obligatoria, mínimo 16 caracteres, no puede ser un valor conocido |
| `VATIO_DEVICE_KEY` | Opcional; sin ella se rechaza toda ingestión | Obligatoria, mínimo 16 caracteres, distinta de la contraseña |
| `VATIO_DB` | Opcional (`data/vatio.sqlite`) | Ruta persistente, por ejemplo `/var/lib/vatio/vatio.sqlite` |
| `VATIO_BACKUP_DIR` | Opcional (`data/backups`) | Carpeta de respaldos; con disco persistente, una ruta dentro de él |
| `VATIO_BACKUP_KEEP` | Opcional (`7`) | Cuántos respaldos conservar |
| `VATIO_BACKUP_INTERVAL_HOURS` | Opcional (`0`: sin respaldo programado) | Por defecto `6`; `0` lo apaga |
| `VATIO_ENV_FILE` | Opcional: ruta alterna del archivo `.env` | Igual |
| `VATIO_ALLOW_DEMO_SEED` | No necesaria | Debe ser `yes` para que `npm run seed:demo` se ejecute; nunca se carga sola |

Reglas de producción: las cookies de sesión siempre llevan `Secure` (sirva la aplicación detrás de HTTPS); si falta un secreto o es inseguro, el servidor no inicia y lista cada problema. En local la cookie también es `Secure` cuando el proxy envía `X-Forwarded-Proto: https`.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm start` | Inicia el servidor |
| `npm run check` | Revisa la sintaxis de todos los archivos JavaScript del repositorio |
| `npm run seed:demo` | Carga los datos de demostración (3 sedes, 11 cargas, 45 días de historial simulado); es idempotente y en producción exige `VATIO_ALLOW_DEMO_SEED=yes` |
| `npm run backup` | Crea un respaldo consistente de la base ahora (ver `docs/operaciones.md`) |
| `node scripts/restore.js <archivo> [--force]` | Restaura un respaldo verificado; la base anterior queda como `.before-restore` |
| `npm run der` | Regenera el diagrama entidad-relación en `docs/der.*` a partir del esquema |
| `npm test` | Ejecuta las pruebas con `node --test` (funciona en Windows) |

## Configurar el ESP32

El firmware `esp32/vatio_esp32_demo.ino` hace que una sola placa simule ocho medidores y envíe un lote cada 5 s.

1. Abra el archivo y cambie `WIFI_SSID`, `WIFI_PASSWORD` y `PC_IP` (la dirección de red local que imprime el servidor al iniciar, por ejemplo `192.168.1.45`). No use `localhost` ni `127.0.0.1`: dentro del ESP32 apuntarían a la propia placa.
2. Cambie `DEVICE_KEY` para que sea idéntica a `VATIO_DEVICE_KEY`. El valor de ejemplo del firmware es público: no lo use.
3. El servidor debe escuchar en la red: defina `HOST=0.0.0.0` (en producción ya es el valor por defecto).
4. En Arduino IDE seleccione `ESP32 Dev Module` (o su placa), el puerto, compile y suba. Abra el Monitor Serie a `115200`.

Salida esperada:

```text
POST http://192.168.1.45:3000/api/telemetry
HTTP status: 200
{"ok":true,"received":8,...}
```

### Si el ESP32 no llega al servidor

- Con un celular en la misma Wi-Fi abra `http://IP_DEL_PC:3000/api/health`. Si no abre, el problema es de red o firewall, no del ESP32.
- Firewall de Windows: cuando Node pida permiso, permita **redes privadas**, o cree una regla de entrada TCP para el puerto 3000.
- Algunas redes (invitados, universidades) aíslan a los clientes entre sí (`AP isolation`). Use una red doméstica, un hotspot o un router sin aislamiento.
- `401` en el Monitor Serie: la `DEVICE_KEY` del firmware no coincide con `VATIO_DEVICE_KEY`. `400`: el payload no es válido (ver abajo).

El firmware actual usa HTTP sin cifrar y no se ha verificado con hardware físico en este proyecto.

## API actual

Las rutas `/api/*` exigen sesión (cookie `vatio_session`), salvo las indicadas. Los métodos que modifican datos exigen además la cabecera `X-CSRF-Token` con el valor devuelto al iniciar sesión.

| Método y ruta | Autenticación | Descripción |
|---|---|---|
| `GET /api/health` | Ninguna | Estado del servicio y origen de datos (`simulator` o `esp32`) |
| `POST /api/auth/login` | Ninguna (10 intentos por minuto por IP) | Inicia sesión; devuelve `username`, `role`, `csrf` y la cookie |
| `GET /api/auth/me` | Sesión | Usuario de la sesión actual |
| `GET /api/info` | Sesión | URLs de red local para configurar el ESP32 |
| `GET /api/telemetry/latest` | Sesión | Últimas lecturas por módulo (las del simulador si ningún ESP32 ha reportado) |
| `GET /api/telemetry/history?limit=250` | Sesión | Últimas lecturas guardadas del ESP32 (máximo 1000) |
| `POST /api/telemetry` | Cabecera `X-Device-Key` | Ingestión: ESP32 o fabricantes simulados; hasta 100 lecturas por lote (1000 en una sincronización de búfer) |
| `POST /api/control/requests` | Sesión + CSRF | Registra una solicitud de apagado pendiente; rechaza y audita cargas críticas y pérdida de comunicación |
| `POST /api/reset` | Sesión + CSRF | Oculta las lecturas del ESP32 y vuelve a la vista del simulador (no borra datos guardados) |

Payload de `POST /api/telemetry`:

```json
{
  "gateway_id": "ESP32-DEMO-01",
  "site_id": "la-espiga-chia",
  "readings": [
    { "module_id": "MX-001", "load_id": "freezer", "load_name": "Congelador vertical",
      "manufacturer": "EnerSense", "voltage_v": 120.1, "current_a": 3.43,
      "power_w": 412, "energy_kwh": 0.123, "status": "active" }
  ]
}
```

Cada lectura se valida (números finitos, rangos, fecha dentro de los últimos 60 días y no futura), se normaliza y se guarda en `readings`; reenviar el mismo lote no duplica datos (se identifica por carga y marca de tiempo). Si falta `timestamp` o viene vacío, se usa la hora de recepción. Las lecturas inválidas se informan una a una en `rejected` y las válidas del mismo lote se guardan; si ninguna es válida la respuesta es `400`. En el perfil local un módulo desconocido se registra solo (con su carga, modo de solo monitoreo y criticidad esencial); en producción debe estar registrado. Si un módulo no reporta en más de 2 minutos pasa a `inactive`.

### Fabricantes simulados y búfer sin conexión

La ingestión normaliza dos formatos de fabricante al mismo modelo de lectura (RNF-03). Se indican con `"format"` o se detectan por su forma:

```json
{ "site_id": "la-espiga-chia", "format": "enersense",
  "readings": [ { "dev": "MX-001", "t": 1773261000, "v": 120.4, "i": 2.9, "p": 350.1, "e": 12.345, "st": "OK", "load": "freezer" } ] }

{ "site_id": "la-espiga-chia", "format": "voltiolab",
  "readings": [ { "meter": { "id": "MX-002", "state": "ONLINE" }, "sampled_at": "2026-03-11T20:30:00Z", "channel": "fridge",
                  "metrics": { "volts": 120.2, "milliamps": 3300, "watts": 395, "wh_total": 12345 } } ] }
```

Un módulo desconectado guarda sus lecturas y al reconectarse las envía con `"buffered": true` y `"expected": N`; la respuesta trae `sync.message`, por ejemplo "Se sincronizaron 600 lecturas, 0 perdidas".

## Datos de demostración y simulador

`npm run seed:demo` crea las sedes "Panadería La Espiga – Chía" (principal), "La Espiga – Cajicá" y "La Espiga – Zipaquirá", 11 cargas con su módulo (la Batidora nueva solo tiene 3 días de datos), la tarifa de 950 COP/kWh marcada como ejemplo, la inversión de 1.800.000 COP, el factor de emisión 0,126 kgCO2e/kWh con su fuente y 45 días de historial (lecturas de 1 minuto solo en los últimos 2 días; agregados por hora antes). Con la misma semilla y el mismo instante los datos son idénticos. No crea usuarios. La arquitectura del simulador está en `backend/adapters/` (reloj, simulador, fabricantes) y los casos de uso en `backend/app/`.

## Pruebas

```bash
npm run check
npm test
```

Cubren autenticación, clave de dispositivo, CSRF, rechazo de carga crítica, persistencia de telemetría tras reiniciar, configuración por perfiles (`.env`, producción segura, cookies), la guarda de versión de Node, el dominio, los relojes, el simulador y su historial, la normalización de fabricantes, la ingestión (validación, idempotencia, búfer sin conexión), la migración de la telemetría heredada y el script de datos de demostración. No constituyen todavía una validación completa de roles, interfaz, concurrencia o seguridad.

## Limitaciones actuales

- Solo existe el usuario administrador y una sede; los demás roles y la multisede están pendientes.
- Las solicitudes de control quedan pendientes: no hay aprobación, ejecución simulada ni modo cierre implementados.
- Varias vistas de la interfaz muestran ejemplos identificados como tales, no datos persistidos.
- Las lecturas, módulos y cargas ya se guardan en el esquema completo (simulador y ESP32); las alertas, recomendaciones y acciones de control todavía no se usan desde la API ni la interfaz.
- No se controla hardware físico; el firmware usa HTTP sin cifrar. No exponga el servidor a redes no confiables sin un proxy HTTPS.
- No hay pruebas E2E ni de carga todavía.

## Documentación

- [`docs/00-gap-analysis.md`](docs/00-gap-analysis.md): auditoría inicial.
- [`docs/der.md`](docs/der.md): modelo de datos, migraciones y diagrama entidad-relación.
- [`docs/09-matriz-cumplimiento.md`](docs/09-matriz-cumplimiento.md): estado de cumplimiento por requisito.
- [`docs/qa.md`](docs/qa.md): QA de interfaz (`cd qa && npm test`) y plantillas de dispositivo real y usabilidad; [`docs/qa-carga.md`](docs/qa-carga.md): pruebas de carga.
- [`.ai/HANDOFF.md`](.ai/HANDOFF.md): estado del trabajo y siguientes pasos.

## Documentación

- API: `docs/api.md` · Datos: `docs/der.md` · Stack y arquitectura: `docs/stack-y-arquitectura.md` · Despliegue: `docs/despliegue.md` · Cumplimiento: `docs/09-matriz-cumplimiento.md`.
