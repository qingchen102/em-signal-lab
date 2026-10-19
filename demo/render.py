# 把 _rec 里的帧、vo2 里的旁白合成成片：时间轴、转场、标题卡、目录卡、字幕。
# 用法： python demo/render.py
# 前置： node demo/record.js 录好帧；python demo/vo_make.py 生成旁白与 srt
import json
import math
import os
import re
import shutil
import subprocess
import sys
import wave

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
REC = os.path.join(ROOT, "_rec")
VO = os.path.join(ROOT, "vo2")
SEQ = os.path.join(REC, "seq")
FPS = 25
SR = 24000
FONT = "Microsoft YaHei"
OUT = os.path.join(ROOT, os.pardir, "submission", "信号实验室-demo.mp4")

# 每章的标题卡：名字 + 一句解释
TITLES = {
    "00": ("信号实验室", "五台仪器、一个网页，双击就能跑"),
    "01": ("信号发生器", "决定送进电路的是什么"),
    "02": ("示波器", "决定你看到的是什么"),
    "03": ("频谱仪", "同一时刻的信号，摊到频域"),
    "04": ("时频图", "频率什么时候在变"),
    "05": ("星座图", "一个符号能带几个比特"),
    "06": ("阵列测向", "波从哪个方向来"),
    "07": ("多径沙盒", "自己摆楼，路径实时重算"),
    "08": ("教师端", "出练习、看全班"),
    "09": ("纯前端，零依赖", "断网也能跑完整个演示"),
}

# 目录卡里的短名
SHORT = {
    "00": "开场：一台发射机，三个方向",
    "01": "信号发生器",
    "02": "示波器",
    "03": "频谱仪",
    "04": "时频图",
    "05": "星座图",
    "06": "阵列测向",
    "07": "多径沙盒",
    "08": "教师端",
    "09": "收尾",
}


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if r.returncode != 0:
        print(r.stdout[-3000:])
        print(r.stderr[-3000:])
        raise SystemExit("失败: " + " ".join(str(c) for c in cmd[:6]))
    return r


def dur_of(p):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                      "-of", "csv=p=0", p]).stdout.strip())


def ts(sec):
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return "%d:%02d:%05.2f" % (h, m, s)


def mmss(sec):
    return "%d:%02d" % (int(sec // 60), int(round(sec % 60)))


def ass_head():
    return """[Script Info]
ScriptType: v4.00+
PlayResX: 1440
PlayResY: 900
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,%s,33,&H00FFFFFF,&H00FFFFFF,&H00101014,&H96000000,0,0,0,0,100,100,0.6,0,1,2.6,0.8,2,90,90,104,1
Style: Card,%s,44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0.4,0,1,2.2,1.2,7,0,0,0,1
Style: Card2,%s,24,&H00D8E4F2,&H00D8E4F2,&H00000000,&H00000000,0,0,0,0,100,100,0.3,0,1,1.6,0.8,7,0,0,0,1
Style: AgT,%s,34,&H0074B9FF,&H0074B9FF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,1.8,0,7,0,0,0,1
Style: AgK,%s,26,&H0090A4BC,&H0090A4BC,&H00000000,&H00000000,0,0,0,0,100,100,0.4,0,1,1.4,0,4,0,0,0,1
Style: AgV,%s,28,&H00E6EEF8,&H00E6EEF8,&H00000000,&H00000000,0,0,0,0,100,100,0.4,0,1,1.4,0,4,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" % ((FONT,) * 6)


def esc(s):
    return s.replace("\\", "\\\\").replace("{", "(").replace("}", ")")


def parse_srt(p):
    txt = open(p, encoding="utf-8-sig").read().replace("\r\n", "\n")
    out = []
    for blk in re.split(r"\n\s*\n", txt.strip()):
        lines = [l for l in blk.split("\n") if l.strip()]
        if len(lines) < 3:
            continue
        m = re.match(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)", lines[1])
        if not m:
            continue
        g = [int(x) for x in m.groups()]
        a = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000.0
        b = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000.0
        out.append((a, b, "".join(lines[2:])))
    return out


def split_long(text, limit=18):
    """把一句按标点切成不超过 limit 字的几段，按字数分配时长。"""
    if len(text) <= limit:
        return [text]
    parts, cur = [], ""
    for ch in text:
        cur += ch
        if ch in "，。；：、？！" and len(cur) >= limit - 6:
            parts.append(cur)
            cur = ""
    if cur:
        parts.append(cur)
    out = []
    for p in parts:
        while len(p) > limit + 6:
            out.append(p[:limit])
            p = p[limit:]
        if p:
            out.append(p)
    return out


def main():
    meta = json.load(open(os.path.join(REC, "meta.json"), encoding="utf-8"))
    frames = json.load(open(os.path.join(REC, "frames.json"), encoding="utf-8"))
    t0 = meta["t0"]
    total = meta["totalMs"] / 1000.0
    marks = {k: (v - t0) / 1000.0 for k, v in meta["marks"].items()}
    keys = sorted(marks)
    print("总长 %.2fs" % total, "章节", " ".join("%s=%.1f" % (k, marks[k]) for k in keys))

    # ---- 1. 按 25fps 选帧，硬链接成序列
    if os.path.isdir(SEQ):
        shutil.rmtree(SEQ)
    os.makedirs(SEQ)
    n = int(round(total * FPS))
    j = 0
    for i in range(n):
        t = i * 1000.0 / FPS
        while j + 1 < len(frames) and frames[j + 1][1] - t0 <= t:
            j += 1
        dst = os.path.join(SEQ, "%05d.jpg" % (i + 1))
        try:
            os.link(frames[j][0], dst)
        except OSError:
            shutil.copyfile(frames[j][0], dst)
    print("序列 %d 帧" % n)

    # ---- 2. 音轨：旁白按章节起点摆放，章节交界一声轻过渡，整体 loudnorm
    spans = []
    for i, k in enumerate(keys):
        b = marks[keys[i + 1]] if i + 1 < len(keys) else total
        spans.append((k, marks[k], b))
    track = []
    for k, a, b in spans:
        wav = os.path.join(REC, "%s.wav" % k)
        run(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(VO, k + ".mp3"),
             "-af", "highpass=f=70,lowpass=f=9000,aresample=%d" % SR,
             "-ac", "1", "-ar", str(SR), wav])
        w = wave.open(wav, "rb")
        data = w.readframes(w.getnframes())
        w.close()
        want = int(round((b - a) * SR)) * 2
        if len(data) < want:
            data = data + b"\x00" * (want - len(data))
        elif len(data) > want:
            data = data[:want]
        track.append(data)
        print("  %s 旁白 %.2fs 章长 %.2fs" % (k, len(data) / 2.0 / SR, b - a))
    voice = b"".join(track)

    rnd = 20261018

    def noise():
        nonlocal rnd
        rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
        return rnd / 0x3FFFFFFF - 1.0

    nf, amp = 240, 0.018
    lp, whoosh = 0.0, []
    for i in range(int(nf * SR / 1000.0)):
        x = i / (nf * SR / 1000.0)
        lp = lp * 0.75 + noise() * 0.25
        whoosh.append(lp * (math.sin(math.pi * x) ** 1.6) * amp)

    buf = [0.0] * (len(voice) // 2)
    for k, a, b in spans:
        if k == keys[0]:
            continue
        at = int(round(a * SR))
        for i, v in enumerate(whoosh):
            p = at + i
            if 0 <= p < len(buf):
                buf[p] += v

    mixed = bytearray(len(voice))
    for i in range(len(buf)):
        v = int(max(-1.0, min(1.0, buf[i])) * 32767)
        mixed[i * 2:i * 2 + 2] = (v & 0xFFFF).to_bytes(2, "little")
    final = bytearray(len(voice))
    for i in range(0, len(voice), 2):
        a = int.from_bytes(voice[i:i + 2], "little", signed=True)
        b = int.from_bytes(mixed[i:i + 2], "little", signed=True)
        v = max(-32768, min(32767, a + b))
        final[i:i + 2] = (v & 0xFFFF).to_bytes(2, "little")

    raw = os.path.join(REC, "mix.wav")
    w = wave.open(raw, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(bytes(final))
    w.close()
    run(["ffmpeg", "-v", "error", "-y", "-i", raw,
         "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", str(SR), "-ac", "1",
         os.path.join(REC, "mix_norm.wav")])
    print("音轨 %.2fs" % (len(final) / 2.0 / SR))

    # ---- 3. 字幕：srt 逐句，超过 18 字按标点切开，整体加上章节起点
    subs = []
    for k, a, b in spans:
        cues = parse_srt(os.path.join(VO, k + ".srt"))
        for ca, cb, text in cues:
            pieces = split_long(text)
            tot = sum(len(p) for p in pieces) or 1
            t = ca
            for p in pieces:
                d = (cb - ca) * len(p) / tot
                s, e = a + t, a + t + d
                if e - s > 0.6:
                    subs.append((s, e, p))
                t += d
    subs.sort()
    print("字幕 %d 条" % len(subs))

    # ---- 4. 组装 ASS：转场、标题卡、目录卡、字幕
    ev = []
    BLACK = "{\\an5\\pos(720,450)\\p1\\bord0\\shad0\\1c&H000000&\\fad(150,150)}m 0 0 l 1440 0 1440 900 0 900"
    for k in keys[1:]:
        m = marks[k]
        ev.append("Dialogue: 2,%s,%s,Sub,,0,0,0,,%s" % (ts(max(0, m - 0.17)), ts(m + 0.17), BLACK))

    # 标题卡：章节开始 0.24s 后出现，停 2.8s
    for k in keys:
        name, line = TITLES[k]
        s = marks[k] + 0.24
        e = s + 2.85
        box = ("{\\an7\\pos(356,116)\\p1\\bord0\\shad0\\1c&H2E2014&\\alpha&H08&\\fad(140,260)}"
               "m 0 0 l 712 0 712 152 0 152")
        bar = ("{\\an7\\pos(356,116)\\p1\\bord0\\shad0\\1c&HFFB974&\\fad(140,260)}"
               "m 0 0 l 4 0 4 152 0 152")
        nm = "{\\an7\\pos(386,138)\\fad(140,260)}%s" % esc(name)
        ln = "{\\an7\\pos(388,196)\\fad(180,260)}%s" % esc(line)
        for layer, txt in ((3, box), (4, bar), (5, nm), (6, ln)):
            st = "Card" if layer == 5 else ("Card2" if layer == 6 else "Sub")
            ev.append("Dialogue: %d,%s,%s,%s,,0,0,0,,%s" % (layer, ts(s), ts(e), st, txt))

    # 目录卡：第 00 章里，念到「下面是这一节的时间点」之后出现，到 00 章结束前消失
    ag_in = marks["00"] + 24.6
    ag_out = marks[keys[1]] - 0.5 if len(keys) > 1 else total - 2
    panel = ("{\\an7\\pos(300,140)\\p1\\bord0\\shad0\\1c&H20160E&\\alpha&H04&\\fad(260,300)}"
             "m 0 0 l 840 0 840 580 0 580")
    edge = ("{\\an7\\pos(300,140)\\p1\\bord0\\shad0\\1c&HFFB974&\\fad(260,300)}"
            "m 0 0 l 4 0 4 580 0 580")
    head = "{\\an7\\pos(344,182)\\fad(260,300)}这一节的时间点"
    sub = "{\\an7\\pos(346,232)\\fad(300,300)}全长 %s，共 %d 段" % (mmss(total), len(keys))
    ev.append("Dialogue: 7,%s,%s,Sub,,0,0,0,,%s" % (ts(ag_in), ts(ag_out), panel))
    ev.append("Dialogue: 8,%s,%s,Sub,,0,0,0,,%s" % (ts(ag_in), ts(ag_out), edge))
    ev.append("Dialogue: 9,%s,%s,AgT,,0,0,0,,%s" % (ts(ag_in), ts(ag_out), head))
    ev.append("Dialogue: 9,%s,%s,AgK,,0,0,0,,%s" % (ts(ag_in), ts(ag_out), sub))
    y = 292
    for k in keys:
        t = "{\\an4\\pos(436,%d)\\fad(320,300)}%s" % (y, mmss(marks[k]))
        v = "{\\an4\\pos(548,%d)\\fad(320,300)}%s" % (y, esc(SHORT[k]))
        ev.append("Dialogue: 9,%s,%s,AgK,,0,0,0,,%s" % (ts(ag_in), ts(ag_out), t))
        ev.append("Dialogue: 9,%s,%s,AgV,,0,0,0,,%s" % (ts(ag_in), ts(ag_out), v))
        y += 38

    for s, e, text in subs:
        ev.append("Dialogue: 1,%s,%s,Sub,,0,0,0,,{\\fad(60,60)}%s" % (ts(s), ts(e), esc(text)))

    ass = os.path.join(REC, "subs.ass")
    open(ass, "w", encoding="utf-8").write(ass_head() + "\n".join(ev) + "\n")
    print("ASS %d 行" % len(ev))

    # ---- 5. 编码（在 _rec 里跑，避开路径里的冒号）
    run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", "seq/%05d.jpg",
         "-i", "mix_norm.wav", "-vf", "ass=subs.ass",
         "-map", "0:v:0", "-map", "1:a:0",
         "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p",
         "-r", str(FPS), "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
         "-movflags", "+faststart", "-t", "%.3f" % total, OUT], cwd=REC)
    print("成片 %.2fs %.1f MB" % (dur_of(OUT), os.path.getsize(OUT) / 1048576.0))


main()
