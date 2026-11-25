import os, re, json, sys
import numpy as np, pandas as pd
from pyproj import Transformer
B = os.path.dirname(os.path.abspath(__file__)); R = os.path.abspath(os.path.join(B, '..', '..'))
D = os.path.join(R, '_데이터', '대구'); W = os.path.join(B, '..', 'work'); S = os.path.join(B, '..', 'docs', 'data')
LD = os.path.join(D, 'LOCALDATA_인허가_대구')
END = pd.Timestamp('2026-11-01')
T_5174_TO_WGS = Transformer.from_crs('EPSG:5174', 'EPSG:4326', always_xy=True)
T_WGS_TO_5174 = Transformer.from_crs('EPSG:4326', 'EPSG:5174', always_xy=True)
# 창업 후보 업종: (코드, 이름, 파일, 업태 필터(None=전체))
TYPES = [
    ('korean', '한식 음식점', '식품_일반음식점', ['한식', '식육(숯불구이)']),
    ('pub', '호프·주점', '식품_일반음식점', ['호프/통닭', '정종/대포집/소주방']),
    ('western', '경양식·레스토랑', '식품_일반음식점', ['경양식']),
    ('snack', '분식', '식품_일반음식점', ['분식']),
    ('jpcn', '일식·중식', '식품_일반음식점', ['일식', '중국식', '횟집']),
    ('cafe', '카페', '식품_휴게음식점', ['커피숍']),
    ('conv', '편의점', '식품_휴게음식점', ['편의점']),
    ('bakery', '제과·베이커리', '식품_제과점영업', None),
    ('deli', '반찬·즉석식품', '식품_즉석판매제조가공업', None),
    ('hair', '미용실', '생활_미용업', ['일반미용업']),
    ('beauty', '피부·네일', '생활_미용업', ['피부미용업', '네일아트업']),
    ('gym', '헬스·체육도장', ['생활_체력단련장업', '생활_체육도장업'], None),
    ('karaoke', '노래연습장', '문화_노래연습장업', None),
    ('pcbang', 'PC방', '문화_인터넷컴퓨터게임시설제공업', None),
    ('petgroom', '반려동물 미용', '동물_동물미용업', None),
]
TYPE_NAME = {t[0]: t[1] for t in TYPES}


def norm_addr(s):
    """지번주소 정규화: 대구광역시 중구 봉산동 0185-0030 1층 -> 중구 봉산동 185-30"""
    if not isinstance(s, str): return ''
    s = re.sub(r'\s+', ' ', s.replace('대구광역시', '')).strip()
    m = re.match(r'^(.*?)\s(산?)0*(\d+)(?:-0*(\d+))?', s)
    if not m: return ''
    tail = f"-{m.group(4)}" if m.group(4) and m.group(4) != '0' else ''
    return f"{m.group(1)} {m.group(2)}{m.group(3)}{tail}"


def norm_road(s):
    """도로명주소 정규화: '대구광역시 중구 국채보상로 679-13, 1층 (동인동)' -> '중구 국채보상로 679-13'"""
    if not isinstance(s, str): return ''
    s = re.sub(r'\(.*?\)', ' ', s.replace('대구광역시', '').replace('대구', ''))
    s = s.split(',')[0]
    s = re.sub(r'\s+', ' ', s).strip()
    m = re.match(r'^(\S+[구군])\s+(?:\S+[읍면]\s+)?(\S+(?:로|길))\s*(\d+)(?:-(\d+))?', s)
    if not m: return ''
    tail = f"-{m.group(4)}" if m.group(4) else ''
    return f"{m.group(1)} {m.group(2)} {m.group(3)}{tail}"


def load_localdata():
    parts = []
    for code, name, files, filt in TYPES:
        for f in (files if isinstance(files, list) else [files]):
            x = pd.read_csv(os.path.join(LD, f + '.csv'), encoding='utf-8-sig', low_memory=False, dtype=str)
            if filt is not None: x = x[x['업태구분명'].isin(filt)]
            x = x.assign(type=code)
            parts.append(x[['type', '인허가일자', '폐업일자', '영업상태명', '지번주소', '도로명주소', '좌표정보(X)', '좌표정보(Y)', '사업장명']])
    d = pd.concat(parts, ignore_index=True)
    d['open'] = pd.to_datetime(d['인허가일자'], errors='coerce'); d['close'] = pd.to_datetime(d['폐업일자'], errors='coerce')
    closed_flag = d['영업상태명'].fillna('').str.contains('폐업|취소|말소')
    d = d[~(closed_flag & d.close.isna())]  # 폐업인데 폐업일자 없는 행은 기간을 알 수 없어 제외
    d['x'] = pd.to_numeric(d['좌표정보(X)'].str.strip(), errors='coerce'); d['y'] = pd.to_numeric(d['좌표정보(Y)'].str.strip(), errors='coerce')
    d = d.dropna(subset=['open', 'x', 'y']).reset_index(drop=True)
    d['addr'] = d['지번주소'].map(norm_addr)
    return d
