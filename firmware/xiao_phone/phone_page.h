// 핸드폰 화면 · XIAO가 http://<IP>/ 로 제공합니다.
#pragma once
const char PHONE_HTML[] PROGMEM = R"PAGE(<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>집중 환경 체크 · 핸드폰</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&family=Noto+Serif+KR:wght@700&display=swap">
<style>
/* 디자인: open-design · warm-editorial 기반 D 시안 (PC 화면과 같은 색·글꼴) */
:root{--bg:#FAF7F2;--surface:#fff;--ink:#1C1A17;--muted:#6F665F;--line:rgba(47,91,79,.16);--accent:#B04A28;--on-accent:#FAF7F2;--forest:#2F5B4F;
--good:#2F5B4F;--good-bg:#EEF3EF;--warn:#8A5A00;--warn-bg:#FFF5E0;--bad:#B3261E;--bad-bg:#FCEBE6;--unk:#6F665F;--unk-bg:#F1ECE4;--focus:#2F5B4F;
--serif:"Noto Serif KR","Batang",serif;
font-family:"Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;color:var(--ink);background:var(--bg);color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}
main{max-width:520px;margin:0 auto;padding:24px 16px 40px;display:grid;gap:14px}
h1{font-family:var(--serif);font-size:24px;margin:0}p{margin:4px 0;line-height:1.6}.muted{color:var(--muted)}
:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
.verdict{border:1px solid var(--unk);background:var(--unk-bg);border-radius:16px;padding:16px;display:grid;grid-template-columns:48px 1fr;gap:12px;align-items:center}
.verdict h2{font-family:var(--serif);font-size:24px;margin:0}.verdict .lbl{font-size:12px;font-weight:700;color:var(--muted);margin:0}
.verdict[data-k="good"] h2{color:var(--good)}.verdict[data-k="bad"] h2{color:var(--bad)}
.icon{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-size:26px;font-weight:800;color:var(--surface);background:var(--unk)}
.verdict[data-k="good"]{border-color:var(--good);background:var(--good-bg)}.verdict[data-k="good"] .icon{background:var(--good)}
.verdict[data-k="warn"]{border-color:var(--warn);background:var(--warn-bg)}.verdict[data-k="warn"] .icon{background:var(--warn);border-radius:6px}
.verdict[data-k="bad"]{border-color:var(--bad);background:var(--bad-bg)}.verdict[data-k="bad"] .icon{background:var(--bad);border-radius:10px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:12px;min-width:0}
.card h3{font-size:14px;margin:0 0 4px;color:var(--forest)}.card .v{font-family:var(--serif);font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.card small{font-family:"Noto Sans KR",sans-serif;font-size:13px;font-weight:400;color:var(--muted)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px}
.panel h2{font-family:var(--serif);color:var(--forest)}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
button{min-height:52px;border-radius:12px;border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);font:inherit;font-size:17px;font-weight:700}
button.secondary{background:transparent;color:var(--ink);border-color:var(--ink)}button:disabled{opacity:.45}
#result{font-weight:700;min-height:1.6em}
</style>
</head>
<body>
<main>
<header><h1>집중 환경 체크</h1><p id="age" class="muted">PC 대시보드 연결 확인 중</p></header>
<section id="verdict" class="verdict" data-k="unknown" aria-labelledby="title">
  <div class="icon" id="icon" aria-hidden="true">?</div>
  <div><p class="lbl">지금 판단</p><h2 id="title" role="status">확인 중</h2><p id="reason">PC 대시보드에서 데이터를 받는 중입니다.</p></div>
</section>
<div class="cards" aria-label="현재 측정값">
  <div class="card"><h3>소음</h3><div class="v" id="level">—</div><small id="sound">상대값 —</small></div>
  <div class="card"><h3>온도</h3><div class="v"><span id="temp">—</span><small> °C</small></div><small>쾌적 20–26</small></div>
  <div class="card"><h3>습도</h3><div class="v"><span id="hum">—</span><small> %</small></div><small>쾌적 40–60</small></div>
</div>
<section class="panel" aria-labelledby="led-h">
  <h2 id="led-h" style="font-size:18px;margin:0">LED</h2>
  <p>보드 보고 상태: <strong id="led">—</strong></p>
  <div class="actions"><button id="on" type="button">LED 켜기</button><button id="off" type="button" class="secondary">LED 끄기</button></div>
  <p id="result" role="status">명령 없음</p>
  <p class="muted" style="font-size:13px">‘보드 적용 응답’은 코드 실행 응답입니다. 실제 LED도 눈으로 확인하세요. 응답이 없으면 다시 보내지 않습니다.</p>
</section>
</main>
<script>
(()=>{'use strict';
const $=id=>document.getElementById(id);
const ICON={good:'✓',warn:'!',bad:'×',unknown:'?',idle:'?'};
let view=null,ageMs=null,waitId=0,waitTimer=null,lastTitle='',reachable=true;
function show(){
  const stale=!reachable||ageMs===null||ageMs>4000;
  $('age').textContent=!reachable?'XIAO에 연결되지 않음 · 핫스팟 연결을 확인하세요':ageMs===null?'PC 대시보드 데이터 없음 · PC에서 XIAO 연결을 확인하세요':stale?`PC 대시보드 데이터가 ${Math.round(ageMs/1000)}초 전 것입니다 · PC 화면이 열려 있는지 확인하세요`:'PC 대시보드와 연결됨 · 1초마다 갱신';
  const k=stale||!view?'unknown':view.k,title=stale||!view?'판단 보류':view.title;
  $('verdict').dataset.k=k; $('icon').textContent=ICON[k]||'?';
  if(k+title!==lastTitle){$('title').textContent=title;lastTitle=k+title;}
  $('reason').textContent=stale||!view?'최신 데이터가 없어 판단하지 않습니다.':view.reason;
  const val=(x)=>!stale&&view&&x!==null&&x!==undefined?x:'—';
  $('level').textContent=val(view&&view.level); $('sound').textContent='상대값 '+val(view&&view.sound);
  $('temp').textContent=val(view&&view.temp); $('hum').textContent=val(view&&view.hum); $('led').textContent=val(view&&view.led);
  const can=!stale&&view&&view.can_cmd&&!waitId; $('on').disabled=!can; $('off').disabled=!can;
}
async function poll(){
  try{
    const r=await fetch('/api/view',{cache:'no-store',signal:AbortSignal.timeout(3000)}); const d=await r.json();
    reachable=true; ageMs=d.age_ms; if(d.view)view=d.view;
    if(waitId&&d.result&&d.result.id===waitId){clearTimeout(waitTimer);$('result').textContent=`#${waitId} ${d.result.text}`;waitId=0;}
  }catch(e){reachable=false;}
  show(); setTimeout(poll,1000);
}
async function send(on){
  if(waitId)return;
  $('result').textContent='전송 중…'; show();
  try{
    const r=await fetch('/api/led?on='+on,{method:'POST',signal:AbortSignal.timeout(3000)}); const d=await r.json();
    if(!r.ok||!d.ok){$('result').textContent=d.text||'XIAO가 명령을 받지 않았습니다.';return;}
    waitId=d.id; $('result').textContent=`#${waitId} 전송됨 · 보드 응답 기다리는 중`;
    waitTimer=setTimeout(()=>{$('result').textContent=`#${waitId} 응답 없음 · 적용 여부 미확인. 자동으로 다시 보내지 않습니다.`;waitId=0;show();},8000);
  }catch(e){$('result').textContent='전송 실패 · 적용 여부 미확인: '+e.message;}
  show();
}
$('on').addEventListener('click',()=>send(1)); $('off').addEventListener('click',()=>send(0));
show(); poll();
})();
</script>
</body>
</html>)PAGE";
