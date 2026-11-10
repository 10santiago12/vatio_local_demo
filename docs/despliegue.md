# Despliegue en Render (paso a paso)

Esta guía despliega Vatio en Render con HTTPS y redespliegue automático. El dominio propio es opcional y se deja como paso final pendiente.

## Antes de empezar
- Use la rama aprobada por el equipo para desplegar. Los cambios de QA y Habeas Data se verificaron en una rama local.
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

## 4. Sugerencias y PQR

- `VATIO_FEEDBACK_URL` recibe el enlace público de **respuesta** del Forms, con HTTPS, sin datos personales ni permisos de edición. `VATIO_PQR_EMAIL` recibe una sola dirección de contacto. En local van en `.env`. En Render van en **Environment**, y el Blueprint las declara con `sync: false`.
- Valores reales [POR CONFIRMAR]. Siga la [guía del formulario](forms-feedback-guia.md) y verifique el enlace en una ventana privada sin iniciar sesión. Con la URL vacía, la interfaz muestra «Canal no configurado» y el arranque registra `feedback_unconfigured`.
- El primer ingreso requiere las dos aceptaciones de los documentos vigentes. Antes de recopilar datos personales, confirme la identidad del responsable, el aviso, el destino de las respuestas y la conservación de las pruebas de autorización. La base SQLite del plan gratuito se pierde al reiniciar o redesplegar. El despliegue que deba conservar autorizaciones requiere almacenamiento persistente y una política de respaldo.
- El 10 de noviembre de 2026, `GET /api/health` en el servicio existente respondió HTTP 200 con TLS 1.2. La verificación no cubre el enlace del firmware ESP32, que usa HTTP, ni acredita que esta rama esté desplegada.

## 5. Redespliegue y reversión

Con `autoDeploy: true`, cada `push` a la rama configurada redespliega. Para volver atrás: en Render, **Events → Rollback** al despliegue anterior.

## 6. Dispositivos ESP32
- La URL de telemetría es `https://<su-servicio>.onrender.com/api/telemetry` con la cabecera `X-Device-Key`.
- El firmware actual usa HTTP. Para HTTPS hay que cambiar el cliente a `WiFiClientSecure` y apuntar a la URL anterior (no verificado con hardware).

## 7. Limitaciones del plan gratuito
- El servicio se duerme tras 15 minutos sin tráfico y tarda cerca de un minuto en despertar: ábralo antes de presentar.
- El sistema de archivos es efímero: la base SQLite se pierde en cada redespliegue o reinicio. Para conservar datos hace falta un disco persistente (plan de pago) o exportar los datos antes de redesplegar (endpoint de exportación en `docs/api.md`).
- Registros y métricas: use el panel **Logs** y **Metrics** de Render, y `docs/operaciones.md` (eventos, errores, métricas propias y respaldos). Descargue un respaldo con `GET /api/ops/backups/<nombre>/download` antes de cada redespliegue.

## 8. Dominio propio (PENDIENTE)
1. Compre un dominio en el registrador que prefiera.
2. En Render, **Settings → Custom Domains → Add**, y cree en el DNS el registro que Render indica (CNAME para subdominios).
3. Espere la verificación; el certificado HTTPS lo emite Render.
