# Referencia de la API de Vatio Local

Todas las rutas empiezan por `/api`. Las respuestas son JSON (UTF-8), salvo las descargas (CSV, PDF). Los textos para personas están en español; los nombres de campos y códigos de error, en inglés.

Una prueba automática (`tests/api-docs.test.js`) comprueba que cada ruta registrada en el servidor aparece en este documento con su permiso.

## Convenciones

**Sesión.** `POST /api/auth/login` entrega la cookie `vatio_session` (HttpOnly, SameSite=Strict, 8 horas; con `Secure` en producción o detrás de HTTPS) y un token `csrf` en el cuerpo. Todas las rutas, salvo las marcadas como públicas, exigen la cookie: sin sesión responden `401`.

**CSRF.** Toda petición que cambia datos (POST, PUT, PATCH, DELETE) debe enviar el encabezado `X-CSRF-Token` con el token del login; si falta o no coincide responde `403` (`csrf`).

**Permisos.** Cada ruta exige un permiso de dominio (columna "Permiso"). Se verifica siempre en el servidor, no solo en la interfaz. Si el perfil no lo tiene responde `403` con un mensaje en español sencillo y se guarda una fila de auditoría (`permission_denied`, resultado `rejected`, con perfil, acción y motivo).

**Errores.** Forma: `{ "error": "mensaje en español", "code": "codigo_corto" }`. Códigos HTTP usados: `400` entrada inválida, `401` sin sesión, `403` sin permiso o CSRF, `404` no existe, `405` método no permitido, `409` conflicto de estado, `413` cuerpo mayor a 2 MB, `422` regla de negocio (por ejemplo, equipo crítico), `429` demasiados intentos de login, `500` error inesperado (se registra en el log de errores).

**Fechas y números.** Instantes en ISO 8601 UTC; días como `AAAA-MM-DD` en hora de Bogotá; potencia en W, energía en kWh, dinero en COP (enteros).

**Equipos.** Donde dice `:load` se acepta el código del equipo (`freezer`) o su id numérico.

### Perfiles y permisos

| Perfil (código) | Permisos |
|---|---|
| Dueño o administrador (`owner`) | todos |
| Gerente de operaciones (`operations_manager`) | view_simple, view_operations, view_load_detail, view_alerts, review_alert, view_recommendations, propose_action |
| Empleado de cierre (`closing_employee`) | view_simple, activate_closing_mode |
| Finanzas (`finance`) | view_savings, view_reports, download_report |
| Sostenibilidad (`sustainability`) | view_impact_report, download_impact_report |
| Dueño de cadena (`chain_owner`) | view_multisite |
| Técnico instalador (`installer_technician`) | view_modules, register_module, view_diagnostics |
| Analista de datos (`data_analyst`) | view_raw_data, export_raw_data, import_raw_data |
| Empleado no técnico (`non_technical_employee`) | view_simple |

Además, `view_technical_data`, `approve_action`, `toggle_load`, `decide_recommendation`, `configure`, `view_audit`, `manage_users` y `view_demo_panel` son solo del dueño.

---

## Sesión

### `POST /api/auth/login`  (público)
- **Entrada:** `{ "username": "demo-owner", "password": "..." }`.
- **Salida 200:** `{ username, role (nombre), roleCode, displayName, permissions: [..], csrf }` y la cookie de sesión.
- **Errores:** `401 invalid_credentials` (también si el usuario está desactivado; se audita `login_failed`), `429 too_many_attempts` (más de 10 intentos por minuto desde una dirección), `400`.

### `GET /api/auth/me`  (cualquier sesión)
- **Salida 200:** igual que el login: perfil, nombre para mostrar y lista de permisos.
- **Errores:** `401`.

### `POST /api/auth/logout`  (cualquier sesión)
- **Salida 200:** `{ ok: true }` y cookie vencida. Se audita `logout`.

---

## Administración (solo dueño)

### `GET /api/users`  · permiso `manage_users`
- **Salida:** `{ users: [{ id, username, displayName, role, roleName, active, createdAt, lastLoginAt }], roles: [{ code, name, description }] }`.

### `POST /api/users`  · `manage_users`
- **Entrada:** `{ username (3-40, minúsculas, números, . _ -), role, password (mínimo 16 caracteres, definida por el administrador), displayName? }`. No existen contraseñas por defecto.
- **Salida 201:** el usuario creado. Se audita `user_created`.
- **Errores:** `400 invalid_username | invalid_role | weak_password`, `409 username_taken`.

### `PATCH /api/users/:id/role`  · `manage_users`
- **Entrada:** `{ "role": "finance" }`. **Salida:** el usuario. Cierra sus sesiones y audita el cambio.
- **Errores:** `400 invalid_role`, `404 user_not_found`, `422 last_owner` (no se puede degradar al último dueño activo).

### `POST /api/users/:id/deactivate`  y  `POST /api/users/:id/activate`  · `manage_users`
- **Salida:** el usuario con `active` actualizado. Desactivar cierra sus sesiones.
- **Errores:** `404 user_not_found`, `422 last_owner` (al desactivar al último dueño activo).

### `POST /api/users/:id/reset-password`  · `manage_users`
- **Entrada:** `{ "password": "nueva de mínimo 16 caracteres" }`. **Salida:** el usuario. Cierra sus sesiones.
- **Errores:** `400 weak_password`, `404 user_not_found`.

### `GET /api/audit`  · `view_audit`
- **Filtros (query):** `from`, `to` (AAAA-MM-DD, ambos días incluidos), `user` (nombre de usuario), `role`, `action` (evento, por ejemplo `permission_denied`), `load` (código o id), `result` (`executed`, `rejected`, `discarded`), `limit` (1-500, por defecto 100), `offset`.
- **Salida:** `{ count, entries: [{ id, at, user, role, roleName, action, result, reason, loadId, loadCode, siteId, simulatedAt, details }] }`, de lo más nuevo a lo más antiguo.
- **Errores:** `400 invalid_filter`, `404 load_not_found`.

### `GET /api/settings`  · `configure`
- **Salida:** `{ siteId, investmentCop, emissionFactorKgPerKwh, emissionFactorSource, alertThresholdPct, alertWindowMinutes, sectorReferenceKwhPerDay, operatingHours: [{ weekday (0 domingo a 6 sábado), closed, opensAt, closesAt }], updatedAt }`.

### `PUT /api/settings`  · `configure`
- **Entrada (todos opcionales, al menos uno):** `investmentCop` (≥ 0), `emissionFactorKgPerKwh` (0-10), `emissionFactorSource` (texto), `alertThresholdPct` (1-500), `alertWindowMinutes` (1-120), `sectorReferenceKwhPerDay` (> 0, referencia editable del comparativo de sedes), `operatingHours` (lista de hasta 7 días, `HH:MM`).
- **Salida:** la configuración nueva. Audita `settings_updated` con antes y después.
- **Errores:** `400 invalid_setting | invalid_schedule | empty_update`.

### `GET /api/tariffs`  · `configure`
- **Salida:** `{ tariffs: [{ id, copPerKwh, effectiveFrom, note, createdAt, inForce }] }`.

### `POST /api/tariffs`  · `configure`
- **Entrada:** `{ copPerKwh (> 0), effectiveFrom: "AAAA-MM-DD", note? }`. Solo afecta los costos desde esa fecha: los días anteriores conservan su precio.
- **Salida 201:** `{ id, copPerKwh, effectiveFrom, note }`.
- **Errores:** `400 invalid_tariff`, `409 tariff_exists` (ya hay una tarifa que empieza ese día).

### `GET /api/loads/config`  · `configure`
- **Salida:** `{ loads: [{ id, code, name, criticality, criticalityLabel, controlMode, powerState, typicalPowerW }] }`.

### `PUT /api/loads/:load/config`  · `configure`
- **Entrada (opcionales):** `name`, `criticality` (`critical`, `essential`, `non_essential`), `controlMode` (`monitor_only`, `control_enabled`). Un equipo crítico nunca puede tener el control habilitado; los equipos nuevos nacen como esencial y solo monitoreo.
- **Salida:** el equipo actualizado. Audita el cambio.
- **Errores:** `400/422` (crítico con control), `404 load_not_found`.

---

## Operaciones

### `GET /api/simple`  · `view_simple`
- **Salida:** `{ generatedAt, todaySpendCop, todaySpendText, comparison: { available, pct, direction (above, below, similar), text }, ranking: [{ loadCode, name, costCop, kwh, sharePct }] (por costo del día, descendente), alerts: [{ id, loadCode, message, detectedAt }], recommendations: [{ id, title, loadName, monthlySavingsCop, text }] (máximo 3) }`. Nunca incluye voltaje, corriente, factor de potencia ni códigos de error.

### `GET /api/loads`  · `view_operations`
- **Filtros:** `criticality`, `status` (estado del módulo), `period` (`today`, `7d`, `30d`), `sort` (`consumption`, `cost`, `name`).
- **Salida:** `{ period, generatedAt, loads: [{ id, code, name, icon, criticality, criticalityLabel, controlMode, powerState, currentPowerW, dataAgeSeconds, stale, todayKwh, todayCostCop, periodKwh, periodCostCop, moduleId, moduleStatus, moduleStatusText, activeAlerts, baseline: { status: "ready" } | { status: "building", dayN, requiredDays } }] }`.
- **Errores:** `400 invalid_period | invalid_filter | invalid_sort`.

### `GET /api/loads/:load`  · `view_load_detail`
- **Salida:** `{ id, code, name, criticality, controlMode, powerState, current: { powerW, at, dataAgeSeconds, stale (> 60 s) }, moduleStatus, liveSeries: [{ ts, powerW }] (2 horas), dailyConsumption: [{ date, kwh, costCop, partial }] (30 días), baseline, cost: { todayCop, monthCop, todayKwh, monthKwh }, alerts, recommendations, technical? }`.
  - `baseline`: `{ status: "ready", dayType, windowStart, windowEnd, sampleDays, typicalDailyKwh, hourly: [{ hour, meanW, bandLowW, bandHighW, sampleDays }] }` o `{ status: "building", dayN, requiredDays: 7, message }` (sin recomendaciones ni alertas de desviación).
  - `technical` (`voltageV`, `currentA`, `powerW`, `energyKwhCounter`, `manufacturer`, `moduleId`, `lastReadingAt`, `communication`) solo para perfiles con acceso técnico o a diagnósticos.
- **Errores:** `404 load_not_found`.

### `GET /api/alerts`  · `view_alerts`
- **Filtros:** `view` (`active`, `history`, `all`), `type` (`consumption`, `off_hours`, `maintenance`, `inactive_module`), `load`.
- **Salida:** `{ alerts: [{ id, type, status, loadId, loadCode, loadName, message, detectedAt, excessPct, excessCostPerHourCop, projectedMonthlyCostCop, details, reviewedAt, reviewedBy }] }`.
- **Errores:** `400 invalid_filter`, `404 load_not_found`.

### `POST /api/alerts/run`  · `review_alert`
- Ejecuta ahora los detectores del dominio. **Salida:** `{ checked, created }`. No duplica alertas activas del mismo equipo y tipo.

### `POST /api/alerts/:id/review`  · `review_alert`
- Marca la alerta como revisada: sale de las activas y queda en el historial. **Salida:** la alerta. **Errores:** `404 alert_not_found`, `409 already_reviewed`.

### `GET /api/recommendations`  · `view_recommendations`
- **Filtros:** `status` (`pending`, `accepted`, `postponed`, `discarded`, `all`), `load`.
- **Salida:** `{ recommendations: [{ id, loadId, loadCode, loadName, type, title, description, assumption, monthlySavingsKwh, monthlySavingsCop, score, scoreExplanation, confidence, evidence, status, createdAt, decidedAt, acceptedAt, postponedUntil, reason }] }`, por puntaje descendente. Nunca propone apagar un equipo crítico ni hay recomendaciones para equipos con la línea base en construcción.
- **Errores:** `400 invalid_filter`, `404 load_not_found`.

### `POST /api/recommendations/refresh`  · `decide_recommendation`
- Genera recomendaciones nuevas ahora. **Salida:** `{ created: [..] }`.

### `POST /api/recommendations/:id/decision`  · `decide_recommendation`
- **Entrada:** `{ action: "accept" | "postpone" | "discard", reason?, days? (solo posponer, 1-90, por defecto 7) }`.
- **Salida:** `{ recommendation, controlAction }`. Aceptar fija `acceptedAt`; si implica apagar un equipo crea una acción pendiente (`controlAction: { actionId, executable, message }`): con control habilitado espera la aprobación del dueño; en solo monitoreo queda un pendiente explicativo que nunca se ejecuta.
- **Errores:** `400 invalid_action | invalid_days`, `404 recommendation_not_found`, `409 already_resolved`.

---

## Control

Las respuestas de control usan el código HTTP del resultado: `200` ejecutada, `202` pendiente, `422` rechazada (con `reason`, por ejemplo `critical_load_protected`), `409` descartada. La ejecución es simulada (no se maneja hardware).

### `GET /api/control/approvals`  · `approve_action`
- **Filtro:** `status` (por defecto `pending`). **Salida:** `{ approvals: [{ id, origin (recommendation, user, schedule), action, status, loadId, loadCode, loadName, criticality, controlMode, executable, requestedBy, requestedAt, decidedAt, reason, recommendationId, recommendationTitle, estimatedMonthlySavingsCop }] }`.

### `POST /api/control/approvals/:id/approve`  · `approve_action`
- El dominio decide: con control habilitado se ejecuta (`200`); en solo monitoreo queda pendiente (`202`) con el motivo "Carga en solo monitoreo"; con el módulo sin señal se descarta (`409`); un equipo crítico se rechaza (`422`).
- **Salida:** `{ actionId, outcome, reason, message, loadCode, simulated }`. **Errores:** `404 action_not_found`, `409 already_resolved`.

### `POST /api/control/approvals/:id/reject`  · `approve_action`
- **Entrada:** `{ reason? }`. **Salida:** `{ actionId, outcome: "rejected", message }`. **Errores:** `404 action_not_found`, `409 already_resolved`.

### `POST /api/control/toggle`  · `toggle_load`
- **Entrada:** `{ load, action: "on" | "off" }`. Apagar un equipo crítico siempre se rechaza (`422 critical_load_protected`) y se audita. En solo monitoreo queda pendiente.
- **Salida:** `{ actionId, outcome, reason, message, loadCode, simulated }`. **Errores:** `400 invalid_action`, `404 load_not_found`.

### `POST /api/control/proposals`  · `propose_action`
- **Entrada:** `{ load, action, reason? }`. Una propuesta nunca se ejecuta: queda en la bandeja del dueño (`202`, `outcome: "pending"`). Un apagado de equipo crítico se rechaza (`422`).

### `GET /api/control/proposals`  · `propose_action`
- **Salida:** `{ proposals: [..] }` con las propuestas del usuario actual (misma forma que la bandeja).

### `GET /api/control/closing-mode`  · `activate_closing_mode`
- Vista previa, no cambia nada. **Salida:** `{ willSwitchOff: [{ loadId, loadName, .. }], staysOn: [{ loadId, loadName, reason }], alreadyOff, estimatedNightlySavings: { kwh, cop, text }, requiresConfirmation: true, confirmation }`.

### `POST /api/control/closing-mode`  · `activate_closing_mode`
- **Entrada:** `{ "confirm": true }` (obligatorio). **Salida:** `{ batchId, message, switchedOff: [códigos], failed, staysOn, alreadyOff, simulated }`. Los equipos críticos y los que no tienen el control habilitado quedan encendidos. Se audita `closing_mode`.
- **Errores:** `400 confirmation_required`.

### `POST /api/control/requests`  · `toggle_load`
- Compatibilidad con el primer MVP. **Entrada:** `{ site_id, load_id, action: "off" }`. **Salida 201:** `{ id, status, simulated, message }`. **Errores:** `400`, `403 site_forbidden`, `422 critical_load_protected` ("Carga crítica: acción rechazada.", auditado).

### Estado seguro
Un trabajo periódico descarta las acciones pendientes de un módulo sin señal por más de 5 minutos: el equipo se queda energizado, la acción pasa a `discarded` con el motivo y se audita `safe_state`.

### `GET /api/modules`  · `view_modules`
- **Salida:** `{ modules: [{ id, manufacturer, status, statusText, loadCode, loadName, lastHeartbeat, silentMinutes, registeredAt, lastReading: { at, powerW } }] }`.

### `POST /api/modules`  · `register_module`
- **Entrada:** `{ id, manufacturer, loadCode?, loadName? }` (indique un equipo existente por `loadCode`, o `loadName` para crear uno nuevo en solo monitoreo y esencial).
- **Salida 201:** el módulo (activo) más `loadCreated` y `firstReadingExpectedWithinMinutes: 2`. Audita `module_registered`.
- **Errores:** `400 invalid_module_id | invalid_manufacturer | load_required | load_name_required | invalid_load_code | invalid_load_name`, `409 module_exists | load_has_module`.

### `GET /api/modules/:id/diagnostics`  · `view_diagnostics`
- **Salida:** el módulo más `{ checks: [{ name, ok, text }], healthy, readingsLast24h, completenessPct, lastReadingValues }`. **Errores:** `404 module_not_found`.

---

## Panel de demostración (solo dueño)

Doble protección: permiso `view_demo_panel` y bandera del entorno. Está habilitado en el perfil local y deshabilitado en producción salvo `VATIO_ENABLE_DEMO_PANEL=yes` (si está deshabilitado responde `404 demo_disabled`). Las acciones que modifican datos necesitan la base sembrada (`409 demo_not_seeded` si no).

### `GET /api/demo/state`  · `view_demo_panel`
- **Salida:** `{ enabled, demoMode, clock: { mode, speed, paused, now.. }, modules: [{ id, connected, buffered }], activeAlerts }`.

### `POST /api/demo/clock`  · `view_demo_panel`
- **Entrada (opcionales):** `speed` (1, 60 o 3600), `paused` (booleano), `advance` (`1h`, `1d`, `7d`). **Salida:** `{ clock, jobs }`. **Errores:** `400 invalid_speed | invalid_advance`.

### `POST /api/demo/anomaly`  · `view_demo_panel`
- **Entrada:** `{ loadCode, pct (1-500), durationMinutes (1-1440) }`. Dispara la alerta de consumo. **Salida:** `{ modifierId, startsAt, endsAt, jobs }`.

### `POST /api/demo/deterioration`  · `view_demo_panel`
- **Entrada:** `{ loadCode, days (3-30), pct (1-100) }`. Dispara la alerta de mantenimiento predictivo.

### `POST /api/demo/sign-on`  · `view_demo_panel`
- Deja el letrero encendido esta noche (alerta fuera de horario).

### `POST /api/demo/modules/:id/disconnect`  y  `POST /api/demo/modules/:id/reconnect`  · `view_demo_panel`
- Desconecta un módulo simulado (guarda lecturas en su memoria) y lo reconecta. **Salida de reconectar:** `{ moduleId, readingsBuffered, stored, lost, message: "Se sincronizaron N lecturas, 0 perdidas", jobs }`. **Errores:** `400 unknown_module`.

### `POST /api/demo/try-critical-off`  · `view_demo_panel`
- Intenta apagar un equipo crítico: `422`, `{ outcome: "rejected", reason: "critical_load_protected", .. }` y fila de auditoría.

### `POST /api/demo/try-unauthorized`  · `view_demo_panel`
- **Entrada:** `{ asRole, permission }`. **Salida:** `{ allowed, message, auditId, simulatedRole }`; deja una fila `permission_denied` en la auditoría. **Errores:** `400 invalid_role | invalid_permission`.

### `POST /api/demo/generate-loads`  · `view_demo_panel`
- **Entrada:** `{ count }`. Crea equipos de prueba con historial (prueba de rendimiento).

### `POST /api/demo/reset`  · `view_demo_panel`
- Borra los datos operativos y vuelve a generar la semilla desde el mismo instante. **Salida:** `{ anchor, clock, loadsCreated, rawReadings, hourlyRows }`. Audita `demo_reset`.

---

## Valor

### `GET /api/savings`  · `view_savings`
- **Salida:** `{ siteId, period: { from, to, days, basedOn }, loadsWithBaseline, loadsBuilding, baselineKwh, actualKwh, cumulativeSavingsKwh, cumulativeSavingsCop, rangeCop: { low, high }, investmentCop, payback, weekly: [{ weekStart, weekEnd, days, baselineKwh, actualKwh }], cumulative: [{ date, savingsCop, investmentCop }], note }`.
  - `payback`: `{ status: "estimated", label, investmentCop, months, minMonths, maxMonths (null si el extremo bajo no es ahorro), avgMonthlySavingsCop, message }` o, cuando el ahorro es ≤ 0, `{ status: "not_estimable", label: "Retorno no estimable", investmentCop, message }` (siempre se informa la inversión usada).
  - Compara días completos contra la línea base de los días anteriores al periodo; es una estimación.

### `GET /api/savings/attributable`  · `view_savings`
- **Salida:** `{ siteId, disclaimer, items: [{ recommendationId, title, loadCode, loadName, acceptedAt, status (conclusive, inconclusive, measuring), label ("Conclusivo", "No concluyente" o "En medición (día N de 7)"), message, disclaimer, dayN?, requiredDays?, daysMeasured?, direction?, savingsKwh?, savingsCop?, differenceKwh?, bandKwh? }] }`.

### `GET /api/reports/monthly`  · `view_reports`
- **Filtro:** `month` (`AAAA-MM`, por defecto el mes actual; solo días completos).
- **Salida:** `{ siteId, siteName, month, period: { from, to, days, partial }, generatedAt, summary: { consumptionKwh, consumptionCostCop, baselineKwh, savingsKwh, savingsCop, investmentCop, paybackStatus, paybackMonths, tariffCopPerKwh, loadsWithBaseline, loadsBuilding }, loads: [{ code, name, consumptionKwh, consumptionCostCop, baselineKwh, savingsKwh, savingsCop }], recommendations: [{ title, loadName, acceptedAt, label, savingsKwh, savingsCop }], note }`.
- **Errores:** `400 invalid_month`.

### `GET /api/reports/monthly/download`  · `download_report`
- **Filtros:** `month`, `format` (`csv` por defecto, o `pdf`). Descarga con `Content-Disposition`. Los valores son idénticos a los del JSON.
- **CSV:** columnas `section, code, name, consumption_kwh, consumption_cost_cop, baseline_kwh, savings_kwh, savings_cop`; primera fila `total`, luego una por equipo.
- **PDF:** resumen, equipos y recomendaciones con formato colombiano. Se audita `report_downloaded`.
- **Errores:** `400 invalid_format | invalid_month`.

### `GET /api/reports/impact`  · `view_impact_report`
- **Filtros:** `from`, `to` (`AAAA-MM-DD`, días completos; por defecto los últimos 30).
- **Salida:** `{ siteId, siteName, generatedAt, period: { from, to, days }, avoidedKwh, baselineKwh, actualKwh, reductionPct, avoidedKgCo2e (= avoidedKwh × factor), emissionFactorKgPerKwh, emissionFactorSource, methodology, loadsWithBaseline }`.
- **Errores:** `400 invalid_filter | invalid_period`.

### `GET /api/reports/impact/download`  · `download_impact_report`
- **Filtros:** `from`, `to`, `format` (`pdf` por defecto, o `json`). Misma información que el JSON, con periodo, metodología y fuente del factor. Se audita `report_downloaded`. **Errores:** `400 invalid_format | invalid_filter | invalid_period`.

### `GET /api/multisite`  · `view_multisite`
- **Filtro:** `days` (7-45, por defecto 30).
- **Salida:** `{ period, sectorReferenceKwhPerDay, highlightedSiteId, rows: [{ siteId, name, operatingDays, consumptionKwh, baselineKwh, kwhPerOperatingDay, copPerOperatingDay, savingsCopPerOperatingDay, reductionPct, vsSectorPct, highlighted }] }`. Todo se normaliza por día de operación; se resalta la sede con mayor reducción porcentual positiva. La referencia del sector se edita con `PUT /api/settings`.
- **Errores:** `400 invalid_period`.

### `GET /api/data/readings`  · `view_raw_data`
- **Filtros:** `site`, `load` (código), `from`, `to` (`AAAA-MM-DD` o instante ISO), `granularity` (`raw`, `hourly`), `limit` (1-5000, por defecto 200).
- **Salida:** `{ granularity, count, limit, columns, rows }`. **Errores:** `400 invalid_filter | invalid_limit`, `404 site_not_found`.

### `GET /api/data/export`  · `export_raw_data`
- **Filtros:** los de `/api/data/readings` más `format` (`csv` por defecto, o `json`) y `limit` (hasta 500 000). Columnas crudas: `site_id, load_code, ts, power_w, voltage_v, current_a, energy_kwh, module_id, source`; por hora: `site_id, load_code, hour_start, avg_power_w, max_power_w, energy_kwh, samples`.
- Se audita `data_exported` con los filtros. **Errores:** `400 invalid_format | invalid_filter | invalid_limit`, `404 site_not_found`.

### `POST /api/data/import`  · `import_raw_data`
- **Entrada:** `{ format: "csv" | "json", content: "<archivo como texto>" }` o, para JSON, `{ format: "json", rows: [..] }`. Solo lecturas crudas (el archivo exportado se acepta tal cual). Hasta 50 000 filas.
- Cada fila se valida (equipo y sede existentes, instante ISO UTC, potencia ≥ 0, módulo existente, fuente `simulator`, `esp32` o `import`), se guarda sin duplicar y se vuelve a leer de la base para compararla campo por campo.
- **Salida:** `{ received, valid, invalid, invalidSamples: [{ row, reason }], inserted, duplicates, conflicts, verified, preservedPct, message }`. `preservedPct` es el porcentaje de filas válidas cuyo valor guardado es idéntico al del archivo (100 cuando todo se conservó). Se audita `data_imported`.
- **Errores:** `400 invalid_format | invalid_file | file_too_large`, `413`.

---

## Telemetría y servicio

### `GET /api/health`  (público)
- **Salida:** `{ ok, service, source (esp32 o simulator), server_time, version, uptime_s }`; fuera de producción también `local_ips` y `port`. En producción no se exponen direcciones de red.

### `GET /api/info`  · cualquier sesión
- **Salida:** `{ port, local_ips, browser_urls, telemetry_urls, device_key_configured }` para configurar el ESP32.

### `GET /api/telemetry/latest`  · cualquier sesión
- **Salida:** `{ source, gateway, server_time, readings: [{ module_id, load_id, load_name, manufacturer, voltage_v, current_a, power_w, energy_kwh, status, timestamp, received_at, age_seconds, effective_status }] }`.

### `GET /api/telemetry/history`  · cualquier sesión
- **Filtro:** `limit` (1-1000, por defecto 250). **Salida:** `{ count, readings }` del ESP32.

### `POST /api/telemetry`  (público, con clave de dispositivo)
- **Encabezado:** `X-Device-Key` igual a `VATIO_DEVICE_KEY`. **Entrada:** el sobre del gateway (`gateway_id`, `site_id`, `readings: [..]`) o una lectura suelta, en el formato del ESP32 o de los fabricantes soportados (EnerSense, VoltioLab); todos se normalizan a un modelo único.
- **Salida 200:** `{ ok, received, accepted, duplicates, rejected: [{ .. }], sync, received_at }`. Un lote con algunas lecturas inválidas guarda las válidas.
- **Errores:** `401` clave inválida; `400` JSON inválido o todas las lecturas inválidas; `500`.

### `POST /api/reset`  · `configure`
- Oculta las lecturas del ESP32 y vuelve a la vista del simulador. **Salida:** `{ ok, source: "simulator" }`.

## Eventos y operación

### `POST /api/events`  (cualquier sesión)
- **Entrada:** `{ name, page? }`. `name` solo puede ser `page_view`, `report_view` o `help_opened`; `page` es opcional (hasta 60 caracteres: letras, números, `-_./#`).
- **Salida:** `202 { ok: true }`. Requiere CSRF como cualquier POST autenticado.
- **Errores:** `400 invalid_event`, `401`, `429 rate_limited` (más de 60 eventos por minuto por usuario).
- El resto de eventos (inicio y cierre de sesión, alertas, decisiones, descargas, respaldos) los registra el servidor solo.

### `GET /api/ops/events`  · `view_ops`
- **Filtros (query):** `name`, `from`, `to` (AAAA-MM-DD, el día final se incluye, o fecha ISO), `limit` (1-500, por defecto 100).
- **Salida:** `{ count, events: [{ id, at, name, userId, properties }] }`, de lo más nuevo a lo más antiguo. Nombres: `login_ok`, `login_failed`, `logout`, `alert_created`, `alert_reviewed`, `recommendation_decision`, `control_decision`, `report_downloaded`, `data_exported`, `backup_created`, `backup_failed`, `page_view`, `report_view`, `help_opened`.
- **Errores:** `400 invalid_filter`, `403` para otros perfiles (queda auditado).

### `GET /api/ops/errors`  · `view_ops`
- **Filtros (query):** `level` (`warn`, `error`, `fatal`), `limit` (1-500).
- **Salida:** `{ count, errors: [{ id, at, level, source, message, stack, context, requestId }] }`. `requestId` coincide con el encabezado `X-Request-Id` de la respuesta que falló.
- **Errores:** `400 invalid_filter`, `403`.

### `GET /api/ops/metrics`  · `view_ops`
- **Salida:** `{ uptime_s, requests: { total, by_status_class: { "2xx", "3xx", "4xx", "5xx", other } }, latency_ms: { samples, p50, p95 }, db: { size_bytes }, sessions: { active }, backup: { last_at, last_status (ok o failed), stored } }`. Los contadores y la latencia son de este proceso (se reinician al reiniciar).
- **Errores:** `403`.

### `GET /api/ops/backups`  · `manage_backups`
- **Salida:** `{ backups: [{ name, size_bytes, created_at, sha256 }], keep, intervalHours }`, del más nuevo al más antiguo.
- **Errores:** `403`.

### `POST /api/ops/backups`  · `manage_backups`
- **Entrada:** ninguna. Crea una copia consistente de la base, verifica su integridad y guarda su suma SHA-256.
- **Salida:** `201 { backup: { name, size_bytes, sha256 } }`. Audita `backup_created`.
- **Errores:** `500 backup_failed` (el detalle queda en `error_log`), `403`.

### `GET /api/ops/backups/:name/download`  · `manage_backups`
- **Salida:** el archivo SQLite como `application/octet-stream` (adjunto), enviado en flujo. Audita `backup_downloaded`. Guárdelo fuera del servidor.
- **Errores:** `404 backup_not_found` (nombre desconocido), `403`.

## Pruebas de la API

Las pruebas de integración están en `tests/api/` (`rbac`, `operations`, `control`, `value`, `reports`, `data`) y levantan la aplicación completa con una base temporal sembrada, un usuario demo por perfil y un reloj simulado controlado.
