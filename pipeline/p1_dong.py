# 행정동 경계(SGIS 2025-2Q) + 2024 행정동 통계 → work/dong.csv, site/data/dong.geojson
import zipfile, io, sys, json, os
import pandas as pd, numpy as np, shapefile
from shapely.geometry import shape, mapping
from shapely.ops import transform
from pyproj import Transformer
sys.stdout.reconfigure(encoding='utf-8')
B = os.path.dirname(os.path.abspath(__file__)); R = os.path.abspath(os.path.join(B, '..', '..'))
D = os.path.join(R, '_데이터'); W = os.path.join(B, '..', 'work'); S = os.path.join(B, '..', 'docs', 'data')
zp = os.path.join(D, '원자료', '15129688_국가데이터처_SGIS 행정구역 통계 및 경계_2026-07-23', '국가데이터처_SGIS 행정구역 통계 및 경계_20250630.zip')
z = zipfile.ZipFile(zp)
names = {}
for i in z.infolist():
    n = i.filename
    try: n = n.encode('cp437').decode('cp949')
    except Exception: pass
    names[n] = i
def get(suffix):
    k = [n for n in names if n.endswith(suffix)][0]; return io.BytesIO(z.read(names[k]))
sf = shapefile.Reader(shp=get('bnd_dong_00_2025_2Q.shp'), dbf=get('bnd_dong_00_2025_2Q.dbf'), shx=get('bnd_dong_00_2025_2Q.shx'), encoding='utf-8')
print(sf.fields[1:])
tf = Transformer.from_crs('EPSG:5179', 'EPSG:4326', always_xy=True).transform
feats = []; rows = []
for sr in sf.iterShapeRecords():
    rec = sr.record.as_dict()
    code = str(rec.get('ADM_CD') or rec.get('adm_cd'))
    if not code.startswith('22'): continue
    g = transform(tf, shape(sr.shape.__geo_interface__)).simplify(0.0003, preserve_topology=True)
    nm = rec.get('ADM_NM') or rec.get('adm_nm')
    c = g.representative_point()
    feats.append({'type': 'Feature', 'properties': {'code': code, 'name': nm}, 'geometry': json.loads(json.dumps(mapping(g)))})
    rows.append({'code': code, 'name': nm, 'lon': c.x, 'lat': c.y, 'area_km2': shape(sr.shape.__geo_interface__).area / 1e6})
dong = pd.DataFrame(rows)
# 통계
sg = os.path.join(D, '대구', 'SGIS_행정구역통계_2024')
def rd(f):
    x = pd.read_csv(os.path.join(sg, f), encoding='utf-8-sig', dtype={'행정구역코드': str}); return x[x.행정구역코드.str.len() == 8]
st = pd.concat([rd(f) for f in ['SGIS행정구역통계2024_성연령별인구.csv', 'SGIS행정구역통계2024_인구총괄(총인구).csv', 'SGIS행정구역통계2024_세대구성별가구.csv', 'SGIS행정구역통계2024_가구총괄.csv', 'SGIS행정구역통계2024_주택유형별주택.csv', 'SGIS행정구역통계2024_건축년도별주택.csv', 'SGIS행정구역통계2024_주택총괄_총주택(거처)수.csv']])
st['통계값'] = pd.to_numeric(st['통계값'], errors='coerce')
pv = st.pivot_table(index='행정구역코드', columns='통계항목', values='통계값', aggfunc='sum').fillna(0)
a = lambda lo, hi: pv[[f'in_age_{i:03d}' for i in range(lo, hi + 1) if f'in_age_{i:03d}' in pv]].sum(axis=1)
out = pd.DataFrame(index=pv.index)
out['pop'] = pv.get('to_in_001', a(1, 22))
out['age0_4'] = a(1, 1); out['age5_14'] = a(2, 3); out['age20_39'] = a(5, 8); out['age65p'] = a(14, 21)
out['hh'] = pv.get('to_ga_001', 0); out['hh1'] = pv.get('ga_sd_005', 0)
out['apt'] = pv.get('ho_gb_003', 0); out['houses'] = pv.get('to_ho_001', 0)
newcols = [c for c in pv.columns if c.startswith('ho_yr_')]
out = out.reset_index().rename(columns={'행정구역코드': 'code'})
dong = dong.merge(out, on='code', how='left')
for c in ['age0_4', 'age5_14', 'age20_39', 'age65p']: dong['r_' + c] = dong[c] / dong['pop']
dong['r_hh1'] = dong.hh1 / dong.hh; dong['r_apt'] = dong.apt / dong.houses.replace(0, np.nan)
dong['density'] = dong['pop'] / dong.area_km2
dong.to_csv(os.path.join(W, 'dong.csv'), index=False, encoding='utf-8-sig')
json.dump({'type': 'FeatureCollection', 'features': feats}, open(os.path.join(S, 'dong.geojson'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(dong), 'dongs; pop sum', int(dong['pop'].sum()))
print(dong[['name', 'pop', 'r_age65p', 'r_hh1']].describe())
