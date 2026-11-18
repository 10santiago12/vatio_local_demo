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

## Avance funcional 18 de noviembre
- Inicio, operaciones, ahorro, reportes, módulos, datos y multisede consultan la API; Configuración guarda parámetros y permite al dueño crear/descargar respaldos.
- `npm run check`: 141/141; `npm test`: 311 aprobadas, 3 omitidas; Chromium: 10 aprobadas, 2 omitidas, más prueba focalizada de las vistas aprobada.
- Render respondió HTTPS 200 con certificado válido. La base y los respaldos aún no están cifrados en reposo; el plan gratuito tiene almacenamiento efímero. No se efectuó un despliegue nuevo.
- SMTP requiere cuenta y destinatario reales; PQR y responsable de datos siguen pendientes. Firmware ESP32 HTTP: prueba aislada preparada en work/esp32_prueba, COM9, pendiente de carga y confirmación. No incluir secretos en Git.
- Prueba física del ESP32 el 18 de noviembre: COM9, Wi-Fi 2,4 GHz; servidor aislado de pruebas en 192.168.10.6:3000 recibió POST /api/telemetry con HTTP 200 aproximadamente cada 5 s. SQLite confirmó origen esp32 y ocho módulos MX-001 a MX-008 con lecturas variables. Los valores son simulados; enlace HTTP sin cifrar. Credenciales y base de pruebas permanecen fuera del repositorio.

## Estado confirmado posteriormente
- Dominio vatio.lat con HTTPS y enlaces de formulario y correo PQR configurados. El usuario confirmó que recibió un mensaje de prueba reenviado; SMTP saliente continúa sin configurar.
- El usuario informó que la política fue aprobada, pero no dispone del documento aprobado. Se actualizó el borrador con el responsable, vigencia del 18 de noviembre de 2026 y plazo de un mes para PQR y respuestas del formulario. Se corrigió la descripción del formulario externo y se confirmó en su vista pública. La rutina de retención de `integrations/forms/retencion.gs` tiene pruebas locales, pero no está instalada ni activa; falta aplicarla y comprobarla en Forms, la hoja, el correo y las copias.
- La base en Render gratuito sigue en almacenamiento efímero; persistencia gratuita y protección en reposo pendientes.
