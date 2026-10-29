/* 집중 환경 체크 · P01 Web Serial 연결 코드를 바탕으로 소음(sound_pp) 판단을 추가했습니다.
   통신 규칙은 P01과 같습니다: 연결은 사용자가 버튼을 눌렀을 때만, 응답이 없으면 자동 재전송하지 않습니다. */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const COMFORT = {tMin:20, tMax:26, hMin:40, hMax:60};
  const WINDOW_MS = 10 * 60 * 1000, CALIB_MS = 10000, STORE = 'focus-calib-v1';
  let port = null, reader = null, writer = null, reading = null, closing = false;
  let mode = 'none', lastState = null, lastTime = 0, request = 0, pending = null;
  let records = [], events = [], log = [], demoTimer = null, demoStep = 0, demoLed = 0, demoBlink = false, session = 0;
  let paused = false, level = 'unknown', lastVerdict = '', measuring = null;
  let lostAt = 0; // USB가 예기치 않게 끊긴 시각. 사용자가 직접 해제하면 0으로 둡니다.
  let calib = loadCalib();
  const LIGHT_STORE = STORE + '-light';
  let lightCalib = loadLight(), bright = 'unknown', lightMeasuring = null;
  const commandButtons = [...document.querySelectorAll('[data-command]')];
  const LEVEL_TEXT = {quiet:'조용', warn:'보통 · 주의', loud:'시끄러움', unknown:'—'};

  function say(text) { el('notice').textContent = text; }
  function trace(text) { log.push(text); log = log.slice(-16); el('log').textContent = log.join('\n'); }
  function fresh() { return !!lastState && Date.now() - lastTime < 4000; }
  function hasSound(s) { return s && Number.isInteger(s.sound_pp); }

  /* ----- 소음 기준 (조용할 때 측정값 × 배수) ----- */
  function loadCalib() {
    try {
      const c = JSON.parse(localStorage.getItem(STORE));
      if (c && Number.isFinite(c.base) && c.base >= 0 && c.base <= 1023) return c;
    } catch {}
    return null;
  }
  function saveCalib() {
    try { calib ? localStorage.setItem(STORE, JSON.stringify(calib)) : localStorage.removeItem(STORE); } catch {}
  }
  function thresholds() {
    if (!calib) return null;
    const kWarn = Number(el('k-warn').value), kLoud = Number(el('k-loud').value);
    // 조용할 때 값이 아주 작으면 배수만으로는 기준이 너무 낮아져 최소 간격을 둡니다.
    const warn = Math.min(1000, Math.max(Math.round(calib.base * kWarn), calib.base + 8));
    const loud = Math.min(1023, Math.max(Math.round(calib.base * kLoud), warn + 8));
    return {warn, loud};
  }
  function recentSound() {
    const recent = records.slice(-3).filter(r => r.sound !== null && lastTime - r.time < 4000);
    return recent.length ? recent.reduce((a, r) => a + r.sound, 0) / recent.length : null;
  }
  function nextLevel(avg, th, prev) {
    if (avg === null || !th) return 'unknown';
    // 경계에서 깜빡이지 않도록 내려갈 때는 기준의 90% 아래로 떨어져야 단계를 바꿉니다.
    if (avg >= th.loud || (prev === 'loud' && avg >= th.loud * 0.9)) return 'loud';
    if (avg >= th.warn || (prev === 'warn' && avg >= th.warn * 0.9)) return 'warn';
    return 'quiet';
  }

  /* ----- 밝기 기준 (평소 공부 밝기 측정값 × 비율). CdS를 5V 쪽에 둔 회로라 값이 클수록 밝습니다 ----- */
  function loadLight() {
    try {
      const c = JSON.parse(localStorage.getItem(LIGHT_STORE));
      if (c && Number.isFinite(c.base) && c.base > 0 && c.base <= 1023) return c;
    } catch {}
    return null;
  }
  function saveLight() {
    try { lightCalib ? localStorage.setItem(LIGHT_STORE, JSON.stringify(lightCalib)) : localStorage.removeItem(LIGHT_STORE); } catch {}
  }
  function lightThreshold() {
    return lightCalib ? Math.round(lightCalib.base * Number(el('light-ratio').value)) : null;
  }
  function recentLight() {
    const recent = records.slice(-3).filter(r => lastTime - r.time < 4000);
    return recent.length ? recent.reduce((a, r) => a + r.l, 0) / recent.length : null;
  }
  function nextBright(avg, dark, prev) {
    if (avg === null || dark === null) return 'unknown';
    // 경계에서 깜빡이지 않도록 어두움에서 벗어날 때는 기준보다 10% 더 밝아져야 합니다.
    return avg < dark || (prev === 'dark' && avg < dark * 1.1) ? 'dark' : 'bright';
  }

  /* ----- 판단 ----- */
  function verdict() {
    // 처음부터 연결하지 않은 상태와 쓰다가 끊긴 상태를 구분합니다 (ISO 9241-110 사용 오류 견고성).
    if (mode === 'none' && lostAt) return {k:'warn', title:'연결 끊김', reason:`USB 케이블을 확인하고 「UNO USB 연결」로 다시 연결하세요 · 마지막 정상 수신 ${lastTime ? new Date(lastTime).toLocaleTimeString() : '없음'}`};
    if (mode === 'none') return {k:'idle', title:'연결 전', reason:'UNO를 연결하거나 연습 데이터를 시작하세요.'};
    if (!fresh()) return {k:'unknown', title:'판단 보류', reason:'최근 4초 동안 정상 데이터가 없습니다. USB 연결을 확인하세요.'};
    const s = lastState, env = [], notes = [];
    const t = s.temperature_c, h = s.humidity_pct;
    if (t === null || h === null) notes.push('온습도 센서값 없음');
    else {
      if (t > COMFORT.tMax) env.push(`온도 높음 ${t.toFixed(1)} °C`);
      if (t < COMFORT.tMin) env.push(`온도 낮음 ${t.toFixed(1)} °C`);
      if (h > COMFORT.hMax) env.push(`습도 높음 ${h.toFixed(0)} %`);
      if (h < COMFORT.hMin) env.push(`습도 낮음 ${h.toFixed(0)} %`);
    }
    if (bright === 'dark') env.push('어두움 · 조명을 켜세요');
    if (!hasSound(s)) {
      return {k:'unknown', title:'소음값 없음', reason:(s.sound_pp === undefined ? '보드에 소음 측정 코드를 업로드했는지 확인하세요.' : '소음 측정을 준비 중입니다.') + (env.length ? ' · ' + env.join(' · ') : '')};
    }
    if (!calib) return {k:'unknown', title:'소음 기준을 먼저 정하세요', reason:['“조용할 때 10초 측정”을 누르세요', ...env, ...notes].join(' · ')};
    if (level === 'loud') return {k:'bad', title:'소음 때문에 집중하기 어려움', reason:['소음 시끄러움 단계', ...env, ...notes].join(' · ')};
    if (env.length) return {k:'warn', title:'환경 조정 필요', reason:[...env, '소음 ' + LEVEL_TEXT[level], ...notes].join(' · ')};
    if (level === 'warn') return {k:'warn', title:'소음 주의', reason:['소음이 주의 단계입니다', ...notes].join(' · ')};
    if (notes.length) return {k:'warn', title:'온습도 확인 필요', reason:['소음 조용', ...notes].join(' · ')};
    return {k:'good', title:'집중하기 좋음', reason:`소음 조용${bright === 'bright' ? ' · 밝음' : ''} · 온도 ${t.toFixed(1)} °C · 습도 ${h.toFixed(0)} %`};
  }

  /* ----- 화면 갱신 ----- */
  function rangeText(key, unit, digits) {
    const v = records.map(r => r[key]).filter(x => x !== null);
    if (!v.length) return '10분 범위: —';
    return `10분 범위: ${Math.min(...v).toFixed(digits)}–${Math.max(...v).toFixed(digits)} ${unit}`;
  }
  function render() {
    const valid = fresh(), active = mode !== 'none';
    el('source').textContent = mode === 'demo' ? '연습 데이터 · 실제 측정 아님' : mode === 'serial' ? '실제 USB 입력' : '입력 없음';
    el('connection').textContent = !active ? (lostAt ? 'USB 연결 끊김' : '연결 전 / 해제됨') : valid ? (mode === 'demo' ? '연습 중' : 'P01 수신 중') : '정상 데이터 대기 / 오래됨';
    el('connect').disabled = active || closing;
    el('demo').disabled = active || closing;
    el('disconnect').disabled = !active || closing;
    commandButtons.forEach(b => { b.disabled = !valid || !!pending || closing; });

    const v = verdict(), box = el('verdict');
    box.dataset.state = v.k;
    // 제목이 바뀔 때만 갱신해 화면낭독기가 매초 같은 문장을 읽지 않게 합니다 (WCAG 4.1.3).
    if (v.k + v.title !== lastVerdict) { el('verdict-title').textContent = v.title; lastVerdict = v.k + v.title; }
    el('verdict-reason').textContent = v.reason;

    const th = thresholds();
    const lv = el('sound-level');
    lv.textContent = valid && hasSound(lastState) && th ? LEVEL_TEXT[level] : valid && hasSound(lastState) ? '기준 없음' : '—';
    lv.className = valid && th ? 'lvl-' + level : '';
    el('sound').textContent = valid && hasSound(lastState) ? lastState.sound_pp : '—';
    el('sound-th').textContent = th ? `기준: 조용할 때 ${calib.base} · 주의 ${th.warn} 이상 · 시끄러움 ${th.loud} 이상` : '기준을 정하기 전입니다.';

    const num = (key, d) => valid && lastState[key] !== null ? Number(lastState[key]).toFixed(d) : '—';
    el('temperature').textContent = num('temperature_c', 1);
    el('humidity').textContent = num('humidity_pct', 0);
    const band = (val, min, max, unit, lowWord, highWord) => {
      if (!valid || val === null) return ['state-none', `쾌적 범위 ${min}–${max} ${unit}`];
      if (val > max) return ['state-bad', `${highWord} · 쾌적 범위 ${min}–${max} ${unit}`];
      if (val < min) return ['state-bad', `${lowWord} · 쾌적 범위 ${min}–${max} ${unit}`];
      return ['state-ok', `쾌적 · 범위 ${min}–${max} ${unit}`];
    };
    const [tc, tt] = band(valid ? lastState.temperature_c : null, COMFORT.tMin, COMFORT.tMax, '°C', '낮음', '높음');
    const [hc, ht] = band(valid ? lastState.humidity_pct : null, COMFORT.hMin, COMFORT.hMax, '%', '건조', '습함');
    el('temp-state').className = tc; el('temp-state').textContent = tt;
    el('hum-state').className = hc; el('hum-state').textContent = ht;
    el('temp-range').textContent = rangeText('t', '°C', 1);
    el('hum-range').textContent = rangeText('h', '%', 0);

    const dark = lightThreshold(), ll = el('light-level');
    ll.textContent = !valid ? '—' : dark === null ? '기준 없음' : bright === 'dark' ? '어두움' : '밝음';
    ll.className = valid && dark !== null ? (bright === 'dark' ? 'lvl-loud' : 'lvl-quiet') : '';
    el('light').textContent = valid ? lastState.light_raw : '—';
    el('light-th').textContent = dark !== null ? `기준: 평소 밝기 ${lightCalib.base} · ${dark} 아래면 어두움` : '기준을 정하기 전입니다.';

    el('led-state').textContent = '보드 보고 상태: ' + (valid ? (lastState.blink ? '깜빡이는 중 (시끄러움 알림)' : lastState.led ? '켜짐' : '꺼짐') : '—');
    el('inputs').textContent = valid ? `버튼: ${lastState.button_pressed ? '눌림' : '놓임'} · LCD: ${lastState.lcd_ready ? '초기화 응답 있음' : '초기화 실패'}` : '버튼: — · LCD: —';
    el('last').textContent = lastTime ? '마지막 정상 수신: ' + new Date(lastTime).toLocaleTimeString() + (valid ? '' : ' · 현재값으로 사용하지 마세요') : '마지막 정상 수신: 없음';
    el('calib-start').disabled = !!measuring || !valid || !hasSound(lastState);
    el('calib-reset').disabled = !!measuring || !calib;
    el('light-start').disabled = !!lightMeasuring || !valid;
    el('light-reset').disabled = !!lightMeasuring || !lightCalib;
  }

  /* 그래프: 소음(위)과 밝기(아래)를 같은 시간 축으로 따로 그립니다.
     단위와 범위가 달라 한 그래프에 세로축 두 개로 겹치지 않습니다. */
  const CH = {W:640, H:150, L:48, R:84, T:12};
  let chartX = null; // 마지막으로 그린 시간→가로 위치 변환 (말풍선이 같은 위치를 쓰도록 보관)
  function drawChart() {
    if (paused) return;
    const {W, H, L, R, T} = CH, now = Date.now();
    const x = t => L + (1 - (now - t) / WINDOW_MS) * (W - L - R);
    chartX = x;
    const xAxis = yBase => [['10분 전', now - WINDOW_MS], ['5분 전', now - WINDOW_MS / 2], ['지금', now]]
      .map(([label, t], i) => `<text x="${x(t)}" y="${yBase}" text-anchor="${['start', 'middle', 'end'][i]}">${label}</text>`).join('');
    const hLine = (y, cls) => `<line class="${cls}" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>`;
    const endLabel = (id, dotId, px, py, text) => {
      el(dotId).setAttribute('cx', px ?? -10); el(dotId).setAttribute('cy', py ?? -10);
      const t = el(id); t.textContent = text; t.setAttribute('x', px === null ? -100 : px + 8); t.setAttribute('y', py === null ? -100 : py + 4);
    };

    // 위: 소음
    const th = thresholds(), B1 = 10;
    const pts = records.filter(r => r.sound !== null);
    const yMax = Math.ceil(Math.max(40, th ? th.loud * 1.3 : 0, ...pts.map(p => p.sound)) / 40) * 40; // 4칸 눈금이 10의 배수가 되게
    const y1 = v => T + (1 - v / yMax) * (H - T - B1);
    const g1 = [];
    for (let i = 0; i <= 4; i++) { const v = yMax * i / 4; g1.push(`${hLine(y1(v), 'grid')}<text x="${L - 8}" y="${y1(v) + 4}" text-anchor="end">${Math.round(v)}</text>`); }
    if (th) {
      g1.push(`${hLine(y1(th.warn), 'th-warn')}<text x="${L + 6}" y="${y1(th.warn) + 15}">주의 ${th.warn}</text>`); // 시끄러움 라벨과 겹치지 않게 선 아래에 둠
      g1.push(`${hLine(y1(th.loud), 'th-loud')}<text x="${L + 6}" y="${y1(th.loud) - 5}">시끄러움 ${th.loud}</text>`);
    }
    el('chart-grid').innerHTML = g1.join('');
    el('line').setAttribute('points', pts.map(p => `${x(p.time).toFixed(1)},${y1(p.sound).toFixed(1)}`).join(' '));
    const lastS = pts[pts.length - 1];
    endLabel('sound-end', 'dot', lastS ? x(lastS.time) : null, lastS ? y1(lastS.sound) : null, lastS ? `소음 ${lastS.sound}` : '');

    // 아래: 밝기 (0–1023 고정)
    const B2 = 28, y2 = v => T + (1 - v / 1023) * (H - T - B2), dark = lightThreshold();
    const g2 = [0, 500, 1000].map(v => `${hLine(y2(v), 'grid')}<text x="${L - 8}" y="${y2(v) + 4}" text-anchor="end">${v}</text>`);
    if (dark !== null) g2.push(`${hLine(y2(dark), 'th-warn')}<text x="${L + 6}" y="${y2(dark) + 15}">어두움 기준 ${dark}</text>`);
    g2.push(xAxis(H - 8));
    el('light-grid').innerHTML = g2.join('');
    el('light-line').setAttribute('points', records.map(p => `${x(p.time).toFixed(1)},${y2(p.l).toFixed(1)}`).join(' '));
    const lastL = records[records.length - 1];
    endLabel('light-end', 'light-dot', lastL ? x(lastL.time) : null, lastL ? y2(lastL.l) : null, lastL ? `밝기 ${lastL.l}` : '');

    let summary = '수신 기록 없음';
    if (records.length) {
      const mins = Math.round((now - records[0].time) / 60000);
      const parts = [mins < 1 ? '최근 1분 미만' : `최근 ${mins}분`];
      if (pts.length) {
        const vals = pts.map(p => p.sound);
        parts.push(`소음 평균 ${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)} · 최고 ${Math.max(...vals)}` + (th ? ` · 시끄러움 기준 이상 ${vals.filter(v => v >= th.loud).length}초` : ''));
      }
      const ls = records.map(r => r.l);
      parts.push(`밝기 ${Math.min(...ls)}–${Math.max(...ls)}` + (dark !== null ? ` · 어두움 ${ls.filter(v => v < dark).length}초` : ''));
      summary = parts.join(' · ');
    }
    el('chart-summary').textContent = summary;
    el('chart-desc').textContent = '최근 10분 소음 그래프. ' + summary;
    el('chart-light-desc').textContent = '최근 10분 밝기 그래프. ' + summary;
  }

  /* 그래프 말풍선: 마우스·터치·키보드(좌우 화살표)로 시각을 고르면 두 그래프에 같은 세로선과 두 값을 함께 보여 줍니다. */
  let pickIndex = null;
  function showPick(i) {
    if (!chartX || !records.length) return;
    pickIndex = Math.max(0, Math.min(records.length - 1, i));
    const r = records[pickIndex], cx = chartX(r.time), th = thresholds(), dark = lightThreshold();
    document.querySelectorAll('.charts .cross').forEach(c => { c.setAttribute('x1', cx); c.setAttribute('x2', cx); c.classList.add('on'); });
    const soundText = r.sound === null ? '값 없음' : `${r.sound}${th ? (r.sound >= th.loud ? ' · 시끄러움' : r.sound >= th.warn ? ' · 주의' : ' · 조용') : ''}`;
    const lightText = `${r.l}${dark !== null ? (r.l < dark ? ' · 어두움' : ' · 밝음') : ''}`;
    const tip = el('chart-tip');
    tip.innerHTML = `<b>${new Date(r.time).toLocaleTimeString()}</b><br><span class="k k-sound"></span>소음 ${soundText}<br><span class="k k-light"></span>밝기 ${lightText}`;
    const box = el('chart').getBoundingClientRect(), wrap = tip.parentElement.getBoundingClientRect();
    tip.classList.add('on');
    const px = box.left - wrap.left + cx * (box.width / CH.W), tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(4, px - tw / 2), wrap.width - tw - 4) + 'px';
    el('chart-pick').textContent = `${new Date(r.time).toLocaleTimeString()} 소음 ${soundText}, 밝기 ${lightText}`;
  }
  function hidePick() {
    pickIndex = null; el('chart-tip').classList.remove('on');
    document.querySelectorAll('.charts .cross').forEach(c => c.classList.remove('on'));
  }
  ['chart', 'chart-light'].forEach(id => {
    const svg = el(id), hit = svg.querySelector('.hit');
    const pick = e => {
      if (!chartX || !records.length) return;
      const b = svg.getBoundingClientRect(), vx = (e.clientX - b.left) * (CH.W / b.width);
      let best = 0, bd = Infinity;
      records.forEach((r, i) => { const d = Math.abs(chartX(r.time) - vx); if (d < bd) { bd = d; best = i; } });
      showPick(best);
    };
    hit.addEventListener('pointermove', pick); hit.addEventListener('pointerdown', pick); hit.addEventListener('pointerleave', hidePick);
    svg.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); showPick((pickIndex ?? records.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1)); }
      if (e.key === 'Escape') hidePick();
    });
    svg.addEventListener('blur', hidePick);
  });

  function renderEvents() {
    const list = el('events');
    list.innerHTML = events.length ? '' : '<li class="muted">아직 없습니다.</li>';
    events.slice().reverse().slice(0, 20).forEach(e => {
      const li = document.createElement('li');
      li.textContent = `${new Date(e.time).toLocaleTimeString()} · 상대값 ${e.value}`;
      list.appendChild(li);
    });
  }

  /* ----- 수신 ----- */
  function validState(s) {
    const raw = v => Number.isInteger(v) && v >= 0 && v <= 1023;
    const optional = (v, min, max) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max);
    return s && s.v === 1 && s.type === 'state' && s.profile === 'P01' &&
      Number.isInteger(s.request) && s.request >= 0 && s.request <= 65535 && Number.isInteger(s.ms) && s.ms >= 0 &&
      // 가변저항을 뺀 보드는 pot_raw를 보내지 않습니다.
      (s.pot_raw === undefined || raw(s.pot_raw)) && raw(s.light_raw) && (s.led === 0 || s.led === 1) &&
      typeof s.auto === 'boolean' && typeof s.button_pressed === 'boolean' && typeof s.lcd_ready === 'boolean' &&
      optional(s.temperature_c, -50, 100) && optional(s.humidity_pct, 0, 100) &&
      (s.sound_pp === undefined || s.sound_pp === null || raw(s.sound_pp)); // 소음 필드가 없는 원래 P01 코드도 받습니다.
  }
  function ingest(line) {
    let s; try { s = JSON.parse(line); } catch { trace('형식 오류: JSON 한 줄을 확인하세요'); return; }
    if (!s || typeof s !== 'object' || Array.isArray(s)) { trace('거절: JSON 객체가 필요합니다'); return; }
    if (s.type === 'state') {
      if (!validState(s)) { lastState = null; render(); trace('거절: P01 필드·자료형·범위 확인'); return; }
      lastState = s; lastTime = Date.now();
      records.push({time:lastTime, sound:hasSound(s) ? s.sound_pp : null, t:s.temperature_c, h:s.humidity_pct, l:s.light_raw});
      records = records.filter(r => lastTime - r.time <= WINDOW_MS);
      if (measuring && hasSound(s)) measuring.samples.push(s.sound_pp);
      if (lightMeasuring) lightMeasuring.samples.push(s.light_raw);
      updateLevel();
      bright = nextBright(recentLight(), lightThreshold(), bright);
      render(); drawChart();
    } else if ((s.type === 'ack' || s.type === 'error') && pending && s.v === 1 && s.request === pending.id) {
      if (s.type === 'ack' && s.applied !== true) return;
      settle(s.type === 'ack' ? `${mode === 'demo' ? '연습 응답' : '보드 적용 응답'} #${s.request} · 실제 LED도 확인하세요` : `명령 거절 #${s.request}: ${String(s.code || 'unknown')}`, s.type === 'ack');
    }
    trace('← ' + JSON.stringify(s));
  }
  function updateLevel() {
    const prev = level;
    level = nextLevel(recentSound(), thresholds(), prev);
    if (level === 'loud' && prev !== 'loud') { events.push({time:lastTime, value:lastState.sound_pp}); renderEvents(); }
    // 시끄러움 단계에 들어가면 LED를 1초에 4번 깜빡이게 하고(보드가 직접 깜빡임), 벗어나면 멈춥니다.
    if (el('alert-led').checked && prev !== 'unknown' && level !== 'unknown' && (prev === 'loud') !== (level === 'loud')) {
      command(level === 'loud' ? 'BLINK 1' : 'BLINK 0', '소음 알림');
    }
  }

  /* ----- 연습 데이터: 조용한 방 + 가끔 대화 소리 + 온도가 천천히 오름 ----- */
  function emitDemo() {
    demoStep++;
    const phase = demoStep % 40;
    const sound = phase >= 28 && phase < 34 ? 90 + Math.round(Math.random() * 50) : phase >= 20 && phase < 24 ? 40 + Math.round(Math.random() * 12) : 14 + Math.round(Math.random() * 8);
    const temp = Math.min(27.5, 24 + demoStep * 0.02), fail = demoStep % 12 === 0;
    const light = phase >= 8 && phase < 16 ? 260 + Math.round(Math.random() * 30) : 600 + Math.round(Math.random() * 20); // 가끔 조명이 꺼진 상황
    ingest(JSON.stringify({v:1, type:'state', profile:'P01', request:0, ms:demoStep * 1000, light_raw:light,
      button_pressed:false, led:demoLed, blink:demoBlink, auto:false, lcd_ready:true,
      temperature_c:fail ? null : Math.round(temp * 10) / 10, humidity_pct:fail ? null : 52, sound_pp:sound}));
  }

  /* ----- 명령 (P01 규칙: 요청번호 + ACK, 자동 재전송 없음) ----- */
  // 명령이 끝났을 때(응답·거절·시간 초과·실패) 한곳에서 정리합니다. 핸드폰에서 온 명령이면 결과를 XIAO로 돌려줍니다.
  function settle(text, ok = false) {
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.phone) xiaoSend({t:'result', id:pending.phone, ok, text});
    pending = null;
    el('command-result').textContent = text; render();
  }
  async function command(text, why, phone = 0) {
    if (!fresh() || pending || closing || mode === 'none') {
      const reason = !fresh() || mode === 'none' ? 'UNO 데이터가 없어 보내지 않았습니다.' : '다른 명령 처리 중이라 보내지 않았습니다.';
      if (why) el('command-result').textContent = `${why}: ${reason} 필요하면 직접 누르세요.`;
      if (phone) xiaoSend({t:'result', id:phone, ok:false, text:reason + ' 자동으로 다시 보내지 않습니다.'});
      return;
    }
    const id = request = request % 65535 + 1, currentSession = session;
    pending = {id, phone, timer:setTimeout(() => {
      if (session !== currentSession || !pending || pending.id !== id) return;
      settle('응답 시간 초과 · 적용 여부 미확인. 자동 재전송하지 않습니다.');
    }, 2500)};
    el('command-result').textContent = `전송 중 #${id}: ${text}${why ? ' (' + why + ')' : ''}`; render(); trace(`→ ${id} ${text}`);
    try {
      if (mode === 'demo') {
        const parts = text.split(' ');
        if (parts[0] === 'LED') demoLed = +parts[1];
        if (parts[0] === 'STOP') demoLed = 0;
        if (parts[0] === 'TOGGLE') demoLed = 1 - demoLed;
        if (parts[0] === 'BLINK') demoBlink = parts[1] === '1';
        if (parts[0] === 'LED' || parts[0] === 'STOP' || parts[0] === 'TOGGLE') demoBlink = false;
        setTimeout(() => { if (session === currentSession && mode === 'demo') ingest(JSON.stringify({v:1, type:'ack', request:id, applied:true})); }, 200);
      } else { await writer.write(new TextEncoder().encode(`${id} ${text}\n`)); }
    } catch (error) {
      if (pending?.id === id) settle('전송 실패 · 적용 여부 미확인: ' + error.message);
    }
  }

  /* ----- 기준 측정 ----- */
  function startCalib() {
    if (measuring || !fresh() || !hasSound(lastState)) return;
    measuring = {samples:[], end:Date.now() + CALIB_MS, session, tick:null};
    el('calib-progress').hidden = false; el('calib-progress').value = 0;
    el('calib-cancel').hidden = false;
    el('calib-msg').textContent = '측정 중입니다. 10초 동안 조용히 해 주세요.';
    measuring.tick = setInterval(() => {
      if (!measuring) return;
      if (measuring.session !== session) { stopCalib('연결이 바뀌어 측정을 취소했습니다.'); return; }
      const left = measuring.end - Date.now();
      el('calib-progress').value = Math.min(10, (CALIB_MS - left) / 1000);
      if (left <= 0) finishCalib();
    }, 250);
    render();
  }
  function finishCalib() {
    const s = measuring.samples.slice().sort((a, b) => a - b);
    if (s.length < 7) { stopCalib(`측정값이 ${s.length}개뿐이라 기준을 정하지 않았습니다. 연결 상태를 확인하고 다시 측정하세요.`); return; }
    const base = s[Math.floor(s.length / 2)]; // 중앙값: 측정 중 한두 번 튄 소리의 영향을 줄입니다.
    calib = {base, at:Date.now()}; saveCalib();
    stopCalib(`기준을 정했습니다. 조용할 때 ${base} (측정 ${s.length}회의 중앙값)`);
    level = 'unknown'; updateLevel(); drawChart();
  }
  function stopCalib(message) {
    if (measuring) clearInterval(measuring.tick);
    measuring = null;
    el('calib-progress').hidden = true; el('calib-cancel').hidden = true;
    el('calib-msg').textContent = message; render();
  }

  /* ----- 밝기 기준 측정 ----- */
  function startLight() {
    if (lightMeasuring || !fresh()) return;
    lightMeasuring = {samples:[], end:Date.now() + CALIB_MS, session, tick:null};
    el('light-progress').hidden = false; el('light-progress').value = 0;
    el('light-cancel').hidden = false;
    el('light-msg').textContent = '측정 중입니다. 10초 동안 평소 공부할 때의 조명을 유지하고 센서를 가리지 마세요.';
    lightMeasuring.tick = setInterval(() => {
      if (!lightMeasuring) return;
      if (lightMeasuring.session !== session) { stopLight('연결이 바뀌어 측정을 취소했습니다.'); return; }
      const left = lightMeasuring.end - Date.now();
      el('light-progress').value = Math.min(10, (CALIB_MS - left) / 1000);
      if (left <= 0) finishLight();
    }, 250);
    render();
  }
  function finishLight() {
    const s = lightMeasuring.samples.slice().sort((a, b) => a - b);
    if (s.length < 7) { stopLight(`측정값이 ${s.length}개뿐이라 기준을 정하지 않았습니다. 연결 상태를 확인하고 다시 측정하세요.`); return; }
    const base = s[Math.floor(s.length / 2)];
    if (base < 20) { stopLight(`평소 밝기가 ${base}로 너무 어둡게 측정됐습니다. 조명을 켜고 센서가 가려지지 않았는지 확인한 뒤 다시 측정하세요.`); return; }
    lightCalib = {base, at:Date.now()}; saveLight();
    stopLight(`기준을 정했습니다. 평소 밝기 ${base} (측정 ${s.length}회의 중앙값)`);
    bright = 'unknown'; bright = nextBright(recentLight(), lightThreshold(), bright);
  }
  function stopLight(message) {
    if (lightMeasuring) clearInterval(lightMeasuring.tick);
    lightMeasuring = null;
    el('light-progress').hidden = true; el('light-cancel').hidden = true;
    el('light-msg').textContent = message; render();
  }

  /* ----- USB ----- */
  async function readLoop(myReader) {
    let buffer = '', dropping = false; const decoder = new TextDecoder();
    try {
      while (!closing) {
        const {value, done} = await myReader.read(); if (done) break;
        for (const char of decoder.decode(value, {stream:true})) {
          if (char === '\n') { if (!dropping && buffer.trim()) ingest(buffer.trim()); buffer = ''; dropping = false; }
          else if (!dropping) { buffer += char; if (buffer.length > 2048) { trace('너무 긴 수신 줄 거절'); dropping = true; buffer = ''; } }
        }
      }
    } catch (error) { if (!closing) say('USB 수신 중단: ' + error.message); }
    finally { myReader.releaseLock(); }
    if (!closing) { lostAt = Date.now(); await cleanup(false); say('USB 수신이 끝났습니다. 연결을 확인하고 다시 연결하세요.'); }
  }
  async function cleanup(waitForReader = true) {
    if (closing) return;
    closing = true; session++; clearInterval(demoTimer); demoTimer = null;
    if (measuring) stopCalib('연결이 끊겨 측정을 취소했습니다.');
    if (pending) settle('연결 종료 · 명령 적용 여부 미확인');
    if (reader && waitForReader) { try { await reader.cancel(); await reading; } catch {} }
    reader = null; reading = null;
    if (writer) { try { writer.releaseLock(); } catch {} writer = null; }
    if (port) { try { await port.close(); } catch {} port = null; }
    mode = 'none'; lastState = null; level = 'unknown'; closing = false; render();
  }
  function resetSession() { records = []; events = []; lastState = null; lastTime = 0; level = 'unknown'; renderEvents(); drawChart(); }

  /* ----- XIAO 연결 (핸드폰 연동) -----
     PC → XIAO: 1초마다 지금 판단과 값(view), 핸드폰 명령의 결과(result)
     XIAO → PC: Wi-Fi 상태(wifi), 핸드폰에서 누른 명령(cmd)
     핸드폰 명령도 UNO 명령과 같은 규칙(요청번호 + ACK, 자동 재전송 없음)을 따릅니다. */
  const xiao = {port:null, reader:null, writer:null, reading:null, closing:false, wifi:null, lastSeen:0};
  function xiaoSend(obj) {
    if (!xiao.writer) return;
    xiao.writer.write(new TextEncoder().encode(JSON.stringify(obj) + '\n')).catch(error => trace('XIAO 전송 실패: ' + error.message));
  }
  function phoneView() {
    const v = verdict(), valid = fresh(), th = thresholds(), soundNow = valid && hasSound(lastState);
    const fmt = (key, d) => valid && lastState[key] !== null ? Number(lastState[key]).toFixed(d) : null;
    return {t:'view', k:v.k, title:v.title, reason:v.reason,
      level:soundNow && th ? LEVEL_TEXT[level] : soundNow ? '기준 없음' : null, sound:soundNow ? lastState.sound_pp : null,
      temp:fmt('temperature_c', 1), hum:fmt('humidity_pct', 0),
      led:valid ? (lastState.blink ? '깜빡이는 중' : lastState.led ? '켜짐' : '꺼짐') : null, can_cmd:valid && !pending,
      result:el('command-result').textContent};
  }
  function handleXiao(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    xiao.lastSeen = Date.now();
    if (m.t === 'wifi') { xiao.wifi = m; renderXiao(); }
    else if (m.t === 'cmd' && Number.isInteger(m.id)) {
      trace(`핸드폰 명령 #${m.id}: ${m.cmd}`);
      if (m.cmd === 'LED 1' || m.cmd === 'LED 0') command(m.cmd, '핸드폰', m.id);
      else xiaoSend({t:'result', id:m.id, ok:false, text:'허용되지 않은 명령입니다.'});
    }
  }
  function renderXiao() {
    const on = !!xiao.port, w = xiao.wifi;
    el('xiao-connect').disabled = on || xiao.closing;
    el('xiao-disconnect').disabled = !on || xiao.closing;
    let status = '연결 전', addr = '—';
    if (on && !w) status = 'XIAO 연결됨 · Wi-Fi 상태 기다리는 중';
    if (on && w) {
      if (w.status === 'connected') { status = `핫스팟(${w.ssid}) 연결됨`; addr = `http://${w.ip}`; }
      else if (w.status === 'no_secrets') status = 'Wi-Fi 정보 없음 · secrets.h에 핫스팟 이름과 비밀번호를 넣고 다시 업로드하세요';
      else status = `핫스팟(${w.ssid || '?'}) 연결 시도 중 · 핫스팟이 켜져 있는지 확인하세요`;
    }
    el('xiao-status').textContent = status;
    el('xiao-addr').textContent = addr;
  }
  async function xiaoReadLoop() {
    let buffer = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const {value, done} = await xiao.reader.read(); if (done) break;
        for (const char of decoder.decode(value, {stream:true})) {
          if (char === '\n') { if (buffer.trim()) handleXiao(buffer.trim()); buffer = ''; }
          else if (buffer.length < 2048) buffer += char;
        }
      }
    } catch (error) { if (!xiao.closing) trace('XIAO 수신 중단: ' + error.message); }
    finally { try { xiao.reader.releaseLock(); } catch {} }
    if (!xiao.closing) { await xiaoCleanup(); el('xiao-status').textContent = 'XIAO 연결 끊김 · USB를 확인하고 다시 연결하세요'; }
  }
  async function xiaoCleanup() {
    if (xiao.closing) return;
    xiao.closing = true;
    if (xiao.reader) { try { await xiao.reader.cancel(); await xiao.reading; } catch {} }
    if (xiao.writer) { try { xiao.writer.releaseLock(); } catch {} }
    if (xiao.port) { try { await xiao.port.close(); } catch {} }
    Object.assign(xiao, {port:null, reader:null, writer:null, reading:null, wifi:null, closing:false});
    renderXiao();
  }
  el('xiao-connect').addEventListener('click', async () => {
    if (!navigator.serial || !window.isSecureContext || xiao.port) return;
    try {
      xiao.port = await navigator.serial.requestPort(); await xiao.port.open({baudRate:115200});
      xiao.writer = xiao.port.writable.getWriter(); xiao.reader = xiao.port.readable.getReader();
      xiao.reading = xiaoReadLoop(); renderXiao();
    } catch (error) { xiao.port = null; await xiaoCleanup(); el('xiao-status').textContent = 'XIAO를 연결하지 못했습니다: ' + error.message; }
  });
  el('xiao-disconnect').addEventListener('click', xiaoCleanup);
  setInterval(() => { if (xiao.writer) xiaoSend(phoneView()); }, 1000);

  el('connect').addEventListener('click', async () => {
    if (!navigator.serial || !window.isSecureContext) { say('Web Serial을 지원하는 Chrome/Edge에서 localhost 주소로 여세요. 연습 데이터로 화면 확인은 계속할 수 있습니다.'); return; }
    if (mode !== 'none' || closing) return;
    closing = true; render();
    try {
      port = await navigator.serial.requestPort(); await port.open({baudRate:115200});
      writer = port.writable.getWriter(); reader = port.readable.getReader();
      mode = 'serial'; closing = false; session++; lostAt = 0; resetSession();
      say('115200 연결됨. UNO 재시작 후 데이터를 기다립니다. 수신 뒤 제어 버튼이 활성화됩니다.');
      reading = readLoop(reader); render();
    } catch (error) { closing = false; await cleanup(); say('연결하지 못했습니다: ' + error.message + ' · 시리얼 모니터와 다른 연결 탭을 닫고 다시 시도하세요.'); }
  });
  el('demo').addEventListener('click', () => {
    if (mode !== 'none' || closing) return;
    session++; mode = 'demo'; demoStep = 0; demoLed = 0; demoBlink = false; lostAt = 0; resetSession();
    say('연습 데이터입니다. 가끔 대화 소리와 센서 실패(null)를 흉내 냅니다. 실제 배선·센서·LED는 검증하지 않습니다.');
    emitDemo(); demoTimer = setInterval(emitDemo, 1000); render();
  });
  el('disconnect').addEventListener('click', async () => { lostAt = 0; await cleanup(); say('연결 해제. 현재값은 숨기고 그래프와 기록은 남깁니다. 보드 LED를 끄려면 연결된 동안 정지를 누르세요.'); });
  commandButtons.forEach(b => b.addEventListener('click', () => command(b.dataset.command)));
  el('calib-start').addEventListener('click', startCalib);
  el('calib-cancel').addEventListener('click', () => stopCalib('측정을 취소했습니다. 이전 기준을 그대로 씁니다.'));
  el('calib-reset').addEventListener('click', () => { calib = null; saveCalib(); level = 'unknown'; el('calib-msg').textContent = '기준을 지웠습니다.'; render(); drawChart(); });
  ['k-warn', 'k-loud'].forEach(id => el(id).addEventListener('change', () => {
    if (Number(el('k-loud').value) <= Number(el('k-warn').value)) { el('calib-msg').textContent = '시끄러움 배수는 주의 배수보다 커야 합니다. 시끄러움 단계를 다시 고르세요.'; }
    try { localStorage.setItem(STORE + '-k', JSON.stringify({w:el('k-warn').value, l:el('k-loud').value})); } catch {}
    if (lastState) updateLevel(); render(); drawChart();
  }));
  el('light-start').addEventListener('click', startLight);
  el('light-cancel').addEventListener('click', () => stopLight('측정을 취소했습니다. 이전 기준을 그대로 씁니다.'));
  el('light-reset').addEventListener('click', () => { lightCalib = null; saveLight(); bright = 'unknown'; el('light-msg').textContent = '기준을 지웠습니다.'; render(); });
  el('light-ratio').addEventListener('change', () => {
    try { localStorage.setItem(LIGHT_STORE + '-r', el('light-ratio').value); } catch {}
    bright = nextBright(recentLight(), lightThreshold(), bright); render();
  });
  try { const r = localStorage.getItem(LIGHT_STORE + '-r'); if (r) el('light-ratio').value = r; } catch {}
  if (lightCalib) el('light-msg').textContent = `저장된 기준을 불러왔습니다. 평소 밝기 ${lightCalib.base} (${new Date(lightCalib.at).toLocaleString()})`;
  el('pause').addEventListener('click', () => {
    paused = !paused; el('pause').setAttribute('aria-pressed', paused); el('pause').textContent = paused ? '그래프 다시 움직이기' : '그래프 멈춤';
    if (!paused) drawChart();
  });
  try { const k = JSON.parse(localStorage.getItem(STORE + '-k')); if (k) { el('k-warn').value = k.w; el('k-loud').value = k.l; } } catch {}
  if (calib) el('calib-msg').textContent = `저장된 기준을 불러왔습니다. 조용할 때 ${calib.base} (${new Date(calib.at).toLocaleString()})`;
  setInterval(render, 500); setInterval(drawChart, 5000); render(); drawChart();
})();
