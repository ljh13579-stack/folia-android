import sys
import imageio.v2 as imageio
import numpy as np

VID = sys.argv[1]
r = imageio.get_reader(VID)
fps = float(r.get_meta_data().get("fps", 30))
prev = None
i = 0
events = []
for frame in r:
    g = frame.mean(axis=2).astype(np.int16)
    diff = float(np.abs(g - prev).mean()) if prev is not None else 0.0
    prev = g
    if diff > 1.5:
        events.append((i / fps, diff, i))
    i += 1
# 合并相邻事件为运动区间
print(f"frames={i} fps={fps:.1f}")
if events:
    segs = []
    s = events[0]
    for t, d, idx in events[1:]:
        if t - s[0] <= 0.25:
            s = (s[0], max(s[1], d), s[2])
        else:
            segs.append(s)
            s = (t, d, idx)
    segs.append(s)
    for t0, dmax, idx in segs:
        print(f"motion {t0:6.2f}s ~ diff_max={dmax:5.1f} (frame {idx})")
else:
    print("no motion detected")
