# Configuración del formulario de sugerencias y PQR

**Estado** [POR CONFIRMAR: URL del Forms]. La aplicación puede abrir el enlace, pero el formulario real y el correo PQR siguen pendientes. Configure el formulario en la cuenta institucional que custodie las respuestas después de confirmar al responsable del tratamiento, el texto del aviso y el acceso a la hoja.

## Crear y publicar el formulario

1. En Google Forms, cree un formulario en blanco con el título **Vatio · Sugerencias y PQR**. Use esta descripción: «Envíe reportes técnicos, sugerencias o solicitudes relacionadas con sus datos personales. Consulte el Aviso de Privacidad [POR CONFIRMAR: URL pública del aviso]. Comparta únicamente información necesaria para atender su solicitud. Evite contraseñas, identificaciones y datos sensibles».
2. Agregue las preguntas de la tabla en el orden indicado. Configure validación de correo en la pregunta de respuesta. Use un enlace opcional en lugar de la carga de archivos para conservar el acceso sin cuenta. Si se comparte evidencia, limite su acceso a los revisores y evite datos de terceros.
3. En **Configuración**, desactive la restricción a usuarios de la organización y el límite de una respuesta si estos obligan a iniciar sesión. Desactive la recopilación automática de cuentas, la edición posterior y la visualización de resultados por parte de quienes responden.
4. En **Respuestas**, vincule una hoja con acceso restringido al equipo designado. Compruebe que conserva la marca de tiempo y active las notificaciones por cada respuesta. Defina el responsable de revisar la bandeja, clasificar y dar seguimiento.
5. En **Presentación**, configure la confirmación: «Recibimos tu solicitud. Metas internas de soporte: errores críticos en menos de 4 horas y funcionales en 24 a 48 horas hábiles, sujetas a confirmación por el equipo. Consultas sobre datos personales: hasta 10 días hábiles. Reclamos: hasta 15 días hábiles según el artículo 15 de la Ley 1581 de 2012».
6. Publique el formulario con acceso de respuesta para cualquier persona con el enlace. Abra el enlace en una ventana privada sin sesión. Haga una respuesta de prueba con datos ficticios, confirme el registro y la notificación, y elimine la respuesta de prueba. Compruebe que el enlace público permite responder, carece de permisos de edición y no contiene datos personales o respuestas precargadas.
7. Use la URL en `VATIO_FEEDBACK_URL` en `.env` local o en **Environment** de Render. Deje el ejemplo vacío y mantenga la hoja privada. Configure `VATIO_PQR_EMAIL` por separado. Verifique el botón en el login, la barra lateral, el menú Más y el pie.

Para Microsoft Forms, use **Cualquier persona puede responder** y vincule **Respuestas → Abrir en Excel**. Aplique las mismas comprobaciones de privacidad y acceso.

Documentación del proveedor: [publicación en Google Forms](https://support.google.com/docs/answer/2839588), [respuestas en Google Forms](https://support.google.com/docs/answer/139706) y [respuestas en Microsoft Forms](https://support.microsoft.com/en-us/forms/microsoft-forms-and-excel-workbooks).

| Grupo | Campo | Tipo y opciones |
|---|---|---|
| 1 | Tipo de solicitud | Selección única obligatoria. Reporte de error o falla técnica, Alerta o lectura inusual de un módulo, Sugerencia de mejora o usabilidad, Consulta de datos personales (Habeas Data), Reclamo de datos personales (corrección, actualización, supresión o revocatoria). |
| 2 | Nombre del solicitante y rol | Dos preguntas. Texto corto para el nombre y lista de roles con Dueño/Administrador, Operaciones, Cierre, Mantenimiento, Financiero, Técnico y Otro. Solicítelos cuando sean necesarios para identificar al titular o tramitar el caso. |
| 3 | PyME o sede y correo de respuesta | Dos preguntas. Texto corto para la PyME o sede y correo validado para respuesta. Requiera correo para consultas y reclamos y cuando el solicitante quiera respuesta. |
| 4 | Módulo, pantalla o equipo | Selección o texto. Panel general, Costos en COP, Línea base, Alertas, Recomendaciones, Modo cierre, Reporte PDF/CSV, Módulo IoT físico, Cuenta/Datos personales y Otro. |
| 5 | Nivel de impacto | Selección única. Crítico, Alto, Medio/Bajo. |
| 6 | Descripción detallada | Párrafo obligatorio. Indique qué pasó, cuándo y cómo reproducirlo, o describa la consulta o el reclamo. |
| 7 | Evidencia o soporte | Enlace opcional a una captura o un archivo. |
| 8 | Autorización de tratamiento | Casilla obligatoria sin premarcar. «Autorizo el tratamiento de los datos enviados para atender mi solicitud, según la Política de Tratamiento [POR CONFIRMAR: URL pública de la política]». |
