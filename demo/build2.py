# 用已有的画面（成片里的视频轨）重做音轨并烧字幕。
# 用法： python demo/build2.py
import json
import math
import os
import re
import subprocess
import sys
import wave

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
VO = os.path.join(ROOT, "vo2")
SR = 24000
VOICE = "zh-CN-YunxiNeural"
RATE = "+4%"
FONT = "Microsoft YaHei"

# 章节起点（秒），来自录制时的 marks
MARKS = [
    ("00", 0.000), ("01", 7.100), ("02", 20.500), ("03", 31.600), ("04", 38.150),
    ("05", 48.050), ("06", 54.900), ("07", 63.150), ("08", 71.150), ("09", 87.950),
]
TOTAL = 94.068

TITLES = {
    "00": ("信号实验室", "五台仪器、一个网页，双击就能跑"),
    "01": ("混叠", "1 kHz 的信号，屏幕上却是一条 500 Hz 的波"),
    "02": ("方波与谐波", "谐波一条一条落在基波的整数倍上"),
    "03": ("带宽限制", "砍掉高次谐波，方波自己变圆"),
    "04": ("多径沙盒", "只有一台发射机，阵列却报出三个方向"),
    "05": ("直达被挡", "只剩一条反射，测出来的方向偏了 43 度"),
    "06": ("教师端", "88 份成绩单，全班卡在哪一道题上一眼看到"),
    "07": ("出练习", "按知识点和难度出卷，答案与讲解一起生成"),
    "08": ("AI 助教", "拿着屏幕上的数字讲，不编"),
    "09": ("纯前端，零依赖", "断网也能跑完整个演示"),
}

VIDEO = os.path.join(ROOT, os.pardir, "submission", "信号实验室-demo.mp4")
OUT = os.path.join(ROOT, os.pardir, "submission", "_new-demo.mp4")


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if r.returncode != 0:
        print(r.stdout[-3000:])
        print(r.stderr[-3000:])
        raise SystemExit("失败: " + " ".join(str(c) for c in cmd[:5]))
    return r


def dur_of(path):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                      "-of", "csv=p=0", path]).stdout.strip())


def read_srt(path):
    """返回 [(start, end, text)]，时间是秒。"""
    raw = open(path, encoding="utf-8-sig").read().replace("\r\n", "\n")
    cues = []
    for block in re.split(r"\n\s*\n", raw.strip()):
        lines = [l for l in block.split("\n") if l.strip()]
        if not lines:
            continue
        idx = 0
        if re.fullmatch(r"\d+", lines[0].strip()):
            idx = 1
        if idx >= len(lines) or "-->" not in lines[idx]:
            continue
        a, b = lines[idx].split("-->")
        text = " ".join(lines[idx + 1:]).strip()
        if text:
            cues.append((stamp(a), stamp(b), text))
    return cues


def stamp(s):
    s = s.strip().replace(",", ".")
    h, m, rest = s.split(":")
    return int(h) * 3600 + int(m) * 60 + float(rest)


def split_cue(start, end, text, limit=18):
    """把一句话切成每行不超过 limit 字，时长按字数比例分。"""
    parts, buf = [], ""
    for ch in text:
        buf += ch
        if len(buf) >= limit and ch in "，。；：、！？ ":
            parts.append(buf.strip())
            buf = ""
    if buf.strip():
        parts.append(buf.strip())
    if not parts:
        return []
    if len(parts) == 1 and len(parts[0]) <= limit * 2:
        return [(start, end, parts[0])]
    # 太长的单句按标点再切一次
    if len(parts) == 1:
        p = parts[0]
        parts = [p[i:i + limit] for i in range(0, len(p), limit)]
    total = sum(len(p) for p in parts) or 1
    out, t = [], start
    for p in parts:
        d = (end - start) * len(p) / total
        out.append((t, t + d, p))
        t += d
    return out


def ass_time(t):
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return "%d:%02d:%05.2f" % (h, m, s)


def main():
    texts = dict(json.load(open(os.path.join(ROOT, "vo", "texts.json"), encoding="utf-8")))
    os.makedirs(VO, exist_ok=True)

    # ---- 1. 逐章合成配音与字幕
    spans = []
    for i, (k, a) in enumerate(MARKS):
        b = MARKS[i + 1][1] if i + 1 < len(MARKS) else TOTAL
        spans.append((k, a, b))
        mp3 = os.path.join(VO, k + ".mp3")
        srt = os.path.join(VO, k + ".srt")
        run([sys.executable, "-m", "edge_tts", "--voice", VOICE, "--rate", RATE,
             "--text", texts[k], "--write-media", mp3, "--write-subtitles", srt])
        d = dur_of(mp3)
        flag = " 溢出!" if d > (b - a) - 0.15 else ""
        print("  %s 配音 %.2fs 章长 %.2fs%s" % (k, d, b - a, flag))

    # ---- 2. 音轨：配音按章节摆放，章节交界处一点过渡声
    track = []
    for k, a, b in spans:
        wav = os.path.join(VO, k + ".wav")
        run(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(VO, k + ".mp3"),
             "-ac", "1", "-ar", str(SR), "-af", "highpass=f=70,lowpass=f=9000", wav])
        w = wave.open(wav, "rb")
        data = w.readframes(w.getnframes())
        w.close()
        want = int(round((b - a) * SR)) * 2
        data = data + b"\x00" * (want - len(data)) if len(data) < want else data[:want]
        track.append(data)
    voice = b"".join(track)

    buf = [0.0] * (len(voice) // 2)
    for i in range(0, len(voice), 2):
        buf[i // 2] = int.from_bytes(voice[i:i + 2], "little", signed=True) / 32768.0

    rnd = 20261018

    def noise():
        nonlocal rnd
        rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
        return rnd / 0x3FFFFFFF - 1.0

    n = int(0.22 * SR)
    whoosh = []
    lp = 0.0
    for i in range(n):
        lp = lp * 0.86 + noise() * 0.14
        x = i / n
        whoosh.append(lp * math.sin(math.pi * x) ** 2 * 0.018)
    for k, a, b in spans:
        if k == "00":
            continue
        at = int(round(a * SR))
        for i, v in enumerate(whoosh):
            p = at + i
            if 0 <= p < len(buf):
                buf[p] += v

    mix = os.path.join(VO, "mix.wav")
    w = wave.open(mix, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(b"".join(int(max(-1.0, min(1.0, v)) * 32767).to_bytes(2, "little", signed=True)
                           for v in buf))
    w.close()
    norm = os.path.join(VO, "mix_norm.wav")
    run(["ffmpeg", "-v", "error", "-y", "-i", mix, "-af",
         "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", norm])
    print("音轨 %.2fs" % dur_of(norm))

    # ---- 3. 字幕（全局时间轴）
    head = """[Script Info]
ScriptType: v4.00+
PlayResX: 1440
PlayResY: 900
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,%s,33,&H00FFFFFF,&H00FFFFFF,&H00101014,&H96000000,0,0,0,0,100,100,0.6,0,1,2.6,0.8,2,90,90,104,1
Style: Card,%s,44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Dip,%s,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" % (FONT, FONT, FONT)
    lines = [head]
    count = 0

    # 转场：章节交界处压黑 0.5 秒
    for k, a, b in spans:
        if k == "00":
            continue
        lines.append(r"Dialogue: 0,%s,%s,Dip,,0,0,0,,{\an7\pos(0,0)\p1\1c&H000000&\fad(150,150)}"
                     r"m 0 0 l 1440 0 1440 900 0 900" % (ass_time(a - 0.17), ass_time(a + 0.17)))

    # 标题卡：章节名 + 一句话，压在画面上方
    for k, a, b in spans:
        name, one = TITLES[k]
        t0, t1 = a + 0.22, min(a + 3.05, b - 0.1)
        fade = r"\fad(260,380)"
        lines.append(r"Dialogue: 0,%s,%s,Card,,0,0,0,,{\an7\pos(356,116)\p1\1c&H20150E&\1a&H1C&%s}"
                     r"m 0 0 l 712 0 712 152 0 152" % (ass_time(t0), ass_time(t1), fade))
        lines.append(r"Dialogue: 0,%s,%s,Card,,0,0,0,,{\an7\pos(356,116)\p1\1c&HFFB974&\1a&H10&%s}"
                     r"m 0 0 l 5 0 5 152 0 152" % (ass_time(t0), ass_time(t1), fade))
        lines.append(r"Dialogue: 0,%s,%s,Card,,0,0,0,,{\an7\pos(384,134)\fs42\b1%s}%s  %s"
                     % (ass_time(t0), ass_time(t1), fade, k, name))
        lines.append(r"Dialogue: 0,%s,%s,Card,,0,0,0,,{\an7\pos(386,206)\fs24\c&H00D8D0C8&%s}%s"
                     % (ass_time(t0), ass_time(t1), fade, one))
    for k, a, b in spans:
        for s, e, text in read_srt(os.path.join(VO, k + ".srt")):
            for cs, ce, ct in split_cue(s, e, text):
                if ce - cs < 0.35:
                    ce = cs + 0.35
                lines.append("Dialogue: 0,%s,%s,Sub,,0,0,0,,%s" % (
                    ass_time(a + cs), ass_time(a + ce), ct.replace("{", "(").replace("}", ")")))
                count += 1
    ass = os.path.join(VO, "subs.ass")
    open(ass, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print("字幕 %d 条" % count)

    # ---- 4. 合成：视频轨重编码 + 新音轨 + 烧字幕（在 vo2 目录里跑，避开路径里的冒号）
    run(["ffmpeg", "-v", "error", "-y", "-i", VIDEO, "-i", "mix_norm.wav",
         "-vf", "ass=subs.ass",
         "-map", "0:v:0", "-map", "1:a:0",
         "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p",
         "-r", "25", "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
         "-movflags", "+faststart", "-t", "%.3f" % TOTAL, OUT], cwd=VO)
    print("成片 %.2fs %.1f MB" % (dur_of(OUT), os.path.getsize(OUT) / 1048576.0))


main()
