# 버스 정류소 시간대별 승하차(2024~2025년 매달 말일 하루씩, 24일) → 정류소 위치와 이름으로 결합 → docs/data/bus_hours.json
# [[경도, 위도, [05시~23시 하루 평균 승하차]], ...]  (사이트가 점포 300m 안 정류소를 더해 시간대 그래프를 그림)
import sys, os, glob, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
sys.stdout.reconfigure(encoding='utf-8')
fs = sorted(glob.glob(os.path.join(D, '버스_정류소별_시간대별승하차_2024-2025', '*.csv')))
print('파일', len(fs))
H = [f'{h:02d}시' for h in range(5, 24)]
x = pd.concat([pd.read_csv(f, encoding='utf-8-sig') for f in fs])
x[H] = x[H].apply(pd.to_numeric, errors='coerce').fillna(0)
tot = x.groupby('정류소명')[H].sum() / len(fs)   # 파일 하나 = 그 달 말일 하루치(합계 약 80만 명) → 24일 평균(승차+하차)
loc = pd.read_csv(os.path.join(D, '대구광역시_시내버스 정류소 위치정보_20260902.csv'), encoding='utf-8-sig')
loc = loc.groupby('정류소명')[['경도', '위도']].median()
m = tot.join(loc, how='inner')
print('정류소: 이용 기록', len(tot), '위치 결합', len(m))
out = [[round(r['경도'], 5), round(r['위도'], 5), [int(round(r[h])) for h in H]] for _, r in m.iterrows() if r[H].sum() >= 20]
json.dump(out, open(os.path.join(S, 'bus_hours.json'), 'w', encoding='utf-8'), separators=(',', ':'))
print('저장', len(out), os.path.getsize(os.path.join(S, 'bus_hours.json')))
