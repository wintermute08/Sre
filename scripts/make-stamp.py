"""비누 윗면 'SLANG' 각인 텍스처를 굽는다.

원본 GLB의 각인 노멀맵은 글자 테두리 1~2px짜리 선뿐이라 휴대폰 크기에서는 밉맵에 뭉개져 안 보였다.
여기서는 실제 도장처럼
  - 글자 안쪽으로 완만하게 파이는 넓은 경사(베벨)를 가진 높이맵을 만들고
  - 그 높이맵으로 노멀맵(soap_stamp_normal.png)과
  - 파인 곳을 살짝 어둡게 할 그늘 마스크(soap_stamp_cavity.png)를 만든다.

레이아웃은 원본 GLB 텍스처와 같다: 1536x1024 아틀라스의 오른쪽 위 512x512 칸이 윗면,
칸 가장자리 1.5% 여백, 칸이 실제 104 x 66 mm에 대응.
노멀 부호도 원본과 같다: R = -dh/dx, G = +dh/d(아래쪽 행).

사용: python3 scripts/make-stamp.py
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "models"
FONT = ROOT / "node_modules" / "pretendard" / "dist" / "public" / "static" / "Pretendard-SemiBold.otf"

TEXT = "SLANG"
W_MM, H_MM = 104.0, 66.0  # 비누 윗면 실제 크기
TEXT_W_MM = 50.0  # 글자 전체 폭 (원본 약 37mm → 조금 키움)
TRACKING = 0.14  # 자간 (글자 크기 대비)
DEPTH_MM = 0.45  # 파인 깊이 (보이기 위한 과장 포함)
BEVEL_MM = 0.55  # 가장자리 경사 폭
PPM = 24  # 작업 해상도 (px/mm)

ATLAS_W, ATLAS_H, TILE = 1536, 1024, 512
MARGIN, SPAN = 0.015, 0.97


def text_mask() -> Image.Image:
    w, h = int(W_MM * PPM), int(H_MM * PPM)
    font_px = 100
    font = ImageFont.truetype(str(FONT), font_px)

    def layout(size):
        f = ImageFont.truetype(str(FONT), size)
        adv = [f.getlength(c) for c in TEXT]
        total = sum(adv) + TRACKING * size * (len(TEXT) - 1)
        return f, adv, total

    font, adv, total = layout(font_px)
    font_px = int(font_px * (TEXT_W_MM * PPM) / total)
    font, adv, total = layout(font_px)

    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    asc, desc = font.getmetrics()
    top, bottom = font.getbbox("SLANG")[1], font.getbbox("SLANG")[3]
    y = h / 2 - (top + bottom) / 2
    x = (w - total) / 2
    for c, a in zip(TEXT, adv):
        d.text((x, y), c, font=font, fill=255)
        x += a + TRACKING * font_px
    return img


def main():
    mask = text_mask()
    # 가장자리 경사: 블러로 둥근 베벨을 만든 뒤, 안쪽은 평평한 바닥
    soft = mask.filter(ImageFilter.GaussianBlur(BEVEL_MM * PPM * 0.5))
    m = np.asarray(soft).astype(np.float32) / 255.0
    m = np.clip((m - 0.08) / 0.84, 0, 1)
    m = m * m * (3 - 2 * m)  # smoothstep
    height = -DEPTH_MM * m

    # 물리 단위(mm) 기울기. 행은 아래로 증가.
    dh_drow, dh_dx = np.gradient(height, 1.0 / PPM, 1.0 / PPM)
    nx, ny = -dh_dx, dh_drow

    # 그늘: 파인 바닥은 은은하게, 경사면은 조금 더 어둡게
    slope = np.clip(np.hypot(nx, ny) / 1.2, 0, 1)
    cavity = np.clip(0.55 * m + 0.6 * slope, 0, 1)

    # 칸(512px) 크기로 줄여 아틀라스 오른쪽 위에 배치
    inner = int(round(TILE * SPAN))
    off = int(round(TILE * MARGIN))

    def to_tile(a):
        im = Image.fromarray(a.astype(np.float32), mode="F").resize((inner, inner), Image.BOX)
        return np.asarray(im)

    tnx, tny, tcav = to_tile(nx), to_tile(ny), to_tile(cavity)

    normal = np.zeros((ATLAS_H, ATLAS_W, 3), np.float32)
    normal[..., 2] = 1.0
    cav = np.zeros((ATLAS_H, ATLAS_W), np.float32)
    x0, y0 = 2 * TILE + off, 0 + off
    normal[y0 : y0 + inner, x0 : x0 + inner, 0] = tnx
    normal[y0 : y0 + inner, x0 : x0 + inner, 1] = tny
    cav[y0 : y0 + inner, x0 : x0 + inner] = tcav

    n = normal / np.linalg.norm(normal, axis=2, keepdims=True)
    rgb = np.clip(np.round((n * 0.5 + 0.5) * 255), 0, 255).astype(np.uint8)
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb, "RGB").save(OUT / "soap_stamp_normal.png", optimize=True)
    Image.fromarray(np.round(cav * 255).astype(np.uint8), "L").save(OUT / "soap_stamp_cavity.png", optimize=True)

    tile_dev = np.hypot(tnx, tny)
    print(f"font {FONT.name}, 글자 폭 {TEXT_W_MM}mm, 깊이 {DEPTH_MM}mm")
    print(f"칸 안에서 각인이 차지하는 비율 {(tile_dev > 0.05).mean() * 100:.1f}% (원본 1.9%)")


if __name__ == "__main__":
    main()
