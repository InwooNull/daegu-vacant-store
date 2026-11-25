# 5판: 빈 점포 면적 추정 — 같은 지번(가능하면 같은 층)에 있던 인허가(LOCALDATA)의 '소재지면적' 중앙값
# 같은 건물 기록이 없으면 같은 행정동 소형 점포 면적 중앙값, 그것도 없으면 대구 중앙값
import sys, os, re, glob, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
sys.stdout.reconfigure(encoding='utf-8')

files = sorted({f for _, _, fs, _ in TYPES for f in (fs if isinstance(fs, list) else [fs])})
parts = []
for f in files:
    x = pd.read_csv(os.path.join(LD, f + '.csv'), encoding='utf-8-sig', low_memory=False, dtype=str,
                    usecols=lambda c: c in ['지번주소', '도로명주소', '소재지면적', '시설면적', '업태구분명'])
    if '소재지면적' not in x and '시설면적' in x: x = x.rename(columns={'시설면적': '소재지면적'})
    x['src'] = f; parts.append(x)
d = pd.concat(parts, ignore_index=True)
d['area'] = pd.to_numeric(d['소재지면적'], errors='coerce')
d = d[(d.area >= 10) & (d.area <= 400)].copy()          # 한 칸 점포 범위(10~400㎡)만
d['addr'] = d['지번주소'].map(norm_addr)
d['fl'] = d['도로명주소'].fillna('').str.extract(r'(?:,|\s)(?:지상\s*)?(\d{1,2})층')[0]
d = d[d.addr != '']
print('면적 있는 인허가', len(d), '중앙값', d.area.median())

# 같은 건물·층 / 같은 건물
by_af = d.dropna(subset=['fl']).groupby(['addr', 'fl']).area.median()
by_a = d.groupby('addr').area.median()
n_a = d.groupby('addr').size()

v = pd.read_csv(os.path.join(W, 'vacant.csv'), encoding='utf-8-sig', dtype={'dong_code': str, 'fl': str})
v['addr'] = v['지번주소'].map(norm_addr)
v['fl_'] = v.fl.fillna('').str.replace(r'\.0$', '', regex=True)
dong_med = None
area, src = [], []
for a, f in zip(v.addr, v.fl_):
    if f and (a, f) in by_af.index: area.append(by_af[(a, f)]); src.append('floor')
    elif a in by_a.index: area.append(by_a[a]); src.append('bldg')
    else: area.append(np.nan); src.append('')
v['area'] = area; v['asrc'] = src
dm = v.groupby('dong_code').area.median()
miss = v.area.isna()
v.loc[miss, 'area'] = v.loc[miss, 'dong_code'].map(dm); v.loc[miss & v.area.notna(), 'asrc'] = 'dong'
miss = v.area.isna(); v.loc[miss, 'area'] = d.area.median(); v.loc[miss, 'asrc'] = 'city'
print(v.asrc.value_counts().to_dict()); print(v.area.describe().round(1).to_dict())
v[['id', 'area', 'asrc']].to_csv(os.path.join(W, 'vacant_area.csv'), index=False, encoding='utf-8-sig')
# 업종별 평균 면적(매출을 면적으로 나눌 때 씀): 그 업종 인허가의 중앙값
tmed = {}
for code, name, fs, filt in TYPES:
    fs = fs if isinstance(fs, list) else [fs]
    x = d[d.src.isin(fs)]
    if filt is not None: x = x[x['업태구분명'].isin(filt)]
    tmed[code] = round(float(x.area.median()), 1)
print('업종별 면적 중앙값', tmed)
json.dump(tmed, open(os.path.join(W, 'type_area.json'), 'w', encoding='utf-8'), ensure_ascii=False)
