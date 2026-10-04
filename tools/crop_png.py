"""最小 PNG 解码/裁剪工具（无第三方依赖）。

用途：把 adb screencap 的截图放大局部，确认界面残影是本应用的 bug
还是系统叠加层（MIUI 侧边栏等）。

只支持 screencap 常见格式：8bit RGBA/RGB，非隔行。
"""

import struct
import sys
import zlib


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a png"
    pos = 8
    width = height = None
    bit_depth = color_type = None
    idat = bytearray()
    while pos < len(data):
        (ln,) = struct.unpack(">I", data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            width, height, bit_depth, color_type, comp, filt, interlace = struct.unpack(">IIBBBBB", body)
            assert bit_depth == 8, f"unsupported bit depth {bit_depth}"
            assert interlace == 0, "interlaced not supported"
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[color_type]
    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    out = bytearray(height * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:      # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif f == 2:    # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:    # Average
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:    # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return width, height, channels, out


def write_png(path, width, height, channels, pix):
    color_type = {1: 0, 3: 2, 4: 6}[channels]
    raw = bytearray()
    stride = width * channels
    for y in range(height):
        raw.append(0)
        raw += pix[y * stride:(y + 1) * stride]

    def chunk(typ, body):
        return (struct.pack(">I", len(body)) + typ + body +
                struct.pack(">I", zlib.crc32(typ + body) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


def crop_zoom(src, dst, x0, y0, x1, y1, zoom=2):
    w, h, ch, pix = read_png(src)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)
    cw, chh = x1 - x0, y1 - y0
    ow, oh = cw * zoom, chh * zoom
    out = bytearray(ow * oh * ch)
    for oy in range(oh):
        sy = y0 + oy // zoom
        srow = (sy * w + x0) * ch
        drow = oy * ow * ch
        for ox in range(ow):
            s = srow + (ox // zoom) * ch
            d = drow + ox * ch
            out[d:d + ch] = pix[s:s + ch]
    write_png(dst, ow, oh, ch, out)
    print(f"cropped ({x0},{y0})-({x1},{y1}) -> {ow}x{oh} => {dst}")


if __name__ == "__main__":
    crop_zoom(sys.argv[1], sys.argv[2], *[int(v) for v in sys.argv[3:7]],
              zoom=int(sys.argv[7]) if len(sys.argv) > 7 else 2)
