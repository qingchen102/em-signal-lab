# 把录屏帧 + 配音 + 音效合成成片。用法 python _build2.py
import json
import math
import os
import shutil
import subprocess
import sys
import wave

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
REC = os.path.join(ROOT, "_rec")
VO = os.path.join(ROOT, "vo")
SEQ = os.path.join(REC, "seq")
WAV = os.path.join(REC, "wav")
FPS = 25
SR = 24000

TITLES = {
    "00": "信号实验室",
    "01": "混叠",
    "02": "方波与谐波",
    "03": "带宽限制",
    "04": "多径沙盒",
    "05": "直达被挡",
    "06": "教师端",
    "07": "出练习",
    "08": "AI 助教",
    "09": "纯前端，零依赖",
}


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if r.returncode != 0:
        print(r.stdout[-2000:])
        print(r.stderr[-2000:])
        raise SystemExit("ffmpeg 失败: " + " ".join(cmd[:6]))
    return r


def main():
    meta = json.load(open(os.path.join(REC, "meta.json"), encoding="utf-8"))
    frames = json.load(open(os.path.join(REC, "frames.json"), encoding="utf-8"))
    t0 = meta["t0"]
    total = meta["totalMs"] / 1000.0

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
            shutil.copy(frames[j][0], dst)
    print("序列帧 %d 张，时长 %.2fs" % (n, n / FPS))

    # ---- 2. 配音：逐章解码、补静音到章长、拼接
    if os.path.isdir(WAV):
        shutil.rmtree(WAV)
    os.makedirs(WAV)
    marks = meta["marks"]
    keys = sorted(marks)
    spans = []
    for i, k in enumerate(keys):
        end = marks[keys[i + 1]] if i + 1 < len(keys) else meta["end"]
        spans.append((k, (marks[k] - t0) / 1000.0, (end - t0) / 1000.0))

    track = []
    for k, a, b in spans:
        wav = os.path.join(WAV, k + ".wav")
        run(["ffmpeg", "-y", "-v", "error", "-i", os.path.join(VO, k + ".mp3"),
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
        print("  %s 配音 %.2fs 章长 %.2fs" % (k, len(data) / 2.0 / SR, b - a))
    voice = b"".join(track)

    # ---- 3. 音效：点击 + 转场
    def env(i, ms, shape):
        x = i / (ms * SR / 1000.0)
        if shape == "click":
            return math.exp(-9.0 * x)
        return math.sin(math.pi * min(1.0, x)) ** 1.6 * math.exp(-1.2 * x)

    rnd = 12345

    def noise():
        nonlocal rnd
        rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
        return rnd / 0x3FFFFFFF - 1.0

    def sfx(kind):
        if kind == "click":
            nf, amp = 46, 0.085
        else:
            nf, amp = 280, 0.05
        out = []
        lp = 0.0
        for i in range(int(nf * SR / 1000.0)):
            s = noise()
            lp = lp * 0.72 + s * 0.28
            v = lp * env(i, nf, kind)
            if kind == "whoosh":
                v *= 0.6 + 0.4 * math.sin(2 * math.pi * 900 * i / SR)
            out.append(v * amp)
        return out

    click = sfx("click")
    whoosh = sfx("whoosh")

    buf = [0.0] * (len(voice) // 2)
    for c in meta["clicks"]:
        at = int(round((c - t0) / 1000.0 * SR))
        for i, v in enumerate(click):
            p = at + i
            if 0 <= p < len(buf):
                buf[p] += v
    for k, a, b in spans:
        if k == "00":
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

    finalwav = os.path.join(REC, "mix.wav")
    w = wave.open(finalwav, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(bytes(final))
    w.close()
    print("音轨 %.2fs" % (len(final) / 2.0 / SR))

    # ---- 4. 画面：章节角标 + 首尾淡入淡出
    font = "C\\:/Windows/Fonts/simhei.ttf"
    vf = []
    for k, a, b in spans:
        label = (k + "  " + TITLES[k]).replace(":", "\\:")
        A = "%.3f" % a
        BS = chr(92)
        alpha = ("if(lt(t" + BS + ",@+0.3),0,if(lt(t" + BS + ",@+0.62),(t-@-0.3)/0.32,"
                 "if(lt(t" + BS + ",@+2.4),1,if(lt(t" + BS + ",@+2.8),(@+2.8-t)/0.4,0))))").replace("@", A)
        vf.append(
            "drawtext=fontfile='%s':text='|':x=28:y=h-54:fontsize=28:fontcolor=0x74b9ff:"
            "alpha='%s':enable='between(t\\,%0.3f\\,%0.3f)'"
            % (font, alpha, a + 0.05, a + 2.85)
        )
        vf.append(
            "drawtext=fontfile='%s':text='%s':x=44:y=h-52:fontsize=25:fontcolor=white:"
            "shadowcolor=black@0.85:shadowx=0:shadowy=2:"
            "alpha='%s':enable='between(t\\,%0.3f\\,%0.3f)'"
            % (font, label, alpha, a + 0.05, a + 2.85)
        )
    vf.append("fade=t=in:st=0:d=0.55")
    vf.append("fade=t=out:st=%0.3f:d=0.85" % (n / FPS - 0.9))
    vf.append("format=yuv420p")

    base = os.path.join(REC, "base.mp4")
    run(["ffmpeg", "-y", "-v", "error", "-framerate", str(FPS),
         "-i", os.path.join(SEQ, "%05d.jpg"),
         "-vf", ",".join(vf), "-c:v", "libx264", "-preset", "medium", "-crf", "20",
         "-r", str(FPS), "-movflags", "+faststart", base])
    print("画面完成")

    out = os.path.join(ROOT, "..", "submission", "信号实验室-demo.mp4")
    run(["ffmpeg", "-y", "-v", "error", "-i", base, "-i", finalwav,
         "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
         "-shortest", "-movflags", "+faststart", out])
    print("成片", out, "%.1f MB" % (os.path.getsize(out) / 1e6))
    d = run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size:stream=codec_type,width,height,r_frame_rate",
             "-of", "default=nw=1", out]).stdout
    print(d)


main()
