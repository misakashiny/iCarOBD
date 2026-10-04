"""生成 OBD 仪表盘用的低延迟音效（无第三方依赖，纯标准库）。

输出到 app/src/main/res/raw/：
  tick_left.wav  —— 左转向「咔嗒」声（中低频短脉冲）
  tick_right.wav —— 右转向「咔嗒」声（略高，便于听辨左右）
  warn.wav       —— 三声急促告警
  beep.wav       —— 单声提示

设计约束：
  · 时长尽量短（tick < 60ms），SoundPool 起播才跟得上转向灯节奏
  · 峰值归一化到 -1dBFS，避免削波破音
  · 16bit / 44.1kHz / 单声道，兼容性最好
"""

import math
import os
import random
import struct
import wave

SR = 44100
# 脚本位于 <project>/tools/，资源目录是 <project>/app/src/main/res/raw
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(PROJECT_ROOT, "app", "src", "main", "res", "raw")


def write_wav(path, samples):
    peak = max(1e-9, max(abs(s) for s in samples))
    target = 0.891  # -1 dBFS
    gain = target / peak
    data = b"".join(
        struct.pack("<h", max(-32768, min(32767, int(s * gain * 32767))))
        for s in samples
    )
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)
    print(f"  {os.path.basename(path):16s} {len(samples)/SR*1000:6.1f} ms  {len(data)+44:6d} bytes")


def click(freq, ms, noise=0.55, decay=90.0, seed=1):
    """继电器式咔嗒：阻尼正弦 + 短噪声脉冲。"""
    random.seed(seed)
    n = int(SR * ms / 1000)
    out = []
    for i in range(n):
        t = i / SR
        env = math.exp(-decay * t)
        # 阻尼正弦主体
        s = math.sin(2 * math.pi * freq * t) * 0.75
        # 起振瞬间的宽带噪声，让「咔」更真实
        if i < n * 0.18:
            s += (random.random() * 2 - 1) * noise
        # 尾部加一点高频，避免听起来太闷
        s += math.sin(2 * math.pi * freq * 2.7 * t) * 0.2 * env
        out.append(s * env)
    return out


def tone(freq, ms, fade_ms=6.0, amp=0.8):
    n = int(SR * ms / 1000)
    f = int(SR * fade_ms / 1000)
    out = []
    for i in range(n):
        t = i / SR
        s = math.sin(2 * math.pi * freq * t) * amp
        # 淡入淡出，消除爆音
        if i < f:
            s *= i / f
        elif i > n - f:
            s *= (n - i) / f
        out.append(s)
    return out


def silence(ms):
    return [0.0] * int(SR * ms / 1000)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print("生成音效 →", OUT_DIR)

    write_wav(os.path.join(OUT_DIR, "tick_left.wav"), click(1500, 55, seed=1))
    write_wav(os.path.join(OUT_DIR, "tick_right.wav"), click(2100, 55, seed=7))

    warn = tone(1000, 110) + silence(70) + tone(1000, 110) + silence(70) + tone(1250, 170)
    write_wav(os.path.join(OUT_DIR, "warn.wav"), warn)

    write_wav(os.path.join(OUT_DIR, "beep.wav"), tone(880, 130))

    print("完成")


if __name__ == "__main__":
    main()
