# 사이트가 읽는 데이터 형식 (Colab 모델로 바꿀 때)

사이트(`docs/`)는 `docs/data/` 아래 JSON 파일만 읽습니다. **Colab에서 아래 형식 그대로 파일을 만들어 덮어쓰면** 코드를 고치지 않아도 화면이 바뀝니다. 지금 들어 있는 파일은 `pipeline/` 스크립트로 공개 데이터에서 계산한 결과입니다.

공통 약속
- 인코딩 UTF-8, 확률은 **0~1 소수**(단 `stores.json`의 업종 확률만 0~100 정수 %).
- 업종 코드와 순서는 `meta.json`의 `types` 키 순서를 따릅니다. 업종을 늘리거나 줄이면 `meta.json`, `stores.json`, 카드의 `biz`를 함께 맞춥니다.
- 점포 ID(`V00001` 형식)는 `stores.json`과 카드 파일에서 같아야 합니다.

## 1. `stores.json` — 지도 점 (점포당 한 줄)
```json
[["V00001", 35.86414, 128.64413, "수성구", 0, [66, 66, 62, 60, 70, 62, 74, 52, 44, 84, 71, 90, 95, 61, 79]], ...]
```
| 자리 | 뜻 |
|---|---|
| 0 | 점포 ID |
| 1, 2 | 위도, 경도 (WGS84) |
| 3 | 구·군 이름 → 카드 파일 이름(`cards/<구>.json`) |
| 4 | 판정: 0 창업 연계 / 1 공공 활용 / 2 보류 |
| 5 | 업종별 3년 생존 확률(% 정수), `meta.types` 순서 |

## 2. `cards/<구·군>.json` — 점포를 눌렀을 때 카드
```json
{"V00001": {
  "addr": "대구광역시 수성구 만촌로 58", "bld": "", "fl": "1", "prev": "채소/과일 소매업", "prev_big": "소매",
  "seen": 202606, "permit": true, "gu": "수성구", "dong": "만촌2동", "dtype": "아파트 가족형",
  "v": "biz",                                   // biz | public | hold
  "biz": [["korean", 0.721], ["cafe", 0.508]],  // 전 업종, 확률 높은 순
  "top": "korean",                              // 판정에 쓴 추천 업종(없으면 null)
  "why": ["반경 300m 같은 업종 영업 20곳 (대구 개업 자리 중앙값 42곳)"],   // 추천 업종 근거 문장 0~4개
  "pub": [["childcare", 32.2, 0, 1730, 160, 0.0]]  // [시설 코드, 결손 점수 0~100, 반경 내 시설 수, 가장 가까운 시설 거리 m, 반경 내 대상 인구, 대구 평균 대비 배수], 점수 높은 순
}}
```

## 3. `meta.json` — 업종 이름·정확도·규칙
- `types.<코드>`: `name`, `rel`(`ok` 판정 사용 / `weak` 판정 사용·약함 / `none` 참고용), `auc`, `auc_base`, `avg`(대구 최근 평균 3년 생존율 %), `n_test`, `bottom20`, `top20`
- `public.<시설 코드>`: `name`, `r`(도보 반경 m), `target`, `op`(운영 구조 제안)
- `rules`: `biz_p`, `biz_ratio`, `pub_score`
- `model`: 검증 방식과 AUC, `verdict_counts`, `n_stores`, `permit_confirmed`, `dtypes`, `generated`

## 4. 그 밖의 파일
- `dong.geojson`: 행정동 경계(SGIS 2025-2Q, 속성 `code`, `name`)
- `dong_summary.json`: 행정동별 `code, name, dtype, pop, r65, r2039, rhh1, n, biz, public, hold`
- `facilities.json`: `{"senior": [[이름, 경도, 위도], ...], "library": [...], "childcare": [...]}`

## Colab 모델을 넣는 가장 쉬운 방법
1. Colab에서 빈 점포 목록(`stores.json`의 ID·좌표)을 받아 업종별 확률을 계산합니다.
2. `stores.json`의 5번 자리와 카드의 `biz`를 새 확률로 바꾸고, `meta.json`의 `types.*.auc`·`rel`을 새 검증 결과로 바꿉니다.
3. 판정을 다시 내려야 하면 `pipeline/p6_export.py`의 규칙(`BIZ_P`, `BIZ_R`, `PUB_S`)을 그대로 쓰거나 바꿉니다.
4. `docs/data/`에 덮어쓰고 커밋하면 GitHub Pages가 1~2분 안에 갱신됩니다.

실시간 계산(목록에 없는 자리)이 필요하면 모델을 Hugging Face Spaces에 API로 올리고 `docs/app.js`의 `loadJSON` 한 곳만 그 API를 부르게 바꿉니다.
