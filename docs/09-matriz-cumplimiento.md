# Matriz de cumplimiento de Vatio

Actualización del 10 de noviembre de 2026. «API lista» indica que la función se probó en el servidor y que su conexión a la interfaz puede seguir pendiente.

| Requisito | Evidencia | Estado |
|---|---|---|
| Inicio de sesión, CSRF y roles (RNF-10) | `backend/app/auth.js`, `backend/domain/permissions.js`, `tests/api/rbac.test.js` | Listo en API. Nueve roles y denegaciones auditadas. |
| Clave de dispositivo | `backend/config.js`, `backend/http/telemetry.js` | Listo por entorno, sin rotación automática. |
| Telemetría persistente e ingesta (RF-01) | `backend/app/ingestion.js`, migraciones 001–007 | Listo en API. Validación, persistencia e idempotencia. |
| Búfer sin conexión (RNF-08) | `tests/ingestion.test.js:181`, `backend/adapters/simulator/module-fleet.js:80`, `esp32/vatio_esp32_demo.ino:209` | Parcial. Recuperación probada en simulador y API, pendiente en firmware. |
| Modelo de datos y DER | `docs/der.md`, `backend/db/migrations/` | Listo. 22 tablas y migraciones 001–010. |
| Control seguro y modo cierre (RF-06/07/12, RNF-18) | `backend/domain/control.js:55`, `tests/api/control.test.js:137` | API lista en simulación. Inactivo tras 120 s, estado seguro tras 300 s o sin reporte previo. |
| Alertas y mantenimiento (RF-04/15) | `backend/domain/alerts.js`, `backend/app/alerts.js` | API lista. |
| Recomendaciones y puntaje (RF-05) | `backend/app/recommendations.js` | API lista. |
| Costo, tarifas y línea base (RF-02/03) | `backend/domain/cost.js`, `backend/domain/baseline.js`, `backend/app/analytics.js` | API lista. |
| Ahorro, retorno y ahorro atribuible (RF-10/14) | `backend/domain/savings.js`, `backend/app/value.js` | API lista. |
| Reportes PDF, CSV y ODS 7 (RF-13/16) | `backend/app/report-render.js`, `backend/app/pdf.js` | API lista. La verificación de extracción PDF se omitió en el entorno sin `pdftotext`. |
| Multisede y datos crudos (RF-09/17, RNF-14) | `backend/domain/multisite.js`, `backend/app/data-exchange.js:16`, `tests/api/data.test.js` | API lista para exportar y reimportar. Anonimización parcial: excluye campos de cuenta y conserva identificadores operativos. |
| Módulos y fabricantes (RF-08, RNF-03) | `backend/adapters/manufacturers/`, `backend/app/modules.js` | API lista. |
| Interfaz web conectada a la API | `public/app.js`, [informe QA](qa-informe.md) | Parcial. Lecturas en vivo desde API y varias pantallas con ejemplos. |
| Pruebas | [Informe QA](qa-informe.md), [carga](qa-carga.md) | 307 pruebas Node y 53 E2E aprobadas. Carga RNF-01 y RNF-02 aprobada en local. Pruebas de usabilidad y de los cambios en dispositivos físicos pendientes. |
| Consentimiento | `backend/app/consent.js:8`, `backend/db/migrations/010_consents.sql:2`, `tests/api/privacy.test.js:6` | Listo en prototipo. Dos aceptaciones al activar, prueba por versiones. |
| Derechos y páginas públicas | `backend/http/privacy.js:12`, [Habeas Data](habeas-data.md) | Parcial. Consulta propia auditada y documentos públicos. Rectificación y supresión manuales cuando se habilite el canal. |
| Sugerencias y PQR | `public/app.js:309`, `render.yaml`, [guía](forms-feedback-guia.md) | Parcial. Enlace y estado sin configuración probados. URL real y correo por confirmar. |
| Integración externa (webhook o notificación) | [Habeas Data](habeas-data.md) | Pendiente. El enlace de Forms no integra almacenamiento ni seguimiento en Vatio. |
| Registro, incidentes y métricas | `backend/runtime.js`, `backend/ops/request-log.js`, `docs/operaciones.md` | Parcial. Auditoría, eventos, errores y métricas disponibles. Gestión formal de incidentes y notificaciones pendiente. |
| Respaldo y retención | `backend/ops/backup.js:53`, `backend/app/ingestion.js:208` | Parcial. Copias rotadas y agregación de telemetría. Sin ciclo de vida aprobado para datos personales. |
| TLS y cifrado en reposo (RNF-09) | `esp32/vatio_esp32_demo.ino:213`, `backend/db/connection.js`, [despliegue](despliegue.md) | Parcial en tránsito: HTTPS observado en Render, ESP32 por HTTP. Cifrado en reposo sin implementar en la aplicación. |
| Despliegue | `render.yaml`, [despliegue](despliegue.md) | El servicio existente respondió al chequeo de salud. La rama QA y Habeas Data permanece local. |
