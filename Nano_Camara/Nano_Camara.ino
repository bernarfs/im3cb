#include <Servo.h>
#include <stdlib.h>
#include <string.h>

// Nano clasico ATmega328P. Orden: brazo D, brazo I, pierna D, pierna I.
// Son canales de control: comprueba su correspondencia mecanica en tu robot.
const byte PINS[4] = {9, 5, 3, 11};
const int NEUTRAL[4] = {180, 100, 10, 90};
const int MINIMO[4] = {150, 85, 10, 75};
const int MAXIMO[4] = {180, 115, 40, 105};
Servo servos[4];
int actual[4] = {180, 100, 10, 90};
int destino[4] = {180, 100, 10, 90};
bool conectado = false;
bool activo = false;
unsigned long ultimaOrden = 0, ultimoPaso = 0;
char linea[48];
byte longitud = 0;
bool desbordada = false;

void detener() {
  activo = false;
  for (byte i = 0; i < 4; i++) destino[i] = actual[i];
  // Mantiene la ultima posicion. No es un corte electrico de emergencia.
}

void procesar() {
  if (strcmp(linea, "P") == 0) {
    Serial.println(F("IM3CB_NANO_1"));
  } else if (strcmp(linea, "S") == 0) {
    detener(); Serial.println(F("STOPPED"));
  } else if (strcmp(linea, "A") == 0) {
    if (!conectado) {
      // No hay pulsos a los servos hasta la primera activacion explicita.
      for (byte i = 0; i < 4; i++) {
        servos[i].write(NEUTRAL[i]);
        servos[i].attach(PINS[i]);
      }
      conectado = true;
    }
    activo = true; ultimaOrden = millis(); Serial.println(F("ARMED"));
  } else if (linea[0] == 'M' && linea[1] == ',') {
    int valores[4]; char *cursor = linea + 2; bool valida = true;
    for (byte i = 0; i < 4; i++) {
      char *fin;
      long valor = strtol(cursor, &fin, 10);
      if (cursor == fin || valor < MINIMO[i] || valor > MAXIMO[i] ||
          (i < 3 ? *fin != ',' : *fin != '\0')) { valida = false; break; }
      valores[i] = (int)valor; cursor = fin + (i < 3 ? 1 : 0);
    }
    if (!valida) { detener(); Serial.println(F("INVALID")); return; }
    if (activo) {
      for (byte i = 0; i < 4; i++) destino[i] = valores[i];
      ultimaOrden = millis();
    }
  } else {
    detener(); Serial.println(F("INVALID"));
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println(F("IM3CB_NANO_1"));
}

void loop() {
  // Limita el trabajo serie por iteracion para atender siempre el watchdog.
  byte presupuesto = 64;
  while (Serial.available() && presupuesto--) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (desbordada) { detener(); Serial.println(F("INVALID")); }
      else if (longitud) { linea[longitud] = '\0'; procesar(); }
      longitud = 0; desbordada = false;
    } else if (!desbordada) {
      if (longitud < sizeof(linea) - 1) linea[longitud++] = c;
      else { desbordada = true; detener(); }
    }
  }
  unsigned long ahora = millis();
  if (activo && ahora - ultimaOrden > 600) {
    detener(); Serial.println(F("TIMEOUT"));
  }
  if (activo && ahora - ultimoPaso >= 30) {
    ultimoPaso = ahora;
    for (byte i = 0; i < 4; i++) {
      if (actual[i] < destino[i]) actual[i]++;
      else if (actual[i] > destino[i]) actual[i]--;
      servos[i].write(actual[i]);
    }
  }
}
