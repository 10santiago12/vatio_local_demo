# Pruebas de carga: RNF-01 y RNF-02

Scripts: `qa/load/telemetry.js` y `qa/load/dashboard.js`. Mediciones del 4 de noviembre de 2026, Node 24, Windows 11, un solo equipo.

## RNF-01: 50 módulos reportando a la vez (criterio: procesar y guardar en menos de 3 s)

**Método.** Servidor local con base vacía. Se lanzan 20 rondas; en cada ronda 50 módulos simulados envían a la vez, con `Promise.all`, un `POST /api/telemetry` en el formato del ESP32 con la clave de dispositivo (1000 peticiones en total). La respuesta de la API se entrega cuando la lectura ya está guardada, por lo que la latencia por petición y el tiempo de la ronda incluyen el almacenamiento. Al final se exportan las lecturas por la API (`/api/data/export`) y se cuentan.

| Medida | Resultado |
|---|---|
| Latencia por petición p50 / p95 / máximo | 186,6 ms / 420,1 ms / 728,4 ms |
| Tiempo hasta guardar las 50 lecturas de una ronda (mediana / máximo) | 344,7 ms / 730,5 ms |
| Lecturas aceptadas / guardadas / perdidas | 1000 / 1000 / 0 |
| Peticiones fallidas | 0 |

**Resultado: CUMPLE** (máximo 0,73 s frente a 3 s).

## RNF-02: panel con 20 equipos y 24 h de historial (criterio: menos de 5 s)

**Método.** Se siembra la demostración (11 equipos, 45 días de historial) y se generan 9 equipos más con `POST /api/demo/generate-loads` hasta tener 20 equipos instrumentados. Cada endpoint del panel se mide 30 veces en serie con sesión. La carga de página usa Chrome headless (Playwright), con sesión iniciada, desde `goto` hasta que aparece el ranking de la vista Inicio; 10 repeticiones con contexto nuevo (sin caché).

| Endpoint | p50 | p95 | máximo |
|---|---|---|---|
| `GET /api/loads` | 30,3 ms | 42,3 ms | 45,5 ms |
| `GET /api/simple` | 28,7 ms | 37,3 ms | 38,7 ms |
| `GET /api/loads/:load` (serie en vivo) | 12,4 ms | 18,9 ms | 19,1 ms |
| `GET /api/data/readings` (24 h, 1440 filas de un equipo) | 15,7 ms | 29,0 ms | 30,6 ms |
| `GET /api/telemetry/latest` | 17,6 ms | 19,9 ms | 23,5 ms |
| Página Inicio renderizada | 125,3 ms | 358,8 ms | 358,8 ms |

**Resultado: CUMPLE** (peor caso 0,36 s frente a 5 s).

## Límites

- Todo corre en `localhost` en una sola máquina: **no se mide el tiempo de red** ni la latencia de Internet o de un celular en datos móviles.
- No se probó el servicio desplegado en Render (otro hardware, plan gratuito, arranque en frío).
- Las 50 conexiones son concurrentes dentro de un mismo proceso de Node, no 50 dispositivos físicos con su propia red Wi-Fi.
- Los equipos extra son generados por el panel de demostración; la carga de lecturas continuas (cada 5 s durante horas) no se midió.
- Cómo repetir: `cd qa && npm install && npx playwright install chromium && node load/telemetry.js && node load/dashboard.js`.
