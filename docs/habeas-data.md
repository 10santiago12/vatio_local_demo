# Protección de datos personales y términos de Vatio

Capstone Design Project · Universidad de La Sabana · 10 de noviembre de 2026

**Borrador académico. No constituye asesoría jurídica.** La versión técnica de la política y de los términos es **2026-11-10.1**. La adopción formal, el responsable y los canales de atención requieren confirmación antes de recopilar datos reales.

## 1 Política de tratamiento de datos personales

El responsable, su domicilio y el correo de PQR quedan [POR CONFIRMAR]. Vatio usa el nombre de usuario, nombre visible, rol, vínculos con sedes, estado y fechas de cuenta para gestionar el acceso. Almacena hash y sal para comprobar la contraseña. Registra acciones de auditoría y eventos de uso. Los datos energéticos y operativos sirven para monitoreo, análisis y reportes. Si se habilita un formulario externo, su aviso debe explicar qué recoge, quién tiene acceso y cómo tramita cada solicitud.

El titular puede conocer, actualizar y rectificar sus datos, solicitar prueba de autorización o información sobre su uso y pedir supresión o revocatoria cuando proceda. Tras agotar el trámite ante el responsable o encargado puede acudir a la SIC. Desde el pie de página autenticado puede consultar el perfil, sus sedes, las autorizaciones y el resumen de los últimos 100 registros por fuente de actividad. Para registros históricos completos, rectificación, supresión y revocatoria se prevé un trámite manual por el canal que el equipo habilite.

| Trámite | Gestión manual propuesta |
|---|---|
| Consulta | Registrar la fecha de recibo, verificar la legitimación de forma proporcionada y responder en hasta 10 días hábiles desde el recibo. Si se requiere una prórroga, informar el motivo y la nueva fecha antes del vencimiento, con hasta 5 días hábiles adicionales. |
| Reclamo | Registrar el recibo y tramitar en hasta 15 días hábiles desde el día siguiente al recibo. Si falta información, requerirla dentro de 5 días. Si pasan 2 meses sin subsanación, se entiende desistido. Si el receptor carece de competencia, trasladar en hasta 2 días hábiles e informar. Al completarse, anotar «reclamo en trámite» en hasta 2 días hábiles. Si se requiere una prórroga, informar el motivo y la nueva fecha antes del vencimiento, con hasta 8 días hábiles adicionales. |
| Cierre y conservación | Documentar la respuesta y, según corresponda, ejecutar la corrección o supresión autorizada. Confirmar con el responsable los plazos, la gestión de copias y la fecha de vigencia formal [POR CONFIRMAR]. |

Fuente de los derechos y plazos: [Ley 1581 de 2012, artículos 8, 14, 15 y 16](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981).

## 2 Aviso de privacidad y autorización electrónica

El aviso, la política y los términos son [páginas públicas](../public/aviso-de-privacidad.html) y se enlazan desde el login y el pie. En el primer ingreso con credenciales válidas, o al cambiar la versión de uno de los documentos, el titular debe marcar dos casillas independientes, inicialmente vacías. El servidor exige los dos booleanos verdaderos y las versiones vigentes para abrir la sesión. No se generan consentimientos retroactivos.

La [migración 010](../backend/db/migrations/010_consents.sql#L1) conserva una fila por aceptación de un par de versiones. Una nueva aceptación con otras versiones se agrega sin sobrescribir la anterior. Los reintentos del mismo par son idempotentes. Se registra usuario, fecha UTC, IP del par TCP, agente de usuario, versiones y ambas decisiones. IP y agente de usuario dan contexto probatorio de la solicitud, no acreditan por sí solos identidad. En un proxy la IP registrada puede corresponder al intermediario. El agente de usuario procede del navegador y se limita a 512 caracteres.

`GET /api/me/personal-data` deriva el titular de la sesión y audita cada acceso exitoso. Devuelve datos de cuenta, vínculos con sedes, pruebas de autorización y resúmenes recientes. Las credenciales, las sales y los detalles internos quedan fuera de la respuesta.

## 3 Términos y condiciones de uso

Vatio es un prototipo de apoyo a la gestión energética. Los cálculos de ahorro y retorno son estimaciones para uso interno, no sustituyen la facturación del comercializador y no garantizan un ahorro fijo ni un nivel de disponibilidad. El usuario debe proteger su cuenta y operar según el perfil asignado. El control de cargas y el estado seguro se comprueban en software simulado. La operación e instalación eléctrica corresponden a personal autorizado.

## 4 Sugerencias y PQR

El acceso «Sugerencias / Reportar un problema» está en la barra lateral de escritorio, el menú Más en móvil, el pie de las 12 vistas y el login. Abre el enlace HTTPS de respuesta en otra pestaña. Vatio no agrega datos personales a la URL. Si falta `VATIO_FEEDBACK_URL`, se informa «Canal no configurado» y se registra una advertencia de arranque. El correo se enlaza si existe `VATIO_PQR_EMAIL`.

Se entregó la [guía para crear el Forms y su hoja de respuestas](forms-feedback-guia.md). El formulario de borrador está publicado y vinculado a una hoja de respuestas de la cuenta que lo creó. El buzón, el responsable, la política y la custodia requieren confirmación institucional. Vatio no almacena envíos de soporte ni dispone de un formulario interno, bandeja, estados o plazos automatizados.

## 5 Verificación técnica

Los estados corresponden al prototipo y a la evidencia indicada. No equivalen a una certificación legal.

| Afirmación | Estado y evidencia |
|---|---|
| Consentimiento y consulta del titular | CUMPLE el flujo probado de activación y consulta propia. [Validación](../backend/app/consent.js#L8), [migración](../backend/db/migrations/010_consents.sql#L2), [consulta y auditoría](../backend/http/privacy.js#L12), [pruebas](../tests/api/privacy.test.js#L6). |
| TLS en tránsito (RNF-09) | PARCIAL. El endpoint de salud publicado respondió HTTP 200 forzando TLS 1.2. La evidencia cubre el acceso al borde y no establece la versión mínima. El [ESP32 usa HTTP](../esp32/vatio_esp32_demo.ino#L213). [TLS en Render](https://render.com/docs/tls). |
| Cifrado en reposo | NO CUMPLE. La aplicación abre [SQLite sin cifrado](../backend/db/connection.js#L1) y genera [copias SQLite](../backend/ops/backup.js#L64). El hash de credenciales es una medida distinta. |
| Anonimización del analista (RF-17) | PARCIAL. El CSV/JSON crudo conserva sede, equipo, fecha, potencia, voltaje, corriente, energía, módulo y fuente. La agregación horaria conserva sede, equipo, hora, potencia media y máxima, energía y muestras. No exporta nombres de usuarios ni credenciales, pero tampoco transforma identificadores ni prueba irreversibilidad. [Columnas reales](../backend/app/data-exchange.js#L16). |
| Lecturas durante 10 min sin conexión (RNF-08) | PARCIAL. El simulador guarda y reenvía lotes, y la API cuenta recibidas, duplicadas y perdidas. La [prueba de integración](../tests/ingestion.test.js#L181) recupera 600 lecturas simuladas. El [firmware de demostración](../esp32/vatio_esp32_demo.ino#L209) omite el envío sin Wi-Fi y carece de cola de reintento. |
| Estado seguro (RNF-18) | CUMPLE en simulación. Después de 120 s sin reporte el módulo queda inactivo y la acción queda pendiente. Después de 300 s, o sin reporte previo, queda desconectado y se descartan acciones pendientes sin cambiar el estado de energía de la carga. [Regla](../backend/domain/control.js#L55), [prueba](../tests/api/control.test.js#L137). |
| Roles (RNF-10) | CUMPLE en API. Dueño/administrador, operaciones, empleado de cierre, finanzas, sostenibilidad, dueño de cadena, técnico instalador, analista de datos y empleado no técnico. [Matriz de permisos](../backend/domain/permissions.js#L49), [pruebas](../tests/api/rbac.test.js#L33). |
| Retención, supresión y bases temporales | PARCIAL. La telemetría cruda se agrega a partir de dos días y se depuran copias por cantidad. La suite usa bases temporales. No hay vencimiento formal, purga de datos personales ni garantía de persistencia en el plan gratuito de Render. [Agregación](../backend/app/ingestion.js#L208), [copias](../backend/ops/backup.js#L53), [despliegue](despliegue.md). |
| Incidentes | PARCIAL. Hay auditoría, eventos y registro de errores. Falta un procedimiento de contención, registro especializado y notificación a titulares o autoridad. [Registro técnico](../backend/runtime.js#L62), [operación](operaciones.md). |
| Sugerencias y PQR | PARCIAL. Enlace externo configurable y estado de canal ausente probados. El enlace de borrador existe y el correo PQR está pendiente. [Interfaz](../public/app.js#L309), [E2E](../qa/e2e/vatio.spec.js#L119). |

## 6 Confirmaciones del equipo

- [POR CONFIRMAR] Responsable y domicilio del tratamiento, canal oficial y correo de PQR.
- [POR CONFIRMAR] Aviso de privacidad, responsable, custodia y acceso a la hoja del Forms.
- [POR CONFIRMAR] Plazos de conservación, gestión de incidentes y fecha de vigencia formal.
- [POR CONFIRMAR] Aplicabilidad del RNBD según la naturaleza y condiciones del responsable. [Criterios de la SIC](https://sedeelectronica.sic.gov.co/publicaciones/boletin-juridico/concepto/cuales-personas-estan-obligadas-realizar-el-registro-de-bases-de-datos-personales-en-el-rnbd).
- [POR CONFIRMAR] Revisión jurídica o institucional.

## Actualización del 10 de noviembre

El formulario de borrador se publicó en Google Forms. El enlace público de respuesta es https://docs.google.com/forms/d/e/1FAIpQLSdE0YHreDJoHdrcJX-PrvWy9xi7G6BLfXf5Io0jRO9HgJXF8A/viewform?usp=publish-editor. La hoja de respuestas se vinculó y se activaron notificaciones a la cuenta creadora. La identidad del responsable, la política y el correo PQR están [POR CONFIRMAR]. La rama publicada requiere revisión y despliegue antes de usar este enlace en el servicio remoto.
