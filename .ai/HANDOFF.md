# VATIO — handoff

- Objetivo: implementar el MVP del encargo del 28 de octubre, de extremo a extremo, preservando el frontend y el protocolo ESP32.
- Rama: `feat/vatio-mvp-20261028`, desde `master` `adb8ec3`. La copia local anterior no es un repositorio Git y se conservó intacta.
- Completado: auditoría inicial; SQLite para telemetría; inicio de sesión local del administrador con scrypt, cookie y CSRF; rechazo de cargas críticas por backend; advertencias de interfaz. La búsqueda no encontró `entregables_diseno.zip`.
- Estado: MVP incompleto. Solo existe administrador y una sede; las solicitudes no se aprueban ni ejecutan. La interfaz conserva ejemplos no persistentes. No hay migraciones versionadas, gestión de usuarios, alertas/recomendaciones persistentes ni modo cierre. Ver `docs/09-matriz-cumplimiento.md`.
- Verificación: `npm test` prueba inicio de sesión, clave, CSRF, carga crítica y persistencia tras reinicio; `npm run check` solo comprueba sintaxis. No hay E2E ni carga.
- Siguiente paso: completar modelo y migraciones, roles y sede, aprobación con revalidación y simulador, vincular flujos de interfaz, pruebas E2E/carga y documentos 01–08. Revisar seguridad y manejo de concurrencia antes de uso.
- Precaución: mantener el servidor local; firmware usa HTTP y clave demo. El worker local no produjo respuesta durante la inspección.
