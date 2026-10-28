# Matriz de cumplimiento — estado parcial

| Requisito | Evidencia | Verificación | Estado |
|---|---|---|---|
| Auditoría inicial | `docs/00-gap-analysis.md` | Inspección de código | Parcial: falta cotejar el ZIP de diseño |
| Inicio de sesión y CSRF | `backend/security.js`, `server.js`, `public/app.js` | `npm test` | Parcial: solo administrador; sin gestión de sesiones completa ni cinco roles |
| Clave de dispositivo | `server.js` | `npm test` | Parcial: sin rotación, registro por gateway ni limitación de intentos de ingestión |
| Telemetría persistente | `backend/security.js`, `server.js` | `npm test`: reinicio | Parcial: una sede, validación incompleta, sin migraciones versionadas |
| Control seguro | `server.js` | `npm test`: crítica y CSRF | Parcial: solicitud pendiente; sin aprobación, ejecución simulada ni matriz de permisos |
| Desconexión | `server.js`, `public/app.js` | Lectura de código | Parcial: sin prueba automatizada de tiempo límite |
| Inicio, operaciones y módulos | `public/app.js` | No hay E2E | Parcial: lecturas actuales y ejemplo |
| Alertas, recomendaciones y cierre | `public/app.js` | No hay E2E | Pendiente: los ejemplos no son flujos persistentes |
| Ahorro, reportes, datos crudos y multisede | `public/app.js` | No hay E2E | Pendiente: métricas y comparaciones incluyen ejemplos |
| Modelo de datos y DER | `backend/security.js` | Inspección de esquema | Parcial: faltan entidades y DER |
| Interfaz, carga y seguridad integral | `tests/security.test.js` | `npm test` | Parcial: sin pruebas E2E ni carga |
| Documentación restante | `README.md` | Inspección | Pendiente: documentos 01 a 08 y migraciones |
