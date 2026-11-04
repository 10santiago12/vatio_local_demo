# Pruebas de carga (RNF-01 y RNF-02)

Scripts de Node sin dependencias propias de la aplicación (el de dashboard usa Playwright de `qa/`).
Cada uno levanta un servidor desechable (perfil local, base temporal, secretos aleatorios, puertos 31901 y 31902) y lo apaga al terminar.

```
cd qa && npm install
node load/telemetry.js   # RNF-01
node load/dashboard.js   # RNF-02 (requiere: npx playwright install chromium)
```

Resultados y análisis: `docs/qa-carga.md`.
