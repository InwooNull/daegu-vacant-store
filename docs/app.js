/* 빈 점포 한 칸 — 지도·카드
   데이터: data/stores.json(점), data/cards/<구>.json(카드), data/meta.json(업종·정확도·규칙), data/dong.geojson, data/dong_summary.json, data/facilities.json
   팀원 모델로 바꿀 때는 같은 형식의 JSON만 덮어쓰면 됩니다(DATA_FORMAT.md). 서버 API로 바꿀 때는 loadJSON 한 곳만 고치면 됩니다. */
(function () {
  'use strict';
  const VERDICT = ['biz', 'public', 'hold'];
  const VERDICT_NAME = { biz: '창업 연계', public: '공공 활용', hold: '보류' };
  const COLOR = { biz: '#2f5fd0', public: '#1f8a5b', hold: '#9aa1ad' };
  const REL_NAME = { ok: '예측 근거 있음', weak: '예측력 약함', none: '참고용 · 예측력 낮음' };
  const DTYPE_COLOR = {
    '고령 1인·노후 주택형': '#d9822b', '교외·농촌 고령형': '#a5794f', '중장년 혼합 주거형': '#c9b458',
    '아파트 가족형': '#7aa6c2', '영유아 신축 아파트형': '#5e9c86', '청년 1인 가구형': '#9a7fc1'
  };
  const FAC_STYLE = { senior: '#d9822b', library: '#7b5ea7', childcare: '#0f8b8d' };

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => n.toLocaleString('ko-KR');
  const pct = (x) => Math.round(x * 100) + '%';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DATA_BASE = 'data/';
  async function loadJSON(path) {
    const r = await fetch(DATA_BASE + path);
    if (!r.ok) throw new Error(path + ' 불러오기 실패 (' + r.status + ')');
    return r.json();
  }

  let meta, stores, typeKeys, map, renderer, markers = [], dongLayer, facLayers = {}, facData;
  const cardCache = {};
  const state = { verdicts: new Set([0, 1, 2]), gu: '', type: '' };

  // 업종 확률 색: 회색 → 파랑 (한 색상 계열)
  const SEQ = ['#d7dbe2', '#b6c6ea', '#7f9ee0', '#2f5fd0', '#18307a'];
  function seqColor(v, lo, hi) {
    const t = Math.max(0, Math.min(1, (v - lo) / Math.max(1, hi - lo)));
    return SEQ[Math.min(SEQ.length - 1, Math.floor(t * SEQ.length))];
  }

  async function init() {
    map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([35.8714, 128.6014], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자'
    }).addTo(map);
    renderer = L.canvas({ padding: 0.3 });
    try {
      [meta, stores] = await Promise.all([loadJSON('meta.json'), loadJSON('stores.json')]);
    } catch (e) {
      $('#loading').textContent = '데이터를 불러오지 못했습니다. 새로고침해 주세요. (' + e.message + ')';
      return;
    }
    typeKeys = Object.keys(meta.types);
    buildControls();
    drawMarkers();
    renderCounts();
    $('#loading').hidden = true;
    buildMethod();
  }

  function buildControls() {
    const gus = [...new Set(stores.map((s) => s[3]))].sort();
    const gs = $('#guSelect');
    gus.forEach((g) => gs.insertAdjacentHTML('beforeend', `<option value="${esc(g)}">${esc(g)}</option>`));
    gs.addEventListener('change', () => { state.gu = gs.value; drawMarkers(); renderCounts(); fitGu(); });

    const ts = $('#typeSelect');
    const order = { ok: 0, weak: 1, none: 2 };
    typeKeys.slice().sort((a, b) => order[meta.types[a].rel] - order[meta.types[b].rel])
      .forEach((t) => {
        const ty = meta.types[t];
        ts.insertAdjacentHTML('beforeend', `<option value="${t}">${esc(ty.name)}${ty.rel === 'none' ? ' (참고용)' : ty.rel === 'weak' ? ' (예측력 약함)' : ''}</option>`);
      });
    ts.addEventListener('change', () => {
      state.type = ts.value;
      $('#seqLegend').hidden = !state.type;
      const w = $('#typeWarn');
      if (state.type && meta.types[state.type].rel !== 'ok') {
        const ty = meta.types[state.type];
        w.hidden = false;
        w.textContent = ty.auc == null
          ? `${ty.name}은 시험할 개업 건수가 적어 정확도를 재지 못했습니다. 참고로만 보세요.`
          : `${ty.name}은 과거 데이터로 시험했을 때 가려내는 힘이 약했습니다(AUC ${ty.auc}). 참고로만 보세요.`;
      } else w.hidden = true;
      drawMarkers();
    });

    $('#verdictChips').addEventListener('change', (e) => {
      const v = +e.target.value;
      e.target.checked ? state.verdicts.add(v) : state.verdicts.delete(v);
      drawMarkers(); renderCounts();
    });
    $('#layerDong').addEventListener('change', (e) => toggleDong(e.target.checked));
    [['layerSenior', 'senior'], ['layerLibrary', 'library'], ['layerChild', 'childcare']].forEach(([id, k]) =>
      $('#' + id).addEventListener('change', (e) => toggleFac(k, e.target.checked)));
    $('#closeCard').addEventListener('click', closeCard);
    $('#openMethod').addEventListener('click', () => $('#method').showModal());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#card').hidden) closeCard(); });
  }

  function visible(s) { return state.verdicts.has(s[4]) && (!state.gu || s[3] === state.gu); }

  function drawMarkers() {
    markers.forEach((m) => m.remove()); markers = [];
    const ti = state.type ? typeKeys.indexOf(state.type) : -1;
    let lo = 0, hi = 100;
    if (ti >= 0) { // 이 업종 확률의 5~95% 구간으로 색 범위
      const vals = stores.filter(visible).map((s) => s[5][ti]).sort((a, b) => a - b);
      lo = vals[Math.floor(vals.length * 0.05)] || 0; hi = vals[Math.floor(vals.length * 0.95)] || 100;
    }
    const z = map.getZoom();
    const r = z >= 15 ? 5 : z >= 13 ? 3.5 : 2.5;
    for (const s of stores) {
      if (!visible(s)) continue;
      const col = ti >= 0 ? seqColor(s[5][ti], lo, hi) : COLOR[VERDICT[s[4]]];
      const m = L.circleMarker([s[1], s[2]], { renderer, radius: r, stroke: true, color: '#ffffff', weight: 0.8, fillColor: col, fillOpacity: 0.9 });
      m.on('click', () => openCard(s));
      if (ti >= 0) m.bindTooltip(`${meta.types[state.type].name} ${s[5][ti]}%`, { className: 'tip', direction: 'top' });
      m.addTo(map); markers.push(m);
    }
  }
  let lastZoomBand = null;
  function zoomBand() { const z = map.getZoom(); return z >= 15 ? 2 : z >= 13 ? 1 : 0; }
  function onZoom() { const b = zoomBand(); if (b !== lastZoomBand) { lastZoomBand = b; if (markers.length) drawMarkers(); } }

  function fitGu() {
    const pts = stores.filter(visible).map((s) => [s[1], s[2]]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
  }

  function renderCounts() {
    const inGu = stores.filter((s) => !state.gu || s[3] === state.gu);
    const c = [0, 0, 0]; inGu.forEach((s) => c[s[4]]++);
    $('#counts').innerHTML = `
      <div class="count all"><b>${fmt(inGu.length)}</b><span>${state.gu ? esc(state.gu) : '대구'} 빈 점포(추정)</span></div>
      <div class="count biz"><b>${fmt(c[0])}</b><span>창업 연계</span></div>
      <div class="count public"><b>${fmt(c[1])}</b><span>공공 활용</span></div>
      <div class="count hold"><b>${fmt(c[2])}</b><span>보류</span></div>`;
  }

  async function toggleDong(on) {
    if (!on) { if (dongLayer) dongLayer.remove(); $('#dtypeLegend').hidden = true; return; }
    if (!dongLayer) {
      const [gj, sm] = await Promise.all([loadJSON('dong.geojson'), loadJSON('dong_summary.json')]);
      const by = Object.fromEntries(sm.map((d) => [d.code, d]));
      dongLayer = L.geoJSON(gj, {
        style: (f) => ({ color: '#ffffff', weight: 1, fillColor: DTYPE_COLOR[(by[f.properties.code] || {}).dtype] || '#ccc', fillOpacity: 0.32 }),
        onEachFeature: (f, l) => {
          const d = by[f.properties.code]; if (!d) return;
          l.bindTooltip(`<b>${esc(d.name)}</b> · ${esc(d.dtype)}<br>65세 이상 ${pct(d.r65)} · 20~39세 ${pct(d.r2039)} · 1인 가구 ${pct(d.rhh1)}<br>빈 점포(추정) ${fmt(d.n)}곳`, { className: 'tip', sticky: true });
        }
      });
      $('#dtypeLegend').innerHTML = Object.entries(DTYPE_COLOR).map(([k, c]) => `<div><i style="background:${c}"></i>${k} (${meta.dtypes[k] || 0}개 동)</div>`).join('');
    }
    dongLayer.addTo(map); dongLayer.bringToBack(); $('#dtypeLegend').hidden = false;
  }

  async function toggleFac(k, on) {
    if (!facData) facData = await loadJSON('facilities.json');
    if (!on) { if (facLayers[k]) facLayers[k].remove(); return; }
    if (!facLayers[k]) {
      facLayers[k] = L.layerGroup((facData[k] || []).map(([nm, lon, lat]) =>
        L.circleMarker([lat, lon], { renderer, radius: 4, color: FAC_STYLE[k], weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(nm), { className: 'tip' })));
    }
    facLayers[k].addTo(map);
  }

  let selected;
  async function openCard(s) {
    if (selected) selected.remove();
    selected = L.circleMarker([s[1], s[2]], { renderer, radius: 9, color: '#1d2330', weight: 2.5, fill: false }).addTo(map);
    const body = $('#cardBody');
    $('#card').hidden = false; body.innerHTML = '<p class="meta">불러오는 중</p>';
    try {
      if (!cardCache[s[3]]) cardCache[s[3]] = await loadJSON('cards/' + encodeURIComponent(s[3]) + '.json');
    } catch (e) { body.innerHTML = '<p class="meta">카드를 불러오지 못했습니다. 다시 눌러 주세요.</p>'; return; }
    const c = cardCache[s[3]][s[0]];
    body.innerHTML = cardHTML(s[0], c);
    const more = body.querySelector('.more');
    if (more) more.addEventListener('click', () => { body.querySelector('.bars.rest').hidden = false; more.remove(); });
    setTimeout(() => map.invalidateSize(), 0);
  }
  function closeCard() { $('#card').hidden = true; if (selected) { selected.remove(); selected = null; } setTimeout(() => map.invalidateSize(), 0); }

  function verdictSentence(c) {
    const R = meta.rules;
    if (c.v === 'biz') {
      const t = meta.types[c.top]; const p = c.biz.find((b) => b[0] === c.top)[1];
      return `<b>${esc(t.name)}</b>을(를) 열면 3년 버틸 확률이 <b>${pct(p)}</b>로, 대구 최근 평균 ${t.avg}%보다 높습니다. 민간 창업으로 연결할 후보입니다.`;
    }
    if (c.v === 'public') {
      const k = c.pub[0][0];
      return `예측력이 있는 업종 중 대구 평균보다 확실히 나은 업종이 없고, 주변에 <b>${esc(meta.public[k].name)}</b>이(가) 모자랍니다. 구청 임차로 공공 활용을 검토할 후보입니다.`;
    }
    const why = [];
    if (!(c.fl === '' || /^(1|2)$/.test(c.fl))) why.push('층이 높거나 지하라 생활시설 접근성이 떨어집니다');
    return `창업·공공 어느 쪽도 기준(창업: 3년 버틸 확률 ${Math.round(R.biz_p * 100)}% 이상이면서 대구 평균의 ${R.biz_ratio}배 이상 / 공공: 결손 점수 ${R.pub_score}점 이상)을 넘지 못했습니다.${why.length ? ' ' + why.join(', ') + '.' : ''} 임시 활용이나 시장 회복을 지켜볼 자리입니다.`;
  }

  function bar(b) {
    const t = meta.types[b[0]]; const cls = t.rel === 'none' ? 'none' : '';
    return `<div class="bar ${cls}"><span class="nm" title="${esc(t.name)}">${esc(t.name)}</span>
      <span class="track"><span class="fill" style="width:${Math.round(b[1] * 100)}%"></span><span class="avg" style="left:${t.avg}%" title="대구 최근 평균 ${t.avg}%"></span></span>
      <span class="val">${pct(b[1])}</span></div>`;
  }

  function cardHTML(id, c) {
    const usable = c.biz.filter((b) => meta.types[b[0]].rel !== 'none');
    const rest = c.biz.filter((b) => meta.types[b[0]].rel === 'none');
    const floor = c.fl ? `${esc(c.fl)}층` : '층 정보 없음';
    const pubs = c.pub.map((p, i) => {
      const sp = meta.public[p[0]]; const zero = p[1] <= 0;
      return `<div class="pub ${i === 0 && c.v === 'public' ? 'top' : ''}">
        <div class="row"><b>${esc(sp.name)}</b><span class="score ${zero ? 'zero' : ''}">${zero ? '충분' : '결손 ' + Math.round(p[1]) + '점'}</span></div>
        <p>도보 ${sp.r >= 1000 ? sp.r / 1000 + 'km' : sp.r + 'm'} 안 ${p[2]}곳 · 가장 가까운 곳 ${p[3] >= 1000 ? (p[3] / 1000).toFixed(1) + 'km' : p[3] + 'm'} · 대상 인구 약 ${fmt(p[4])}명 · 대구 평균 대비 ${p[5] >= 10 ? '10배 이상' : p[5].toFixed(1) + '배'}</p>
        ${i === 0 && !zero ? `<p class="op">운영 구조(제안): ${esc(sp.op)}</p>` : ''}</div>`;
    }).join('');
    return `
      <span class="verdict ${c.v}">${VERDICT_NAME[c.v]}</span>
      <h3 class="addr">${esc(c.addr)}${c.bld ? ' · ' + esc(c.bld) : ''}</h3>
      <p class="meta">${esc(c.gu)} ${esc(c.dong)} · ${floor} · 동네 유형 <b>${esc(c.dtype)}</b></p>
      <p class="meta">마지막 업소: ${esc(c.prev)} · ${String(c.seen).slice(0, 4)}년 ${+String(c.seen).slice(4)}월 상가정보까지 확인
        ${c.permit ? '<span class="badge ok">같은 지번 인허가 폐업 확인</span>' : '<span class="badge warn">현장 확인 필요</span>'}</p>
      <p class="why-v">${verdictSentence(c)}</p>

      <section class="sec">
        <h4>가게를 연다면 <small>3년 뒤에도 영업 중일 확률</small></h4>
        <p class="lead">세로선은 그 업종의 대구 최근 평균(2021~2023년 개업)입니다.</p>
        <div class="bars">${usable.map(bar).join('')}</div>
        ${c.why.length ? `<ul class="why">${c.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <button class="more" type="button">참고용 업종 ${rest.length}개 더 보기</button>
        <div class="bars rest" hidden style="margin-top:10px">${rest.map(bar).join('')}
          <p class="lead" style="margin:4px 0 0">회색은 과거 데이터로 시험했을 때 가려내는 힘이 약했던 업종입니다. 판정에 쓰지 않았습니다.</p></div>
      </section>

      <section class="sec">
        <h4>주민에게 모자란 시설 <small>생활SOC 도보 기준</small></h4>
        <p class="lead">반경 안 시설 수를 대상 인구로 나눠 대구 평균과 비교했습니다.</p>
        ${pubs}
      </section>
      <p class="note">자리 ${esc(id)} · 판정은 참고 자료이고 최종 결정은 구청 담당자가 합니다. 확률은 인허가 개업·폐업 기록으로 학습한 값이며 매출을 뜻하지 않습니다.</p>`;
  }

  function buildMethod() {
    const m = meta.model;
    const rows = typeKeys.map((t) => {
      const x = meta.types[t];
      return `<tr><td>${esc(x.name)}</td><td>${REL_NAME[x.rel]}</td><td class="num">${x.auc ?? '—'}</td><td class="num">${x.auc_base ?? '—'}</td><td class="num">${x.bottom20 ?? '—'}% → ${x.top20 ?? '—'}%</td><td class="num">${x.avg}%</td><td class="num">${x.n_test ? fmt(x.n_test) : '—'}</td></tr>`;
    }).join('');
    const vc = meta.verdict_counts;
    $('#methodBody').innerHTML = `
      <h2>계산 방법과 정확도</h2>
      <p>모든 숫자는 공개 데이터로 직접 계산했습니다. 계산 시각 ${esc(meta.generated)}.</p>

      <h3>1. 빈 점포(추정) ${fmt(meta.n_stores)}곳</h3>
      <ul>
        <li>소상공인시장진흥공단 상가정보 분기 파일(2025년 10월~2026년 6월)에 있었는데 2026년 9월 파일에서 사라진 업소의 자리입니다.</li>
        <li>같은 건물·같은 층에 새 업소가 들어와 업소 수가 줄지 않았으면 빼고, 같은 상호·업종이 같은 구에 다시 보이면 이전한 것으로 보고 뺐습니다.</li>
        <li>그중 ${fmt(meta.permit_confirmed)}곳은 같은 지번에 2025년 7월 이후 인허가 폐업 기록이 있습니다. 나머지는 현장·건축물대장 확인이 필요합니다.</li>
      </ul>

      <h3>2. 가게를 연다면 — 3년 생존 확률</h3>
      <ul>
        <li>행정안전부 지방행정 인허가 15개 업종의 개업·폐업일로, 2015년~2023년 10월에 문 연 가게가 3년 뒤에도 영업 중이었는지를 학습했습니다(그래디언트 부스팅, LightGBM). 행사·팝업처럼 같은 지번에 한 달 새 개업이 몰린 기록은 뺐습니다.</li>
        <li>자리 정보: 반경 100·300·500m의 같은 업종·전체 업소 수, 최근 1년 개업·폐업, 같은 업종의 과거 3년 생존율, 같은 지번의 과거 폐업 횟수, 버스 정류소·노선 수, 행정동 인구 구성(SGIS 2024).</li>
        <li><b>검증:</b> ${esc(m.split)}. 업종 안에서 가려내는 힘(AUC, 0.5는 동전 던지기)은 평균 ${m.auc_within_type_weighted}로, 구·업종 평균만 쓰는 방식(${m.auc_within_type_baseline})보다 조금 낫습니다. 확률은 2021~2023년 개업의 실제 생존율에 맞춰 보정했습니다.</li>
      </ul>
      <table><thead><tr><th>업종</th><th>판정 사용</th><th class="num">AUC</th><th class="num">기준선</th><th class="num">예측 하위→상위 20% 실제 생존</th><th class="num">대구 평균</th><th class="num">시험 건수</th></tr></thead><tbody>${rows}</tbody></table>
      <p>AUC 0.58 이상이면서 기준선보다 0.03 이상 나은 업종을 '예측 근거 있음', 0.54 이상이면서 기준선보다 나은 업종을 '예측력 약함'으로 두고 이 두 무리만 판정에 썼습니다.</p>

      <h3>3. 주민에게 모자란 시설 — 결손 점수</h3>
      <ul>
        <li>경로당(대구시 목록 + 표준데이터, 주소로 좌표를 붙임), 도서관, 지역아동센터·다함께돌봄센터의 위치를 썼습니다. 반경은 생활SOC 최저기준의 도보 시간을 거리로 바꾼 값입니다(경로당 500m, 도서관·돌봄 1km).</li>
        <li>반경 안 시설 수 ÷ 대상 인구(65세 이상, 전체, 5~14세)를 대구 평균과 비교한 부족분, 최저기준 거리 초과, 대상 인구 크기를 합쳐 0~100점으로 냈습니다.</li>
        <li>학교 돌봄교실, 사설 시설, 표준데이터에 없는 경로당은 빠져 있어 실제보다 결손이 크게 나올 수 있습니다.</li>
      </ul>

      <h3>4. 동네 유형</h3>
      <p>대구 150개 행정동을 65세 이상·20~39세·0~4세 비율, 1인 가구 비율, 아파트 비율, 인구 밀도로 K-평균 군집 6개로 나눴습니다.</p>

      <h3>5. 판정 규칙</h3>
      <ul>
        <li><b>창업 연계 (${fmt(vc.biz || 0)}곳):</b> 판정에 쓰는 업종 중 하나라도 3년 버틸 확률 ${Math.round(meta.rules.biz_p * 100)}% 이상이면서 대구 평균의 ${meta.rules.biz_ratio}배 이상</li>
        <li><b>공공 활용 (${fmt(vc.public || 0)}곳):</b> 창업 기준을 못 넘고, 결손 점수 최고값 ${meta.rules.pub_score}점 이상, 1~2층(또는 층 정보 없음)</li>
        <li><b>보류 (${fmt(vc.hold || 0)}곳):</b> 둘 다 아님</li>
      </ul>

      <h3>데이터</h3>
      <p>소상공인시장진흥공단 상가(상권)정보(2025-10~2026-09), 행정안전부 지방행정 인허가(2026-11-25 내려받음), 국가데이터처 SGIS 행정구역 통계(2024)·행정동 경계(2025-2Q), 대구광역시 경로당(2026-06)·다함께돌봄센터(2026-10)·시내버스 정류소(2026-09), 행정안전부 표준데이터(도서관·경로당·지역아동센터). 모두 공공데이터포털 공개 파일입니다. 개인 단위 정보는 쓰지 않았습니다.</p>`;
  }

  window.addEventListener('DOMContentLoaded', () => {
    init().then(() => { if (map) { lastZoomBand = zoomBand(); map.on('zoomend', onZoom); } });
  });
})();
