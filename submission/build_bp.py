# -*- coding: utf-8 -*-
"""把 docs/项目说明.md 渲染成可以直接上传的 PDF 商业计划书。

用法：
    python submission/build_bp.py

做的事情：
  1. 读 ../docs/项目说明.md（遇到「## 附：」就停，那节是内部核对表，不进 BP）
  2. 转成一份自带样式的 A4 HTML（不依赖任何库，纯标准库的极简 markdown 转换）
  3. 用本机 Chrome 的无头模式打印成 PDF

只支持这份文档实际用到的 markdown 语法：标题、段落、无序号/有序列表、
表格、引用、分隔线、加粗、行内代码、链接。不是通用转换器，也不打算是。
"""

import html
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, os.pardir, "docs", "项目说明.md")
HTML_OUT = os.path.join(HERE, "商业计划书.html")
PDF_OUT = os.path.join(HERE, "信号实验室-商业计划书.pdf")

CJK = re.compile(u"[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]")


def join_cjk(lines):
    """把折行拼回段落：两侧都是中日韩字符时不插空格。"""
    s = ""
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        if s and not (CJK.match(s[-1]) or CJK.match(ln[0])):
            s += " "
        s += ln
    return s


CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

CSS = """
@page { size: A4; margin: 15mm 14mm 16mm; }
* { box-sizing: border-box; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
  font-size: 10.2pt; line-height: 1.78; color: #1b1f24;
  margin: 0;
}
.kicker {
  font-size: 8.6pt; letter-spacing: .08em; color: #5a6b83;
  border-top: 3px solid #1f6feb; padding-top: 6px; margin-bottom: 18px;
}
.kicker span { color: #1f6feb; font-weight: 700; }
h1 {
  font-size: 21pt; line-height: 1.3; margin: 0 0 14px;
  letter-spacing: -.01em;
}
h2 {
  font-size: 13.5pt; margin: 22px 0 8px; padding-bottom: 5px;
  border-bottom: 1.5px solid #dbe4ef; break-after: avoid;
}
h3 { font-size: 11pt; margin: 15px 0 6px; color: #0b5cb0; break-after: avoid; }
p { margin: 7px 0; }
strong { color: #0f1a2b; }
a { color: #1f6feb; text-decoration: none; }
code {
  font-family: Consolas, "Courier New", monospace; font-size: 8.9pt;
  background: #f2f5f9; padding: 1px 4px; border-radius: 3px; color: #234;
}
hr { border: none; border-top: 1px solid #e4eaf2; margin: 16px 0; }
blockquote {
  margin: 10px 0; padding: 8px 14px; background: #f6f9fd;
  border-left: 3px solid #9dc0e8; color: #3f4d63; break-inside: avoid;
}
blockquote p { margin: 3px 0; }
table {
  width: 100%; border-collapse: collapse; margin: 9px 0;
  font-size: 9.3pt; break-inside: avoid;
}
th, td { border: 1px solid #d9e1ec; padding: 5px 8px; text-align: left; vertical-align: top; }
th { background: #f2f6fb; font-weight: 700; color: #16233a; }
th:first-child, td:first-child { word-break: keep-all; }
ul, ol { margin: 7px 0; padding-left: 20px; }
li { margin: 3px 0; }
.cover-note {
  margin-top: 4px; font-size: 9pt; color: #66748c;
}
""".strip()


def inline(text):
    """行内标记：先转义，再换加粗/行内代码/链接（这几个标记不会被转义破坏）。"""
    s = html.escape(text)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
    return s


def split_row(line):
    cells = line.strip().strip("|").split("|")
    return [c.strip() for c in cells]


def convert(md):
    lines = md.splitlines()
    out = []
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        # 遇到附录就停
        if stripped.startswith("## 附："):
            break

        if not stripped:
            i += 1
            continue

        if stripped == "---":
            out.append("<hr>")
            i += 1
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            level = len(m.group(1))
            out.append("<h%d>%s</h%d>" % (level, inline(m.group(2)), level))
            i += 1
            continue

        # 表格：以 | 开头，第二行是分隔行
        if stripped.startswith("|") and i + 1 < n and re.match(r"^\|[\s:\-|]+\|$", lines[i + 1].strip()):
            header = split_row(stripped)
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i].strip()))
                i += 1
            out.append("<table>")
            out.append("<thead><tr>" + "".join("<th>%s</th>" % inline(c) for c in header) + "</tr></thead>")
            out.append("<tbody>")
            for r in rows:
                out.append("<tr>" + "".join("<td>%s</td>" % inline(c) for c in r) + "</tr>")
            out.append("</tbody></table>")
            continue

        # 引用
        if stripped.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i].rstrip()))
                i += 1
            body = "".join("<p>%s</p>" % inline(b) if b.strip() else "" for b in buf)
            out.append("<blockquote>%s</blockquote>" % body)
            continue

        # 列表
        if re.match(r"^[-*]\s+", stripped):
            items = []
            while i < n and re.match(r"^[-*]\s+", lines[i].strip()):
                items.append(re.sub(r"^[-*]\s+", "", lines[i].strip()))
                i += 1
            out.append("<ul>" + "".join("<li>%s</li>" % inline(t) for t in items) + "</ul>")
            continue

        if re.match(r"^\d+\.\s+", stripped):
            items = []
            while i < n and re.match(r"^\d+\.\s+", lines[i].strip()):
                items.append(re.sub(r"^\d+\.\s+", "", lines[i].strip()))
                i += 1
            out.append("<ol>" + "".join("<li>%s</li>" % inline(t) for t in items) + "</ol>")
            continue

        # 普通段落（连续的非空行合成一段）
        buf = []
        while i < n:
            s = lines[i].strip()
            if (not s or s == "---" or s.startswith("#") or s.startswith("|")
                    or s.startswith(">") or re.match(r"^[-*]\s+", s) or re.match(r"^\d+\.\s+", s)):
                break
            buf.append(s)
            i += 1
        out.append("<p>%s</p>" % inline(join_cjk(buf)))

    return "\n".join(out)


def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        md = f.read()

    kicker = (
        '<div class="kicker">'
        '<span>浙客松 · 2026 AI+X 破界黑客松</span> ｜ 校园赛道 · 自由命题（示例场景 04 教育）'
        ' ｜ 2026 年 10 月'
        '</div>'
    )
    doc = (
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        "<title>信号实验室 Signal Lab · 商业计划书</title>"
        "<style>" + CSS + "</style></head><body>"
        + kicker + convert(md).replace("· 项目说明", "· 商业计划书", 1)
        + "</body></html>"
    )
    with open(HTML_OUT, "w", encoding="utf-8") as f:
        f.write(doc)
    print("html  :", HTML_OUT)

    chrome = find_chrome()
    if not chrome:
        print("没找到 Chrome，HTML 已生成，可以手动打开后「打印 → 另存为 PDF」", file=sys.stderr)
        return 1

    url = "file:///" + os.path.abspath(HTML_OUT).replace("\\", "/")
    if os.path.exists(PDF_OUT):
        os.remove(PDF_OUT)
    cmd = [
        chrome, "--headless=new", "--disable-gpu", "--no-first-run",
        "--no-pdf-header-footer",
        "--print-to-pdf=" + PDF_OUT,
        url,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if r.returncode != 0 or not os.path.exists(PDF_OUT):
        print(r.stdout[-800:], r.stderr[-800:], file=sys.stderr)
        print("打印失败", file=sys.stderr)
        return 1
    size = os.path.getsize(PDF_OUT)
    print("pdf   :", PDF_OUT, "(%.1f KB)" % (size / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
