# 슬랑 비누

꾹 누르면 바삭, 놓으면 말랑. 손끝으로 만지는 비누 말랑이 웹 장난감입니다. 모바일 화면을 기준으로 만들었어요.

- Next.js 16 (App Router) + three.js, 정적 페이지라 Vercel에 그대로 배포됩니다.
- 모델: Blender 전달본 `slang_soap.glb`를 웹용으로 줄임 (2.9MB → 0.4MB)
- 소리: 녹음 파일 없이 Web Audio로 크런치를 합성 (저작권/라이선스 걱정 없음)

## 실행

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # 배포 전 확인
```

## Vercel 배포

1. Vercel에서 **Add New → Project** → 이 GitHub 저장소 선택
2. Framework Preset이 **Next.js**로 자동 인식됨 — 설정 변경 없이 **Deploy**
3. 환경 변수 없음

## 구조

| 파일 | 역할 |
| --- | --- |
| `components/SoapPlayground.tsx` | 화면 UI (헤더, 첫 안내, 오늘 누른 횟수, 설정 바텀시트) |
| `lib/soap/engine.ts` | three.js 씬, GLB 로드, 터치 입력, 눌림/복원 물리, `TUNING` 값 |
| `lib/soap/deform.ts` | 손가락 위치 중심 국소 눌림 셰이더 |
| `lib/soap/audio.ts` | 크런치 사운드 합성 |
| `public/models/slang_soap.glb` | 웹용 비누 모델 |
| `scripts/optimize-model.mjs` | 원본 GLB → 웹용 GLB 변환 |

## 원본 전달서와 다르게 한 점

- **누르기**: 전달서의 `Press_*` 모프 5개를 섞는 대신, 셰이더로 **손가락이 닿은 바로 그 자리**를 누릅니다. 전달서에 적힌 "더 정교하게 하려면 국소 메시 변형"을 구현한 것입니다. 그래서 웹용 GLB에서 `Press_*`는 빼고 `Squeeze`(두 손가락), `Pull_Left/Right`(누른 채 좌우로 끌기)만 남겼습니다.
- **용량**: 모프를 정리하고 meshopt로 압축해서 0.4MB가 되었습니다. 원본 모델을 바꾸면 다시 변환하세요.
  ```bash
  npm run optimize-model -- 원본/slang_soap.glb public/models/slang_soap.glb
  ```
- **소리**: 샘플 대신 합성음을 씁니다. 짧은 노이즈 알갱이 수십 개를 앞쪽에 몰아 뿌려서 크런치를 만들기 때문에 매번 조금씩 다르게 들립니다. 음량은 실제 변형량(누른 깊이, 문지른 거리, 복원 속도)에 맞춥니다.

## 손맛 조절

`lib/soap/engine.ts`의 `TUNING`에서 조절합니다.

- `depth`, `radius`: 얼마나 깊고 넓게 들어가는지
- `stiffness`, `damping`: 누를 때 '푹' 들어가는 속도와 출렁임
- `recoverSlow`, `recoverFast`, `recoverRamp`: 놓은 뒤 쫀득하게 버티다가 돌아오는 느낌

## 디자인 원칙 (Toss Tech Design 참고)

- 선택지를 줄였어요. 첫 화면에서는 비누만 보이고, 설정은 바텀시트에 모았어요.
- 처음 한 번만 "비누를 꾹 눌러보세요"를 안내하고, 누른 뒤에는 "오늘 n번 눌렀어요"로 바꿔요.
- 접근성: 스페이스바나 엔터를 누르고 있으면 비누 가운데를 눌러요. 스위치와 색상 선택에 역할 정보를 넣었고, 모션 줄이기 설정과 다크 모드를 따라가요.
- 문구는 압박 없이 해요체로 썼어요. 아이폰 무음 모드에서는 소리가 나지 않는다고 미리 알려요.
