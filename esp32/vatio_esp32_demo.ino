/*
  Vatio ESP32 - Gateway virtual de 8 medidores
  =============================================

  El PC ejecuta Vatio Local:
      http://IP_DEL_PC:3000

  El ESP32 envía:
      POST http://IP_DEL_PC:3000/api/telemetry

  IMPORTANTE:
  - ESP32 y PC deben estar en la misma red Wi-Fi.
  - Cambia WIFI_SSID, WIFI_PASSWORD y PC_IP.
  - El servidor y este firmware usan por defecto:
        X-Device-Key: vatio-demo-2026

  No requiere ArduinoJson.
*/

#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID     = "TU_WIFI";
const char* WIFI_PASSWORD = "TU_PASSWORD";

// PON AQUÍ LA IP QUE VATIO LOCAL IMPRIME AL ARRANCAR.
// Ejemplo: "192.168.1.45"
const char* PC_IP = "192.168.1.45";

const uint16_t SERVER_PORT = 3000;
const char* DEVICE_KEY = "vatio-demo-2026";

const unsigned long SEND_EVERY_MS = 5000;

struct VirtualDevice {
  const char* moduleId;
  const char* loadId;
  const char* name;
  const char* manufacturer;
  float nominalW;
  float energyKWh;
};

VirtualDevice devices[] = {
  {"MX-001","freezer","Congelador vertical","EnerSense",350.0,0.0},
  {"MX-002","fridge","Nevera exhibidora","VoltioLab",400.0,0.0},
  {"MX-003","pos","Computador / POS","EnerSense",120.0,0.0},
  {"MX-004","oven","Horno eléctrico","VoltioLab",6000.0,0.0},
  {"MX-005","coffee","Cafetera industrial","EnerSense",2000.0,0.0},
  {"MX-006","ac","Aire acondicionado","VoltioLab",1200.0,0.0},
  {"MX-007","sign","Letrero luminoso","EnerSense",250.0,0.0},
  {"MX-008","tv","Televisor","VoltioLab",110.0,0.0}
};

const int DEVICE_COUNT = sizeof(devices) / sizeof(devices[0]);

unsigned long lastSendMs = 0;
unsigned long lastEnergyMs = 0;

float randFactor(float pct) {
  long n = random(-1000, 1001);
  return 1.0f + ((float)n / 1000.0f) * pct;
}

float powerForDevice(const VirtualDevice& d) {
  unsigned long s = millis() / 1000;

  if (strcmp(d.loadId, "freezer") == 0) {
    // Escenario de deterioro: +18 % cuando compresor está ON.
    bool compressorOn = ((s / 6) % 10) < 6;
    return compressorOn ? d.nominalW * 1.18f * randFactor(0.04f) : 18.0f;
  }

  if (strcmp(d.loadId, "fridge") == 0) {
    bool compressorOn = ((s / 5) % 10) < 5;
    return compressorOn ? d.nominalW * randFactor(0.04f) : 16.0f;
  }

  if (strcmp(d.loadId, "pos") == 0) {
    return 120.0f * randFactor(0.03f);
  }

  if (strcmp(d.loadId, "oven") == 0) {
    bool heaterOn = ((s / 8) % 10) < 6;
    return heaterOn ? 6000.0f * randFactor(0.03f) : 90.0f;
  }

  if (strcmp(d.loadId, "coffee") == 0) {
    bool heating = ((s / 5) % 10) < 4;
    return heating ? 2000.0f * randFactor(0.04f) : 150.0f;
  }

  if (strcmp(d.loadId, "ac") == 0) {
    bool compressor = ((s / 7) % 10) < 7;
    return compressor ? 1200.0f * randFactor(0.04f) : 80.0f;
  }

  if (strcmp(d.loadId, "sign") == 0) {
    // Se mantiene ON para poder demostrar "fuera de horario".
    return 250.0f * randFactor(0.02f);
  }

  if (strcmp(d.loadId, "tv") == 0) {
    return 110.0f * randFactor(0.03f);
  }

  return 0.0f;
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Conectando a WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi conectado.");
  Serial.print("IP ESP32: ");
  Serial.println(WiFi.localIP());
}

void updateEnergy() {
  unsigned long now = millis();

  if (lastEnergyMs == 0) {
    lastEnergyMs = now;
    return;
  }

  float dtHours = (now - lastEnergyMs) / 3600000.0f;

  for (int i = 0; i < DEVICE_COUNT; i++) {
    float p = powerForDevice(devices[i]);
    devices[i].energyKWh += p * dtHours / 1000.0f;
  }

  lastEnergyMs = now;
}

String buildPayload() {
  String json;
  json.reserve(5000);

  json += "{";
  json += "\"gateway_id\":\"ESP32-DEMO-01\",";
  json += "\"site_id\":\"la-espiga-chia\",";
  json += "\"readings\":[";

  for (int i = 0; i < DEVICE_COUNT; i++) {
    if (i > 0) json += ",";

    VirtualDevice& d = devices[i];

    float powerW = powerForDevice(d);
    float voltage = 120.0f * randFactor(0.015f);
    float current = voltage > 0 ? powerW / voltage : 0;

    json += "{";

    json += "\"module_id\":\"";
    json += d.moduleId;
    json += "\",";

    json += "\"load_id\":\"";
    json += d.loadId;
    json += "\",";

    json += "\"load_name\":\"";
    json += d.name;
    json += "\",";

    json += "\"manufacturer\":\"";
    json += d.manufacturer;
    json += "\",";

    json += "\"voltage_v\":";
    json += String(voltage, 2);
    json += ",";

    json += "\"current_a\":";
    json += String(current, 3);
    json += ",";

    json += "\"power_w\":";
    json += String(powerW, 1);
    json += ",";

    json += "\"energy_kwh\":";
    json += String(d.energyKWh, 6);
    json += ",";

    json += "\"status\":\"active\",";

    // El servidor asigna timestamp real de recepción.
    json += "\"timestamp\":\"\"";

    json += "}";
  }

  json += "]}";
  return json;
}

void sendTelemetry() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  String url = "http://" + String(PC_IP) + ":" + String(SERVER_PORT) + "/api/telemetry";
  String payload = buildPayload();

  WiFiClient client;
  HTTPClient http;

  Serial.println();
  Serial.print("POST ");
  Serial.println(url);

  if (!http.begin(client, url)) {
    Serial.println("No se pudo iniciar HTTP.");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);

  int code = http.POST(payload);

  Serial.print("HTTP status: ");
  Serial.println(code);

  if (code > 0) {
    Serial.println(http.getString());
  } else {
    Serial.println("No hubo respuesta del PC.");
    Serial.println("Revisa PC_IP, misma WiFi y firewall de Windows.");
  }

  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(800);

  randomSeed(esp_random());
  connectWiFi();

  lastEnergyMs = millis();

  Serial.println();
  Serial.println("Vatio ESP32 listo.");
  Serial.println("Abre Vatio Local en el PC y revisa Estado de módulos.");
}

void loop() {
  updateEnergy();

  unsigned long now = millis();
  if (now - lastSendMs >= SEND_EVERY_MS) {
    lastSendMs = now;
    sendTelemetry();
  }

  delay(50);
}
