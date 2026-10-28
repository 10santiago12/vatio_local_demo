# Vatio Local Demo

Conversión local del prototipo de Figma **Vatio**. El proyecto incluye:

- Dashboard web servido en `http://localhost:3000`.
- API local para recibir telemetría de un ESP32.
- Simulador integrado: la UI funciona aunque el ESP32 esté apagado.
- Cambio automático a **ESP32 en vivo** cuando llega el primer lote.
- Firmware `.ino` que hace que un solo ESP32 finja ser 8 medidores.
- Histórico de los lotes recibidos en `data/telemetry.jsonl`.

## Arquitectura

```text
 ESP32
   |
   | HTTP POST cada 5 s
   | X-Device-Key: vatio-demo-2026
   v
 PC en la misma Wi-Fi
 http://IP_DEL_PC:3000/api/telemetry
   |
   +--> Node server.js
   |      +--> data/telemetry.jsonl
   |
   +--> Dashboard Vatio
          GET /api/telemetry/latest cada 2 s
```

## Requisitos

- Node.js 18 o superior.
- ESP32 y PC conectados a la misma red Wi-Fi.
- Para el ESP32: Arduino IDE con el core de ESP32.
- No hay dependencias npm externas.

## 1. Ejecutar la web

### Opción A — Windows

Haz doble clic en:

```text
start_windows.bat
```

### Opción B — Terminal

```bash
npm start
```

o directamente:

```bash
node server.js
```

El terminal imprimirá algo como:

```text
Vatio Local está ejecutándose
Navegador en este PC: http://localhost:3000
Red local:             http://192.168.1.45:3000
ESP32 POST:            http://192.168.1.45:3000/api/telemetry
X-Device-Key:          vatio-demo-2026
```

Abre `http://localhost:3000`.

En **Panel de Demo** o **Estado de módulos**, Vatio también muestra el endpoint que debes copiar al ESP32.

## 2. Configurar el ESP32

Abre:

```text
esp32/vatio_esp32_demo.ino
```

Cambia:

```cpp
const char* WIFI_SSID     = "TU_WIFI";
const char* WIFI_PASSWORD = "TU_PASSWORD";
const char* PC_IP         = "192.168.1.45";
```

`PC_IP` debe ser la dirección que imprimió Vatio Local.

No uses `localhost` ni `127.0.0.1` dentro del ESP32: esas direcciones se referirían al propio ESP32, no al PC.

## 3. Cargar al ESP32

En Arduino IDE:

1. Selecciona `ESP32 Dev Module` o tu placa específica.
2. Selecciona el puerto.
3. Compila y sube.
4. Abre Serial Monitor a `115200`.

Deberías ver:

```text
POST http://192.168.1.45:3000/api/telemetry
HTTP status: 200
{"ok":true,"received":8,...}
```

En unos 2 segundos, la etiqueta azul **Datos simulados** del dashboard cambiará a verde:

```text
ESP32 en vivo
```

## 4. Si el ESP32 no llega al servidor

### Comprueba primero desde el celular

Con el celular en la misma Wi-Fi abre:

```text
http://IP_DEL_PC:3000/api/health
```

Si no abre, el problema es red/firewall, no el ESP32.

### Firewall de Windows

Cuando Node solicite permiso de red, permite acceso en **redes privadas**.

También puedes crear una regla para TCP 3000 en Firewall de Windows.

### Redes de invitados

Algunas redes Wi-Fi tienen `AP isolation` / `client isolation`. En ellas dos dispositivos de la misma Wi-Fi no pueden verse entre sí.

Usa una red doméstica, hotspot o router sin aislamiento.

## API

### Salud

```http
GET /api/health
```

### Información de conexión

```http
GET /api/info
```

### Últimas lecturas

```http
GET /api/telemetry/latest
```

### Histórico en memoria

```http
GET /api/telemetry/history?limit=250
```

### Ingestión desde ESP32

```http
POST /api/telemetry
Content-Type: application/json
X-Device-Key: vatio-demo-2026
```

Payload:

```json
{
  "gateway_id": "ESP32-DEMO-01",
  "site_id": "la-espiga-chia",
  "readings": [
    {
      "module_id": "MX-001",
      "load_id": "freezer",
      "load_name": "Congelador vertical",
      "manufacturer": "EnerSense",
      "voltage_v": 120.1,
      "current_a": 3.43,
      "power_w": 412,
      "energy_kwh": 0.123,
      "status": "active"
    }
  ]
}
```

## Seguridad

Esto está preparado para una **demo local**, no para Internet.

La clave por defecto es:

```text
vatio-demo-2026
```

Puedes cambiarla al iniciar el servidor:

### PowerShell

```powershell
$env:VATIO_DEVICE_KEY="otra-clave"
node server.js
```

En ese caso cambia `DEVICE_KEY` también en el `.ino`.

## Fuente de datos

- Antes de recibir ESP32: `source = simulator`.
- Después de recibir ESP32: `source = esp32`.
- Si un módulo deja de reportar por más de 120 s, se muestra `inactive`.
- `POST /api/reset` borra las lecturas reales de memoria y vuelve al simulador.

## Diseño

La implementación sigue la dirección visual del Figma Vatio:
- fondo `#f6f8f7`;
- sidebar oscuro `#0e1612`;
- verde de energía `#148c4f`;
- tarjetas blancas;
- estados verde/ámbar/rojo/azul;
- tipografía Manrope cuando hay Internet, con fallback local.

El frontend es responsive y funciona también en móvil.
