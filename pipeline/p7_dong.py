# 4판 데이터: 동네 카드(dong_detail.json), 동네에 모자란·넘치는 업종, 구청용 우선순위 목록(priority.json)
# 모자란 업종 = 같은 동네 유형(K-평균 6개)끼리 묶어, 주민 1천 명당 업소 수를 그 유형 전체 비율과 비교
import sys, os, json
import numpy as np, pandas as pd
import shapely
from shapely.geometry import shape
from shapely.strtree import STRtree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
sys.stdout.reconfigure(encoding='utf-8')

dong = pd.read_csv(os.path.join(W, 'dong_types.csv'), dtype={'code': str})
gj = json.load(open(os.path.join(S, 'dong.geojson'), encoding='utf-8'))
polys = [shape(f['geometry']) for f in gj['features']]; dcodes = np.array([f['properties']['code'] for f in gj['features']])
tree = STRtree(polys)

# ---------- 1. 동별 업종 수 (상가정보 2026-09, 생활 업종만) ----------
sb = pd.read_csv(os.path.join(D, '소진공_상가정보_202609_대구.csv'), encoding='utf-8-sig',
                 usecols=['상권업종대분류명', '상권업종소분류명', '시군구명', '경도', '위도'], dtype=str)
sb = sb[sb['상권업종대분류명'].isin(['음식', '소매', '수리·개인', '예술·스포츠', '교육', '보건의료'])]
sb = sb[~sb['상권업종소분류명'].str.contains('자동차|주유|이륜', na=False)]  # 빈 점포 한 칸에 맞지 않는 업종 제외
sb[['lon', 'lat']] = sb[['경도', '위도']].astype(float)
pts = shapely.points(sb.lon.values, sb.lat.values); res = np.full(len(pts), -1)
ii, jj = tree.query(pts, predicate='intersects'); res[ii] = jj
sb = sb[res >= 0].assign(code=dcodes[res[res >= 0]])
gu_of = sb.groupby('code')['시군구명'].agg(lambda s: s.mode().iat[0]).to_dict()
cnt = sb.groupby(['code', '상권업종소분류명']).size().unstack(fill_value=0)
cnt = cnt.reindex(dong.code, fill_value=0)
pop = dong.set_index('code')['pop']
# 유형 전체 비율(1천 명당): 그 유형 동들의 업소 합 ÷ 인구 합
dt = dong.set_index('code')['dtype']
pooled = cnt.groupby(dt).sum().div(pop.groupby(dt).sum(), axis=0) * 1000
short, over = {}, {}
for c in dong.code:
    t = dt[c]; p = pop[c]
    exp = pooled.loc[t] * p / 1000; act = cnt.loc[c]
    ratio = (act / exp.replace(0, np.nan))
    s = pd.DataFrame({'act': act, 'exp': exp, 'ratio': ratio}).dropna()
    sh = s[(s.exp >= 3) & (s.ratio <= 0.5)].assign(gap=lambda x: x.exp - x.act).sort_values('gap', ascending=False).head(6)
    ov = s[(s.act >= 5) & (s.ratio >= 2)].sort_values('ratio', ascending=False).head(4)
    short[c] = [[k, round(r.ratio, 2), int(r.act), round(r.exp, 1)] for k, r in sh.iterrows()]
    over[c] = [[k, round(r.ratio, 1), int(r.act), round(r.exp, 1)] for k, r in ov.iterrows()]
print('모자란 업종이 1개 이상인 동', sum(1 for v in short.values() if v), '/', len(short))

# ---------- 2. 빈 점포·판정·우선순위 ----------
v = pd.read_csv(os.path.join(W, 'vacant.csv'), encoding='utf-8-sig', dtype={'dong_code': str})
pub = pd.read_csv(os.path.join(W, 'public.csv'), encoding='utf-8-sig', dtype={'dong_code': str}).set_index('id')
P = pd.read_pickle(os.path.join(W, 'vacant_pred.pkl'))
meta = json.load(open(os.path.join(S, 'meta.json'), encoding='utf-8'))
stores = json.load(open(os.path.join(S, 'stores.json'), encoding='utf-8'))
verdict = {s[0]: s[4] for s in stores}
pk = list(meta['public'].keys())
use = [t for t, x in meta['types'].items() if x['rel'] != 'none']
v['verdict'] = v.id.map(verdict)
v['addr'] = v['도로명주소'].fillna(v['지번주소'])
best = P[P.type.isin(use)].sort_values('ratio', ascending=False).drop_duplicates('id').set_index('id')
v['btype'] = v.id.map(best.type); v['bp'] = v.id.map(best.p); v['bratio'] = v.id.map(best.ratio)
sc = pub[[f'{k}_score' for k in pk]]
v['pkind'] = v.id.map(sc.idxmax(axis=1).str.replace('_score', '')); v['pscore'] = v.id.map(sc.max(axis=1))
v['ptpop'] = [pub.at[i, f'{k}_tpop'] for i, k in zip(v.id, v.pkind)]
v['dname'] = v.dong_code.map(dong.set_index('code')['name'])
v['fl_'] = v.fl.fillna('')
v['n_same'] = v.groupby(['addr', 'fl_']).id.transform('size')   # 같은 건물·층의 빈 칸 수
pubs = v[v.verdict == 1].sort_values(['pscore', 'ptpop'], ascending=False).drop_duplicates(['addr', 'fl_'])
bizs = v[v.verdict == 0].sort_values(['bratio', 'bp'], ascending=False).drop_duplicates(['addr', 'fl_'])
row_p = lambda r: [r.id, r['시군구명'], r.dname, r.addr, r.fl_, r.pkind, round(r.pscore, 1), int(r.ptpop), int(r.n_same)]
row_b = lambda r: [r.id, r['시군구명'], r.dname, r.addr, r.fl_, r.btype, round(r.bp, 3), round(r.bratio, 2), int(r.n_same)]
# 구별 상위 30곳씩(전체 목록은 구 필터로 고름)
prio = {'public': [row_p(r) for _, g in pubs.groupby('시군구명') for _, r in g.head(30).iterrows()],
        'biz': [row_b(r) for _, g in bizs.groupby('시군구명') for _, r in g.head(30).iterrows()]}
json.dump(prio, open(os.path.join(S, 'priority.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

# ---------- 3. 동네 카드 ----------
det = {}
for _, d in dong.iterrows():
    c = d.code; g = v[v.dong_code == c]
    fac = {k: round(float(pub.loc[g.id, f'{k}_score'].mean()), 1) if len(g) else None for k in pk}
    det[c] = {
        'name': d['name'], 'gu': gu_of.get(c, ''), 'dtype': d['dtype'], 'pop': int(d['pop']),
        'r65': round(d.r_age65p, 3), 'r2039': round(d.r_age20_39, 3), 'r04': round(d.r_age0_4, 3), 'rhh1': round(d.r_hh1, 3), 'rapt': round(d.r_apt, 3),
        'n': int(len(g)), 'v': [int((g.verdict == k).sum()) for k in (0, 1, 2)], 'fac': fac,
        'short': short[c], 'over': over[c],
        'top_pub': [row_p(r) for _, r in pubs[pubs.dong_code == c].head(5).iterrows()],
        'top_biz': [row_b(r) for _, r in bizs[bizs.dong_code == c].head(5).iterrows()],
    }
json.dump(det, open(os.path.join(S, 'dong_detail.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
for f in ['priority.json', 'dong_detail.json']: print(f, os.path.getsize(os.path.join(S, f)))
ex = det[dong[dong['name'] == '대명9동'].code.iat[0]] if (dong['name'] == '대명9동').any() else next(iter(det.values()))
print(json.dumps({k: ex[k] for k in ['name', 'gu', 'dtype', 'n', 'v', 'fac', 'short', 'over']}, ensure_ascii=False))
# 점포 → 행정동 코드(4판 카드에서 동네 카드로 연결)
json.dump(dict(zip(v.id, v.dong_code)), open(os.path.join(S, 'store_dong.json'), 'w', encoding='utf-8'), separators=(',', ':'))
