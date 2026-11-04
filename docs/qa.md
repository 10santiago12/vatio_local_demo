# QA de interfaz (RNF-04)

Pruebas automatizadas de navegador con Playwright (`qa/`), más dos plantillas para completar con personas: dispositivos reales y pruebas de usabilidad. Las pruebas de carga están en [`qa-carga.md`](qa-carga.md).

## Matriz ejecutada (4 de noviembre de 2026)

Servidor local desechable (perfil local, base temporal con la demostración sembrada, puerto 31903), sesión del administrador creada con la contraseña del entorno. Cada navegador ejecuta 7 escenarios; los 2 escenarios de barra inferior solo aplican a móvil y se omiten en escritorio.

| Navegador | Tipo | Aprobadas | Falladas | Omitidas |
|---|---|---|---|---|
| Google Chrome instalado (`channel: chrome`) | escritorio 1440x900 | 5 | 0 | 2 |
| Microsoft Edge instalado (`channel: msedge`) | escritorio 1440x900 | 5 | 0 | 2 |
| Chromium de Playwright | escritorio 1440x900 | 5 | 0 | 2 |
| Firefox de Playwright | escritorio 1440x900 | 5 | 0 | 2 |
| WebKit de Playwright | escritorio 1440x900 | 5 | 0 | 2 |
| iPhone 13 (emulación sobre WebKit) | 390x844 | 7 | 0 | 0 |
| Pixel 7 (emulación sobre Chromium) | 412x915 | 7 | 0 | 0 |
| **Total** | | **39** | **0** | **10** |

Escenarios (todos en `qa/e2e/vatio.spec.js`):

1. Login correcto y mensaje de error con contraseña incorrecta.
2. Logout: vuelve al formulario de ingreso, borra la cookie y no deja token, CSRF ni sesión en `localStorage` ni `sessionStorage`.
3. Las 11 vistas más el Panel de Demo cargan con contenido, sin errores de consola, sin errores de página y sin peticiones fallidas ni con estado 4xx/5xx (con sesión iniciada). Se guarda una captura de cada vista por navegador.
4. El botón de tema cambia el tema y se conserva tras recargar.
5. Sin desbordamiento horizontal en ninguna vista (1440x900 y móviles).
6. Móvil: ningún elemento visible se superpone con la barra inferior al llegar al final de cada vista (se descartan los recortados por contenedores con desplazamiento y el contenido de `<details>` cerrados).
7. Móvil: la barra inferior y la hoja "Más" cambian de vista.

## Hallazgos

- Ningún fallo real de la aplicación: no se modificó la interfaz.
- Dos falsos positivos de las propias pruebas se corrigieron antes del resultado final: las tablas dentro de un `<details>` cerrado y las tablas con desplazamiento propio se contaban como superpuestas con la barra inferior.
- Las capturas quedan en `qa/results/screenshots/<navegador>/<vista>.png` (carpeta ignorada por git); no sustituyen la revisión visual de una persona.

## Límites

- WebKit de Playwright **no es Safari real**: comparte el motor, no el navegador ni iOS.
- Los móviles son **emulados** (tamaño de pantalla, agente de usuario y tacto), no dispositivos físicos: no cubren teclado del sistema, barra de direcciones dinámica, rendimiento real ni redes móviles.
- Chrome y Edge se probaron en la versión instalada en el equipo de desarrollo; las versiones antiguas no se cubren.
- Solo se probó el rol de administrador (dueño) sobre datos de demostración y un servidor local, no el servicio desplegado.
- No hay evaluación formal de accesibilidad (lectores de pantalla, contraste medido).

## Cómo repetirlo

```
cd qa
npm install
npx playwright install chromium firefox webkit
npm test                       # toda la matriz
npx playwright test --project=firefox   # un solo navegador
```

Chrome y Edge se incluyen solo si están instalados en las rutas habituales de Windows. El servidor se levanta y se apaga solo (puerto 31903, base temporal, secretos aleatorios).

---

## Plantilla 1: revisión en dispositivo real

Para una persona con un celular Android o iPhone. Sitio: https://vatio-ot3j.onrender.com/ (el primer acceso puede tardar hasta un minuto si el servicio estaba dormido).

Pasos: (1) abrir el sitio; (2) ingresar con las credenciales entregadas; (3) abrir cada opción del menú inferior y de "Más"; (4) cambiar el tema; (5) girar el celular a horizontal y volver a vertical; (6) cerrar sesión y comprobar que vuelve al ingreso.

| Campo | Valor |
|---|---|
| Revisor y fecha | |
| Dispositivo (marca y modelo) | |
| Sistema operativo y versión | |
| Navegador y versión | |
| Tamaño de pantalla / modo (vertical, horizontal) | |

| Paso | Resultado (OK / Falla) | Observación | Captura (archivo) |
|---|---|---|---|
| 1. Abre el sitio | | | |
| 2. Ingresa con usuario y contraseña | | | |
| 3a. Navega por el menú inferior | | | |
| 3b. Abre la hoja "Más" y entra a una vista | | | |
| 3c. Todas las vistas se ven completas, sin texto cortado ni solapado | | | |
| 4. Cambia el tema y se conserva al recargar | | | |
| 5. Girar la pantalla no rompe el diseño | | | |
| 6. Cierra sesión y vuelve al ingreso | | | |

Resultado global: ____ (aprobado / aprobado con observaciones / rechazado).

---

## Plantilla 2: hoja de pruebas de usabilidad

### RNF-05: identificar el equipo de mayor consumo (meta: menos de 30 s, 5 usuarios)

Procedimiento: sin explicarle la pantalla, pedir a la persona que ingrese a la vista Inicio y diga qué equipo gasta más. Medir con cronómetro desde que ve la pantalla hasta que responde. Anotar si acertó (comparar con el primer puesto del ranking).

| Usuario | Perfil (cargo, experiencia con tecnología) | Tiempo (s) | Respuesta correcta (sí / no) | Observaciones |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| Promedio / máximo | | | | |

Criterio: se cumple si todos aciertan y el tiempo es menor de 30 s. Resultado: ____

### RNF-06: mensajes comprendidos sin explicación (3 usuarios)

Procedimiento: mostrar cada mensaje sin explicarlo y preguntar "¿qué entiende y qué haría?". Marcar si lo explica correctamente con sus palabras.

| Mensaje / pantalla evaluada | Usuario 1 (entiende: sí / no) | Usuario 2 | Usuario 3 | Qué entendieron (resumen) |
|---|---|---|---|---|
| Una alerta de consumo | | | | |
| Una recomendación de ahorro | | | | |
| Solicitud de apagado pendiente de aprobación | | | | |
| Mensaje de equipo sin comunicación | | | | |
| Informe mensual (ahorro y retorno) | | | | |

Datos de los usuarios: ______________________________. Criterio: se cumple si cada usuario comprende todos los mensajes sin ayuda. Resultado: ____

Reglas de aplicación: no ayudar ni explicar durante la prueba, registrar frases textuales, y pedir consentimiento para anotar las respuestas.
