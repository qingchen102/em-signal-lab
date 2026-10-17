import json
import urllib.request

BRIEF = (
    "【阵列】M = 8 个阵元，间距 d = 0.50 λ，信噪比 20 dB，快拍数 200，信源数 2\n"
    "【阵列真实来波方向】-6°、6°\n"
    "【阵列空间谱】Bartlett 检出 -2.0°（-0.0 dB）、3.0°（0.0 dB）；"
    "MVDR 检出 -6.0°（-0.2 dB）、6.0°（0.0 dB）；"
    "MUSIC 检出 -6.0°（-5.5 dB）、6.0°（0.0 dB）\n"
    "【阵列关键推导】相邻阵元相位差 = 2π(d/λ)·sinθ；"
    "主瓣宽度约 0.886λ/(M·d) = 12.7°；不出现栅瓣要求 d ≤ 0.5 λ\n"
)

SYSTEM = (
    "你是「信号实验室」的 AI 助教，面对的是电子信息类本科生。"
    "只用【仪器状态】里给出的数字说话，不要编造数字，不要编造教材章节号。"
    "先讲屏幕上能看到的现象，再讲背后的原理。"
)

QUESTIONS = [
    "蓝线（Bartlett）为什么只鼓起一个包，绿线（MUSIC）却能分开？",
    "如果我把阵元数从 8 减到 2，会看到什么变化？为什么？",
]

body = {
    "messages": [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": BRIEF + "\n学生问：" + QUESTIONS[0]},
    ],
    "temperature": 0.3,
    "stream": False,
}

req = urllib.request.Request(
    "http://127.0.0.1:8771/api/chat",
    data=json.dumps(body).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=180) as r:
    raw = r.read().decode("utf-8", "replace")

print("=== 原始长度", len(raw), "===")
try:
    d = json.loads(raw)
except Exception as e:
    print("JSON 解析失败:", e)
    print(raw[:2000])
    raise SystemExit(1)

msg = d["choices"][0]["message"]
rc = msg.get("reasoning_content") or ""
print("--- 思考过程（前 600 字）---")
print(rc[:600])
print("--- 正式回答 ---")
print(msg.get("content"))
print("--- usage ---", d.get("usage"))
