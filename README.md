# Webtoon Previewer

웹툰 작가가 업로드 전에 회차 이미지를 실제 독자 화면처럼 빠르게 확인할 수 있는 macOS 데스크톱 미리보기 앱입니다. 여러 장의 이미지를 여백 없이 세로로 이어 붙여 보고, 표시폭과 배경색, 파일 순서를 바로 바꿀 수 있습니다.

## Why I Built This

웹툰 원고는 업로드 전 세로 흐름, 컷 사이 연결감, 말풍선 가독성, 이미지 순서가 중요합니다. Finder나 일반 이미지 뷰어로는 여러 장을 한 번에 이어서 보기 어렵기 때문에, 작가 작업 흐름에 맞춘 로컬 프리뷰 툴로 만들었습니다.

## Features

- JPG/PNG/WebP/WBPB 폴더 열기
- Finder에서 폴더나 여러 이미지 드래그 앤 드롭
- 이미지 사이 `margin/padding/gap` 0으로 연속 표시
- 표시폭 선택: 360, 430, 500, 690, 800, 1000, 1200px
- 창 너비 맞춤 / 원본 폭 보기 / 이미지 폭에 창 맞춤
- 흰색, 검정 배경 전환
- 업로드 전 확인용 뷰어 모드
- 숫자 자연 정렬: `1.png`, `2.png`, `10.png` 순서
- 파일 순서 편집창에서 드래그 앤 드롭 및 위/아래 버튼으로 순서 변경
- 수동 파일 순서 저장 및 최근 항목 복원
- 현재 표시폭 기준으로 이어붙인 PNG 저장, 너무 긴 원고는 자동 분할 저장
- PSD 합성 미리보기 직접 추출, 실패 시 ImageMagick 변환 재시도
- CLIP 내부 `CanvasPreview` 또는 PNG/JPEG 내장 미리보기 추출
- PSD/CLIP 원본 파일을 macOS 기본 앱(Photoshop, Clip Studio Paint 등)으로 바로 열기
- 이미지에 마우스를 올리면 각 이미지 시작 지점 상단에 파일명 표시
- macOS `.dmg` 패키징

## Tech Stack

- Electron
- Vite
- React
- TypeScript
- electron-builder

## Download

배포 파일은 GitHub Releases에 업로드하는 것을 권장합니다. 로컬에서 직접 만들려면 아래 명령을 실행합니다.

```bash
npm install
npm run release
```

생성된 `.dmg` 파일은 `release/` 폴더에 만들어집니다. 새 DMG를 만들면 이전 버전 DMG와 `.blockmap`은 자동 삭제되고 현재 버전만 남습니다.

PNG 저장은 선택한 표시폭을 그대로 사용합니다. 예를 들어 표시폭이 360이면 저장 PNG도 360px 폭입니다. 원고가 너무 길면 macOS/브라우저 캔버스 한계를 피하기 위해 `-01`, `-02`처럼 여러 PNG로 자동 분할됩니다.

## Development

```bash
npm install
npm run dev
```

## Build Check

```bash
npm run typecheck
npm run build
```

## Shortcuts

- `Command+O`: 파일/폴더 열기
- `Command+Shift+O`: 파일 순서 편집
- `Command+Enter`: 뷰어로 보기
- `Command+Shift+E`: 이어붙인 PNG 저장
- `Esc`: 뷰어 모드 또는 순서 편집창 닫기

## Format Support Notes

- JPG/PNG/WebP/WBPB: 브라우저 네이티브 표시를 사용합니다.
- PSD: 8-bit PSD 합성 이미지를 직접 추출하고, 실패하면 설치된 ImageMagick을 사용합니다. PSD 구조에 따라 일부 파일은 표시되지 않을 수 있습니다.
- CLIP: Clip Studio Paint의 독점 포맷 전체를 렌더링하는 것이 아니라, 파일 내부 `CanvasPreview` 또는 내장 PNG/JPEG 미리보기를 추출합니다. 파일 저장 방식에 따라 실패할 수 있습니다.

## Portfolio / Privacy Notes

이 저장소에는 테스트에 사용한 웹툰 원고, 개인 작업물, 스크린샷, DMG 빌드 산출물을 포함하지 않습니다. 실제 배포 파일은 GitHub Releases에 별도로 올리는 방식이 안전합니다.

## macOS Security Note

현재 개인 포트폴리오용 빌드는 Apple Developer ID notarization을 하지 않았습니다. 처음 실행할 때 macOS 보안 경고가 뜰 수 있습니다.

## License

MIT
