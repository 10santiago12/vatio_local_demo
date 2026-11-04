# Auditoría inicial — VATIO, 28 de octubre de 2026

Base: `master` en `adb8ec3`. Esta es una evaluación del prototipo anterior a la implementación, no una certificación del MVP. Se inspeccionaron los archivos del repositorio, incluido el servidor, las vistas, los estilos, el HTML, las dependencias y el firmware. El ZIP `entregables_diseno.zip` no se encontró en las ubicaciones de trabajo consultadas; no se pudo cotejar el UI Kit, los flujos ni la matriz de roles. Se usa la interfaz existente como referencia visual.

## Estado por área

| Área | Estado inicial y evidencia |
|---|---|
| Stack | Node HTTP nativo y JavaScript sin framework ni dependencias npm; `package.json`, `server.js`, `public/app.js`. Activos visuales locales uPlot, Lucide y Manrope. |
| Inicio y operaciones | Parciales: potencia y lecturas actuales, estimación de 12 horas y valores por carga. No existe inventario persistente. |
| Alertas | Parciales: reglas en navegador (`buildAlerts`); el reconocimiento se guarda solo en memoria, sin resolución ni auditoría. La pérdida de comunicación se presenta como módulo inactivo. |
| Recomendaciones | Simuladas: arreglo con valores fijos; aceptación solo en memoria y sin rechazo persistente. |
| Control y cierre | No existe motor ni endpoint. Aprobar produce únicamente un mensaje; la fila de rechazo crítico está fijada en la interfaz. No existe modo cierre. |
| Ahorro y retorno | Simulados: cifras, línea base y gráficas fijas; no hay medición atribuible. Tarifa e inversión solo en `localStorage`. |
| Módulos y telemetría | Parciales: POST con clave, simulador y estado por antigüedad. Firmware genera ocho medidores virtuales; no realiza control físico. |
| Reportes y datos crudos | Parciales: exportación de lecturas actuales en navegador, sin consulta histórica filtrable ni reportes financieros reales. |
| Multisede | Simulada: dos sedes y cifras fijas, sin aislamiento. |
| Configuración | Parcial: tarifa e inversión en navegador; otros campos no se guardan. Roles y usuarios no se gestionan. |
| Persistencia | Parcial: se agrega JSONL, pero el historial y últimas lecturas se mantienen en memoria y no se recuperan al reiniciar; se ignoran errores de escritura. No hay migraciones ni entidades de negocio. |
| Autenticación y permisos | Inexistentes. El rol se cambia en `localStorage`; ningún endpoint de usuario está protegido. |
| QA | `npm run check` solo verifica sintaxis. No hay pruebas automatizadas ni resultados de carga o interfaz en la base. |

## Riesgos prioritarios

1. `GET /api/info` divulga la clave de dispositivo y el servidor la imprime al iniciar; usa además una clave demo predecible y escucha por defecto en todas las interfaces.
2. `POST /api/reset` no requiere autenticación, autorización ni CSRF. La API permite CORS con origen `*`.
3. No hay aislamiento entre sedes: las lecturas se indexan globalmente por módulo, y el cliente define la sede del gateway.
4. Los valores inválidos se convierten silenciosamente en ceros; se permite falsificar identificadores y estados dentro del protocolo. No existe límite de peticiones.
5. El control y su supuesta auditoría son presentación estática, no validación de seguridad. No afirmar que el rechazo crítico está implementado.
6. La ruta estática usa comprobación de prefijo de cadena y el decodificado puede fallar; revisar acceso a archivos y errores malformados.
7. Estimaciones y ahorro fijo pueden confundirse con mediciones. La energía simulada no es un contador monotónico.
8. La recepción ESP32 usa HTTP sin cifrar; el acceso remoto requiere una solución de transporte autenticado y TLS. La clave demo no es apta para producción.

## Compatibilidad y regresiones a vigilar

Conservar `/?view=...`, `theme` y `more`, estilos responsive, la estructura `gateway_id`, `site_id`, `readings[]` y encabezado `X-Device-Key`, además del simulador explícitamente identificado. No inferir operación física del ESP32: el firmware envía lecturas virtuales y no incluye salidas de potencia. Los cambios de sesión requieren actualizar el frontend y las pruebas de carga/compatibilidad, no solo proteger rutas.
