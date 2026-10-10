"""隐私体检：把每张界面截图里"可能出现路径/提示文字"的区域裁出来拼成一张对比图，便于一眼看清。
用法：python tools/privacy-scan-shots.py
"""
import os
import sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
OUT = os.path.join(ROOT, "tmp", "privacy-contact-sheet.png")

# 关注区域：右下角提示条（toast）与顶部标题栏、左侧栏底部——截图里的路径通常出现在提示条
REGIONS = [
    ("右下提示条", (1020, 600, 1440, 880)),
    ("顶部标题栏", (0, 0, 1440, 60)),
    ("左侧栏底部", (0, 780, 240, 900)),
]

files = sorted(f for f in os.listdir(SHOTS) if f.lower().endswith(".png") and not f.endswith(".tmp"))
print(f"共 {len(files)} 张截图：{', '.join(files)}")

tiles = []
for name in files:
    img = Image.open(os.path.join(SHOTS, name)).convert("RGB")
    w, h = img.size
    for label, box in REGIONS:
        x0, y0, x1, y1 = box
        crop = img.crop((min(x0, w), min(y0, h), min(x1, w), min(y1, h)))
        tiles.append((f"{name} · {label}", crop))

# 拼图：每行两张
tw = max(t[1].width for t in tiles)
th = max(t[1].height for t in tiles)
cols = 2
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new("RGB", (cols * (tw + 10) + 10, rows * (th + 26) + 10), (245, 245, 245))
draw = ImageDraw.Draw(sheet)
for i, (label, crop) in enumerate(tiles):
    r, c = divmod(i, cols)
    x = 10 + c * (tw + 10)
    y = 10 + r * (th + 26)
    draw.text((x, y), label, fill=(20, 20, 20))
    sheet.paste(crop, (x, y + 18))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
sheet.save(OUT)
print(f"已生成对比图：{OUT}  尺寸 {sheet.size}")
