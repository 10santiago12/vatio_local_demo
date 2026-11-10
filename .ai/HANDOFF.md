# Vatio QA y Habeas Data

- Base: `ca5f6b6` (`feat/mvp-completion`), 186 archivos versionados verificados contra `Proyecto.zip`. Rama local: `feat/qa-habeas-data`.
- Activación con las dos aceptaciones, migración 010, páginas públicas, datos propios auditados y enlaces externos de sugerencias y PQR. Ver `docs/habeas-data.md` y `docs/api.md`.
- Node: 307 aprobadas, 3 omitidas sin `pdftotext`. Sintaxis: 139 archivos. Playwright: 53 aprobadas, 10 casos móviles omitidos en escritorio. Carga local: RNF-01/02 aprobados. Render: solo chequeo de salud TLS 1.2.
- Entregables en `docs/entrega/`. Capturas en `docs/qa-evidencia/`. Los resultados y límites están en `docs/qa-informe.md`.
- Para habilitar el canal en el servicio desplegado: confirmar responsable, revisión institucional y correo. El Forms ya está creado en la cuenta seleccionada. Usar `docs/forms-feedback-guia.md`. Preservar consentimientos en almacenamiento persistente si se despliega.

## Actualización del 10 de noviembre

El formulario de borrador se publicó en Google Forms. El enlace público de respuesta es https://docs.google.com/forms/d/e/1FAIpQLSdE0YHreDJoHdrcJX-PrvWy9xi7G6BLfXf5Io0jRO9HgJXF8A/viewform?usp=publish-editor. La hoja de respuestas se vinculó y se activaron notificaciones a la cuenta creadora. La identidad del responsable, la política y el correo PQR están [POR CONFIRMAR]. La rama publicada requiere revisión y despliegue antes de usar este enlace en el servicio remoto.

## Avance en feat/completar-entrega

- Alertas, recomendaciones y control simulado conectados a la API. SMTP de prueba con TLS y permisos preparado, sin cuenta real.
- Pendientes: cifrado de SQLite y respaldos, conexión de otras vistas, proveedor y destinatario SMTP, política y responsable de datos, validación final y seguimiento PQR.
