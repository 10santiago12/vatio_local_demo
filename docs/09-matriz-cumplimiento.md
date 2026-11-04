# Matriz de cumplimiento (estado al 4 de noviembre de 2026)

Estado: **Listo** = implementado y probado. **API lista** = implementado y probado en la API; la interfaz web aún no lo conecta. **Pendiente** = no implementado.

| Requisito | Evidencia | Estado |
|---|---|---|
| Inicio de sesión, CSRF y roles | `backend/app/auth.js`, `backend/domain/permissions.js`, `tests/api/rbac.test.js` | Listo: 9 roles; permisos en la capa de aplicación; intentos denegados auditados |
| Clave de dispositivo | `backend/config.js`, `backend/http/telemetry.js` | Listo: obligatoria por entorno; sin rotación automática |
| Telemetría persistente e ingesta | `backend/app/ingestion.js`, migraciones 001-007 | Listo: idempotente, validación estricta, buffer sin conexión |
| Modelo de datos y DER | `docs/der.md`, `backend/db/migrations/` | Listo: 21 tablas, migraciones versionadas |
| Control seguro (RF-06, RF-07) | `backend/domain/control.js`, `tests/api/control.test.js` | API lista: aprobación explícita, crítica rechazada y auditada, solo monitoreo queda pendiente |
| Modo cierre y estado seguro (RF-12, RNF-18) | `backend/domain/control.js`, `backend/app/control.js` | API lista |
| Alertas y mantenimiento predictivo (RF-04, RF-15) | `backend/domain/alerts.js`, `backend/app/alerts.js` | API lista |
| Recomendaciones y puntaje (RF-05) | `backend/domain/recommendations.js` | API lista |
| Costo, tarifas y línea base (RF-02, RF-03) | `backend/domain/cost.js`, `baseline.js` | Listo en API |
| Ahorro, retorno y ahorro atribuible (RF-10, RF-14) | `backend/domain/savings.js`, `backend/app/value.js` | API lista |
| Reportes PDF, CSV y ODS 7 (RF-13, RF-16) | `backend/app/report-render.js`, `pdf.js` | API lista: valores idénticos a la API |
| Multisede y datos crudos (RF-09, RF-17, RNF-14) | `backend/domain/multisite.js`, `backend/app/data-exchange.js` | API lista: exportación y reimportación verificada |
| Módulos y fabricantes (RF-08, RNF-03) | `backend/adapters/manufacturers/`, `backend/app/modules.js` | API lista |
| Interfaz web conectada a la API | `public/app.js` | Parcial: lecturas en vivo reales; varias pantallas aún con datos de ejemplo |
| Pruebas | 288 pruebas (`npm test`) | Listo: unitarias del dominio, API e integración. Pruebas E2E, de navegador y de carga: pendientes (equipo de calidad) |
| Documentación | `README.md`, `docs/api.md`, `docs/der.md`, `docs/stack-y-arquitectura.md`, `docs/despliegue.md` | Listo |
| Integración externa (webhook, correo) | — | Pendiente |
| Registro de eventos, métricas y respaldo automático | — | Pendiente |
| TLS (RNF-09) y cifrado en reposo | — | TLS depende del hosting (HTTPS); cifrado en reposo no implementado |
| Despliegue | `render.yaml`, `docs/despliegue.md` | Pendiente de ejecutar (cuenta y dominio del usuario) |
