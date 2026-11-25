# 자리 특징 계산: 학습용(인허가 개업 시점) + 빈 점포(현재 시점 2026-11-01)
import sys, os, json, time
import numpy as np, pandas as pd
from sklearn.neighbors import BallTree
from shapely.geometry import shape
from shapely.strtree import STRtree
import shapely
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
sys.stdout.reconfigure(encoding='utf-8')

d = load_localdata(); print('인허가(후보 업종 전체)', len(d), d.type.value_counts().to_dict(), flush=True)
d.to_pickle(os.path.join(W, 'localdata.pkl'))
codes = [t[0] for t in TYPES]; tix = {c: i for i, c in enumerate(codes)}
XY = d[['x', 'y']].values; tree = BallTree(XY)
OPEN = d.open.values.astype('datetime64[D]'); CLOSE = d.close.fillna(pd.Timestamp('2100-01-01')).values.astype('datetime64[D]')
TY = d.type.map(tix).values
surv3 = ((CLOSE - OPEN).astype(int) >= 1095)
gd = d[d.close.notna() & (d.addr != '')].groupby('addr')['close'].apply(lambda s: np.sort(s.values.astype('datetime64[D]'))).to_dict()
bus = pd.read_csv(os.path.join(D, '대구광역시_시내버스 정류소 위치정보_20260902.csv'), encoding='utf-8-sig')
bx, by = T_WGS_TO_5174.transform(bus['경도'].values, bus['위도'].values); btree = BallTree(np.c_[bx, by]); broutes = bus['경유노선수'].fillna(1).values
gj = json.load(open(os.path.join(S, 'dong.geojson'), encoding='utf-8'))
polys = [shape(f['geometry']) for f in gj['features']]; dcodes = np.array([f['properties']['code'] for f in gj['features']])
ptree = STRtree(polys)
dong = pd.read_csv(os.path.join(W, 'dong.csv'), dtype={'code': str}).set_index('code')
DF = ['density', 'r_age65p', 'r_age20_39', 'r_age0_4', 'r_hh1', 'r_apt']
FEATS = ['n_all300', 'n_same300', 'open1y_same300', 'close1y_same300', 'close1y_all300', 'n_same100', 'hist_n500', 'hist_surv500', 'prior_close_addr', 'bus300', 'routes300']


def dong_of(lon, lat):
    pts = shapely.points(lon, lat); res = np.full(len(pts), -1)
    ii, jj = ptree.query(pts, predicate='intersects'); res[ii] = jj
    miss = np.where(res < 0)[0]
    if len(miss): res[miss] = ptree.nearest(pts[miss])
    return dcodes[res]


def feats(px, py, t, typ, addr):
    n = len(px); P = np.c_[px, py]
    i300 = tree.query_radius(P, r=300); i100 = tree.query_radius(P, r=100); i500 = tree.query_radius(P, r=500)
    out = np.zeros((n, len(FEATS)))
    yr = np.timedelta64(365, 'D')
    for k in range(n):
        tk = t[k]; ty = typ[k]
        a = i300[k]; o = OPEN[a]; c = CLOSE[a]; same = TY[a] == ty
        alive = (o < tk) & (c > tk)
        out[k, 0] = alive.sum(); out[k, 1] = (alive & same).sum()
        out[k, 2] = ((o < tk) & (o >= tk - yr) & same).sum(); out[k, 3] = ((c < tk) & (c >= tk - yr) & same).sum()
        out[k, 4] = ((c < tk) & (c >= tk - yr)).sum()
        b = i100[k]; out[k, 5] = (((OPEN[b] < tk) & (CLOSE[b] > tk)) & (TY[b] == ty)).sum()
        e = i500[k]; m = (TY[e] == ty) & (OPEN[e] < tk - 3 * yr) & (OPEN[e] >= tk - 6 * yr)
        out[k, 6] = m.sum(); out[k, 7] = surv3[e][m].sum()
        arr = gd.get(addr[k]); out[k, 8] = 0 if arr is None or addr[k] == '' else int((arr < tk).sum())
    bi = btree.query_radius(P, r=300); out[:, 9] = [len(b) for b in bi]; out[:, 10] = [broutes[b].sum() for b in bi]
    f = pd.DataFrame(out, columns=FEATS)
    lon, lat = T_5174_TO_WGS.transform(px, py); dc = dong_of(lon, lat)
    f['dong_code'] = dc
    for c in DF: f[c] = dong.loc[dc, c].values
    f['type'] = [codes[i] for i in typ]
    return f


if __name__ == '__main__':
    t0 = time.time()
    c = d[(d.open >= '2015-01-01') & (d.open < END - pd.Timedelta(days=1095))].copy()
    c['y3'] = ((c.close.fillna(END) - c.open).dt.days >= 1095).astype(int)
    print('학습 표본', len(c), flush=True)
    F = feats(c.x.values, c.y.values, c.open.values.astype('datetime64[D]'), c.type.map(tix).values, c.addr.values)
    F['y3'] = c.y3.values; F['open'] = c.open.values
    F['gu'] = c['지번주소'].fillna(c['도로명주소']).str.extract(r'대구광역시\s+(\S+)')[0].values
    F.to_pickle(os.path.join(W, 'train_feats.pkl')); print('학습 특징', F.shape, round(time.time() - t0), '초', flush=True)
    v = pd.read_csv(os.path.join(W, 'vacant.csv'), encoding='utf-8-sig', dtype=str)
    vx, vy = T_WGS_TO_5174.transform(v.lon.astype(float).values, v.lat.astype(float).values)
    va = v['지번주소'].map(norm_addr).values
    allf = []
    for i, cd in enumerate(codes):
        f = feats(vx, vy, np.full(len(v), np.datetime64(END.date(), 'D')), np.full(len(v), i), va); f['id'] = v.id.values; allf.append(f)
        print(' 빈 점포 특징', cd, round(time.time() - t0), flush=True)
    pd.concat(allf).to_pickle(os.path.join(W, 'vacant_feats.pkl'))
    rc = d[(d.close >= '2025-07-01') & (d.addr != '')].addr.unique()
    pd.DataFrame({'id': v.id, 'permit_closed': np.isin(va, rc)}).to_csv(os.path.join(W, 'vacant_confirm.csv'), index=False)
    print('인허가 폐업 확인 비율', np.isin(va, rc).mean().round(3))
