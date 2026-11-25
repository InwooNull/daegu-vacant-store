/* 빈 점포 한 칸 — 지도·카드 (2판: 점 뭉치기, 간결한 카드)
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
  const FAC_STYLE = { senior: '#d9822b', library: '#7b5ea7', childcare: '#0f8b8d' };
  const SEQ = ['#d7dbe2', '#b6c6ea', '#7f9ee0', '#2f5fd0', '#18307a'];

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

  function redraw() {
    const ti = state.type ? typeKeys.indexOf(state.type) : -1;
    const vis = stores.filter(visible);
    if (ti >= 0) {
      const vals = vis.map((s) => s[5][ti]).sort((a, b) => a - b);
      state.lo = vals[Math.floor(vals.length * 0.05)] || 0; state.hi = vals[Math.floor(vals.length * 0.95)] || 100;
    }
    const ms = vis.map((s) => {
      const p = ti >= 0 ? s[5][ti] : 0;
      const col = ti >= 0 ? seqColor(p) : COLOR[VERDICT[s[4]]];
      const m = L.marker([s[1], s[2]], { icon: L.divIcon({ html: `<div class="pt" style="background:${col}"></div>`, className: '', iconSize: [12, 12] }), v: s[4], p, keyboard: false });
      m.on('click', () => openCard(s));
      if (ti >= 0) m.bindTooltip(`${meta.types[state.type].name} ${p}%`, { className: 'tip', direction: 'top', offset: [0, -6] });
      return m;
    });
    cluster.clearLayers(); cluster.addLayers(ms);
    renderCounts(); renderLegend();
  }

  function renderLegend() {
    const el = $('#mapLegend'); if (!el) return;
    if (state.type) {
      el.innerHTML = `<b>${esc(meta.types[state.type].name)}</b> 3년 생존 확률<br><span style="display:inline-block;width:120px;height:8px;border-radius:4px;background:linear-gradient(90deg,${SEQ.join(',')})"></span><br>원 안 숫자 = 빈 점포 수 · 색 = 평균 확률`;
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
    // 과거 데이터로 시험해 맞힌 업종만 보여 줌(나머지는 계산 방법 표에만)
    typeKeys.filter((t) => meta.types[t].rel !== 'none')
      .forEach((t) => ts.insertAdjacentHTML('beforeend', `<option value="${t}">${esc(meta.types[t].name)}</option>`));
    ts.addEventListener('change', () => {
      state.type = ts.value;
      $('#seqLegend').hidden = !state.type;
      redraw();
    });
    $('#layerDong').addEventListener('change', (e) => toggleDong(e.target.checked));
    [['layerSenior', 'senior'], ['layerLibrary', 'library'], ['layerChild', 'childcare']].forEach(([id, k]) =>
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
  let selected;
  async function openCard(s) {
    if (selected) selected.remove();
    selected = L.circleMarker([s[1], s[2]], { renderer, radius: 11, color: '#1d2330', weight: 3, fill: false, interactive: false }).addTo(map);
    const body = $('#cardBody');
    $('#card').hidden = false; body.innerHTML = '<p class="hint">불러오는 중</p>';
    try {
      if (!cardCache[s[3]]) cardCache[s[3]] = await loadJSON('cards/' + encodeURIComponent(s[3]) + '.json');
    } catch (e) { body.innerHTML = '<p class="hint">카드를 불러오지 못했습니다. 다시 눌러 주세요.</p>'; return; }
    body.innerHTML = cardHTML(s[0], cardCache[s[3]][s[0]]);
    $('#card').scrollTop = 0;
    setTimeout(() => map.invalidateSize(), 0);
  }
  function closeCard() { $('#card').hidden = true; if (selected) { selected.remove(); selected = null; } setTimeout(() => map.invalidateSize(), 0); }

  function headline(c) {
    const R = meta.rules;
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
    const t = meta.types[b[0]]; const none = t.rel === 'none';
    return `<div class="bar ${none ? 'none' : ''}"><span class="nm">${esc(t.name)}</span>
      <span class="val">${pct(b[1])}<small>대구 평균 ${Math.round(t.avg)}%</small></span>
      <span class="track"><span class="fill" style="width:${Math.round(b[1] * 100)}%"></span><span class="avg" style="left:${t.avg}%"></span></span></div>`;
  }

  function cardHTML(id, c) {
    const h = headline(c);
    const usable = c.biz.filter((b) => meta.types[b[0]].rel !== 'none')
      .sort((a, b) => (b[1] * 100 - meta.types[b[0]].avg) - (a[1] * 100 - meta.types[a[0]].avg));
    const top3 = usable.slice(0, 3);  // 대구 평균보다 가장 나은 3개
        const P = c.pub[0]; const sp = meta.public[P[0]]; const has = P[1] > 0;
    const floor = c.fl ? `${esc(c.fl)}층` : '층 정보 없음';
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

      <section class="sec">
        <h4>가게를 연다면</h4>
        <p class="lead">3년 뒤에도 영업 중일 확률 · 세로선은 대구 평균</p>
        <div class="bars">${top3.map(bar).join('')}</div>
        ${c.why.length && c.top ? `<ul class="why"><b style="margin-left:-16px;display:block;color:var(--ink)">${esc(meta.types[c.top].name)} 근거</b>${c.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}

      </section>

      <section class="sec">
        <h4>주민에게 모자란 시설</h4>
        <p class="lead">걸어서 갈 거리 안 시설을 대상 인구와 대구 평균에 비교</p>
        <div class="pub-main ${has ? '' : 'none'}">
          <div class="row"><b>${esc(sp.name)}</b><span class="score">${has ? '부족 ' + Math.round(P[1]) + '점' : '충분'}</span></div>
          <dl class="facts">
            <div><dt>도보 ${dist(sp.r)} 안</dt><dd>${P[2]}곳</dd></div>
            <div><dt>가장 가까운 곳</dt><dd>${dist(P[3])}</dd></div>
            <div><dt>대상 인구(추정)</dt><dd>${fmt(P[4])}명</dd></div>
            <div><dt>대구 평균 대비</dt><dd>${P[2] === 0 ? '시설 없음' : P[5] >= 10 ? '10배 이상' : P[5].toFixed(1) + '배'}</dd></div>
          </dl>
          ${has ? `<p class="op">운영(제안): ${esc(sp.op)}</p>` : ''}
        </div>
        <div class="pub-rest">${c.pub.slice(1).map((p) => `<div><span>${esc(meta.public[p[0]].name)}</span><span>${p[1] > 0 ? '부족 ' + Math.round(p[1]) + '점' : '충분'}</span></div>`).join('')}</div>
      </section>
      <p class="note">판정은 참고 자료이고 결정은 구청이 합니다. 확률은 인허가 개업·폐업 기록으로 학습한 값으로 매출을 뜻하지 않습니다. (${esc(id)})</p>`;
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
        <li>경로당, 도서관, 지역아동센터·다함께돌봄센터 위치를 썼습니다. 반경은 생활SOC 최저기준의 도보 시간을 거리로 바꾼 값입니다(경로당 500m, 도서관·돌봄 1km).</li>
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
