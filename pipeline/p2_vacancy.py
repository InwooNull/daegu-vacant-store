# 빈 점포(추정): 최근 1년(2025-10~2026-06 분기 파일)에 있었는데 2026-09에 사라졌고,
# 같은 건물·층·호에 새 업소가 없는 자리. 호 정보가 없으면 같은 건물·층의 업소 수가 줄어든 만큼만.
import sys, os, json, re
import pandas as pd, numpy as np
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
sys.stdout.reconfigure(encoding='utf-8')
B = os.path.dirname(os.path.abspath(__file__)); R = os.path.abspath(os.path.join(B, '..', '..'))
D = os.path.join(R, '_데이터', '대구'); W = os.path.join(B, '..', 'work'); S = os.path.join(B, '..', 'docs', 'data')
Q = ['202510', '202512', '202603', '202606']; CUR = '202609'
cols = ['상가업소번호', '상호명', '상권업종대분류명', '상권업종중분류명', '상권업종소분류명', '시군구명', '행정동명', '지번주소', '도로명주소', '건물관리번호', '건물명', '층정보', '호정보', '경도', '위도']
def load(q):
    x = pd.read_csv(os.path.join(D, f'소진공_상가정보_{q}_대구.csv'), encoding='utf-8-sig', usecols=cols, dtype=str)
    x['q'] = q
    x['bkey'] = x['건물관리번호'].fillna(x['지번주소'])
    x['fl'] = x['층정보'].fillna('').str.strip(); x['ho'] = x['호정보'].fillna('').str.strip()
    return x
cur = load(CUR); prev = pd.concat([load(q) for q in Q])
print('층 채움률', (cur.fl != '').mean().round(3), '호 채움률', (cur.ho != '').mean().round(3))
gone = prev[~prev['상가업소번호'].isin(cur['상가업소번호'])].sort_values('q').drop_duplicates('상가업소번호', keep='last')
print('최근 1년 사이 사라진 업소', len(gone))
# 이전·상호 유지(체인 아님) 제외
cnt = cur['상호명'].value_counts()
key_cur = set(zip(cur['상호명'], cur['상권업종소분류명'], cur['시군구명']))
moved = gone.apply(lambda r: cnt.get(r['상호명'], 0) <= 3 and (r['상호명'], r['상권업종소분류명'], r['시군구명']) in key_cur, axis=1)
gone = gone[~moved]; print('이전 추정 제외 후', len(gone), '(제외', int(moved.sum()), ')')
# 호 있는 자리
cur_slot = set(zip(cur.bkey, cur.fl, cur.ho))
g1 = gone[gone.ho != '']
g1 = g1[[s not in cur_slot for s in zip(g1.bkey, g1.fl, g1.ho)]].drop_duplicates(['bkey', 'fl', 'ho'], keep='last')
# 호 없는 자리: 층별 업소 수 감소분만큼
g0 = gone[gone.ho == '']
cc = cur.groupby(['bkey', 'fl']).size()
pc = prev[prev.ho == ''].groupby(['q', 'bkey', 'fl']).size().groupby(level=[1, 2]).max()
keep = []
for (b, f), grp in g0.groupby(['bkey', 'fl']):
    k = int(pc.get((b, f), 0) - cc.get((b, f), 0))
    if k > 0: keep.append(grp.sort_values('q').tail(k))
g0 = pd.concat(keep) if keep else g0.iloc[:0]
v = pd.concat([g1, g0]).reset_index(drop=True)
v['lon'] = pd.to_numeric(v['경도']); v['lat'] = pd.to_numeric(v['위도'])
v = v.dropna(subset=['lon', 'lat'])
# 층 숫자
def fnum(s):
    s = str(s)
    if s.startswith('B') or '지하' in s:
        m = re.findall(r'\d+', s); return -int(m[0]) if m else -1
    m = re.findall(r'\d+', s); return int(m[0]) if m else np.nan
v['floor'] = v.fl.map(fnum)
# SGIS 행정동 붙이기
gj = json.load(open(os.path.join(S, 'dong.geojson'), encoding='utf-8'))
polys = [shape(f['geometry']) for f in gj['features']]; codes = [f['properties']['code'] for f in gj['features']]
tree = STRtree(polys)
def dcode(lon, lat):
    p = Point(lon, lat); hit = tree.query(p, predicate='intersects')
    if len(hit): return codes[hit[0]]
    return codes[tree.nearest(p)]
v['dong_code'] = [dcode(a, b) for a, b in zip(v.lon, v.lat)]
v['id'] = 'V' + v.index.astype(str).str.zfill(5)
out = v[['id', '상가업소번호', 'lon', 'lat', '시군구명', '행정동명', 'dong_code', '지번주소', '도로명주소', '건물명', 'fl', 'ho', 'floor', '상권업종대분류명', '상권업종중분류명', '상권업종소분류명', '상호명', 'q']].rename(columns={'q': 'last_seen'})
out.to_csv(os.path.join(W, 'vacant.csv'), index=False, encoding='utf-8-sig')
print('빈 점포(추정)', len(out)); print(out['시군구명'].value_counts().to_string()); print(out['상권업종대분류명'].value_counts().to_string()); print(out.floor.value_counts().head(8).to_string())
