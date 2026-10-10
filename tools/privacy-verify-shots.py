"""脱敏核验：把每张截图的下半部分（含提示条/详情栏文件行所在区域）拼成一张图，
人眼确认没有残留的本机路径。用法：python tools/privacy-verify-shots.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
OUT = os.path.join(ROOT, "tmp", "privacy-bottom-sheet.png")
BAND = 320  # 取每张图底部这么多像素

files = sorted(f for f in os.listdir(SHOTS) if f.lower().endswith(".png"))
tiles = []
for name in files:
    img = Image.open(os.path.join(SHOTS, name)).convert("RGB")
    w, h = img.size
    crop = img.crop((0, max(0, h - BAND), w, h))
    # 缩到宽 900 便于一屏看完
    scale = 900 / crop.width
    crop = crop.resize((900, max(1, int(crop.height * scale))), Image.LANCZOS)
    tiles.append((name, crop))

W = 900
H = sum(t[1].height + 20 for t in tiles) + 10
sheet = Image.new("RGB", (W + 20, H), (240, 240, 240))
draw = ImageDraw.Draw(sheet)
y = 10
for name, crop in tiles:
    draw.text((10, y), name, fill=(0, 0, 0))
    y += 18
    sheet.paste(crop, (10, y))
    y += crop.height + 2

os.makedirs(os.path.dirname(OUT), exist_ok=True)
sheet.save(OUT)
print(f"核验图已生成：{OUT}  尺寸 {sheet.size}")
