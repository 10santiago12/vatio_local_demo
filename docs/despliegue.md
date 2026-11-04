# Despliegue en Render (paso a paso)

Esta guía despliega Vatio en Render con HTTPS y redespliegue automático. El dominio propio es opcional y se deja como paso final pendiente.

## Antes de empezar
- Los cambios deben estar en GitHub (`git push -u origin feat/mvp-completion` y, si lo decide el equipo, fusionar a `master`).
- Verificado localmente: la aplicación arranca en perfil de producción (`APP_ENV=production`), `/api/health` responde y el inicio de sesión funciona.

## 1. Generar los dos secretos
En PowerShell, ejecute dos veces (una por secreto) y guarde los valores en un lugar seguro:

```powershell
$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

- `VATIO_ADMIN_PASSWORD`: contraseña del usuario `admin` (mínimo 16 caracteres).
- `VATIO_DEVICE_KEY`: clave que usarán los dispositivos ESP32 (distinta de la anterior y sin valores conocidos).

En producción el servidor se niega a arrancar con valores débiles o iguales.

## 2. Crear el servicio
1. Cree una cuenta en https://render.com e inicie sesión con GitHub.
2. **New → Blueprint** y elija el repositorio `vatio_local_demo` y la rama a desplegar.
3. Render lee `render.yaml`. Cuando lo pida, escriba los valores de `VATIO_ADMIN_PASSWORD` y `VATIO_DEVICE_KEY`.
4. **Apply**. El primer despliegue tarda unos minutos.

## 3. Comprobar
1. Abra `https://<su-servicio>.onrender.com/api/health`: debe devolver `ok: true`.
2. Abra la dirección principal e inicie sesión como `admin` con `VATIO_ADMIN_PASSWORD`.
3. Cree los demás usuarios por rol desde la API de usuarios (ver `docs/api.md`).

## 4. Redespliegue automático (CI/CD)
Con `autoDeploy: true`, cada `push` a la rama configurada redespliega. Para volver atrás: en Render, **Events → Rollback** al despliegue anterior.

## 5. Dispositivos ESP32
- La URL de telemetría es `https://<su-servicio>.onrender.com/api/telemetry` con la cabecera `X-Device-Key`.
- El firmware actual usa HTTP. Para HTTPS hay que cambiar el cliente a `WiFiClientSecure` y apuntar a la URL anterior (no verificado con hardware).

## 6. Limitaciones del plan gratuito
- El servicio se duerme tras 15 minutos sin tráfico y tarda cerca de un minuto en despertar: ábralo antes de presentar.
- El sistema de archivos es efímero: la base SQLite se pierde en cada redespliegue o reinicio. Para conservar datos hace falta un disco persistente (plan de pago) o exportar los datos antes de redesplegar (endpoint de exportación en `docs/api.md`).
- Registros y métricas: use el panel **Logs** y **Metrics** de Render, y `docs/operaciones.md` (eventos, errores, métricas propias y respaldos). Descargue un respaldo con `GET /api/ops/backups/<nombre>/download` antes de cada redespliegue.

## 7. Dominio propio (PENDIENTE)
1. Compre un dominio en el registrador que prefiera.
2. En Render, **Settings → Custom Domains → Add**, y cree en el DNS el registro que Render indica (CNAME para subdominios).
3. Espere la verificación; el certificado HTTPS lo emite Render.
