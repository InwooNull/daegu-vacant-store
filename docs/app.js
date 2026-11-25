/* 빈 점포 한 칸 — 지도·카드 (3판: 내 업종 확인, 공공시설 제안 강화)
   데이터: data/stores.json(점), data/cards/<구>.json(카드), data/meta.json(업종·정확도·규칙), data/dong.geojson, data/dong_summary.json, data/facilities.json
   팀원 모델로 바꿀 때는 같은 형식의 JSON만 덮어쓰면 됩니다(DATA_FORMAT.md). 서버 API로 바꿀 때는 loadJSON 한 곳만 고치면 됩니다. */
(function () {
  'use strict';
  const VERDICT = ['biz', 'public', 'hold'];
  const VNAME = { biz: '창업 추천', public: '공공시설 추천', hold: '지켜보기' };
  const VDESC = { biz: '가게가 오래 갈 만한 자리', public: '동네에 필요한 시설이 부족한 자리', hold: '아직 뚜렷한 쓰임이 없는 자리' };
  const COLOR = { biz: '#2f5fd0', public: '#1f8a5b', hold: '#9aa1ad' };
  const REL_NAME = { ok: '사용', weak: '사용', none: '제외' };
  const DTYPE_COLOR = {
    '고령 1인·노후 주택형': '#d9822b', '교외·농촌 고령형': '#a5794f', '중장년 혼합 주거형': '#c9b458',
    '아파트 가족형': '#7aa6c2', '영유아 신축 아파트형': '#5e9c86', '청년 1인 가구형': '#9a7fc1'
  };
  const FAC_STYLE = { senior: '#d9822b', library: '#7b5ea7', childcare: '#0f8b8d', cowork: '#b8457a' };
  const SEQ_B = ['#d7dbe2', '#b6c6ea', '#7f9ee0', '#2f5fd0', '#18307a'];
  const SEQ_P = ['#d7dbe2', '#b4dcc6', '#6fbf96', '#1f8a5b', '#0f4f33'];
  let SEQ = SEQ_B;

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => n.toLocaleString('ko-KR');
  const pct = (x) => Math.round(x * 100) + '%';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eul = (w) => { const c = w.charCodeAt(w.length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '을' : '를'; };
  const dist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + 'km' : m + 'm');

  const DATA_BASE = 'data/';
  async function loadJSON(path) {
    const r = await fetch(DATA_BASE + path);
    if (!r.ok) throw new Error(path + ' 불러오기 실패 (' + r.status + ')');
    return r.json();
  }

  let meta, stores, typeKeys, map, cluster, dongLayer, facLayers = {}, facData, renderer;
  const cardCache = {};
  const state = { verdicts: new Set([0, 1, 2]), gu: '', type: '', lo: 0, hi: 100 };

  function seqColor(v) {
    const t = Math.max(0, Math.min(0.999, (v - state.lo) / Math.max(1, state.hi - state.lo)));
    return SEQ[Math.floor(t * SEQ.length)];
  }

  async function init() {
    map = L.map('map', { preferCanvas: false }).setView([35.8714, 128.6014], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자'
    }).addTo(map);
    renderer = L.canvas({ padding: 0.3 });
    cluster = L.markerClusterGroup({
      chunkedLoading: true, maxClusterRadius: 56, showCoverageOnHover: false,
      spiderfyOnMaxZoom: true, disableClusteringAtZoom: 18, iconCreateFunction: clusterIcon
    });
    map.addLayer(cluster);
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => { const d = L.DomUtil.create('div', 'maplegend'); d.id = 'mapLegend'; return d; };
    legend.addTo(map);
    try {
      [meta, stores] = await Promise.all([loadJSON('meta.json'), loadJSON('stores.json')]);
    } catch (e) {
      $('#loading').textContent = '데이터를 불러오지 못했습니다. 새로고침해 주세요. (' + e.message + ')';
      return;
    }
    typeKeys = Object.keys(meta.types);
    buildControls();
    redraw();
    $('#loading').hidden = true;
    buildMethod();
  }

  /* ---------- 점 뭉치기 ---------- */
  function clusterIcon(c) {
    const ms = c.getAllChildMarkers(); const n = ms.length;
    const size = n < 10 ? 34 : n < 100 ? 40 : n < 1000 ? 48 : 56;
    let bg, cls = 'cl';
    if (state.type) { // 업종 보기: 평균 확률 색
      const avg = ms.reduce((a, m) => a + m.options.p, 0) / n;
      bg = seqColor(avg); cls += ' seq';
      const fg = SEQ.indexOf(bg) < 2 ? '#1d2330' : '#ffffff';  // 옅은 색 위엔 진한 글자
      return L.divIcon({ html: `<div class="${cls}" style="width:${size}px;height:${size}px;background:${bg}"><span style="background:${bg};color:${fg}">${n >= 1000 ? (n / 1000).toFixed(1) + '천' : n}</span></div>`, className: '', iconSize: [size, size] });
    }
    const k = [0, 0, 0]; ms.forEach((m) => k[m.options.v]++);
    const a = (k[0] / n) * 360, b = a + (k[1] / n) * 360;  // 테두리 고리 = 창업·공공·보류 비율
    bg = `conic-gradient(${COLOR.biz} 0 ${a}deg, ${COLOR.public} ${a}deg ${b}deg, ${COLOR.hold} ${b}deg 360deg)`;
    if (n >= 100) cls += ' big';
    return L.divIcon({ html: `<div class="${cls}" style="width:${size}px;height:${size}px;background:${bg}" title="창업 ${k[0]} · 공공시설 ${k[1]} · 지켜보기 ${k[2]}"><span>${n >= 1000 ? (n / 1000).toFixed(1) + '천' : n}</span></div>`, className: '', iconSize: [size, size] });
  }

  function visible(s) { return state.verdicts.has(s[4]) && (!state.gu || s[3] === state.gu); }

  // 색으로 보기: 'b:업종' = 3년 생존 확률(%), 'p:시설' = 부족 점수(0~100)
  function modeVal() {
    if (!state.type) return null;
    const [k, code] = state.type.split(':');
    if (k === 'b') { const i = typeKeys.indexOf(code); return (s) => s[5][i]; }
    const i = Object.keys(meta.public).indexOf(code); return (s) => s[6][i];
  }
  function modeName() {
    const [k, code] = state.type.split(':');
    return k === 'b' ? `${meta.types[code].name} 3년 생존 확률` : `${meta.public[code].name} 부족 점수`;
  }
  function modeUnit() { return state.type.startsWith('b:') ? '%' : '점'; }

  function redraw() {
    const fv = modeVal(); const ti = fv ? 0 : -1;
    SEQ = state.type.startsWith('p:') ? SEQ_P : SEQ_B;
    const vis = stores.filter(visible);
    if (ti >= 0) {
      const vals = vis.map(fv).sort((a, b) => a - b);
      state.lo = vals[Math.floor(vals.length * 0.05)] || 0; state.hi = vals[Math.floor(vals.length * 0.95)] || 100;
    }
    const ms = vis.map((s) => {
      const p = ti >= 0 ? fv(s) : 0;
      const col = ti >= 0 ? seqColor(p) : COLOR[VERDICT[s[4]]];
      const m = L.marker([s[1], s[2]], { icon: L.divIcon({ html: `<div class="pt" style="background:${col}"></div>`, className: '', iconSize: [12, 12] }), v: s[4], p, keyboard: false });
      m.on('click', () => openCard(s));
      if (ti >= 0) m.bindTooltip(`${modeName()} ${p}${modeUnit()}`, { className: 'tip', direction: 'top', offset: [0, -6] });
      return m;
    });
    cluster.clearLayers(); cluster.addLayers(ms);
    renderCounts(); renderLegend();
  }

  function renderLegend() {
    const el = $('#mapLegend'); if (!el) return;
    if (state.type) {
      el.innerHTML = `<b>${esc(modeName())}</b><br><span style="display:inline-block;width:120px;height:8px;border-radius:4px;background:linear-gradient(90deg,${SEQ.join(',')})"></span><br>원 안 숫자 = 빈 점포 수 · 진할수록 높음`;
    } else {
      el.innerHTML = `<i style="background:${COLOR.biz}"></i>창업 추천 <i style="background:${COLOR.public};margin-left:8px"></i>공공시설 추천 <i style="background:${COLOR.hold};margin-left:8px"></i>지켜보기<br>원 안 숫자 = 빈 점포 수 · 테두리 색 = 추천 비율`;
    }
  }

  /* ---------- 왼쪽 패널 ---------- */
  function buildControls() {
    $('#vfilter').innerHTML = VERDICT.map((v, i) => `<button type="button" class="vbtn ${v}" data-v="${i}" aria-pressed="true">
      <span class="dot"></span><span class="nm">${VNAME[v]}<span class="ds">${VDESC[v]}</span></span><span class="n" id="n${i}">0</span></button>`).join('');
    $('#vfilter').addEventListener('click', (e) => {
      const b = e.target.closest('.vbtn'); if (!b) return;
      const v = +b.dataset.v; const on = b.getAttribute('aria-pressed') === 'true';
      if (on && state.verdicts.size === 1) return; // 하나는 남김
      b.setAttribute('aria-pressed', String(!on));
      on ? state.verdicts.delete(v) : state.verdicts.add(v);
      redraw();
    });
    const gus = [...new Set(stores.map((s) => s[3]))].sort();
    const gs = $('#guSelect');
    gus.forEach((g) => gs.insertAdjacentHTML('beforeend', `<option value="${esc(g)}">${esc(g)}</option>`));
    gs.addEventListener('change', () => { state.gu = gs.value; redraw(); fitGu(); });

    const ts = $('#typeSelect');
    // 업종 = 과거 데이터로 시험해 맞힌 업종만(나머지는 계산 방법 표에만), 공공시설 = 부족 점수
    ts.insertAdjacentHTML('beforeend', `<optgroup label="가게를 연다면 (3년 생존 확률)">${typeKeys.filter((t) => meta.types[t].rel !== 'none')
      .map((t) => `<option value="b:${t}">${esc(meta.types[t].name)}</option>`).join('')}</optgroup>`);
    ts.insertAdjacentHTML('beforeend', `<optgroup label="공공시설로 쓴다면 (부족 점수)">${Object.keys(meta.public)
      .map((k) => `<option value="p:${k}">${esc(meta.public[k].name)}</option>`).join('')}</optgroup>`);
    ts.addEventListener('change', () => {
      state.type = ts.value;
      $('#seqLegend').hidden = !state.type;
      $('#seqLegend i').style.background = `linear-gradient(90deg, ${(state.type.startsWith('p:') ? SEQ_P : SEQ_B).join(',')})`;
      redraw();
    });
    $('#layerDong').addEventListener('change', (e) => toggleDong(e.target.checked));
    [['layerSenior', 'senior'], ['layerLibrary', 'library'], ['layerChild', 'childcare'], ['layerCowork', 'cowork']].forEach(([id, k]) =>
      $('#' + id).addEventListener('change', (e) => toggleFac(k, e.target.checked)));
    $('#closeCard').addEventListener('click', closeCard);
    $('#openMethod').addEventListener('click', () => $('#method').showModal());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#card').hidden) closeCard(); });
  }

  function fitGu() {
    const pts = stores.filter((s) => !state.gu || s[3] === state.gu).map((s) => [s[1], s[2]]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
  }

  function renderCounts() {
    const inGu = stores.filter((s) => !state.gu || s[3] === state.gu);
    const c = [0, 0, 0]; inGu.forEach((s) => c[s[4]]++);
    $('#total').innerHTML = `<b>${fmt(inGu.length)}</b>곳 · ${state.gu ? esc(state.gu) : '대구'} 빈 점포(추정)`;
    c.forEach((n, i) => { $('#n' + i).textContent = fmt(n); });
  }

  async function toggleDong(on) {
    if (!on) { if (dongLayer) dongLayer.remove(); $('#dtypeLegend').hidden = true; return; }
    if (!dongLayer) {
      const [gj, sm] = await Promise.all([loadJSON('dong.geojson'), loadJSON('dong_summary.json')]);
      const by = Object.fromEntries(sm.map((d) => [d.code, d]));
      dongLayer = L.geoJSON(gj, {
        style: (f) => ({ color: '#ffffff', weight: 1, fillColor: DTYPE_COLOR[(by[f.properties.code] || {}).dtype] || '#ccc', fillOpacity: 0.3 }),
        onEachFeature: (f, l) => {
          const d = by[f.properties.code]; if (!d) return;
          l.bindTooltip(`<b>${esc(d.name)}</b> · ${esc(d.dtype)}<br>65세 이상 ${pct(d.r65)} · 20~39세 ${pct(d.r2039)} · 1인 가구 ${pct(d.rhh1)}<br>빈 점포(추정) ${fmt(d.n)}곳`, { className: 'tip', sticky: true });
        }
      });
      $('#dtypeLegend').innerHTML = Object.entries(DTYPE_COLOR).map(([k, c]) => `<div><i style="background:${c}"></i>${k}</div>`).join('');
    }
    dongLayer.addTo(map); dongLayer.bringToBack(); $('#dtypeLegend').hidden = false;
  }

  async function toggleFac(k, on) {
    if (!facData) facData = await loadJSON('facilities.json');
    if (!on) { if (facLayers[k]) facLayers[k].remove(); return; }
    if (!facLayers[k]) {
      facLayers[k] = L.layerGroup((facData[k] || []).map(([nm, lon, lat]) =>
        L.circleMarker([lat, lon], { renderer, radius: 5, color: FAC_STYLE[k], weight: 2.5, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(nm), { className: 'tip' })));
    }
    facLayers[k].addTo(map);
  }

  /* ---------- 카드 ---------- */
  // 공공시설 종류별 제안 내용(과제: 필요한 시설·서비스, 기존 시설 중복, 공간 확보, 운영 주체, 비용)
  const PROGRAM = {
    senior: { what: '경로당과 작은 쉼터를 합친 동네 사랑방. 혼자 사는 어르신이 걸어와 머물고 안부를 나누는 곳',
      slots: [['오전', '건강 체조·안부 확인'], ['오후', '여가·쉼터·식사 모임'], ['저녁', '주민 모임·반상회']],
      need: '경로당은 노유자시설이라 용도변경 허가가 필요합니다(바닥면적 100㎡ 이상이면 사용승인도).', opcost: '연 약 690만 원(경로당 운영 지원 기준, 추정)' },
    library: { what: '책과 열람석을 둔 작은도서관. 동네 아이·어르신·직장인이 함께 쓰는 열람 공간',
      slots: [['오전', '어르신 신문·독서 모임'], ['오후', '아이 방과후 독서·숙제'], ['저녁', '청년·직장인 열람실']],
      need: '공립 작은도서관으로 등록하려면 시설 기준(33㎡ 이상, 열람석 6석 이상)을 맞춥니다.', opcost: '위탁 단체와 협의(자원봉사 운영 사례 다수)' },
    childcare: { what: '초등학생 방과후 돌봄과 영유아 공동육아를 함께 하는 돌봄 공간',
      slots: [['오전', '영유아 공동육아 나눔터'], ['오후', '초등 방과후 돌봄'], ['저녁', '부모 모임·상담']],
      need: '다함께돌봄센터로 지정하려면 시설 기준과 돌봄교사 배치가 필요합니다.', opcost: '다함께돌봄센터 국비·지방비 지원 기준으로 산정' },
    cowork: { what: '청년·1인 창업자가 함께 쓰는 공동작업 공간과 동네 회의실',
      slots: [['낮', '공동작업·1인 창업 사무'], ['저녁', '스터디·소모임'], ['주말', '동네 원데이 클래스·회의']],
      need: '사무 용도라 큰 용도변경 없이 쓸 수 있는 경우가 많습니다(건축물대장 확인).', opcost: '청년센터 위탁, 이용료로 일부 충당' },
  };
  const RENT5Y = 5930, REMODEL = 1600;  // 만 원, 전용 60㎡ 1층·5년, 팀 개요서 예시 상권 임대료 기준(추정)
  let selected, subway;
  const sortedBy = {};
  const hav = (a, b, c, d) => { const R = 6371000, t = Math.PI / 180, x = (c - a) * t * Math.cos(((b + d) / 2) * t), y = (d - b) * t; return Math.round(Math.sqrt(x * x + y * y) * R); };

  async function openCard(s) {
    if (selected) selected.remove();
    selected = L.circleMarker([s[1], s[2]], { renderer, radius: 11, color: '#1d2330', weight: 3, fill: false, interactive: false }).addTo(map);
    const body = $('#cardBody');
    $('#card').hidden = false; body.innerHTML = '<p class="hint">불러오는 중</p>';
    try {
      if (!cardCache[s[3]]) cardCache[s[3]] = await loadJSON('cards/' + encodeURIComponent(s[3]) + '.json');
      if (!facData) facData = await loadJSON('facilities.json');
      if (!subway) subway = await loadJSON('subway.json');
    } catch (e) { body.innerHTML = '<p class="hint">카드를 불러오지 못했습니다. 다시 눌러 주세요.</p>'; return; }
    const c = cardCache[s[3]][s[0]];
    body.innerHTML = cardHTML(s, c);
    const pick = body.querySelector('#myType');
    pick.addEventListener('change', () => { body.querySelector('#myResult').innerHTML = myType(s, c, pick.value); });
    $('#card').scrollTop = 0;
    setTimeout(() => map.invalidateSize(), 0);
  }
  function closeCard() { $('#card').hidden = true; if (selected) { selected.remove(); selected = null; } setTimeout(() => map.invalidateSize(), 0); }

  function headline(c) {
    if (c.v === 'biz') {
      const t = meta.types[c.top]; const p = c.biz.find((b) => b[0] === c.top)[1];
      return { title: `${t.name} 하기 좋은 자리`, text: `이 자리에 ${t.name}${eul(t.name)} 열면 3년 뒤에도 영업 중일 확률이 <b>${pct(p)}</b>로, 대구 평균(${Math.round(t.avg)}%)보다 높습니다.` };
    }
    if (c.v === 'public') {
      const sp = meta.public[c.pub[0][0]];
      return { title: `${sp.name}로 쓰기 좋은 자리`, text: `가게보다는 동네에 부족한 ${sp.name}로 쓰는 편이 더 도움이 되는 자리입니다.` };
    }
    const high = c.fl && !/^(1|2)$/.test(c.fl);
    return { title: '조금 더 지켜볼 자리', text: `지금은 창업과 공공시설 중 어느 쪽이 더 낫다고 보기 어렵습니다.${high ? ' 높은 층이나 지하라 공공시설로 쓰기에도 불편합니다.' : ''}` };
  }

  function bar(b) {
    const t = meta.types[b[0]];
    return `<div class="bar"><span class="nm">${esc(t.name)}</span>
      <span class="val">${pct(b[1])}<small>대구 평균 ${Math.round(t.avg)}%</small></span>
      <span class="track"><span class="fill" style="width:${Math.round(b[1] * 100)}%"></span><span class="avg" style="left:${t.avg}%"></span></span></div>`;
  }

  // 내가 하려는 업종: 이 자리 확률 + 대구 빈 점포 중 순위 + 1km 안 더 나은 자리 수
  function myType(s, c, t) {
    if (!t) return '';
    const ti = typeKeys.indexOf(t);
    if (!sortedBy[t]) sortedBy[t] = stores.map((x) => x[5][ti]).sort((a, b) => a - b);
    const arr = sortedBy[t]; const v = s[5][ti];
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; }
    const top = Math.max(1, Math.round((1 - lo / arr.length) * 100));
    const ty = meta.types[t]; const p = c.biz.find((b) => b[0] === t)[1];
    const better = p * 100 >= ty.avg;
    const near = stores.filter((x) => x !== s && x[5][ti] > v && hav(s[2], s[1], x[2], x[1]) <= 1000).length;
    return `${bar([t, p])}
      <p class="my">${esc(ty.name)}${eul(ty.name)} 이 자리에 열면 3년 뒤에도 영업 중일 확률은 <b>${pct(p)}</b>로, 대구 평균보다 <b>${better ? '높습니다' : '낮습니다'}</b>.
      대구 빈 점포 ${fmt(arr.length)}곳 가운데 <b>상위 ${top}%</b>입니다.
      ${near ? `1km 안에 이 업종 확률이 더 높은 빈 점포가 ${fmt(near)}곳 있습니다. 왼쪽 '색으로 보기'에서 ${esc(ty.name)}${eul(ty.name)} 고르면 지도에서 찾을 수 있습니다.` : '1km 안 빈 점포 중에서는 이 자리가 가장 높습니다.'}</p>`;
  }

  function nearest(kind, s, n) {
    return (facData[kind] || []).map(([nm, lon, lat]) => [nm, hav(s[2], s[1], lon, lat)]).sort((a, b) => a[1] - b[1]).slice(0, n);
  }
  function stationNear(s) {
    let best = null;
    for (const st of subway) { const d = hav(s[2], s[1], st[1], st[2]); if (!best || d < best[1]) best = [st, d]; }
    return best && best[1] <= 800 ? best : null;
  }
  function hoursChart(h) {
    const mx = Math.max(...h);
    return `<div class="hours">${h.map((v, i) => `<i style="height:${Math.max(3, Math.round((v / mx) * 36))}px" title="${i + 5}시 ${fmt(v)}명"></i>`).join('')}</div>
      <div class="hours-ax"><span>5시</span><span>12시</span><span>18시</span><span>24시</span></div>`;
  }

  function publicHTML(s, c) {
    const P = c.pub[0]; const k = P[0]; const sp = meta.public[k]; const pg = PROGRAM[k]; const has = P[1] > 0;
    const exist = nearest(k, s, 3);
    const inR = exist.filter((e) => e[1] <= sp.r);
    const st = stationNear(s);
    const floorOk = !c.fl || /^(1|2)$/.test(c.fl);
    const rows = c.pub.map((p) => `<div class="prow ${p[0] === k && has ? 'on' : ''}"><span>${esc(meta.public[p[0]].name)}</span>
        <span class="ptrack"><span style="width:${Math.round(p[1])}%"></span></span><span class="pv">${p[1] > 0 ? Math.round(p[1]) + '점' : '충분'}</span></div>`).join('');
    return `
      <section class="sec">
        <h4>공공시설로 쓴다면</h4>
        <p class="lead">동네 인구와 걸어서 갈 거리 안 기존 시설로 계산한 부족 점수(0~100)</p>
        <div class="prows">${rows}</div>
        ${has ? `
        <div class="plan">
          <div class="plan-h">제안 · ${esc(sp.name)}</div>
          <p>${esc(pg.what)}</p>
          <dl class="facts">
            <div><dt>도보 ${dist(sp.r)} 안 같은 시설</dt><dd>${P[2]}곳</dd></div>
            <div><dt>가장 가까운 곳</dt><dd>${dist(P[3])}</dd></div>
            <div><dt>대상 주민(추정)</dt><dd>${fmt(P[4])}명</dd></div>
            <div><dt>동네 유형</dt><dd>${esc(c.dtype)}</dd></div>
          </dl>

          <h5>기존 시설과 겹치지 않나</h5>
          <p>${inR.length ? `도보 ${dist(sp.r)} 안에 비슷한 시설이 ${inR.length}곳 있어, 운영 시간을 나눠 겹치지 않게 합니다.` : `도보 ${dist(sp.r)} 안에 같은 종류의 시설이 없습니다.`}</p>
          <ul class="exist">${exist.map((e) => `<li><span>${esc(e[0])}</span><span>${dist(e[1])}</span></li>`).join('')}</ul>

          <h5>시간대별 운영안</h5>
          <ul class="slots">${pg.slots.map(([a, b]) => `<li><b>${a}</b><span>${esc(b)}</span></li>`).join('')}</ul>
          ${st ? `<p class="sub2">가까운 지하철 ${esc(st[0][0].replace(/\d$/, ''))}역(${dist(st[1])})의 시간대별 이용객입니다. 오가는 사람이 많은 시간에 맞춰 문을 엽니다.</p>${hoursChart(st[0][3])}` : ''}

          <h5>공간 확보와 운영</h5>
          <ul class="how">
            <li><b>확보</b><span>구청이 5년 이상 장기 임차합니다. 매입보다 부담이 적고, 판정이 틀리면 5년 뒤 다른 용도로 바꿀 수 있습니다.${floorOk ? '' : ' 이 자리는 1~2층이 아니라 엘리베이터 등 접근성 확인이 필요합니다.'}</span></li>
            <li><b>절차</b><span>${esc(pg.need)}</span></li>
            <li><b>운영</b><span>${esc(sp.op)}</span></li>
          </ul>

          <h5>예상 비용 <small>전용 60㎡ 기준, 추정</small></h5>
          <ul class="cost">
            <li><span>임차료 5년</span><span>약 ${fmt(RENT5Y)}만 원</span></li>
            <li><span>리모델링 (지방비, 국비 70% 가정)</span><span>약 ${fmt(REMODEL)}만 원</span></li>
            <li><span>운영비</span><span>${esc(pg.opcost)}</span></li>
          </ul>
          <p class="sub2">임차료는 예시 상권(월촌·안지랑) 시세로 잡은 값이라, 이 자리 임대료로 다시 계산해야 합니다.</p>
        </div>` : `<p class="sub2">이 자리 주변에는 네 가지 시설이 모두 대구 평균만큼 있습니다.</p>`}
      </section>`;
  }

  function bizHTML(s, c) {
    const usable = c.biz.filter((b) => meta.types[b[0]].rel !== 'none')
      .sort((a, b) => (b[1] * 100 - meta.types[b[0]].avg) - (a[1] * 100 - meta.types[a[0]].avg));
    const top3 = usable.slice(0, 3);  // 대구 평균보다 가장 나은 3개
    const opts = typeKeys.filter((t) => meta.types[t].rel !== 'none').map((t) => `<option value="${t}">${esc(meta.types[t].name)}</option>`).join('');
    return `
      <section class="sec">
        <h4>가게를 연다면</h4>
        <p class="lead">3년 뒤에도 영업 중일 확률 · 세로선은 대구 평균</p>
        <div class="bars">${top3.map(bar).join('')}</div>
        ${c.why.length && c.top ? `<ul class="why"><b style="margin-left:-16px;display:block;color:var(--ink)">${esc(meta.types[c.top].name)} 근거</b>${c.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <label class="mypick"><span>하려는 업종이 따로 있나요?</span>
          <select id="myType"><option value="">업종 고르기</option>${opts}</select></label>
        <div id="myResult"></div>
      </section>`;
  }

  function cardHTML(s, c) {
    const h = headline(c);
    const floor = c.fl ? `${esc(c.fl)}층` : '층 정보 없음';
    const parts = c.v === 'public' ? [publicHTML(s, c), bizHTML(s, c)] : [bizHTML(s, c), publicHTML(s, c)];
    return `
      <div class="head ${c.v}">
        <div class="lab">${VNAME[c.v]}</div>
        <h3>${esc(h.title)}</h3>
        <p>${h.text}</p>
      </div>
      <div class="place">
        <div class="addr">${esc(c.addr)}${c.bld ? ' · ' + esc(c.bld) : ''}</div>
        <div class="tags">
          <span class="tag">${esc(c.dong)}</span><span class="tag">${floor}</span><span class="tag">${esc(c.dtype)}</span>
          <span class="tag">이전 업종 ${esc(c.prev)}</span>
          ${c.permit ? '<span class="tag ok">인허가 폐업 확인</span>' : '<span class="tag warn">현장 확인 필요</span>'}
        </div>
      </div>
      ${parts.join('')}
      <p class="note">판정은 참고 자료이고 결정은 구청이 합니다. 확률은 인허가 개업·폐업 기록으로 학습한 값으로 매출을 뜻하지 않습니다. (${esc(s[0])})</p>`;
  }

  /* ---------- 계산 방법 ---------- */
  function buildMethod() {
    const m = meta.model;
    const rows = typeKeys.map((t) => {
      const x = meta.types[t];
      return `<tr><td>${esc(x.name)}</td><td>${REL_NAME[x.rel]}</td><td class="num">${x.auc ?? '—'}</td><td class="num">${x.auc_base ?? '—'}</td><td class="num">${x.bottom20 ?? '—'}% → ${x.top20 ?? '—'}%</td><td class="num">${x.avg}%</td><td class="num">${x.n_test ? fmt(x.n_test) : '—'}</td></tr>`;
    }).join('');
    const vc = meta.verdict_counts;
    $('#methodBody').innerHTML = `
      <h2>계산 방법과 정확도</h2>
      <p>모든 숫자는 공공데이터포털 공개 파일로 직접 계산했습니다(계산 ${esc(meta.generated)}).</p>
      <h3>1. 빈 점포(추정) ${fmt(meta.n_stores)}곳</h3>
      <ul>
        <li>상가정보 분기 파일(2025년 10월~2026년 6월)에 있었는데 2026년 9월 파일에서 사라진 업소의 자리입니다.</li>
        <li>같은 건물·층에 새 업소가 들어와 업소 수가 줄지 않았으면 빼고, 같은 상호·업종이 같은 구에 다시 보이면 이전으로 보고 뺐습니다.</li>
        <li>${fmt(meta.permit_confirmed)}곳은 같은 지번에 2025년 7월 이후 인허가 폐업 기록이 있습니다. 나머지는 현장 확인이 필요합니다.</li>
      </ul>
      <h3>2. 가게를 연다면 — 3년 생존 확률</h3>
      <ul>
        <li>인허가 15개 업종의 개업·폐업일로, 2015년~2023년 10월에 문 연 가게가 3년 뒤에도 영업 중이었는지를 학습했습니다(LightGBM). 행사·팝업처럼 같은 지번에 한 달 새 개업이 몰린 기록은 뺐습니다.</li>
        <li>자리 정보
          <ul>
            <li>상권: 반경 100·300·500m 같은 업종·전체 업소 수, 최근 1년 개업·폐업, 같은 업종의 과거 3년 생존율, 같은 지번 과거 폐업</li>
            <li>교통: 가장 가까운 지하철역 거리와 그 역 하루 이용객, 800m 안 역 수, 300m 안 버스 정류소·노선 수, 300m 안 주차 면수</li>
            <li>생활 인프라: 500m 안 아파트 단지·세대수(10년 안 새 아파트 따로), 학교 수, 가장 가까운 초등학교 거리, 공원 수·면적, 전통시장 수·점포 수</li>
            <li>동네 인구: 행정동 인구 밀도, 65세 이상·20~39세·영유아 비율, 1인 가구·아파트 비율(SGIS 2024)</li>
          </ul>
          학습할 때는 개업 당시 있던 것만 셉니다(지하철 개통일, 아파트 사용승인일, 학교 설립일, 공원 지정일, 시장 개설 연도).</li>
        <li><b>검증:</b> ${esc(m.split)}. 업종 안에서 가려내는 힘(AUC, 0.5는 동전 던지기)은 평균 ${m.auc_within_type_weighted}로, 구·업종 평균만 쓰는 방식(${m.auc_within_type_baseline})보다 조금 낫습니다. 교통·생활 인프라를 넣기 전(${m.auc_within_type_no_infra ?? '—'})보다 올랐습니다.</li>
      </ul>
      <div class="tablewrap"><table><thead><tr><th>업종</th><th>쓰임</th><th class="num">AUC</th><th class="num">기준선</th><th class="num">예측 하위→상위 20% 실제 생존</th><th class="num">대구 평균</th><th class="num">시험 건수</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h3>3. 주민에게 모자란 시설</h3>
      <ul>
        <li>네 가지 시설을 봅니다: 동네 사랑방(경로당 위치), 작은도서관(도서관 위치), 초등 돌봄센터(지역아동센터·다함께돌봄센터), 청년 공동작업 공간(공공시설 개방 회의실·강의실·다목적실, 창업 지원기관). 반경은 생활SOC 최저기준의 도보 시간을 거리로 바꾼 값입니다(경로당 500m, 나머지 1km).</li>
        <li>대상 주민은 시설마다 다릅니다(65세 이상, 전체, 5~14세, 20~39세). 행정동 인구 밀도로 반경 안 인원을 추정합니다.</li>
        <li>제안 칸의 시간대별 운영안은 시설 종류별 기본안이고, 800m 안에 지하철역이 있으면 그 역의 시간대별 이용객(2026년 1~10월 하루 평균)을 함께 보여 줍니다. 비용은 팀 개요서의 예시 상권(전용 60㎡, 5년) 추정이라 자리마다 임대료로 다시 계산해야 합니다.</li>
        <li>반경 안 시설 수 ÷ 대상 인구를 대구 평균과 비교한 부족분, 최저기준 거리 초과, 대상 인구 크기를 합쳐 0~100점으로 냈습니다.</li>
        <li>학교 돌봄교실·사설 시설과 일부 경로당 좌표가 빠져 결손이 실제보다 크게 나올 수 있습니다.</li>
      </ul>
      <h3>4. 판정 규칙</h3>
      <ul>
        <li><b>창업 추천 ${fmt(vc.biz || 0)}곳:</b> 판정에 쓰는 업종 중 하나라도 확률 ${Math.round(meta.rules.biz_p * 100)}% 이상이면서 대구 평균의 ${meta.rules.biz_ratio}배 이상</li>
        <li><b>공공시설 추천 ${fmt(vc.public || 0)}곳:</b> 창업 기준 미달, 결손 점수 ${meta.rules.pub_score}점 이상, 1~2층(또는 층 정보 없음)</li>
        <li><b>지켜보기 ${fmt(vc.hold || 0)}곳:</b> 둘 다 아님</li>
      </ul>
      <h3>데이터</h3>
      <p>소상공인시장진흥공단 상가(상권)정보, 행정안전부 지방행정 인허가, 국가데이터처 SGIS 행정구역 통계(2024)·행정동 경계, 대구광역시 경로당·다함께돌봄센터·시내버스 정류소, 행정안전부 표준데이터(도서관·경로당·지역아동센터). 개인 단위 정보는 쓰지 않았습니다.</p>`;
  }

  window.addEventListener('DOMContentLoaded', init);
})();
