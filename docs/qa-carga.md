# Pruebas de carga RNF-01 y RNF-02

Mediciones del 10 de noviembre de 2026 en Node v24.19.0 y Windows x64. Los dos scripts de `qa/load/` levantan servidores descartables con bases temporales en localhost.

## RNF-01 Ingesta concurrente de 50 módulos

`qa/load/telemetry.js` envió 20 rondas de 50 peticiones concurrentes a `POST /api/telemetry` con módulos y lecturas simulados. La respuesta incluye el procesamiento y el guardado. Al final se contó la persistencia con `GET /api/data/export`.

| Medida | Resultado |
|---|---|
| Latencia por petición p50 / p95 / máximo | 205,9 / 865,8 / 1.976,6 ms |
| Tiempo de ronda p50 / máximo | 381,4 / 1.987 ms |
| Aceptadas / persistidas / perdidas | 1.000 / 1.000 / 0 |
| Peticiones fallidas | 0 |

**CUMPLE en local.** El máximo de ronda fue 1.987 ms, frente al límite de 3.000 ms.

## RNF-02 Panel con 20 equipos y 24 horas de historial

`qa/load/dashboard.js` sembró la demostración y generó equipos adicionales hasta completar 20. La consulta de 24 horas devolvió 1.440 filas de un equipo. Se hicieron 30 mediciones en serie por endpoint y 10 cargas de Inicio en Chromium headless con sesión iniciada y un contexto nuevo, desde la navegación hasta mostrar el ranking.

| Medida | p50 (ms) | p95 (ms) | Máximo (ms) |
|---|---:|---:|---:|
| `GET /api/loads` | 70,0 | 116,7 | 128,1 |
| `GET /api/simple` | 63,3 | 234,8 | 259,2 |
| `GET /api/loads/:load` | 29,6 | 128,4 | 137,6 |
| `GET /api/data/readings` | 30,8 | 57,4 | 63,4 |
| `GET /api/telemetry/latest` | 57,1 | 80,0 | 82,7 |
| Renderizado de Inicio | 248,7 | 812,5 | 812,5 |

**CUMPLE en local.** El máximo fue 812,5 ms, frente al límite de 5.000 ms.

## Alcance publicado y reproducción

La carga se ejecutó en una sola máquina. Los módulos son simulados y las mediciones no incluyen Internet, red móvil ni Wi-Fi física. El 10 de noviembre, `GET /api/health` en Render respondió HTTP 200 con TLS 1.2. El tiempo de esa consulta fue 0,775 s y no es una medida de carga. Los scripts escriben datos de prueba y requieren instancias descartables. No se ejecutaron contra el servicio compartido.

```sh
npm ci --prefix qa
npm exec --prefix qa -- playwright install chromium
npm run load --prefix qa
```
