# 공공 활용: 동네 유형(K-means) + 생활시설 결손(도보권 공급 / 대상 인구) → work/public.csv, work/dong_types.csv, work/facilities.json
import sys, os, json, re
import numpy as np, pandas as pd
from sklearn.neighbors import BallTree
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
sys.stdout.reconfigure(encoding='utf-8')
rng = np.random.default_rng(0)

# ---------- 1. 도로명주소 → 좌표 사전 (상가정보 2026-09 + 인허가 전 업종 도로명주소) ----------
sb = pd.read_csv(os.path.join(D, '소진공_상가정보_202609_대구.csv'), encoding='utf-8-sig', usecols=['도로명주소', '경도', '위도'], dtype=str)
sb['k'] = sb['도로명주소'].map(norm_road); sb[['lon', 'lat']] = sb[['경도', '위도']].astype(float)
geo = sb[sb.k != ''].groupby('k')[['lon', 'lat']].median()
ld = pd.read_pickle(os.path.join(W, 'localdata.pkl')) if os.path.exists(os.path.join(W, 'localdata.pkl')) else load_localdata()
ld['k'] = ld['도로명주소'].map(norm_road)
lon, lat = T_5174_TO_WGS.transform(ld.x.values, ld.y.values); ld['lon'] = lon; ld['lat'] = lat
geo = pd.concat([geo, ld[ld.k != ''].groupby('k')[['lon', 'lat']].median()])
geo = geo[~geo.index.duplicated()]
road = pd.DataFrame({'k': geo.index, 'lon': geo.lon.values, 'lat': geo.lat.values})
road['road'] = road.k.str.extract(r'^(\S+ \S+) ')[0]; road['num'] = road.k.str.extract(r' (\d+)(?:-\d+)?$')[0].astype(float)
road_groups = {r: g.sort_values('num') for r, g in road.groupby('road')}
print('도로명 좌표 사전', len(geo))


def geocode(addr):
    k = norm_road(addr)
    if not k: return None, 'none'
    if k in geo.index: r = geo.loc[k]; return (r.lon, r.lat), 'exact'
    m = re.match(r'^(\S+ \S+) (\d+)', k)
    if m and m.group(1) in road_groups:   # 같은 도로 가장 가까운 번지
        g = road_groups[m.group(1)]; i = (g.num - int(m.group(2))).abs().idxmin()
        if abs(g.num[i] - int(m.group(2))) <= 30: return (g.lon[i], g.lat[i]), 'near'
    return None, 'none'


# ---------- 2. 생활시설 ----------
fac = []
kl = pd.read_csv(os.path.join(D, '대구광역시_경로당_20260630__대구광역시_경로당_2606.csv'), encoding='utf-8-sig')
std = pd.read_csv(os.path.join(D, '전국마을회관및경로당표준데이터_대구.csv'), encoding='utf-8-sig')
std = std[std['시설유형'].fillna('').str.contains('경로당')].drop_duplicates('시설명')
stdmap = std.set_index('시설명')[['경도', '위도']]
how = {'exact': 0, 'near': 0, 'std': 0, 'none': 0}
for _, r in kl.iterrows():
    nm = r['시설명칭']
    if nm in stdmap.index and pd.notna(stdmap.loc[nm, '경도']):
        fac.append(('senior', nm, float(stdmap.loc[nm, '경도']), float(stdmap.loc[nm, '위도']))); how['std'] += 1; continue
    p, h = geocode(f"{r['시군구']} " + re.sub(r'^\S+[구군]\s*', '', str(r['시설 주소'])))
    how[h] += 1
    if p: fac.append(('senior', nm, p[0], p[1]))
print('경로당', len(kl), '좌표 붙임', how)
lib = pd.read_csv(os.path.join(D, '전국도서관표준데이터_대구.csv'), encoding='utf-8-sig')
for _, r in lib.dropna(subset=['위도']).iterrows(): fac.append(('library', r['도서관명'], r['경도'], r['위도']))
ac = pd.read_csv(os.path.join(D, '전국지역아동센터표준데이터_대구.csv'), encoding='utf-8-sig')
for _, r in ac.dropna(subset=['위도']).iterrows(): fac.append(('childcare', r['센터명'], r['경도'], r['위도']))
dh = pd.read_csv(os.path.join(D, '대구광역시_다함께돌봄센터 현황_20261001.csv'), encoding='utf-8-sig')
nd = 0
for _, r in dh.iterrows():
    p, h = geocode(r['주소'])
    if p: fac.append(('childcare', r['시설명'], p[0], p[1])); nd += 1
print('다함께돌봄', len(dh), '좌표', nd)
# 공동작업 공간 공급: 공공시설 개방(회의실·강의실·다목적실) + 창업 지원기관·창업보육센터
op_ = pd.read_csv(os.path.join(D, '전국공공시설개방정보표준데이터_대구.csv'), encoding='utf-8-sig')
op_ = op_[op_['개방시설유형구분'].isin(['회의실', '강의실', '다목적실'])].dropna(subset=['위도']).drop_duplicates(['개방장소명'])
for _, r in op_.iterrows(): fac.append(('cowork', f"{r['개방장소명']}({r['개방시설유형구분']})", r['경도'], r['위도']))
nc = 0
for f_ in ['대구광역시_창업관련 지원기관 현황_20260923.csv']:
    cs = pd.read_csv(os.path.join(D, f_), encoding='utf-8-sig')
    for _, r in cs.iterrows():
        p, h = geocode(str(r['주소']).replace('대구 ', '대구광역시 '))
        if p: fac.append(('cowork', r['기관명'], p[0], p[1])); nc += 1
print('공동작업 공급: 공공 개방 회의·강의실', len(op_), '창업 지원기관', nc)
F = pd.DataFrame(fac, columns=['kind', 'name', 'lon', 'lat'])
F = F[(F.lat > 35.5) & (F.lat < 36.4) & (F.lon > 128.3) & (F.lon < 129.0)]
print(F.kind.value_counts().to_dict())
json.dump({k: g[['name', 'lon', 'lat']].round(6).values.tolist() for k, g in F.groupby('kind')}, open(os.path.join(S, 'facilities.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

# ---------- 3. 동네 유형 (행정동 150개, K-means) ----------
dong = pd.read_csv(os.path.join(W, 'dong.csv'), dtype={'code': str})
X = dong[['r_age65p', 'r_age20_39', 'r_age0_4', 'r_hh1', 'r_apt']].copy(); X['logd'] = np.log1p(dong.density)
Z = StandardScaler().fit_transform(X.fillna(X.median()))
from sklearn.metrics import silhouette_score
for k in [4, 5, 6, 7]:
    print('K', k, 'silhouette', round(silhouette_score(Z, KMeans(k, n_init=20, random_state=0).fit(Z).labels_), 3))
# K=4가 실루엣은 가장 높지만 '고령 1인 가구형'과 '청년 1인 가구형'이 섞여 시설 처방이 갈리지 않음 → 해석 가능한 K=6 사용
K = 6
km = KMeans(K, n_init=20, random_state=0).fit(Z); dong['cluster'] = km.labels_
cen = dong.groupby('cluster')[['r_age65p', 'r_age20_39', 'r_age0_4', 'r_hh1', 'r_apt', 'density']].mean()
names = {}
left = list(cen.index)
def take(c, n): names[c] = n; left.remove(c)
take(cen.loc[left].density.idxmin(), '교외·농촌 고령형')
take(cen.loc[left].r_age20_39.idxmax(), '청년 1인 가구형')
take(cen.loc[left].r_age0_4.idxmax(), '영유아 신축 아파트형')
take(cen.loc[left].r_age65p.idxmax(), '고령 1인·노후 주택형')
take(cen.loc[left].r_apt.idxmax(), '아파트 가족형')
for c in list(left): take(c, '중장년 혼합 주거형')
dong['dtype'] = dong.cluster.map(names)
print(dong.groupby('dtype')[['r_age65p', 'r_age20_39', 'r_age0_4', 'r_hh1', 'r_apt', 'density']].mean().round(3).assign(n=dong.groupby('dtype').size()).to_string())
dong.to_csv(os.path.join(W, 'dong_types.csv'), index=False, encoding='utf-8-sig')

# ---------- 4. 빈 점포별 결손 ----------
# 생활SOC 최저기준(도보): 경로당 5~10분 -> 500m, 도서관 10~15분 -> 1km, 아동 돌봄 -> 1km(초등 도보권 가정)
SPEC = {
    'senior': dict(name='동네 사랑방(경로당·쉼터)', r=500, target='age65p', op='구청 임차 + 대한노인회 구지회·종합사회복지관 위탁'),
    'library': dict(name='작은도서관·열람실', r=1000, target='pop', op='구청 임차 + 작은도서관 운영 단체·주민자치회 위탁'),
    'childcare': dict(name='초등 돌봄센터', r=1000, target='age5_14', op='구청 임차 + 다함께돌봄센터 위탁 기관'),
    'cowork': dict(name='청년 공동작업 공간', r=1000, target='age20_39', op='구청 임차 + 청년센터·창업 지원기관 위탁'),
}
v = pd.read_csv(os.path.join(W, 'vacant.csv'), encoding='utf-8-sig', dtype={'dong_code': str})
dg = dong.set_index('code')
vx, vy = T_WGS_TO_5174.transform(v.lon.values, v.lat.values); VP = np.c_[vx, vy]
res = pd.DataFrame({'id': v.id})
for kind, sp in SPEC.items():
    g = F[F.kind == kind]; fx, fy = T_WGS_TO_5174.transform(g.lon.values, g.lat.values)
    t = BallTree(np.c_[fx, fy])
    cnt = np.array([len(i) for i in t.query_radius(VP, r=sp['r'])])
    dist, _ = t.query(VP, k=1); dist = dist[:, 0]
    # 반경 안 대상 인구(행정동 대상 인구 밀도 × 원 면적, 반경 넘는 동은 근사)
    dens = (dg.loc[v.dong_code, sp['target']].values / dg.loc[v.dong_code, 'area_km2'].values)
    tpop = dens * np.pi * (sp['r'] / 1000) ** 2
    city_rate = len(g) / dong[sp['target']].sum() * 1000  # 대구 평균: 대상 1천 명당 시설 수
    local_rate = cnt / np.maximum(tpop, 1) * 1000
    ratio = local_rate / city_rate
    # 결손 점수: 공급 부족(대구 평균 대비) × 수요 크기(대상 인구가 많을수록) + 최저기준 거리 초과
    short = np.clip(1 - ratio, 0, 1)
    demand = np.clip(np.log1p(tpop) / np.log1p(np.percentile(tpop, 90)), 0, 1)
    over = np.clip((dist - sp['r']) / sp['r'], 0, 1)
    score = 100 * (0.5 * short * demand + 0.3 * over * demand + 0.2 * demand * (short > 0))
    res[f'{kind}_score'] = score.round(1); res[f'{kind}_n'] = cnt; res[f'{kind}_dist'] = dist.round(0)
    res[f'{kind}_tpop'] = tpop.round(0); res[f'{kind}_ratio'] = ratio.round(2)
    print(kind, '대구 평균(대상 1천 명당)', round(city_rate, 2), '결손 점수 분포', np.percentile(score, [25, 50, 75, 90]).round(1))
res = res.merge(v[['id', 'dong_code']], on='id').merge(dong[['code', 'dtype']].rename(columns={'code': 'dong_code'}), on='dong_code', how='left')
res.to_csv(os.path.join(W, 'public.csv'), index=False, encoding='utf-8-sig')
json.dump({k: {kk: vv for kk, vv in s.items()} for k, s in SPEC.items()}, open(os.path.join(W, 'public_spec.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('완료', len(res))
