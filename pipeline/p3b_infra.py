# 인프라·교통 특징 추가: 지하철(역 위치·이용객), 학교, 공원, 아파트 단지(세대수·준공), 전통시장, 공영·민영 주차장
# 학습 행은 개업 시점 기준으로 그때 있던 것만 셈(지하철 개통·아파트 사용승인·학교 설립·공원 지정·시장 개설 연도)
import sys, os, re, json
import numpy as np, pandas as pd
from sklearn.neighbors import BallTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
sys.stdout.reconfigure(encoding='utf-8')
INF = np.datetime64('1900-01-01')


def xy(lon, lat):
    x, y = T_WGS_TO_5174.transform(np.asarray(lon, float), np.asarray(lat, float)); return np.c_[x, y]


# ---------- 지하철 역: 버스 정류소 이름 '○○역…'의 좌표 중앙값 ----------
sub = pd.read_csv(os.path.join(D, '대구교통공사_역별일별시간별승하차인원현황_20261031.csv'), encoding='utf-8-sig')
daily = sub.groupby(['역번호', '역명', '월', '일'])['일계'].sum().groupby(['역번호', '역명']).mean().reset_index(name='riders')
bus = pd.read_csv(os.path.join(D, '대구광역시_시내버스 정류소 위치정보_20260902.csv'), encoding='utf-8-sig')
sbz = pd.read_csv(os.path.join(D, '소진공_상가정보_202609_대구.csv'), encoding='utf-8-sig', usecols=['상호명', '건물명', '경도', '위도'], dtype=str)
sbz[['경도', '위도']] = sbz[['경도', '위도']].astype(float)
bn = bus['정류소명'].fillna('')
rows = []; how = {}
for _, r in daily.iterrows():
    base = re.sub(r'\d+$', '', r['역명']).removesuffix('역')
    # ① 정류소 이름에 '○○역'(앞에 다른 한글 없음, 예: 도시철도담티역·청라언덕(신남)역) ② 상가 건물명·상호에 '○○역' ③ 정류소 이름이 역 이름으로 시작(3호선 지상역 주변)
    m = bus[bn.str.contains(rf'(?:^|[^가-힣]|도시철도){re.escape(base)}(?:\([^)]*\))?역')]; h = 'bus역'
    if len(m) == 0:
        m = sbz[sbz['건물명'].fillna('').str.contains(base + '역') | sbz['상호명'].fillna('').str.contains(base + '역점')]; h = '상가건물'
    if len(m) == 0:
        m = bus[bn.str.startswith(base)]; h = 'bus이름'
    if len(m) == 0: continue
    how[h] = how.get(h, 0) + 1
    no = int(r['역번호']); line = no // 100
    opened = {1: '1998-05-02', 2: '2005-10-18', 3: '2015-04-23'}.get(line, '2005-10-18')
    if line == 1 and no >= 145: opened = '2024-12-28'   # 안심~하양 연장
    if line == 2 and base in ('사월', '정평', '임당', '영남대'): opened = '2012-09-19'
    rows.append({'station': r['역명'], 'line': line, 'lon': m['경도'].median(), 'lat': m['위도'].median(), 'riders': r.riders, 'opened': pd.Timestamp(opened)})
st = pd.DataFrame(rows).drop_duplicates('station')
print('지하철역 좌표', len(st), '/', len(daily), '역', how, '없음:', sorted(set(daily['역명']) - set(st.station)))
st.to_csv(os.path.join(W, 'subway_stations.csv'), index=False, encoding='utf-8-sig')

# ---------- 지번 → 좌표 사전(아파트 단지 위치용) ----------
sb = pd.read_csv(os.path.join(D, '소진공_상가정보_202609_대구.csv'), encoding='utf-8-sig', usecols=['지번주소', '경도', '위도'], dtype=str)
sb['k'] = sb['지번주소'].map(norm_addr); sb[['lon', 'lat']] = sb[['경도', '위도']].astype(float)
jib = sb[sb.k != ''].groupby('k')[['lon', 'lat']].median()
ld = pd.read_pickle(os.path.join(W, 'localdata.pkl'))
lon, lat = T_5174_TO_WGS.transform(ld.x.values, ld.y.values); ld['lon'] = lon; ld['lat'] = lat
jib = pd.concat([jib, ld[ld.addr != ''].groupby('addr')[['lon', 'lat']].median()]); jib = jib[~jib.index.duplicated()]
apt = pd.read_csv(os.path.join(D, '한국부동산원_공동주택 단지 식별정보_기본정보_20260831.csv'), encoding='utf-8-sig', dtype=str)
apt['k'] = apt['주소'].map(norm_addr); apt['hh'] = pd.to_numeric(apt['세대수'], errors='coerce'); apt['built'] = pd.to_datetime(apt['사용승인일'], errors='coerce')
apt = apt.join(jib, on='k')
# 지번으로 못 찾으면 도로명(구 + 도로명주소)으로, 그래도 없으면 같은 동 가장 가까운 본번(±20)
sb2 = pd.read_csv(os.path.join(D, '소진공_상가정보_202609_대구.csv'), encoding='utf-8-sig', usecols=['도로명주소', '경도', '위도'], dtype=str)
sb2['k'] = sb2['도로명주소'].map(norm_road); sb2[['lon', 'lat']] = sb2[['경도', '위도']].astype(float)
ld['rk'] = ld['도로명주소'].map(norm_road)
road = pd.concat([sb2[sb2.k != ''].groupby('k')[['lon', 'lat']].median(), ld[ld.rk != ''].groupby('rk')[['lon', 'lat']].median()])
road = road[~road.index.duplicated()]
apt['gu'] = apt['주소'].str.extract(r'대구광역시\s+(\S+[구군])')[0]
apt['rk'] = (apt.gu.fillna('') + ' ' + apt['도로명주소'].fillna('').str.strip()).map(norm_road)
miss = apt.lon.isna()
apt.loc[miss, ['lon', 'lat']] = road.reindex(apt.loc[miss, 'rk']).values
jb = pd.DataFrame({'k': jib.index}); jb[['lon', 'lat']] = jib.values
jb['dong'] = jb.k.str.extract(r'^(.*) 산?\d')[0]; jb['num'] = pd.to_numeric(jb.k.str.extract(r' 산?(\d+)(?:-\d+)?$')[0], errors='coerce')
jg = {d: g.dropna(subset=['num']) for d, g in jb.groupby('dong')}
apt['dong'] = apt.k.str.extract(r'^(.*) 산?\d')[0]; apt['num'] = pd.to_numeric(apt.k.str.extract(r' 산?(\d+)(?:-\d+)?$')[0], errors='coerce')
for i in apt.index[apt.lon.isna()]:
    g = jg.get(apt.at[i, 'dong'])
    if g is None or pd.isna(apt.at[i, 'num']) or len(g) == 0: continue
    j = (g.num - apt.at[i, 'num']).abs().idxmin()
    if abs(g.num[j] - apt.at[i, 'num']) <= 20: apt.loc[i, ['lon', 'lat']] = [g.lon[j], g.lat[j]]
n_all = len(apt); apt = apt.dropna(subset=['lon', 'hh'])
print('아파트 단지 좌표', len(apt), '/', n_all, '세대', int(apt.hh.sum()))

# ---------- 그 밖의 시설 ----------
sch = pd.read_csv(os.path.join(D, '전국초중등학교위치표준데이터_대구.csv'), encoding='utf-8-sig').dropna(subset=['위도'])
sch['since'] = pd.to_datetime(sch['설립일자'], errors='coerce')
park = pd.read_csv(os.path.join(D, '전국도시공원정보표준데이터_대구.csv'), encoding='utf-8-sig').dropna(subset=['위도'])
park['since'] = pd.to_datetime(park['지정고시일'], errors='coerce'); park['area'] = pd.to_numeric(park['공원면적'], errors='coerce').fillna(0)
mkt = pd.read_csv(os.path.join(D, '전국전통시장표준데이터_대구.csv'), encoding='utf-8-sig').dropna(subset=['위도'])
mkt['since'] = pd.to_datetime(mkt['개설연도'].astype(str).str[:4], format='%Y', errors='coerce'); mkt['shops'] = pd.to_numeric(mkt['점포수'], errors='coerce').fillna(0)
pk = pd.read_csv(os.path.join(D, '전국주차장정보표준데이터_대구.csv'), encoding='utf-8-sig').dropna(subset=['위도'])
pk['slots'] = pd.to_numeric(pk['주차구획수'], errors='coerce').fillna(0)
print('학교', len(sch), '공원', len(park), '전통시장', len(mkt), '주차장', len(pk))

def tree_of(df, lonc='경도', latc='위도'): return BallTree(xy(df[lonc].values, df[latc].values))
T = {'st': tree_of(st, 'lon', 'lat'), 'apt': tree_of(apt, 'lon', 'lat'), 'sch': tree_of(sch), 'park': tree_of(park), 'mkt': tree_of(mkt), 'pk': tree_of(pk)}
since = lambda s: s.fillna(pd.Timestamp('1900-01-01')).values.astype('datetime64[D]')
ST_OPEN = since(st.opened); ST_R = st.riders.values
APT_B = since(apt.built); APT_H = apt.hh.values
SCH_B = since(sch.since); SCH_E = sch['학교급구분'].fillna('').str.contains('초등').values
PK_B = since(park.since); PK_A = park.area.values
MK_B = since(mkt.since); MK_S = mkt.shops.values
PKS = pk.slots.values
COLS = ['subway_dist', 'subway_riders_near', 'subway_n800', 'apt_hh500', 'apt_new_hh500', 'apt_n500', 'school_n500', 'elem_dist', 'park_n500', 'park_area500', 'market_n500', 'market_shops500', 'parking_slots300']


def infra(P, t):
    n = len(P); out = np.zeros((n, len(COLS)))
    i800 = T['st'].query_radius(P, 3000, return_distance=True)
    ia, _ = T['apt'].query_radius(P, 500, return_distance=True)
    isc, dsc = T['sch'].query_radius(P, 2000, return_distance=True)
    ipk = T['park'].query_radius(P, 500); imk = T['mkt'].query_radius(P, 500); ipl = T['pk'].query_radius(P, 300)
    for k in range(n):
        tk = t[k]
        ii, dd = i800[0][k], i800[1][k]; ok = ST_OPEN[ii] <= tk
        if ok.any():
            j = np.argmin(np.where(ok, dd, 1e9)); out[k, 0] = dd[j]; out[k, 1] = ST_R[ii[j]]; out[k, 2] = (ok & (dd <= 800)).sum()
        else: out[k, 0] = 3000
        a = ia[k]; ok = APT_B[a] <= tk
        out[k, 3] = APT_H[a][ok].sum(); out[k, 4] = APT_H[a][ok & (APT_B[a] > tk - np.timedelta64(3650, 'D'))].sum(); out[k, 5] = ok.sum()
        s, d = isc[k], dsc[k]; ok = SCH_B[s] <= tk
        out[k, 6] = (ok & (d <= 500)).sum(); e = ok & SCH_E[s]; out[k, 7] = d[e].min() if e.any() else 2000
        p = ipk[k]; ok = PK_B[p] <= tk; out[k, 8] = ok.sum(); out[k, 9] = PK_A[p][ok].sum()
        m = imk[k]; ok = MK_B[m] <= tk; out[k, 10] = ok.sum(); out[k, 11] = MK_S[m][ok].sum()
        out[k, 12] = PKS[ipl[k]].sum()
    return pd.DataFrame(out, columns=COLS)


c = ld[(ld.open >= '2015-01-01') & (ld.open < END - pd.Timedelta(days=1095))].reset_index(drop=True)
Ftr = infra(np.c_[c.x.values, c.y.values], c.open.values.astype('datetime64[D]'))
Ftr.to_pickle(os.path.join(W, 'infra_train.pkl'))
v = pd.read_csv(os.path.join(W, 'vacant.csv'), encoding='utf-8-sig')
Fv = infra(xy(v.lon.values, v.lat.values), np.full(len(v), np.datetime64(END.date(), 'D'))); Fv['id'] = v.id.values
Fv.to_pickle(os.path.join(W, 'infra_vacant.pkl'))
print('학습', Ftr.shape, '빈 점포', Fv.shape); print(Fv.describe().T[['mean', '50%', 'max']].round(1).to_string())
