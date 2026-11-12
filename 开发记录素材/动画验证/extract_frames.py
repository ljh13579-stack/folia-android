import os
import imageio.v2 as imageio
import numpy as np

VID = r"D:\claude\folia-android\build\anim-verify\anim_rec.mp4"
OUT = r"D:\claude\folia-android\build\anim-verify\frames"
os.makedirs(OUT, exist_ok=True)

r = imageio.get_reader(VID)
meta = r.get_meta_data()
fps = float(meta.get("fps", 30))
print(f"fps={fps:.2f} duration={meta.get('duration')} size={meta.get('size')}")

rows = []
prev = None
i = 0
for frame in r:
    h, w = frame.shape[:2]
    g = frame.mean(axis=2)
    mb = float(g.mean())
    # 右上角区域（顶部 4%~20% 高、右侧 82%~100% 宽）：灯泡所在处
    tr = g[int(0.04 * h):int(0.20 * h), int(0.82 * w):]
    bright = tr > 60
    cnt = int(bright.sum())
    xs = np.where(bright.any(axis=0))[0]
    rightmost = int(xs.max()) if len(xs) else -1  # 区域内最右亮像素（相对区域左缘）
    diff = float(np.abs(g - prev).mean()) if prev is not None else 0.0
    prev = g
    # 保存缩略帧（每帧都存，小图）
    th = frame[::6, ::6]
    imageio.imwrite(os.path.join(OUT, f"t{i:04d}.jpg"), th, quality=70)
    rows.append((i, i / fps, mb, cnt, rightmost, diff))
    i += 1

r.close()
print(f"total_frames={i}")
# 关键时间线：亮度/content 出现、右上角灯泡出现、帧间变化大的时刻
first_bulb = next((r for r in rows if r[3] > 50), None)
print(f"first_bulb_frame={first_bulb}")
print("t(s)  bright  diff")
for r0 in rows:
    if r0[5] > 3.0 or r0[0] % 20 == 0:
        print(f"{r0[1]:6.2f}  bulb_right={r0[4]:4d}  cnt={r0[3]:6d}  diff={r0[5]:6.2f}")
