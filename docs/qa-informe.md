# Informe de calidad de Vatio

Capstone Design Project · Universidad de La Sabana · 10 de noviembre de 2026

La verificación cubrió el repositorio `vatio_local_demo`, con base `ca5f6b6` de `feat/mvp-completion` y cambios locales de `feat/qa-habeas-data`. Se usó Node v24.19.0 en Windows x64, SQLite nativo, una instancia desechable para QA y datos de demostración. Las cifras de este informe sustituyen las del borrador y la infografía original.

## 1 Entorno y comandos

| Comando | Resultado observado |
|---|---|
| `npm test` | 310 casos registrados, 307 aprobados, 0 fallidos y 3 omitidos porque el entorno carece de `pdftotext`. |
| `npm run check` | 139 de 139 archivos JS válidos sintácticamente. |
| `npm ci --prefix qa` | Instaló las dependencias de QA del archivo de bloqueo. |
| `npm exec --prefix qa -- playwright install chromium firefox webkit` | Motores para la matriz automatizada. Chrome y Edge instalados se detectan automáticamente. |
| `npm test --prefix qa` | 53 aprobados, 0 fallidos y 10 omitidos porque los casos de barra inferior aplican solo a móvil. |
| `npm run load --prefix qa` | Aprobaron los dos escenarios locales RNF-01 y RNF-02. |

## 2 Hito 1 Pruebas unitarias y de seguridad

| Caso y requisito | Prueba real | Alcance observado |
|---|---|---|
| SEC-01 y SEC-02 · RF-01, RNF-09/10 | `tests/security.test.js`, `tests/telemetry-api.test.js` | Secreto fuera de la respuesta, sesión y clave de dispositivo exigidas. Validación de payload de telemetría. |
| SEC-03 y SEC-04 · RF-06/07, RNF-10 | `tests/security.test.js`, `tests/api/rbac.test.js`, `tests/api/events.test.js` | Cookie y CSRF, credenciales inválidas, auditoría de intentos y permisos de nueve roles. |
| SEC-05 · RF-01 | `tests/security.test.js` | Lectura persistida y recuperada al reiniciar. Es una prueba de servidor, distinta de RNF-08. |
| UT-01 y UT-02 · RF-01, RNF-03 | `tests/adapters/manufacturers.test.js`, `tests/ingestion.test.js` | Normalización de fabricantes, validación de sede y lotes, idempotencia, potencia y formato. |
| UT-03 y UT-04 · RF-05/06/07/12 | `tests/domain/control.test.js`, `tests/api/control.test.js` | Protección de carga crítica, solicitud y aprobación, solo monitoreo queda pendiente y modo cierre se verifica en simulación. |
| UT-05 · RF-08, RNF-18 | `tests/domain/control.test.js`, `tests/api/control.test.js` | Inactividad después de 120 s. Después de 300 s sin señal se descarta la acción y se conserva el estado simulado. |
| UT-06 · RF-02/03/10/14 | `tests/domain/baseline.test.js`, `tests/domain/cost.test.js`, `tests/domain/savings.test.js`, `tests/api/value.test.js` | Línea base de siete días, integración kWh y tarifa, ahorro y retorno. Los cálculos verificados corresponden al dominio y la API. |
| RF-17 · Exportación y reimportación | `tests/api/data.test.js` | CSV/JSON, permisos, auditoría y comparación de filas reimportadas. Conserva identificadores operativos. |
| RNF-08 · Resincronización | `tests/ingestion.test.js`, `tests/telemetry-api.test.js` | 600 lecturas simuladas recuperadas sin pérdidas en el escenario probado. El firmware físico no tiene búfer. |
| Privacidad y consentimiento | `tests/api/privacy.test.js`, `tests/schema.test.js` | Se rechazó la activación sin ambas aceptaciones, con valores no booleanos o versiones antiguas. Se comprobó persistencia, páginas públicas, configuración del canal, consulta propia y auditoría. |

Se retiraron las métricas y rutas del corredor anterior. UT-07 ya no acredita una prueba específica de rate limit ni de rutas estáticas. UI-01 y UI-04 se sustituyeron por el resultado observable de navegador y los checks de diseño responsivo. Se retiró LD-03 como medición de carga y se conservó RNF-08 como prueba de integración simulada. No se mantienen los resultados de los casos aritméticos exactos del borrador cuando el repositorio usa escenarios distintos.

## 3 Hito 2 QA de interfaz

`qa/e2e/vatio.spec.js` recorrió las 12 vistas con sesión. La matriz usó Chrome, Edge, Chromium, Firefox y WebKit de escritorio, más iPhone 13 y Pixel 7 emulados. Probó login, activación, logout, cambio y persistencia de tema, errores de consola y red, desbordamiento y barra inferior. Los casos UI-02, UI-03 y UI-05 corresponden a este recorrido.

El caso de sugerencias comprobó la ubicación en las 12 vistas, el enlace del pie, la apertura en otra pestaña y el retorno del foco en móvil. Se usó una URL de prueba interceptada por Playwright. La suite también comprobó el texto y botón del estado sin configuración en el login. [Captura de escritorio](qa-evidencia/feedback-escritorio.png) · [Captura móvil](qa-evidencia/feedback-movil.png).

La ejecución usó emulación móvil. [QA de interfaz](qa.md) conserva evidencia anterior de un iPhone 14 Pro, además de las plantillas de dispositivo real y usabilidad RNF-05/06. La evidencia histórica corresponde a la versión previa a este cambio.

## 4 Hito 3 Pruebas de carga

| Caso | Método en localhost | Resultado |
|---|---|---|
| LD-01 · RNF-01 | `qa/load/telemetry.js`. 20 ráfagas de 50 módulos simultáneos. | 1.000 de 1.000 lecturas guardadas, 0 fallos, p95 por petición 865,8 ms y máximo de ronda 1.987 ms, bajo el límite de 3.000 ms. |
| LD-02 · RNF-02 | `qa/load/dashboard.js`. 20 equipos, consulta de 24 h con 1.440 filas, 30 muestras por API y 10 renders del inicio. | Máximo de renderizado 812,5 ms, bajo el límite de 5.000 ms. |

Las pruebas midieron un único equipo en `127.0.0.1`, sin red IoT física. En Render, una consulta de solo lectura a `/api/health` respondió HTTP 200 con TLS 1.2. Las cargas escriben telemetría y generan equipos sobre servidores descartables. No se ejecutaron contra el servicio compartido. [Métricas y método](qa-carga.md).

## 5 Cobertura real del MVP

- **Línea base y recomendaciones.** El backend calcula la línea base con lecturas persistidas (`backend/app/analytics.js:58`) y genera y almacena recomendaciones con API de decisión (`backend/app/recommendations.js:45`, `backend/http/operations.js:21`). La SPA conserva datos de ejemplo para esas pantallas (`public/app.js:49` y `public/app.js:566`).
- **Curvas.** El panel de inicio usa telemetría de `/api/telemetry/latest` y un historial local de la sesión (`public/app.js:408` y `public/app.js:858`). Las curvas semanales de ahorro y reportes son ejemplos en la SPA (`public/app.js:622` y `public/app.js:662`). La API ofrece series y reportes calculados.
- **Control y roles.** La API implementa nueve roles, aprobación, control simulado y modo cierre. La SPA mezcla llamadas reales, como el rechazo de apagar la carga crítica, con interacciones demostrativas. El estado seguro probado es de software.
- **Privacidad y soporte.** La activación y la consulta autenticada se prueban de extremo a extremo o por API según el caso. La publicación y verificación del Forms real quedan pendientes de la configuración del equipo.
