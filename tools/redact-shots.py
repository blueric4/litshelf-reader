"""截图隐私处理：
① 统一裁掉底部若干像素（详情栏「文件」行会显示本机完整路径）；
② 对提示条区域做像素化（提示条里出现过本机账户路径）。
用法：python tools/redact-shots.py [--check]
"""
import os
import sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
CROP_BOTTOM = 42  # 底部裁掉的像素（盖住详情栏「文件」行里的完整路径）
# 提示条只出现在左下/右下两个角：为稳妥起见，所有截图统一把这两块打码
BLUR_ALL = [
    (0, 660, 258, 858),      # 左下（含提示条、侧栏底部）
    (1010, 560, 1440, 858),  # 右下（含提示条栈）
]
PLANS = {name: list(BLUR_ALL) for name in (
    "01-onboarding.png",
    "02-library.png",
    "03-detail.png",
    "04-reader.png",
    "05-live-add.png",
    "10-selection-toolbar.png",
    "11-annotation.png",
    "12-dark-mode.png",
    "13-cjk-selection.png",
    "14-cjk-acceptance.png",
)}
BLOCK = 16
check_only = "--check" in sys.argv

if not check_only:
    # 先把上一轮打歪的区域恢复？无法恢复——上一轮已改到文件里，这里只做"再处理"。
    pass

for name in sorted(f for f in os.listdir(SHOTS) if f.lower().endswith(".png")):
    path = os.path.join(SHOTS, name)
    img = Image.open(path).convert("RGB")
    w, h = img.size
    actions = []
    for (x0, y0, x1, y1) in PLANS.get(name, []):
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(w, x1), min(h - CROP_BOTTOM, y1)
        if x1 <= x0 or y1 <= y0:
            continue
        actions.append(f"打码 ({x0},{y0})-({x1},{y1})")
        if not check_only:
            region = img.crop((x0, y0, x1, y1))
            bw = max(1, region.width // BLOCK)
            bh = max(1, region.height // BLOCK)
            region = region.resize((bw, bh), Image.BILINEAR).resize((region.width, region.height), Image.NEAREST)
            img.paste(region, (x0, y0))
    if h > CROP_BOTTOM:
        actions.append(f"裁掉底部 {CROP_BOTTOM}px")
        if not check_only:
            img = img.crop((0, 0, w, h - CROP_BOTTOM))
    if actions:
        print(f"  {name}：{'；'.join(actions)}")
    if not check_only and actions:
        img.save(path)
print("完成" + ("（仅检查，未改文件）" if check_only else "：已处理"))
