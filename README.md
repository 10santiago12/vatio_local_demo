# VATIO — prototipo local en desarrollo

**Estado:** implementación parcial. Hay ingreso de administrador, almacenamiento SQLite de lecturas, protección CSRF y rechazo de solicitudes sobre las tres cargas críticas de la demo. La autorización por múltiples roles y sedes, aprobación de órdenes, modo cierre y el resto de los flujos de negocio todavía no están implementados. Las vistas contienen ejemplos identificados como tales. No se controla hardware físico. No utilizar para operaciones reales ni exponer a redes no confiables.

## Requisitos e inicio

Node.js 24 o superior; no requiere paquetes externos. En PowerShell, antes del primer inicio configure variables en la sesión local. El primer inicio crea un usuario `admin` con contraseña protegida mediante scrypt; use una contraseña única de al menos 16 caracteres. Use entrada oculta para evitar escribir secretos en el historial:

```powershell
$secure = Read-Host 'Contraseña inicial del administrador' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $env:VATIO_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
$secureDevice = Read-Host 'Clave de dispositivo' -AsSecureString
$ptrDevice = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureDevice)
try { $env:VATIO_DEVICE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptrDevice) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptrDevice) }
npm start
```

Abra http://127.0.0.1:3000 e ingrese como `admin`. Sin clave de dispositivo se rechaza toda ingestión. La contraseña inicial solo se usa al crear el usuario: cambiar la variable no cambia una contraseña existente. La base se crea en `data/vatio.sqlite` mediante un esquema inicial al iniciar; aún no hay sistema de migraciones versionadas. No borre la base para recuperar acceso si desea conservar datos. `.env.example` documenta variables, pero no se carga automáticamente.

Las lecturas simuladas aparecen cuando todavía no hay telemetría ESP32. El protocolo recibe `POST /api/telemetry` con `X-Device-Key`, `gateway_id: ESP32-DEMO-01`, `site_id: la-espiga-chia` y `readings`. Para un ESP32 en otra máquina se necesita configurar `HOST` y la clave en el firmware y establecer transporte TLS y protección de red adecuados; el firmware actual utiliza HTTP sin cifrar. No se ha verificado el dispositivo físico.

## Pruebas

```powershell
npm run check
npm test
```

Las pruebas actuales cubren autenticación básica, clave de dispositivo, CSRF, rechazo de carga crítica y recuperación de telemetría tras reiniciar. No constituyen una validación completa de roles, interfaz, concurrencia o seguridad. Consulte `docs/00-gap-analysis.md` para la auditoría original y `.ai/HANDOFF.md` para el trabajo pendiente.
