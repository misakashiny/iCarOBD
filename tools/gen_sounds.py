"""生成 OBD 仪表盘用的低延迟音效（无第三方依赖，纯标准库）。

输出到 `app/src/main/res/raw/`，与 `app/src/main/java/com/icar/obd/data/SoundPresets.kt`
里的预设表**一一对应**（那张表是"有哪些音效"的唯一权威）。

| 文件 | 语义 | 时长 | 采样率 |
|---|---|---|---|
| `tick_left.wav`  | 左转向「咔嗒」（中低频短脉冲） | 55 ms | 44100 |
| `tick_right.wav` | 右转向「咔嗒」（略高，便于听辨左右） | 55 ms | 44100 |
| `beep.wav`       | 提示「哔」（单声） | 130 ms | 22050 |
| `ding.wav`       | 轻提示「叮」（钟状单音） | 220 ms | 22050 |
| `dingdong.wav`   | 叮咚（双音，门铃） | 400 ms | 22050 |
| `success.wav`    | 成功「上行」（C5→G5） | 300 ms | 22050 |
| `fail.wav`       | 失败「下行」（G4→C4） | 320 ms | 22050 |
| `warn.wav`       | 警告（三声急促） | 430 ms | 22050 |
| `alert.wav`      | 严重告警（低频方波双响） | 400 ms | 22050 |

## 设计约束

  · **时长尽量短**（tick < 60ms），SoundPool 起播才跟得上转向灯节奏
  · **每个文件 ≤ 20 KB**（22050Hz / 16bit / 单声道 = 44 字节/毫秒 → 时长 ≤ 440ms）
  · 峰值归一化到 **-1dBFS**，避免削波破音
  · 首尾都做淡入淡出，消除爆音
  · **全部由代码合成**（正弦/方波 + 指数包络）—— 不下载任何外部音频：
    版权干净，而且重跑脚本能得到**逐字节相同**的 wav（可复现）

跑法（工程根目录）：

    python tools/gen_sounds.py
"""

import math
import os
import random
import struct
import wave

SR = 44100
#: 除了转向灯咔嗒，其余都用它 —— 体积减半，而这些音最高才 1.6 kHz，听不出差别
SR_LOW = 22050

# 脚本位于 <project>/tools/，资源目录是 <project>/app/src/main/res/raw
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(PROJECT_ROOT, "app", "src", "main", "res", "raw")

#: 每个文件的上限（SoundPresetsTest 会逐个量，超了就红）
MAX_BYTES = 20 * 1024


def write_wav(path, samples, sr):
    """写 16bit 单声道 PCM，峰值归一化到 -1dBFS。返回文件字节数。"""
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
        w.setframerate(sr)
        w.writeframes(data)
    total = len(data) + 44
    flag = "  <-- 超 20 KB！" if total > MAX_BYTES else ""
    print(f"  {os.path.basename(path):16s} {len(samples)/sr*1000:6.1f} ms  "
          f"{sr:5d} Hz  {total:6d} bytes{flag}")
    return total


# ---------------------------------------------------------------- 合成基元

def silence(ms, sr=SR):
    return [0.0] * int(sr * ms / 1000)


def _edges(n, fade):
    """首尾淡入淡出（采样数）。返回每点的系数。"""
    for i in range(n):
        if i < fade:
            yield i / fade
        elif i > n - fade:
            yield (n - i) / fade
        else:
            yield 1.0


def tone(freq, ms, sr=SR, fade_ms=6.0, amp=0.8):
    """纯正弦 + 首尾淡入淡出。"""
    n = int(sr * ms / 1000)
    f = max(1, int(sr * fade_ms / 1000))
    out = []
    for i, e in enumerate(_edges(n, f)):
        t = i / sr
        out.append(math.sin(2 * math.pi * freq * t) * amp * e)
    return out


def bell(freq, ms, sr=SR_LOW, decay=13.0, fade_ms=8.0):
    """钟状：基频 + 三个非整数倍泛音，整体指数衰减（"叮"）。"""
    n = int(sr * ms / 1000)
    f = max(1, int(sr * fade_ms / 1000))
    partials = ((1.0, 1.0), (2.01, 0.42), (3.0, 0.18), (4.76, 0.09))
    out = []
    for i, e in enumerate(_edges(n, f)):
        t = i / sr
        env = math.exp(-decay * t) * e
        s = sum(a * math.sin(2 * math.pi * freq * m * t) for m, a in partials)
        out.append(s * env)
    return out


def buzz(freq, ms, sr=SR_LOW, fade_ms=5.0, amp=0.75):
    """近似方波（奇次谐波叠加）。比正弦刺耳得多 —— 留给"严重"档。"""
    n = int(sr * ms / 1000)
    f = max(1, int(sr * fade_ms / 1000))
    out = []
    for i, e in enumerate(_edges(n, f)):
        t = i / sr
        s = (math.sin(2 * math.pi * freq * t)
             + math.sin(2 * math.pi * freq * 3 * t) / 3.0
             + math.sin(2 * math.pi * freq * 5 * t) / 5.0)
        out.append(s * amp * e)
    return out


def click(freq, ms, sr=SR, noise=0.55, decay=90.0, seed=1):
    """继电器式咔嗒：阻尼正弦 + 短噪声脉冲。"""
    random.seed(seed)
    n = int(sr * ms / 1000)
    out = []
    for i in range(n):
        t = i / sr
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


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print("生成音效 →", OUT_DIR)

    total = 0

    # ---- 转向灯：44100Hz。咔嗒的"咔"在 11kHz 以上还有能量，降采样会变闷；
    #      但它只有 55ms（不到 2.5 KB），留着高频不心疼。
    total += write_wav(os.path.join(OUT_DIR, "tick_left.wav"), click(1500, 55, seed=1), SR)
    total += write_wav(os.path.join(OUT_DIR, "tick_right.wav"), click(2100, 55, seed=7), SR)

    # ---- 轻提示
    total += write_wav(os.path.join(OUT_DIR, "beep.wav"), tone(880, 130, SR_LOW), SR_LOW)
    total += write_wav(os.path.join(OUT_DIR, "ding.wav"), bell(1568, 220), SR_LOW)
    total += write_wav(
        os.path.join(OUT_DIR, "dingdong.wav"),
        bell(1319, 170) + silence(30, SR_LOW) + bell(1047, 200),
        SR_LOW,
    )

    # ---- 成功 / 失败：两音，只差音高方向 —— 听感上一听就知道成没成
    total += write_wav(
        os.path.join(OUT_DIR, "success.wav"),
        tone(523, 110, SR_LOW) + silence(30, SR_LOW) + tone(784, 160, SR_LOW),
        SR_LOW,
    )
    total += write_wav(
        os.path.join(OUT_DIR, "fail.wav"),
        tone(392, 120, SR_LOW) + silence(30, SR_LOW) + tone(262, 170, SR_LOW),
        SR_LOW,
    )

    # ---- 警告 / 严重
    total += write_wav(
        os.path.join(OUT_DIR, "warn.wav"),
        tone(1000, 90, SR_LOW) + silence(55, SR_LOW)
        + tone(1000, 90, SR_LOW) + silence(55, SR_LOW)
        + tone(1250, 140, SR_LOW),
        SR_LOW,
    )
    total += write_wav(
        os.path.join(OUT_DIR, "alert.wav"),
        buzz(233, 140) + silence(60, SR_LOW) + buzz(196, 200),
        SR_LOW,
    )

    print(f"合计 {total} bytes（{total/1024:.1f} KB，上限 {MAX_BYTES} bytes/个）")
    print("完成")


if __name__ == "__main__":
    main()
