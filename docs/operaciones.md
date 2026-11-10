# Operación: registros, eventos, errores, métricas y respaldos

Guía para quien opera Vatio. Todo lo de esta página es solo para el perfil **dueño** (`view_ops` y `manage_backups`); cualquier otro perfil recibe 403 y el intento queda en la auditoría.

## Registros (logs)
- Cada solicitud escribe **una línea JSON** en la salida estándar: `at`, `request_id`, `method`, `path` (sin parámetros de la URL), `status`, `ms` y `role`. Nunca se registran contraseñas, cookies, tokens, claves ni cuerpos de solicitud.
- Cada respuesta incluye el encabezado `X-Request-Id`. Si una persona reporta un problema, pídale ese valor y búsquelo en los logs (en Render, panel **Logs**) y en `GET /api/ops/errors`.

- Si falta `VATIO_FEEDBACK_URL`, el servidor registra una advertencia `feedback_unconfigured` al arrancar. La interfaz indica «Canal no configurado».
- Cada consulta exitosa de datos propios queda en `audit` como `personal_data_accessed`.

## Eventos de uso
Se guardan en la tabla `events`: inicio de sesión correcto y fallido, cierre de sesión, alerta creada y revisada, decisión sobre una recomendación, decisión de control (ejecutada, rechazada, pendiente, descartada), descarga de reporte, exportación de datos, respaldo creado o fallido y vistas de página enviadas por la interfaz (`POST /api/events`, con lista fija de nombres y máximo 60 por minuto por usuario). Los eventos no guardan secretos.

Consulta: `GET /api/ops/events?name=login_failed&from=2026-11-01&to=2026-11-04&limit=50`.

## Errores
Un error no controlado se guarda en `error_log` (mensaje, traza, ruta, `request_id` y perfil) y la persona usuaria solo ve un mensaje genérico en español. Consulta: `GET /api/ops/errors?limit=20`.

## Métricas
`GET /api/ops/metrics` devuelve tiempo activo, solicitudes por clase de estado (2xx a 5xx), latencia p50 y p95 (últimas 1000 solicitudes), tamaño de la base, sesiones activas y hora y estado del último respaldo. Los contadores viven en memoria: se reinician con el proceso.

## Respaldos
- Se usa la copia en línea de SQLite. Incluye datos de cuenta, actividad y pruebas de consentimiento, por lo que requiere acceso restringido. La copia es consistente aunque el servidor esté escribiendo. Cada copia pasa `PRAGMA integrity_check` y tiene un archivo `.sha256` al lado.
- Archivos: `VATIO_BACKUP_DIR` (por defecto `data/backups`), nombre `vatio-AAAAMMDD-HHMMSSmmm.sqlite`. Se conservan los últimos `VATIO_BACKUP_KEEP` (7).
- Programación dentro del servidor: `VATIO_BACKUP_INTERVAL_HOURS` (0 = apagada; si no se define, 0 en local y 6 en producción). Con la programación activa se crea además un respaldo al arrancar si no hay ninguno.
- A mano: `npm run backup`, o `POST /api/ops/backups` (dueño). Lista: `GET /api/ops/backups`. Descarga: `GET /api/ops/backups/<nombre>/download`.

## Qué se pierde en el plan gratuito de Render
El disco es **efímero**: en cada redespliegue o reinicio se pierden la base y también la carpeta de respaldos. Un respaldo guardado en el mismo disco no protege de eso. Mitigación:
1. **Descargue copias fuera del servidor** con el endpoint de descarga (guarde el `.sqlite` y, si puede, su `.sha256`), por ejemplo antes de cada redespliegue y una vez al día en una demo larga.
2. Para datos que importan, use un **disco persistente** (plan de pago), monte el disco (por ejemplo en `/var/data`) y defina `VATIO_DB=/var/data/vatio.sqlite` y `VATIO_BACKUP_DIR=/var/data/backups`.

## Restaurar paso a paso
1. Detenga el servidor (en Render: suspenda el servicio o use una sesión de shell si el plan la tiene; en local, cierre `npm start`).
2. Ponga el archivo de respaldo en el equipo donde corre la base (si lo descargó, súbalo al disco persistente o déjelo en una carpeta local). Si tiene el `.sha256`, déjelo junto al archivo.
3. Ejecute: `node scripts/restore.js ruta/al/vatio-AAAAMMDD-HHMMSSmmm.sqlite`. Verifica integridad y suma SHA-256; si ya existe una base, se niega y pide `--force`.
4. Con `--force` la base reemplazada queda como `<base>.before-restore`.
5. Inicie el servidor y compruebe `/api/health` e inicie sesión. Si algo salió mal, devuelva `<base>.before-restore` a su nombre original.

En el plan gratuito sin shell, la restauración se hace en el arranque de un servicio con disco: lo práctico es restaurar localmente, comprobar los datos y volver a sembrar la demo en Render.

## Correo de prueba

El dueño puede comprobar el SMTP configurado desde Configuración. Se auditan `email_test_sent` y `email_test_failed` sin registrar credenciales ni destinatarios. La aceptación por SMTP no prueba la llegada al buzón. Véase `docs/despliegue.md`.

Proveedor seleccionado para la primera configuración: Brevo SMTP, host `smtp-relay.brevo.com`, puerto 587 con STARTTLS. Use el usuario y la clave SMTP de la cuenta (no la API key) y un remitente autenticado. La activación y prueba requieren una cuenta del equipo, dominio/remitente verificado y dirección destinataria. Referencia: https://developers.brevo.com/docs/smtp-integration.
