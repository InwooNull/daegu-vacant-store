# 판정 규칙 + 사이트용 JSON 내보내기
import sys, os, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
sys.stdout.reconfigure(encoding='utf-8')
v = pd.read_csv(os.path.join(W, 'vacant.csv'), encoding='utf-8-sig', dtype={'dong_code': str})
cf = pd.read_csv(os.path.join(W, 'vacant_confirm.csv'))
pub = pd.read_csv(os.path.join(W, 'public.csv'), encoding='utf-8-sig', dtype={'dong_code': str})
P = pd.read_pickle(os.path.join(W, 'vacant_pred.pkl'))
met = json.load(open(os.path.join(W, 'model_metrics.json'), encoding='utf-8'))
spec = json.load(open(os.path.join(W, 'public_spec.json'), encoding='utf-8'))
dong = pd.read_csv(os.path.join(W, 'dong_types.csv'), dtype={'code': str})
codes = [t[0] for t in TYPES]

# 업종별 신뢰도: 시간 분할 시험 AUC 기준
def rel(t):
    b = met['by_type'][t]; a = b.get('auc')
    if a is None: return 'none'
    if a >= 0.58 and a - b['auc_baseline'] >= 0.03: return 'ok'
    if a >= 0.54 and a > b['auc_baseline']: return 'weak'
    return 'none'
REL = {t: rel(t) for t in codes}
print('신뢰도', REL)
# 판정 규칙(공개): ① 신뢰도 ok/weak 업종 중 예측 생존율 ≥ 60% 이고 대구 평균의 1.1배 이상 → 창업
#                 ② 아니면 공공 결손 점수 최고값 ≥ 50 이고 1~2층(또는 층 미상) → 공공
#                 ③ 둘 다 아니면 보류(시장 회복 대기·임시 활용 검토)
BIZ_P, BIZ_R, PUB_S = 0.60, 1.10, 50
P['rel'] = P.type.map(REL)
elig = P[(P.rel != 'none')]
best = elig.sort_values('ratio', ascending=False).drop_duplicates('id').set_index('id')
pk = list(spec.keys())
pub = pub.set_index('id')
pub['best_kind'] = pub[[f'{k}_score' for k in pk]].idxmax(axis=1).str.replace('_score', '')
pub['best_score'] = pub[[f'{k}_score' for k in pk]].max(axis=1)
v = v.merge(cf, on='id').set_index('id')
fl = v.floor
floor_ok = fl.isna() | fl.between(1, 2)
b = best.reindex(v.index)
is_biz = (b.p >= BIZ_P) & (b.ratio >= BIZ_R)
is_pub = (~is_biz) & (pub.best_score.reindex(v.index) >= PUB_S) & floor_ok
verdict = np.where(is_biz, 'biz', np.where(is_pub, 'public', 'hold'))
v['verdict'] = verdict
print(pd.Series(verdict).value_counts().to_dict())
med = met['median_train']


def reasons(r):
    t = r.type; out = []
    m = med[t]['n_same300']
    out.append(f"300m 안에 같은 업종 가게가 없음 (대구 보통 {int(m)}곳)" if r.n_same300 == 0 else f"300m 안에 같은 업종 {int(r.n_same300)}곳이 영업 중 (대구 보통 {int(m)}곳)")
    if r.close1y_same300 > 0: out.append(f"최근 1년 사이 300m 안 같은 업종 {int(r.close1y_same300)}곳 폐업")
    if r.hist_n500 >= 5: out.append(f"500m 안에서 3~6년 전 문 연 같은 업종 {int(r.hist_n500)}곳 중 {int(r.hist_surv500)}곳이 3년 넘게 영업")
    if r.prior_close_addr > 0: out.append(f"이 지번에서 예전에 {int(r.prior_close_addr)}번 폐업")
    return out[:4]


Pi = P.set_index(['id', 'type'])
dname = dong.set_index('code')
os.makedirs(os.path.join(S, 'cards'), exist_ok=True)
points = []; cards = {}
PP = (P.pivot(index='id', columns='type', values='p')[codes] * 100).round().astype(int)
for sid, r in v.iterrows():
    # [id, 위도, 경도, 구, 판정(0 창업/1 공공/2 보류), 업종별 3년 생존 확률(%, meta.types 순서)]
    points.append([sid, round(r.lat, 5), round(r.lon, 5), r['시군구명'], {'biz': 0, 'public': 1, 'hold': 2}[r.verdict], PP.loc[sid].tolist()])
# 카드: 구별 파일
Pg = P.groupby('id')
for gu, g in v.groupby('시군구명'):
    out = {}
    for sid, r in g.iterrows():
        bz = Pg.get_group(sid).sort_values('p', ascending=False)
        biz = [[x.type, round(x.p, 3)] for x in bz.itertuples()]  # 대구 평균·신뢰도는 meta.json
        top = bz[bz.rel != 'none'].sort_values('ratio', ascending=False).head(1)
        pu = pub.loc[sid]
        pubs = sorted([[k, float(pu[f'{k}_score']), int(pu[f'{k}_n']), int(pu[f'{k}_dist']), int(pu[f'{k}_tpop']), float(pu[f'{k}_ratio'])] for k in pk], key=lambda x: -x[1])  # [종류, 결손점수, 반경 내 시설 수, 최근접 거리m, 반경 내 대상 인구, 대구 평균 대비]
        dn = dname.loc[r.dong_code] if r.dong_code in dname.index else None
        out[sid] = {
            'addr': r['도로명주소'] if isinstance(r['도로명주소'], str) else r['지번주소'], 'bld': r['건물명'] if isinstance(r['건물명'], str) else '',
            'fl': r.fl if isinstance(r.fl, str) else '', 'prev': r['상권업종소분류명'], 'prev_big': r['상권업종대분류명'], 'seen': r.last_seen,
            'permit': bool(r.permit_closed), 'gu': gu, 'dong': dn['name'] if dn is not None else r['행정동명'], 'dtype': dn['dtype'] if dn is not None else '',
            'v': r.verdict, 'biz': biz, 'why': reasons(top.iloc[0]) if len(top) else [], 'top': top.iloc[0].type if len(top) else None, 'pub': pubs,
        }
    cards[gu] = out
    json.dump(out, open(os.path.join(S, 'cards', f'{gu}.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
json.dump(points, open(os.path.join(S, 'stores.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
# 행정동 요약
vs = v.groupby('dong_code').verdict.value_counts().unstack(fill_value=0)
ds = []
for _, r in dong.iterrows():
    c = vs.loc[r.code] if r.code in vs.index else {}
    ds.append({'code': r.code, 'name': r['name'], 'dtype': r['dtype'], 'pop': int(r['pop']), 'r65': round(r.r_age65p, 3), 'r2039': round(r.r_age20_39, 3), 'rhh1': round(r.r_hh1, 3),
               'n': int(sum(c.get(k, 0) for k in ['biz', 'public', 'hold'])), 'biz': int(c.get('biz', 0)), 'public': int(c.get('public', 0)), 'hold': int(c.get('hold', 0))})
json.dump(ds, open(os.path.join(S, 'dong_summary.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
meta = {
    'generated': pd.Timestamp.now().strftime('%Y-%m-%d %H:%M'), 'n_stores': int(len(v)), 'verdict_counts': pd.Series(verdict).value_counts().to_dict(),
    'permit_confirmed': int(v.permit_closed.sum()),
    'types': {t: {'name': TYPE_NAME[t], 'rel': REL[t], 'auc': met['by_type'][t].get('auc'), 'auc_base': met['by_type'][t].get('auc_baseline'),
                  'avg': met['recent_avg_survival'][t], 'n_recent': met['recent_n'][t], 'n_test': met['by_type'][t].get('n_test'),
                  'bottom20': met['by_type'][t].get('bottom20_actual'), 'top20': met['by_type'][t].get('top20_actual')} for t in codes},
    'model': {k: met[k] for k in ['split', 'n_train', 'n_test', 'auc_within_type_weighted', 'auc_within_type_baseline', 'quintile_actual_survival']},
    'public': spec, 'rules': {'biz_p': BIZ_P, 'biz_ratio': BIZ_R, 'pub_score': PUB_S},
    'dtypes': dong.groupby('dtype').size().to_dict(),
}
json.dump(meta, open(os.path.join(S, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps(meta['verdict_counts'], ensure_ascii=False), '확인', meta['permit_confirmed'])
for f in sorted(os.listdir(S)): print(f, os.path.getsize(os.path.join(S, f)) if os.path.isfile(os.path.join(S, f)) else '')
