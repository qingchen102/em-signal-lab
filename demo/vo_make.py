# 从 vo/texts.json 生成十段旁白（mp3 + 逐句 srt）并算出每段时长（毫秒）。
# 用法： python demo/vo_make.py
# 产物： demo/vo2/NN.mp3、demo/vo2/NN.srt、demo/vo/durs.json
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
VO = os.path.join(ROOT, "vo2")
TEXTS = os.path.join(ROOT, "vo", "texts.json")
DURS = os.path.join(ROOT, "vo", "durs.json")
VOICE = "zh-CN-YunxiNeural"
RATE = "+4%"

os.makedirs(VO, exist_ok=True)
pairs = json.load(open(TEXTS, encoding="utf-8"))
durs = {}
for key, text in pairs:
    mp3 = os.path.join(VO, key + ".mp3")
    srt = os.path.join(VO, key + ".srt")
    subprocess.run([sys.executable, "-m", "edge_tts",
                    "--voice", VOICE, "--rate", RATE,
                    "--text", text,
                    "--write-media", mp3, "--write-subtitles", srt],
                   check=True, capture_output=True)
    d = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", mp3], capture_output=True, text=True)
    sec = float(d.stdout.strip())
    durs[key] = int(round(sec * 1000))
    print("%s  %6.2fs  %3d 字  %.2f 字/秒" % (key, sec, len(text), len(text) / sec))

json.dump(durs, open(DURS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("总长 %.2fs" % (sum(durs.values()) / 1000.0))
print("durs.json ->", DURS)
