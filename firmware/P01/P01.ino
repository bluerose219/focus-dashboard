// P01 기본 통합 회로를 바탕으로 한 집중 환경 체크 보드 코드.
// 변경: 소리 감지 모듈 AO(A2) 추가 · 가변저항(A0) 제거 · 버튼(D2)으로 LED 켜고 끔 · TOGGLE·BLINK 명령 추가.
// BLINK 1이면 LED가 1초에 4번 깜빡이고(시끄러움 알림), BLINK 0이면 원래 켜짐/꺼짐 상태로 돌아갑니다.
// 1초 동안 소리 값의 최대–최소 차이를 sound_pp로 보냅니다.
// 같은 폴더의 pins.h가 배선표와 동일한 핀을 지정합니다.
#include "pins.h"
#include <DHT.h>
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>
#include "protocol.h"
DHT dht(PIN_DHT, DHT11);
hd44780_I2Cexp lcd;
bool ledOn=false, automatic=false, dhtValid=false, lcdReady=false;
float temperature=0, humidity=0;
int lightRaw=0, onThreshold=350, offThreshold=450;
unsigned long lastDht=0, lastDisplay=0, lastState=0;
// 소리 값은 dB가 아닙니다. 마이크 출력의 흔들림 폭(최대–최소)으로 크기를 비교합니다.
int soundMin=1023, soundMax=0, soundPP=-1; // -1: 아직 1초 구간을 다 재지 못함
// 버튼 채터링 방지: 30ms 동안 같은 상태가 유지돼야 눌림·놓임으로 인정합니다.
const unsigned long DEBOUNCE_MS=30;
bool buttonStable=HIGH, buttonLast=HIGH;
unsigned long buttonChanged=0;
// 깜빡임: 0.125초마다 켜짐·꺼짐을 바꿔 1초에 4번 깜빡입니다. ledOn은 깜빡임이 끝난 뒤 돌아갈 원래 상태입니다.
const unsigned long BLINK_HALF_MS=125;
bool blinking=false, blinkPhase=false;
unsigned long blinkAt=0;
void stopBlink() { blinking=false; digitalWrite(PIN_LED,ledOn?HIGH:LOW); }
void safeStop() { automatic=false; ledOn=false; blinking=false; digitalWrite(PIN_LED, LOW); }
void snapshot(unsigned int request) {
  stateStart(request);
  Serial.print(F(",\"light_raw\":")); Serial.print(lightRaw);
  Serial.print(F(",\"button_pressed\":")); Serial.print(digitalRead(PIN_BUTTON)==LOW ? F("true") : F("false"));
  Serial.print(F(",\"led\":")); Serial.print(ledOn?1:0);
  Serial.print(F(",\"blink\":")); Serial.print(blinking?F("true"):F("false"));
  Serial.print(F(",\"auto\":")); Serial.print(automatic?F("true"):F("false"));
  Serial.print(F(",\"lcd_ready\":")); Serial.print(lcdReady?F("true"):F("false"));
  Serial.print(F(",\"temperature_c\":")); if(dhtValid) Serial.print(temperature,1); else Serial.print(F("null"));
  Serial.print(F(",\"humidity_pct\":")); if(dhtValid) Serial.print(humidity,1); else Serial.print(F("null"));
  Serial.print(F(",\"sound_pp\":")); if(soundPP>=0) Serial.print(soundPP); else Serial.print(F("null"));
  Serial.println('}');
}
bool command(unsigned int request, const char *name, char *args) {
  long value;
  if (!strcmp(name,"LED") && integer(args,0,1,value)) {
    automatic=false; blinking=false; ledOn=value; digitalWrite(PIN_LED,ledOn?HIGH:LOW); applied(request); return true;
  }
  if (!strcmp(name,"BLINK") && integer(args,0,1,value)) {
    automatic=false;
    if (value) { if (!blinking) { blinking=true; blinkPhase=true; blinkAt=millis(); digitalWrite(PIN_LED,HIGH); } }
    else if (blinking) stopBlink();
    applied(request); return true;
  }
  // TOGGLE: LED를 지금과 반대 상태로. 화면이 오래된 상태를 보고 판단하지 않도록 보드가 직접 뒤집습니다.
  if (!strcmp(name,"TOGGLE") && !*args) {
    automatic=false; blinking=false; ledOn=!ledOn; digitalWrite(PIN_LED,ledOn?HIGH:LOW); applied(request); return true;
  }
  if (!strcmp(name,"AUTO") && integer(args,0,1,value)) { automatic=value; applied(request); return true; }
  if (!strcmp(name,"THRESH")) {
    long limits[2];
    if(integers(args,2,0,1023,limits) && limits[0]<limits[1]) {
      onThreshold=limits[0]; offThreshold=limits[1]; applied(request); return true;
    }
  }
  errorReply(request,F("unsupported_or_range")); return false;
}
// 버튼을 누를 때마다(놓았다 누르는 순간 한 번) LED를 반대 상태로 바꿉니다.
// 깜빡이는 중이면 알림만 끄고 원래 상태로 돌아갑니다.
void readButton(unsigned long now) {
  bool raw=digitalRead(PIN_BUTTON);
  if(raw!=buttonLast) { buttonLast=raw; buttonChanged=now; }
  if(now-buttonChanged>=DEBOUNCE_MS && raw!=buttonStable) {
    buttonStable=raw;
    if(buttonStable==LOW) { // INPUT_PULLUP: 누르면 LOW
      automatic=false;
      if (blinking) stopBlink();
      else { ledOn=!ledOn; digitalWrite(PIN_LED,ledOn?HIGH:LOW); }
      snapshot(0); // 화면이 1초를 기다리지 않고 바로 바뀌도록 즉시 보냅니다.
    }
  }
}
void setup() {
  pinMode(PIN_LED,OUTPUT); pinMode(PIN_BUTTON,INPUT_PULLUP); safeStop();
  Serial.begin(115200); dht.begin();
  Wire.begin(); Wire.setWireTimeout(25000,true);
  lcdReady=lcd.begin(16,2)==0;
  if(lcdReady) { lcd.backlight(); lcd.print("P01 ready"); }
  lastContact=millis();
}
void loop() {
  readCommands(); unsigned long now=millis();
  readButton(now);
  if(blinking && now-blinkAt>=BLINK_HALF_MS) { blinkAt=now; blinkPhase=!blinkPhase; digitalWrite(PIN_LED,blinkPhase?HIGH:LOW); }
  lightRaw=analogRead(PIN_LIGHT);
  int sound=analogRead(PIN_SOUND);
  if(sound<soundMin) soundMin=sound;
  if(sound>soundMax) soundMax=sound;
  // CdS를 5V 쪽, 10k 저항을 GND 쪽에 둔 회로: 어두울수록 값이 작습니다.
  if(automatic) {
    if(lightRaw<onThreshold) ledOn=true;
    else if(lightRaw>offThreshold) ledOn=false;
    digitalWrite(PIN_LED,ledOn?HIGH:LOW);
  }
  if(now-lastDht>=2000) {
    lastDht=now; humidity=dht.readHumidity(); temperature=dht.readTemperature();
    dhtValid=!isnan(humidity)&&!isnan(temperature);
  }
  if(lcdReady && now-lastDisplay>=500) {
    lastDisplay=now; char row[17];
    // AVR snprintf는 소수점 출력을 지원하지 않아 정수로 표시합니다.
    if(dhtValid) snprintf(row,sizeof(row),"T:%3dC H:%3d%%  ",(int)(temperature+0.5),(int)(humidity+0.5));
    else snprintf(row,sizeof(row),"T: --  H: --   ");
    lcd.setCursor(0,0); lcd.print(row);
    snprintf(row,sizeof(row),"Snd:%4d LED:%c  ",soundPP<0?0:soundPP,blinking?'B':(ledOn?'1':'0'));
    lcd.setCursor(0,1); lcd.print(row);
  }
  if(now-lastState>=1000) {
    lastState=now; soundPP=soundMax-soundMin; soundMin=1023; soundMax=0;
    snapshot(0);
  }
}
