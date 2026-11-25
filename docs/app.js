/* 빈 점포 쓰임 지도 — 5판: 업종·시설로 지도 찾기, 집주인 의견, 적정 월세(손익분기)
   4판: 동네 카드, 구청용 우선순위 목록, 동네에 모자란 업종
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
  const eun = (w) => { const c = w.charCodeAt(w.length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '은' : '는'; };
  const times = (p, avg) => (p * 100 / avg).toFixed(1).replace(/\.0$/, '') + '배';  // 대구 평균의 몇 배
  const dist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + 'km' : m + 'm');

  const DATA_BASE = 'data/';
  async function loadJSON(path) {
    const r = await fetch(DATA_BASE + path);
    if (!r.ok) throw new Error(path + ' 불러오기 실패 (' + r.status + ')');
    return r.json();
  }

  let meta, stores, typeKeys, map, cluster, dongLayer, facLayers = {}, facData, renderer;
  const cardCache = {};
  const state = { verdicts: new Set([0, 1, 2]), gu: '', type: '', lo: 0, hi: 100, fitOnly: true, me: null, r: 3000 };
  let meLayer;  // 내 위치 핀 + 반경 원
  let LL = {};  // 집주인 의견: 시연용 예시(landlord_demo.json) + 이 브라우저에서 남긴 의견(localStorage)

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
      try { LL = await (await fetch('landlord_demo.json')).json(); } catch (e) { LL = {}; }
    } catch (e) {
      $('#loading').textContent = '데이터를 불러오지 못했습니다. 새로고침해 주세요. (' + e.message + ')';
      return;
    }
    typeKeys = Object.keys(meta.types);
    byId = Object.fromEntries(stores.map((s) => [s[0], s]));
    buildControls();
    redraw();
    $('#loading').hidden = true;
    buildMethod();
    // 점포 링크: 주소 끝 #V00887 이면 그 점포 카드를 바로 엽니다(구청 공유용)
    const openHash = () => { const m = location.hash.match(/^#(V\d+)$/); if (m && byId[m[1]]) goStore(m[1]); };
    window.addEventListener('hashchange', openHash); openHash();
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

  const meDist = (s) => (state.me ? hav(state.me[1], state.me[0], s[2], s[1]) : 0);
  const inR = (s) => !state.me || meDist(s) <= state.r;
  function visible(s) {
    if (state.type && state.fitOnly) return (state.me ? inR(s) : !state.gu || s[3] === state.gu) && fits(s);  // 내 위치가 있으면 구 대신 반경
    if (state.gu && s[3] !== state.gu) return false;   // 찾기 모드: 판정과 상관없이 고른 업종·시설에 잘 맞는 자리
    return state.verdicts.has(s[4]);
  }
  // 잘 맞는 자리: 업종 = 3년 생존 확률이 대구 평균의 1.1배 이상, 시설 = 부족 점수 50점 이상(1~2층 아님은 카드에서 안내). 집주인이 막은 쓰임은 뺌
  function fits(s) {
    const [k, code] = state.type.split(':');
    if (banned(s[0], k === 'b' ? code : 'public')) return false;
    if (k === 'b') return s[5][typeKeys.indexOf(code)] >= meta.types[code].avg * 1.1;
    return s[6][Object.keys(meta.public).indexOf(code)] >= 50;
  }

  /* ---------- 집주인 의견 ---------- */
  function llGet(id) {
    try { const x = localStorage.getItem('ll:' + id); if (x) return JSON.parse(x); } catch (e) { /* 저장소를 못 쓰는 브라우저 */ }
    return LL[id] || null;
  }
  function banned(id, key) { const o = llGet(id); return !!(o && o.ban && o.ban.includes(key)); }
  const useName = (k) => (k === 'public' ? '공공시설 임대' : meta.types[k].name);

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
    gs.addEventListener('change', async () => {
      state.gu = gs.value; redraw(); fitGu();
      await ensure4();
      const ds = $('#dongSelect');
      ds.innerHTML = '<option value="">동 고르기</option>' + Object.entries(dongDet).filter(([, d]) => d.gu === state.gu)
        .sort((a, b) => a[1].name.localeCompare(b[1].name, 'ko')).map(([c, d]) => `<option value="${c}">${esc(d.name)} (${d.n}곳)</option>`).join('');
      ds.disabled = !state.gu;
      if (!$('#card').hidden && $('#cardBody .head.list')) openList();
      if (!$('#card').hidden && $('#cardBody .head.find')) openFind();
    });
    $('#dongSelect').addEventListener('change', (e) => { if (e.target.value) { openDong(e.target.value); fitDong(e.target.value); } });
    $('#openList').addEventListener('click', openList);

    const ts = $('#typeSelect');
    // 업종 = 과거 데이터로 시험해 맞힌 업종만(나머지는 계산 방법 표에만), 공공시설 = 부족 점수
    ts.insertAdjacentHTML('beforeend', `<optgroup label="가게를 연다면 (3년 생존 확률)">${typeKeys.filter((t) => meta.types[t].rel !== 'none')
      .map((t) => `<option value="b:${t}">${esc(meta.types[t].name)}</option>`).join('')}</optgroup>`);
    ts.insertAdjacentHTML('beforeend', `<optgroup label="공공시설로 쓴다면 (부족 점수)">${Object.keys(meta.public)
      .map((k) => `<option value="p:${k}">${esc(meta.public[k].name)}</option>`).join('')}</optgroup>`);
    ts.addEventListener('change', () => {
      state.type = ts.value;
      $('#findBox').hidden = !state.type;
      $('#vfilter').classList.toggle('dim', !!state.type && state.fitOnly);
      if (state.type) {
        const [k, code] = state.type.split(':');
        $('#fitRule').textContent = k === 'b'
          ? `3년 생존 확률이 대구 평균(${Math.round(meta.types[code].avg)}%)의 1.1배 이상인 자리. 집주인이 ${meta.types[code].name}${eul(meta.types[code].name)} 사절한 자리는 뺍니다.`
          : `${meta.public[code].name} 부족 점수 50점 이상인 자리. 집주인이 공공시설 임대를 사절한 자리는 뺍니다.`;
        $('#seqLegend i').style.background = `linear-gradient(90deg, ${(k === 'p' ? SEQ_P : SEQ_B).join(',')})`;
      }
      redraw();
      if (state.type) openFind();
    });
    $('#fitOnly').addEventListener('change', (e) => { state.fitOnly = e.target.checked; $('#vfilter').classList.toggle('dim', state.fitOnly); redraw(); });
    $('#openFind').addEventListener('click', openFind);
    // 내 위치: 지도 클릭 또는 현재 위치(GPS). 이 브라우저에만 기억하고 어디에도 보내지 않음
    try { const m = JSON.parse(localStorage.getItem('me') || 'null'); if (m) { state.me = m.p; state.r = m.r; } } catch (e) { /* 저장소 없음 */ }
    $('#meR').value = String(state.r);
    $('#meSet').addEventListener('click', () => {
      $('#meTxt').textContent = '지도에서 내 위치를 누르세요';
      map.getContainer().classList.add('picking');
      map.once('click', (e) => { map.getContainer().classList.remove('picking'); setMe([e.latlng.lat, e.latlng.lng]); });
    });
    $('#meGps').addEventListener('click', () => {
      if (!navigator.geolocation) { $('#meTxt').textContent = '이 브라우저는 현재 위치를 지원하지 않습니다'; return; }
      $('#meTxt').textContent = '현재 위치 찾는 중';
      navigator.geolocation.getCurrentPosition((g) => setMe([g.coords.latitude, g.coords.longitude]),
        () => { $('#meTxt').textContent = '현재 위치를 못 받았습니다. 지도에서 찍어 주세요'; }, { timeout: 8000 });
    });
    $('#meR').addEventListener('change', (e) => { state.r = +e.target.value; setMe(state.me); });
    $('#meClear').addEventListener('click', () => setMe(null));
    if (state.me) setMe(state.me, true);
    $('#layerDong').addEventListener('change', (e) => toggleDong(e.target.checked));
    [['layerSenior', 'senior'], ['layerLibrary', 'library'], ['layerChild', 'childcare'], ['layerCowork', 'cowork']].forEach(([id, k]) =>
      $('#' + id).addEventListener('change', (e) => toggleFac(k, e.target.checked)));
    $('#closeCard').addEventListener('click', closeCard);
    $('#openMethod').addEventListener('click', () => $('#method').showModal());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#card').hidden) closeCard(); });
  }

  function setMe(p, quiet) {
    state.me = p;
    if (meLayer) { meLayer.remove(); meLayer = null; }
    try { p ? localStorage.setItem('me', JSON.stringify({ p, r: state.r })) : localStorage.removeItem('me'); } catch (e) { /* 저장소 없음 */ }
    $('#meClear').hidden = !p;
    if (p) {
      meLayer = L.layerGroup([
        L.circle(p, { radius: state.r, color: '#1d2330', weight: 1.5, dashArray: '6 6', fill: true, fillOpacity: 0.04, interactive: false }),
        L.marker(p, { icon: L.divIcon({ html: '<div class="mepin"></div>', className: '', iconSize: [18, 18] }), interactive: false, keyboard: false })
      ]).addTo(map);
      const inside = stores.filter(inR).length;
      $('#meTxt').textContent = `반경 ${state.r / 1000}km 안 빈 점포 ${fmt(inside)}곳`;
      if (!quiet) map.fitBounds(L.latLng(p).toBounds(state.r * 2.1));
    } else $('#meTxt').textContent = '';
    redraw();
    if (state.type && !$('#card').hidden && $('#cardBody .head.find')) openFind();
  }

  function fitGu() {
    const pts = stores.filter((s) => !state.gu || s[3] === state.gu).map((s) => [s[1], s[2]]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
  }

  function renderCounts() {
    const inGu = stores.filter((s) => !state.gu || s[3] === state.gu);
    const c = [0, 0, 0]; inGu.forEach((s) => c[s[4]]++);
    $('#total').innerHTML = state.type && state.fitOnly
      ? `<b>${fmt(stores.filter(visible).length)}</b>곳 · ${state.me ? `내 위치 ${state.r / 1000}km 안` : state.gu ? esc(state.gu) : '대구'}에서 ${esc(modeName().replace(/ (3년 생존 확률|부족 점수)$/, ''))}에 잘 맞는 자리`
      : `<b>${fmt(inGu.length)}</b>곳 · ${state.gu ? esc(state.gu) : '대구'} 빈 점포(추정)`;
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
          l.on('click', () => openDong(f.properties.code));
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
  let selected, subway, RENT, AREA;
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
      if (!subway) [subway, busHours] = await Promise.all([loadJSON('subway.json'), loadJSON('bus_hours.json')]);
      await ensure4();
      if (!RENT) [RENT, AREA] = await Promise.all([fetch('rent.json?v=6.1').then((r) => r.json()), fetch('store_area.json').then((r) => r.json())]);
    } catch (e) { body.innerHTML = '<p class="hint">카드를 불러오지 못했습니다. 다시 눌러 주세요.</p>'; return; }
    const c = cardCache[s[3]][s[0]];
    body.innerHTML = cardHTML(s, c);
    const pick = body.querySelector('#myType');
    pick.addEventListener('change', () => {
      body.querySelector('#myResult').innerHTML = myType(s, c, pick.value);
      if (pick.value) { $('#rentType').value = pick.value; $('#rentType').dispatchEvent(new Event('change')); }
    });
    bindRent(s, c);
    if (state.type.startsWith('b:')) { pick.value = state.type.slice(2); pick.dispatchEvent(new Event('change')); }  // 찾던 업종을 바로 보여 줌
    bindRows(); bindLL(s);
    $('#card').scrollTop = 0;
    setTimeout(() => map.invalidateSize(), 0);
  }
  function closeCard() { $('#card').hidden = true; if (selected) { selected.remove(); selected = null; } setTimeout(() => map.invalidateSize(), 0); }

  function headline(c) {
    if (c.v === 'biz') {
      const t = meta.types[c.top]; const p = c.biz.find((b) => b[0] === c.top)[1];
      return { title: `${t.name} 하기 좋은 자리 — 대구 평균의 ${times(p, t.avg)}`, text: `이 자리에 ${t.name}${eul(t.name)} 열면 3년 뒤에도 영업 중일 확률이 <b>${pct(p)}</b>로, 대구 빈 점포 평균(${Math.round(t.avg)}%)의 <b>${times(p, t.avg)}</b>입니다. 어디서 해도 잘 되는 업종보다, 이 자리라서 유리한 업종을 먼저 보여 드립니다.` };
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
      <span class="val">${pct(b[1])}<small>대구 평균 ${Math.round(t.avg)}% · <b class="x">평균의 ${times(b[1], t.avg)}</b></small></span>
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
    const no = banned(s[0], t) ? `<p class="warnline">이 자리 집주인은 ${esc(ty.name)}${eul(ty.name)} 사절했습니다.</p>` : '';
    return `${bar([t, p])}${no}
      <p class="my">${esc(ty.name)}${eul(ty.name)} 이 자리에 열면 3년 뒤에도 영업 중일 확률은 <b>${pct(p)}</b>로, 대구 평균보다 <b>${better ? '높습니다' : '낮습니다'}</b>.
      대구 빈 점포 ${fmt(arr.length)}곳 가운데 <b>상위 ${top}%</b>입니다.
      ${state.me ? (() => { const loc = stores.filter(inR); const better = loc.filter((x) => x[5][ti] > v).length;
        return inR(s) ? `내 위치 ${state.r / 1000}km 안 빈 점포 ${fmt(loc.length)}곳 가운데 <b>${fmt(better + 1)}위</b>입니다. ` : `이 자리는 내 위치에서 ${dist(meDist(s))} 떨어져 있어 반경 ${state.r / 1000}km 밖입니다. `; })() : ''}
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
  // 이 자리 시간대별 오가는 사람: 800m 안 지하철역이 있으면 그 역, 없으면 300m(없으면 500m) 안 버스 정류장 합계
  let busHours;
  function areaHours(s) {
    const st = stationNear(s);
    if (st) return { h: st[0][3], src: `가까운 지하철 ${st[0][0].replace(/\d$/, '').replace(/역$/, '')}역(${dist(st[1])})` };
    for (const r of [300, 500]) {
      const near = busHours.filter((b) => hav(s[2], s[1], b[0], b[1]) <= r);
      if (near.length) {
        const h = near[0][2].map((_, i) => near.reduce((a, b) => a + b[2][i], 0));
        return { h, src: `${r}m 안 버스 정류장 ${near.length}곳` };
      }
    }
    return null;
  }
  function peaks(h) {
    return h.map((v, i) => [v, i + 5]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1]).sort((a, b) => a - b);
  }
  // 붐비는 시간대 → 영업 시간 참고(규칙)
  function bizTip(h) {
    const sum = (a, b) => h.slice(a - 5, b - 5).reduce((x, y) => x + y, 0);
    const tot = h.reduce((x, y) => x + y, 0) || 1;
    const share = { 아침: sum(6, 10) / tot, 점심: sum(11, 14) / tot, 저녁: sum(17, 21) / tot, 밤: sum(21, 24) / tot };
    const top = Object.entries(share).sort((a, b) => b[1] - a[1])[0][0];
    return {
      아침: '출근길에 사람이 가장 많습니다. 카페·베이커리처럼 아침 장사가 중요한 업종이면 이 시간을 살피세요.',
      점심: '점심시간에 사람이 가장 많습니다. 한식·분식처럼 점심 장사가 중요한 업종이면 이 시간을 살피세요.',
      저녁: '퇴근길에 사람이 가장 많습니다. 반찬가게·저녁 식사처럼 저녁 장사가 중요한 업종이면 이 시간을 살피세요.',
      밤: '밤늦게도 사람이 많이 다닙니다. 호프·PC방처럼 밤 장사가 중요한 업종이면 이 시간을 살피세요.',
    }[top];
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
    const ah = areaHours(s);
    const floorOk = !c.fl || /^(1|2)$/.test(c.fl);
    const rows = c.pub.map((p) => `<div class="prow ${p[0] === k && has ? 'on' : ''}"><span>${esc(meta.public[p[0]].name)}</span>
        <span class="ptrack"><span style="width:${Math.round(p[1])}%"></span></span><span class="pv">${p[1] > 0 ? Math.round(p[1]) + '점' : '충분'}</span></div>`).join('');
    return `
      <section class="sec">
        <h4>공공시설로 쓴다면</h4>
        ${banned(s[0], 'public') ? '<p class="warnline">이 자리 집주인은 공공시설 임대를 사절했습니다.</p>' : ''}
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
          ${ah ? `<p class="sub2">${esc(ah.src)}의 시간대별 이용객(하루 평균)입니다. 오가는 사람이 많은 ${peaks(ah.h).join('·')}시에 맞춰 문을 엽니다.</p>${hoursChart(ah.h)}` : ''}

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

  /* ---------- 5판: 적정 월세(손익분기) ----------
     월 매출 = 업종 묶음 연 매출 × √(이 자리 면적 ÷ 묶음 평균 면적)(0.6~1.6배로 제한) ÷ 12
     버틸 수 있는 월세 = 월 매출 × (영업이익 + 임차료) ÷ 매출 − 사장 1명 최저임금(월 215.7만 원)
     업계 평균 월세 = 월 매출 × 임차료 ÷ 매출 · 시세 = 가까운 조사 상권(1km 안, 없으면 대구 평균) ㎡당 월 임대료 × 면적 */
  function marketRent(s) {
    let best = null;
    for (const a of RENT.areas) { const d = hav(s[2], s[1], a[2], a[1]); if (!best || d < best[1]) best = [a, d]; }
    return best && best[1] <= 1000 ? { name: best[0][0], v: best[0][3] } : { name: '대구 평균', v: RENT.cityRent };
  }
  function rentCalc(s, t, area) {
    const g = RENT.groups[RENT.typeGroup[t]];
    const f = Math.min(1.6, Math.max(0.6, Math.sqrt(area / g.area)));
    const sales = (g.sales * 100 * f) / 12;                    // 만 원/월
    const max = sales * (g.profit + g.rent) / g.sales - RENT.minwage;
    const usual = sales * g.rent / g.sales;
    const mk = marketRent(s);
    return { g, f, sales, max, usual, mk, market: (mk.v * area) / 10 };   // 천원/㎡ × ㎡ ÷ 10 = 만 원
  }
  const man = (x) => fmt(Math.round(x)) + '만 원';
  function rentBody(s, c, t, area) {
    const r = rentCalc(s, t, area); const nm = meta.types[t].name; const ll = llGet(s[0]);
    const lvl = r.max < 10 ? 'bad' : r.market <= r.max * 0.8 ? 'good' : r.market <= r.max ? 'mid' : 'bad';
    const say = r.max <= 0
      ? `평균 매출로는 월세를 내고 나면 사장 몫(최저임금)도 남지 않습니다. 매출이 평균보다 높을 자신이 있을 때만 검토하세요.`
      : { good: `이 동네 시세(약 ${man(r.market)})면 여유가 있습니다.`, mid: `이 동네 시세(약 ${man(r.market)})면 빠듯합니다. 매출이 평균보다 낮으면 손해입니다.`,
          bad: `이 동네 시세(약 ${man(r.market)})는 버틸 수 있는 선을 넘습니다. 월세를 ${man(r.max)} 아래로 맞춰야 합니다.` }[lvl];
    const w = Math.max(r.max, r.market, r.usual, (ll && ll.want) || 0, 1);
    const line = (label, v, cls) => `<div class="rline ${cls}"><span>${label}</span><span class="rtrack"><span style="width:${Math.max(2, Math.round((Math.max(0, v) / w) * 100))}%"></span></span><b>${v > 0 ? man(v) : '없음'}</b></div>`;
    return `
      <div class="rverdict ${lvl}"><b>${esc(nm)}${eul(nm)} 하려면 월세 ${r.max >= 10 ? man(r.max) + '까지' : '부담이 큼'}</b><span>${say}</span></div>
      <div class="rlines">
        ${line('버틸 수 있는 월세', r.max, 'max')}
        ${line('업계 평균 월세', r.usual, 'usual')}
        ${line(`시세 (${esc(r.mk.name)})`, r.market, 'mk')}
        ${ll && ll.want ? line('집주인 희망', ll.want, 'll') : ''}
      </div>
      ${ll && ll.want && r.max >= 10 ? `<p class="my">집주인 희망 월세 ${man(ll.want)}은 ${ll.want <= r.max ? '<b>맞출 수 있는</b> 값입니다.' : `버틸 수 있는 선보다 <b>${man(ll.want - r.max)} 높습니다</b>. 조정이 필요합니다.`}</p>` : ''}
      <p class="sub2">계산: 월 매출 약 ${man(r.sales)}(${esc(r.g.name)} 평균 매출을 면적으로 ${r.f.toFixed(2)}배 조정) × 비용 빼기 전 이익률 ${Math.round(((r.g.profit + r.g.rent) / r.g.sales) * 100)}% − 사장 최저임금 ${man(RENT.minwage)}. 시세는 ㎡당 ${(r.mk.v * 1000).toLocaleString('ko-KR')}원(2026년 3분기 소규모 상가, ${/^(1|2)$/.test(c.fl || '1') ? '' : '1층 기준이라 이 층은 더 낮을 수 있음, '}보증금 제외).</p>`;
  }
  function rentHTML(s, c, t0) {
    const a = AREA[s[0]] || [49, 3];
    const src = ['같은 건물·층 인허가 기록', '같은 건물 인허가 기록', '같은 동 평균', '대구 평균'][a[1]];
    const opts = typeKeys.filter((t) => meta.types[t].rel !== 'none').map((t) => `<option value="${t}" ${t === t0 ? 'selected' : ''}>${esc(meta.types[t].name)}</option>`).join('');
    return `<section class="sec rent" id="rentSec"><h4>월세는 얼마까지?</h4>
      <p class="lead">업종 평균 매출과 비용으로 계산한 손익분기 · 추정</p>
      <div class="rinputs">
        <label class="field"><span>업종</span><select id="rentType">${opts}</select></label>
        <label class="field"><span>면적 ㎡ <small>${src}</small></span><input type="number" id="rentArea" min="10" max="400" step="1" value="${a[0]}"></label>
      </div>
      <div id="rentBody">${rentBody(s, c, t0, a[0])}</div>
      <p class="note">평균 매출은 업종 묶음(예: 음식점 전체) 값이라 이 자리 매출과 다를 수 있습니다. 조사 원자료의 영업이익에는 사장 인건비가 빠져 있지 않을 수 있어, 여기서는 최저임금만큼을 따로 뺐습니다. 실제 계약 전 매출 계획으로 다시 계산하세요.</p></section>`;
  }
  function bindRent(s, c) {
    const ty = $('#rentType'), ar = $('#rentArea'); if (!ty) return;
    const up = () => { const a = Math.min(400, Math.max(10, +ar.value || 49)); $('#rentBody').innerHTML = rentBody(s, c, ty.value, a); };
    ty.addEventListener('change', up); ar.addEventListener('input', up);
  }

  function bizHTML(s, c) {
    const bans = c.biz.filter((b) => meta.types[b[0]].rel !== 'none' && banned(s[0], b[0])).map((b) => meta.types[b[0]].name);
    const usable = c.biz.filter((b) => meta.types[b[0]].rel !== 'none' && !banned(s[0], b[0]))
      .sort((a, b) => (b[1] * 100 - meta.types[b[0]].avg) - (a[1] * 100 - meta.types[a[0]].avg));
    const top3 = usable.slice(0, 3);  // 대구 평균보다 가장 나은 3개
    const opts = typeKeys.filter((t) => meta.types[t].rel !== 'none').map((t) => `<option value="${t}">${esc(meta.types[t].name)}</option>`).join('');
    return `
      <section class="sec">
        <h4>가게를 연다면</h4>
        <p class="lead">이 자리만의 장점이 큰 순서(대구 평균보다 몇 배 높은지) · 막대는 3년 뒤에도 영업 중일 확률, 세로선은 대구 평균</p>
        <div class="bars">${top3.map(bar).join('')}</div>
        ${bans.length ? `<p class="sub2">집주인이 사절한 ${bans.map(esc).join('·')}${eun(bans[bans.length - 1])} 추천에서 뺐습니다.</p>` : ''}
        ${c.why.length && c.top ? `<ul class="why"><b style="margin-left:-16px;display:block;color:var(--ink)">${esc(meta.types[c.top].name)} 근거</b>${c.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <label class="mypick"><span>하려는 업종이 따로 있나요?</span>
          <select id="myType"><option value="">업종 고르기</option>${opts}</select></label>
        <div id="myResult"></div>
        ${rentHTML(s, c, top3.length ? top3[0][0] : 'korean')}
        ${(() => { const ah = areaHours(s); return ah ? `<h5 class="h5">이 자리를 오가는 사람 <small>${esc(ah.src)} · 하루 평균</small></h5>${hoursChart(ah.h)}
          <p class="my">가장 붐비는 시간: <b>${peaks(ah.h).join('시 · ')}시</b>. ${bizTip(ah.h)}</p>` : ''; })()}
      </section>`;
  }

  // 집주인 의견: 사절 업종·희망 월세·한마디. 실제 운영에서는 구청 공실 등록 때 받고, 지금은 시연용 예시 + 이 브라우저에만 저장
  function llHTML(s) {
    const o = llGet(s[0]);
    const used = typeKeys.filter((t) => meta.types[t].rel !== 'none');
    const view = o ? `
        <div class="ll-ban">${o.ban && o.ban.length ? o.ban.map((k) => `<span class="tag no">${esc(useName(k))} 사절</span>`).join('') : '<span class="tag">사절 업종 없음</span>'}</div>
        ${o.want ? `<p class="my">희망 월세 <b>${fmt(o.want)}만 원</b></p>` : ''}
        ${o.memo ? `<p class="ll-memo">“${esc(o.memo)}”</p>` : ''}
        <p class="sub2">${o.demo && !o.mine ? '시연용 예시 의견입니다.' : '이 브라우저에 저장한 의견입니다.'}</p>` : '<p class="sub2">아직 집주인 의견이 없습니다.</p>';
    return `<section class="sec ll" id="llSec"><h4>집주인 의견</h4>${view}
      <details class="llform"><summary>${o ? '의견 고치기' : '집주인이세요? 의견 남기기'}</summary>
        <p class="hint">들이고 싶지 않은 쓰임을 고르면, 그 업종·시설로 찾는 사람의 지도와 추천에서 이 자리가 빠집니다.</p>
        <div class="llchecks">${[...used, 'public'].map((k) => `<label><input type="checkbox" value="${k}" ${o && o.ban && o.ban.includes(k) ? 'checked' : ''}>${esc(useName(k))}</label>`).join('')}</div>
        <label class="field"><span>희망 월세 (만 원)</span><input type="number" id="llWant" min="0" step="5" value="${o && o.want ? o.want : ''}"></label>
        <label class="field"><span>한마디</span><input type="text" id="llMemo" maxlength="80" value="${o && o.memo ? esc(o.memo) : ''}" placeholder="예: 저녁 장사는 곤란합니다"></label>
        <div class="llbtns"><button type="button" class="listbtn" id="llSave">저장</button>${o ? '<button type="button" class="link" id="llDel">지우기</button>' : ''}</div>
        <p class="sub2">시연판이라 이 브라우저에만 저장됩니다. 실제로는 구청 공실 등록 때 받습니다. 연락처는 받지 않습니다.</p>
      </details></section>`;
  }
  function bindLL(s) {
    const sv = $('#llSave'); if (!sv) return;
    sv.addEventListener('click', () => {
      const ban = [...document.querySelectorAll('#llSec .llchecks input:checked')].map((i) => i.value);
      const want = parseInt($('#llWant').value, 10) || null; const memo = $('#llMemo').value.trim();
      try { localStorage.setItem('ll:' + s[0], JSON.stringify({ ban, want, memo, mine: 1 })); } catch (e) { LL[s[0]] = { ban, want, memo, mine: 1 }; }
      if (state.type) redraw();
      openCard(s);
    });
    const dl = $('#llDel');
    if (dl) dl.addEventListener('click', () => { try { localStorage.removeItem('ll:' + s[0]); } catch (e) { /* 무시 */ } delete LL[s[0]]; if (state.type) redraw(); openCard(s); });
  }

  function cardHTML(s, c) {
    const h = headline(c);
    const floor = c.fl ? `${esc(c.fl)}층` : '층 정보 없음';
    const pubFirst = state.type ? state.type.startsWith('p:') : c.v === 'public';  // 찾기 중이면 고른 쪽을 먼저
    const parts = pubFirst ? [publicHTML(s, c), bizHTML(s, c)] : [bizHTML(s, c), publicHTML(s, c)];
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
      ${llHTML(s)}
      ${parts.join('')}
      ${dongSnippet(s[0])}
      <p class="note">판정은 참고 자료이고 결정은 구청이 합니다. 확률은 인허가 개업·폐업 기록으로 학습한 값으로 매출을 뜻하지 않습니다. (${esc(s[0])})</p>`;
  }

  /* ---------- 4판: 동네 카드 · 구청용 우선순위 목록 ---------- */
  let byId, dongDet, prio, storeDong, dongGeoLayer;
  const PUB_ICON = { senior: '사랑방', library: '도서관', childcare: '돌봄', cowork: '공동작업' };

  async function ensure4() {
    if (!dongDet) [dongDet, prio, storeDong] = await Promise.all([loadJSON('dong_detail.json'), loadJSON('priority.json'), loadJSON('store_dong.json')]);
  }
  function showPanel(html) {
    $('#cardBody').innerHTML = html; $('#card').hidden = false; $('#card').scrollTop = 0;
    setTimeout(() => map.invalidateSize(), 0);
  }
  function goStore(id) {
    const s = byId[id]; if (!s) return;
    map.setView([s[1], s[2]], Math.max(map.getZoom(), 17));
    openCard(s);
  }
  async function fitDong(code) {
    if (!dongGeoLayer) dongGeoLayer = L.geoJSON(await loadJSON('dong.geojson'));
    dongGeoLayer.eachLayer((l) => { if (l.feature.properties.code === code) map.fitBounds(l.getBounds(), { padding: [20, 20] }); });
  }

  function vbar(v) {
    const n = v[0] + v[1] + v[2] || 1;
    return `<div class="vbar"><i style="width:${(v[0] / n) * 100}%;background:${COLOR.biz}"></i><i style="width:${(v[1] / n) * 100}%;background:${COLOR.public}"></i><i style="width:${(v[2] / n) * 100}%;background:${COLOR.hold}"></i></div>
      <div class="vleg"><span>창업 ${v[0]}</span><span>공공시설 ${v[1]}</span><span>지켜보기 ${v[2]}</span></div>`;
  }
  function storeRow(r, kind) {
    const right = kind === 'public' ? `${esc(meta.public[r[5]].name)} · 부족 ${Math.round(r[6])}점` : `${esc(meta.types[r[5]].name)} ${pct(r[6])}`;
    return `<li><button type="button" class="rowbtn" data-id="${r[0]}"><span class="ra">${esc(r[3])}${r[4] ? ' ' + esc(r[4]) + '층' : ''}${r[8] > 1 ? ` <small class="cnt">빈 칸 ${r[8]}곳</small>` : ''}</span><span class="rb">${right}</span></button></li>`;
  }

  async function openDong(code) {
    await ensure4();
    const d = dongDet[code]; if (!d) return;
    const fac = Object.entries(d.fac).filter(([, x]) => x != null).sort((a, b) => b[1] - a[1]);
    const facMax = Math.max(1, ...fac.map((f) => f[1]));
    showPanel(`
      <div class="head dong"><div class="lab">동네 카드</div><h3>${esc(d.gu)} ${esc(d.name)}</h3><p>${esc(d.dtype)} · 인구 ${fmt(d.pop)}명</p></div>
      <dl class="facts">
        <div><dt>65세 이상</dt><dd>${pct(d.r65)}</dd></div><div><dt>20~39세</dt><dd>${pct(d.r2039)}</dd></div>
        <div><dt>1인 가구</dt><dd>${pct(d.rhh1)}</dd></div><div><dt>아파트</dt><dd>${pct(d.rapt)}</dd></div>
      </dl>
      <section class="sec"><h4>빈 점포 ${fmt(d.n)}곳</h4><p class="lead">최근 1년 사이 비게 된 것으로 추정한 자리</p>${vbar(d.v)}</section>
      <section class="sec"><h4>이 동네에 모자란 업종</h4>
        <p class="lead">같은 '${esc(d.dtype)}' 동네들과 주민 1천 명당 가게 수를 비교 (0.5배 이하)</p>
        ${d.short.length ? `<ul class="ind">${d.short.map((x) => `<li><span>${esc(x[0])}</span><span>${x[2]}곳 · 보통 ${x[3]}곳 <b class="lo">${x[1]}배</b></span></li>`).join('')}</ul>` : '<p class="sub2">같은 유형 동네보다 크게 모자란 업종이 없습니다.</p>'}
        ${d.over.length ? `<h5 class="h5">이미 많은 업종 <small>2배 이상 · 새로 열면 경쟁이 심함</small></h5><ul class="ind">${d.over.map((x) => `<li><span>${esc(x[0])}</span><span>${x[2]}곳 · 보통 ${x[3]}곳 <b class="hi">${x[1]}배</b></span></li>`).join('')}</ul>` : ''}
      </section>
      <section class="sec"><h4>모자란 생활시설</h4><p class="lead">이 동 빈 점포들의 평균 부족 점수</p>
        <div class="prows">${fac.map(([k, x]) => `<div class="prow ${x === fac[0][1] && x > 0 ? 'on' : ''}"><span>${esc(meta.public[k].name)}</span><span class="ptrack"><span style="width:${Math.round((x / facMax) * 100)}%"></span></span><span class="pv">${x > 0 ? Math.round(x) + '점' : '충분'}</span></div>`).join('')}</div>
      </section>
      ${d.top_pub.length ? `<section class="sec"><h4>공공시설 추천 자리</h4><ul class="rows">${d.top_pub.map((r) => storeRow(r, 'public')).join('')}</ul></section>` : ''}
      ${d.top_biz.length ? `<section class="sec"><h4>창업 추천 자리</h4><ul class="rows">${d.top_biz.map((r) => storeRow(r, 'biz')).join('')}</ul></section>` : ''}
      <p class="note">모자란 업종은 상가정보(2026년 9월)의 생활 업종 가게 수로 계산했습니다. 학교 안 시설·온라인 가게는 들어가지 않습니다.</p>`);
    bindRows();
  }

  let listKind = 'public';
  async function openList() {
    await ensure4();
    const rows = prio[listKind].filter((r) => !state.gu || r[1] === state.gu)
      .sort((a, b) => listKind === 'public' ? b[6] - a[6] : b[7] - a[7]).slice(0, 20);
    showPanel(`
      <div class="head list"><div class="lab">구청용 목록</div><h3>${state.gu ? esc(state.gu) : '대구 전체'} 우선 검토할 빈 점포</h3>
        <p>${listKind === 'public' ? '공공시설로 쓰면 도움이 가장 큰 순서(부족 점수)' : '창업하면 대구 평균보다 가장 잘 버틸 순서'} · 상위 20곳</p></div>
      <div class="seg" role="tablist">
        <button type="button" role="tab" aria-selected="${listKind === 'public'}" data-k="public">공공시설 추천</button>
        <button type="button" role="tab" aria-selected="${listKind === 'biz'}" data-k="biz">창업 추천</button>
      </div>
      <ol class="rows num">${rows.map((r) => storeRow(r, listKind)).join('')}</ol>
      <button type="button" class="csv" id="csvBtn">이 목록 CSV로 받기</button>
      <p class="note">지역을 바꾸면 그 구의 목록으로 바뀝니다. 자리를 누르면 지도에서 카드가 열립니다.</p>`);
    $('#cardBody').querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { listKind = b.dataset.k; openList(); }));
    $('#csvBtn').addEventListener('click', () => downloadCSV(rows));
    bindRows();
  }
  // 5판: 업종·시설 → 지도. 고른 쓰임에 가장 잘 맞는 빈 점포 순위(지역 필터 반영)
  async function openFind() {
    if (!state.type) return;
    const fv = modeVal(); const [k, code] = state.type.split(':');
    const nm = k === 'b' ? meta.types[code].name : meta.public[code].name;
    const all = stores.filter(visible);
    const rows = all.slice().sort((a, b) => fv(b) - fv(a)).slice(0, 20);
    // 반경 밖이지만 반경 안 1위보다 확률·점수가 높은 가장 가까운 자리
    let outer = null;
    if (state.me) {
      const best = rows.length ? fv(rows[0]) : -1;
      outer = stores.filter((s) => !inR(s) && fits(s) && fv(s) > best).sort((a, b) => meDist(a) - meDist(b))[0] || null;
      if (outer) rows.push(outer);
    }
    showPanel('<p class="hint">불러오는 중</p>');
    try {
      await Promise.all([...new Set(rows.map((r) => r[3]))].map(async (g) => { if (!cardCache[g]) cardCache[g] = await loadJSON('cards/' + encodeURIComponent(g) + '.json'); }));
    } catch (e) { showPanel('<p class="hint">목록을 불러오지 못했습니다. 다시 눌러 주세요.</p>'); return; }
    const byGu = {}; all.forEach((s) => { byGu[s[3]] = (byGu[s[3]] || 0) + 1; });
    const guTop = Object.entries(byGu).sort((a, b) => b[1] - a[1]).slice(0, 4);
    showPanel(`
      <div class="head find ${k === 'b' ? 'biz' : 'public'}"><div class="lab">${k === 'b' ? '이 가게를 열고 싶다면' : '이 시설을 두고 싶다면'}</div>
        <h3>${esc(nm)}에 잘 맞는 빈 점포 ${fmt(all.length)}곳</h3>
        <p>${state.me ? `내 위치 ${state.r / 1000}km 안` : state.gu ? esc(state.gu) : '대구 전체'} · ${k === 'b' ? '3년 생존 확률이 높은 순' : '부족 점수가 높은 순'} · 상위 ${rows.length - (outer ? 1 : 0)}곳</p></div>
      ${!state.me ? '<p class="sub2">왼쪽에서 내 위치를 정하면 가까운 자리 안에서 순위를 매깁니다.</p>' : ''}
      ${state.me && !all.length ? `<p class="sub2">반경 ${state.r / 1000}km 안에는 잘 맞는 자리가 없습니다. 반경을 넓혀 보세요.</p>` : ''}
      ${!state.gu && !state.me && guTop.length ? `<p class="sub2">많은 구: ${guTop.map(([g, n]) => `${esc(g)} ${fmt(n)}곳`).join(', ')}</p>` : ''}
      ${(() => {
        const row = (r) => { const c = cardCache[r[3]][r[0]] || {}; const v = fv(r); const ll = llGet(r[0]);
          return `<li><button type="button" class="rowbtn" data-id="${r[0]}"><span class="ra">${esc(c.addr || r[0])}${c.fl ? ' ' + esc(c.fl) + '층' : ''}<small>${esc(c.dong || '')}${state.me ? ' · 내 위치에서 ' + dist(meDist(r)) : ''}${ll ? ' · 집주인 의견 있음' : ''}</small></span><span class="rb">${k === 'b' ? v + '%' : v + '점'}</span></button></li>`; };
        const inner = outer ? rows.slice(0, -1) : rows;
        return `<ol class="rows num">${inner.map(row).join('')}</ol>` +
          (outer ? `<h5 class="h5">조금 더 가면 <small>반경 밖에서 이 목록 1위보다 높은 가장 가까운 자리</small></h5><ul class="rows">${row(outer)}</ul>` : '');
      })()}
      <p class="note">자리를 누르면 지도에서 카드가 열립니다. 지역을 바꾸면 그 구의 순위로 바뀝니다. ${k === 'b' ? `대구 빈 점포 평균은 ${Math.round(meta.types[code].avg)}%입니다.` : ''}</p>`);
    bindRows();
  }
  function downloadCSV(rows) {
    const head = listKind === 'public'
      ? ['순위', '점포ID', '구', '행정동', '주소', '층', '추천 시설', '부족 점수', '대상 주민(추정)', '같은 건물·층 빈 칸']
      : ['순위', '점포ID', '구', '행정동', '주소', '층', '추천 업종', '3년 생존 확률', '대구 평균 대비(배)', '같은 건물·층 빈 칸'];
    const body = rows.map((r, i) => [i + 1, r[0], r[1], r[2], r[3], r[4],
      listKind === 'public' ? meta.public[r[5]].name : meta.types[r[5]].name, r[6], r[7], r[8]]);
    const csv = '﻿' + [head, ...body].map((a) => a.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `빈점포_${listKind === 'public' ? '공공시설' : '창업'}추천_${state.gu || '대구전체'}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function bindRows() {
    $('#cardBody').querySelectorAll('.rowbtn').forEach((b) => b.addEventListener('click', () => goStore(b.dataset.id)));
    $('#cardBody').querySelectorAll('.dongbtn').forEach((b) => b.addEventListener('click', () => { openDong(b.dataset.code); fitDong(b.dataset.code); }));
  }

  // 점포 카드 아래: 이 동네 요약 + 모자란 업종
  function dongSnippet(id) {
    const code = storeDong && storeDong[id]; const d = code && dongDet[code]; if (!d) return '';
    return `<section class="sec"><h4>이 동네 (${esc(d.name)})</h4>
      <p class="lead">같은 유형 동네보다 모자란 업종 — 이 자리에서 열면 겹치지 않습니다</p>
      ${d.short.length ? `<ul class="ind">${d.short.slice(0, 3).map((x) => `<li><span>${esc(x[0])}</span><span><b class="lo">${x[1]}배</b></span></li>`).join('')}</ul>` : '<p class="sub2">크게 모자란 업종은 없습니다.</p>'}
      ${d.over.length ? `<p class="sub2">이미 많은 업종: ${d.over.slice(0, 3).map((x) => `${esc(x[0])}(${x[1]}배)`).join(', ')}</p>` : ''}
      <button type="button" class="dongbtn" data-code="${code}">동네 카드 전체 보기</button></section>`;
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
