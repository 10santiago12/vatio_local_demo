# VATIO — handoff

- Objetivo: implementar el MVP del encargo del 28 de octubre, de extremo a extremo, preservando el frontend y el protocolo ESP32.
- Rama: `feat/vatio-mvp-20261028`, desde `master` `adb8ec3`. La copia local anterior no es un repositorio Git y se conservó intacta.
- Completado: inspección inicial y `docs/00-gap-analysis.md`. La búsqueda en el workspace y Documents/Codex no encontró `entregables_diseno.zip`; verificar otras ubicaciones si aparecen nuevos datos.
- Estado: el prototipo original sigue sin autenticación, autorización, persistencia de negocio ni control seguro; no se ha implementado el MVP.
- Verificación: `npm run check` pasó en Node 24.19.0; comprueba únicamente sintaxis. No se ejecutaron pruebas funcionales, E2E ni de carga.
- Siguiente paso: completar diseño de datos y permisos conservadores documentados ante ausencia de la matriz; implementar migraciones y autenticación antes de conectar control seguro, seguido por las vistas, pruebas y documentación solicitadas. Proteger antes de exponer en red.
- Precaución: el servidor original divulga la clave del dispositivo y admite reset sin sesión; no usar en redes no confiables. La clave incluida en firmware es solo demo.
