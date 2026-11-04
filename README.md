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

La contraseña inicial solo se usa al crear el usuario: cambiar la variable después no cambia una contraseña existente. La base SQLite se crea en `data/vatio.sqlite` (ignorada por Git); no la borre si desea conservar datos.

## Variables de entorno

| Variable | Local | Producción |
|---|---|---|
| `APP_ENV` | `local` (por defecto) | `production` |
| `HOST` | `127.0.0.1` por defecto | `0.0.0.0` por defecto |
| `PORT` | `3000` por defecto | del entorno (por ejemplo `8080`) |
| `VATIO_ADMIN_PASSWORD` | Opcional; si se define, mínimo 16 caracteres | Obligatoria, mínimo 16 caracteres, no puede ser un valor conocido |
| `VATIO_DEVICE_KEY` | Opcional; sin ella se rechaza toda ingestión | Obligatoria, mínimo 16 caracteres, distinta de la contraseña |
| `VATIO_DB` | Opcional (`data/vatio.sqlite`) | Ruta persistente, por ejemplo `/var/lib/vatio/vatio.sqlite` |
| `VATIO_ENV_FILE` | Opcional: ruta alterna del archivo `.env` | Igual |

Reglas de producción: las cookies de sesión siempre llevan `Secure` (sirva la aplicación detrás de HTTPS); si falta un secreto o es inseguro, el servidor no inicia y lista cada problema. En local la cookie también es `Secure` cuando el proxy envía `X-Forwarded-Proto: https`.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm start` | Inicia el servidor |
| `npm run check` | Revisa la sintaxis de todos los archivos JavaScript del repositorio |
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
| `GET /api/telemetry/latest` | Sesión | Últimas lecturas por módulo (simuladas si no hay ESP32) |
| `GET /api/telemetry/history?limit=250` | Sesión | Histórico reciente en memoria (máximo 1000) |
| `POST /api/telemetry` | Cabecera `X-Device-Key` | Ingestión desde el ESP32; hasta 100 lecturas por lote |
| `POST /api/control/requests` | Sesión + CSRF | Registra una solicitud de apagado pendiente; rechaza y audita cargas críticas y pérdida de comunicación |
| `POST /api/reset` | Sesión + CSRF | Borra las lecturas en memoria y vuelve al simulador |

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

Si un módulo no reporta en más de 120 s se muestra como `inactive`.

## Pruebas

```bash
npm run check
npm test
```

Cubren autenticación, clave de dispositivo, CSRF, rechazo de carga crítica, persistencia de telemetría tras reiniciar, configuración por perfiles (`.env`, producción segura, cookies) y la guarda de versión de Node. No constituyen todavía una validación completa de roles, interfaz, concurrencia o seguridad.

## Limitaciones actuales

- Solo existe el usuario administrador y una sede; los demás roles y la multisede están pendientes.
- Las solicitudes de control quedan pendientes: no hay aprobación, ejecución simulada ni modo cierre implementados.
- Varias vistas de la interfaz muestran ejemplos identificados como tales, no datos persistidos.
- No hay migraciones versionadas todavía (el esquema se crea al iniciar).
- No se controla hardware físico; el firmware usa HTTP sin cifrar. No exponga el servidor a redes no confiables sin un proxy HTTPS.
- No hay pruebas E2E ni de carga todavía.

## Documentación

- [`docs/00-gap-analysis.md`](docs/00-gap-analysis.md): auditoría inicial.
- [`docs/09-matriz-cumplimiento.md`](docs/09-matriz-cumplimiento.md): estado de cumplimiento por requisito.
- [`.ai/HANDOFF.md`](.ai/HANDOFF.md): estado del trabajo y siguientes pasos.
