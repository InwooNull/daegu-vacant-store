# 업종별 3년 생존 예측: 시간 분할 검증(2015~2019 개업 학습 → 2020~2023 개업 시험) 후 전체로 다시 학습해 빈 점포에 적용
import sys, os, json
import numpy as np, pandas as pd, joblib
import lightgbm as lgb
from sklearn.metrics import roc_auc_score
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
sys.stdout.reconfigure(encoding='utf-8')
F = pd.read_pickle(os.path.join(W, 'train_feats.pkl'))
V = pd.read_pickle(os.path.join(W, 'vacant_feats.pkl'))
codes = [t[0] for t in TYPES]
# 행사·팝업형 인허가 제외: 같은 지번·같은 업종에 30일 안 개업이 3건 넘게 몰린 곳(백화점 행사장·시장 판매대 등) — 빈 점포 한 칸과 성격이 다름
d = pd.read_pickle(os.path.join(W, 'localdata.pkl'))
c = d[(d.open >= '2015-01-01') & (d.open < END - pd.Timedelta(days=1095))].reset_index(drop=True)
assert len(c) == len(F)
F['addr'] = c.addr.values
F = F.sort_values('open'); burst = np.zeros(len(F), bool)
for (a, t), g in F[F.addr != ''].groupby(['addr', 'type']):
    if len(g) < 4: continue
    o = g.open.values.astype('datetime64[D]').astype(int)
    lo = np.searchsorted(o, o - 30); hi = np.searchsorted(o, o + 30, side='right')
    burst[F.index.get_indexer(g.index[(hi - lo) > 3])] = True
print('팝업형 제외', int(burst.sum()), F[burst].type.value_counts().head(5).to_dict())
F = F[~burst]


def prep(df, prior):
    X = df[['n_all300', 'n_same300', 'open1y_same300', 'close1y_same300', 'close1y_all300', 'n_same100', 'hist_n500', 'prior_close_addr', 'bus300', 'routes300', 'density', 'r_age65p', 'r_age20_39', 'r_age0_4', 'r_hh1', 'r_apt']].copy()
    pr = df.type.map(prior).values
    X['hist_rate500'] = (df.hist_surv500 + 5 * pr) / (df.hist_n500 + 5)   # 주변 같은 업종의 과거 3년 생존율(대구 평균으로 수축)
    X['same_share300'] = df.n_same300 / np.maximum(df.n_all300, 1)
    X['type'] = pd.Categorical(df.type, categories=codes)
    return X
PARAMS = dict(objective='binary', learning_rate=0.03, num_leaves=31, min_child_samples=80, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, seed=0)
NR = 600

# ---------- 시간 분할 검증 ----------
tr = F[F.open.dt.year <= 2019]; te = F[F.open.dt.year >= 2020]
prior_tr = tr.groupby('type').y3.mean().to_dict()
m = lgb.train(PARAMS, lgb.Dataset(prep(tr, prior_tr), tr.y3), NR)
p = m.predict(prep(te, prior_tr))
base = tr.groupby(['gu', 'type']).y3.mean(); gm = tr.groupby('type').y3.mean()
pb = np.array([base.get((g, t), gm[t]) for g, t in zip(te.gu, te.type)])
te = te.assign(p=p, pb=pb)
met = {'split': '2015~2019년 개업으로 학습 → 2020년~2023년 10월 개업으로 시험(미래 예측처럼)', 'n_train': int(len(tr)), 'n_test': int(len(te)),
       'auc_model': round(roc_auc_score(te.y3, te.p), 3), 'auc_baseline_gu_type': round(roc_auc_score(te.y3, te.pb), 3), 'by_type': {}}
# 비교용: 시험 세트 행별 예측 저장(팀원 모델과 같은 행으로 비교)
cc = c.loc[te.index]
lon_, lat_ = T_5174_TO_WGS.transform(cc.x.values, cc.y.values)
pd.DataFrame({'row_id': te.index, 'type': te.type.values, 'type_name': te.type.map(TYPE_NAME).values, 'open_date': cc.open.dt.date.values,
              'close_date': cc.close.dt.date.values, 'jibun_addr': cc['지번주소'].values, 'lon': np.round(lon_, 6), 'lat': np.round(lat_, 6),
              'gu': te.gu.values, 'y_survive3y': te.y3.values, 'p_our_model': te.p.round(4).values, 'p_baseline_gu_type': np.round(te.pb, 4)}
             ).to_csv(os.path.join(W, 'test_predictions.csv'), index=False, encoding='utf-8-sig')
te['q'] = pd.qcut(te.p.rank(method='first'), 5, labels=False)
met['quintile_actual_survival'] = (te.groupby('q').y3.mean() * 100).round(1).tolist()
for t in codes:
    s = te[te.type == t]
    if s.y3.nunique() < 2 or len(s) < 100: met['by_type'][t] = {'n_test': int(len(s)), 'auc': None}; continue
    a = roc_auc_score(s.y3, s.p); b = roc_auc_score(s.y3, s.pb)
    s = s.assign(q=pd.qcut(s.p.rank(method='first'), 5, labels=False))
    met['by_type'][t] = {'name': TYPE_NAME[t], 'n_test': int(len(s)), 'auc': round(a, 3), 'auc_baseline': round(b, 3),
                         'bottom20_actual': round(s[s.q == 0].y3.mean() * 100, 1), 'top20_actual': round(s[s.q == 4].y3.mean() * 100, 1)}
print(json.dumps(met, ensure_ascii=False, indent=1))
imp = pd.Series(m.feature_importance('gain'), index=m.feature_name()).sort_values(ascending=False)
met['feature_importance'] = (imp / imp.sum()).round(3).to_dict()

# ---------- 전체로 다시 학습 + 최근 개업(2021~2023) 생존율에 맞춰 보정 ----------
prior_all = F.groupby('type').y3.mean().to_dict()
mf = lgb.train(PARAMS, lgb.Dataset(prep(F, prior_all), F.y3), NR)
rec = F[F.open >= '2021-01-01']
recent = rec.groupby('type').y3.mean()
pr_rec = pd.Series(mf.predict(prep(rec, prior_all)), index=rec.index)
logit = lambda x: np.log(x / (1 - x)); sig = lambda z: 1 / (1 + np.exp(-z))
shift = {}
for t in codes:
    pt = pr_rec[rec.type == t].clip(1e-4, 1 - 1e-4)
    lo, hi = -3, 3   # 평균 예측이 최근 실제 생존율이 되도록 로짓 이동
    for _ in range(50):
        mid = (lo + hi) / 2
        if sig(logit(pt) + mid).mean() > recent[t]: hi = mid
        else: lo = mid
    shift[t] = (lo + hi) / 2
met['recent_avg_survival'] = {t: round(recent[t] * 100, 1) for t in codes}
met['recent_n'] = {t: int((rec.type == t).sum()) for t in codes}
pv = mf.predict(prep(V, prior_all)).clip(1e-4, 1 - 1e-4)
V = V.assign(p=sig(logit(pv) + V.type.map(shift).values))
V['avg'] = V.type.map(recent); V['ratio'] = V.p / V.avg
V['hist_rate500'] = (V.hist_surv500 + 5 * V.type.map(prior_all)) / (V.hist_n500 + 5)
V.to_pickle(os.path.join(W, 'vacant_pred.pkl'))
# 업종별 학습 데이터 중앙값(근거 문장 비교용)
med = F.groupby('type')[['n_same300', 'close1y_same300', 'n_all300']].median()
met['median_train'] = med.to_dict('index')
joblib.dump({'model': mf, 'shift': shift, 'prior': prior_all, 'types': codes}, os.path.join(W, 'survival_model.joblib'))
open(os.path.join(W, 'survival_model.txt'), 'w', encoding='utf-8').write(mf.model_to_string())
ws = [met['by_type'][t]['n_test'] for t in codes if met['by_type'][t].get('auc')]
met['auc_within_type_weighted'] = round(float(np.average([met['by_type'][t]['auc'] for t in codes if met['by_type'][t].get('auc')], weights=ws)), 3)
met['auc_within_type_baseline'] = round(float(np.average([met['by_type'][t]['auc_baseline'] for t in codes if met['by_type'][t].get('auc')], weights=ws)), 3)
print('업종 안 평균 AUC', met['auc_within_type_weighted'], '기준선', met['auc_within_type_baseline'])
json.dump(met, open(os.path.join(W, 'model_metrics.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('최근 실제 3년 생존율', met['recent_avg_survival'])
print('빈 점포 예측 분포', V.groupby('type').p.describe()[['mean', 'min', 'max']].round(3).to_string())
