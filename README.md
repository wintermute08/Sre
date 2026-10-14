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
| `scripts/make-stamp.py` | 윗면 'SLANG' 각인 텍스처 굽기 (`public/models/soap_stamp_*.png`) |

## 원본 전달서와 다르게 한 점

- **누르기**: 전달서의 `Press_*` 모프 5개를 섞는 대신, 셰이더로 **손가락이 닿은 바로 그 자리**를 누릅니다. 전달서에 적힌 "더 정교하게 하려면 국소 메시 변형"을 구현한 것입니다. 그래서 웹용 GLB에서 `Press_*`는 빼고 `Squeeze`(두 손가락), `Pull_Left/Right`(누른 채 좌우로 끌기)만 남겼습니다.
- **용량**: 모프를 정리하고 meshopt로 압축해서 0.4MB가 되었습니다. 원본 모델을 바꾸면 다시 변환하세요.
  ```bash
  npm run optimize-model -- 원본/slang_soap.glb public/models/slang_soap.glb
  ```
- **소리**: 샘플 대신 합성음을 씁니다. 짧은 노이즈 알갱이 수십 개를 앞쪽에 몰아 뿌려서 크런치를 만들기 때문에 매번 조금씩 다르게 들립니다. 음량은 실제 변형량(누른 깊이, 문지른 거리, 복원 속도)에 맞춥니다.

## 각인 (SLANG)

원본 GLB 각인은 글자 테두리 1~2px 선뿐이라 휴대폰 크기에서는 보이지 않았어요. 그래서 각인을 다시 구웠어요.
글자 안쪽으로 완만하게 파이는 경사(노멀맵)와, 파인 홈을 살짝 어둡게 하는 그늘 마스크를 함께 써요.
글자나 깊이를 바꾸려면 `scripts/make-stamp.py` 위쪽 값(`TEXT`, `TEXT_W_MM`, `DEPTH_MM`)을 고친 뒤 다시 실행하세요.

```bash
python3 scripts/make-stamp.py   # numpy, Pillow 필요
```

## 손맛 조절

`lib/soap/engine.ts`의 `TUNING`에서 조절합니다.

- `depth`, `radius`: 얼마나 깊고 넓게 들어가는지
- `stiffness`, `damping`: 누를 때 '푹' 들어가는 속도와 출렁임
- `recoverSlow`, `recoverFast`, `recoverRamp`: 놓은 뒤 쫀득하게 버티다가 돌아오는 느낌

## 소리가 안 날 때 (모바일)

브라우저는 '사용자 활성화' 제스처 안에서만 오디오를 켤 수 있어요. 터치 화면에서는 손가락을 **누를 때(pointerdown)가 아니라 뗄 때(pointerup / touchend)** 가 그 제스처예요.
그래서 첫 터치에서는 손을 떼는 순간 오디오가 켜지고, 그때 첫 크런치가 늦게 들려요. 두 번째 터치부터는 누르는 즉시 들려요.
(`lib/soap/audio.ts`의 `unlock`, `bindGestures`) 아이폰은 무음 모드에서 Web Audio가 나지 않아요.

## 디자인 원칙 (Toss Tech Design 참고)

| 원칙 | 적용 |
| --- | --- |
| 선택지와 입력을 줄인다 | 첫 화면에는 비누만 보여요. 설정(소리·진동·색)은 바텀시트 한 곳에 모았어요 |
| 상태를 전달한다 | 로딩 진행률, 오류와 새로고침, 처음 한 번만 누르기 안내, 이후 "오늘 n번 눌렀어요" |
| 인터랙션은 장식이 아니라 이해 | 손가락 위치 그대로 눌리고, 소리 크기는 실제 변형량에 맞춰요. 가만히 있으면 살짝 흔들려 입체감을 보여주고, 만지면 멈춰요 |
| 접근성은 핵심 사용성 | 본문 글자 대비 4.5:1 이상(토스 기본 grey600/blue를 살짝 진하게 조정), 확대 허용, 스페이스바/엔터로 누르기, 시트를 열면 제목부터 읽히고 닫으면 설정 버튼으로 초점 복귀, 색 선택은 화살표 키로 이동, 모션 줄이기와 다크 모드 지원 |
| 신뢰 | 압박하는 문구 없이 해요체로 썼어요. 안 되는 기능(아이폰 진동)은 숨기고, 무음 모드 제약은 미리 알려요 |

### 성공 지표 제안 (아직 수집하지 않음)

한 번 방문할 때 누른 횟수, 첫 누르기까지 걸린 시간, 재방문율. 필요하면 Vercel Analytics를 붙여 측정해요.
