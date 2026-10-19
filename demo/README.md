# demo 视频是怎么做出来的

成片在 `../submission/信号实验室-demo.mp4`。这一目录只放可重跑的制作流程，不放中间产物。

## 两步

1. 起本地服务并打开一个可被远程调试的浏览器，然后在 `app/` 同级跑：

   ```
   python app/server.py --no-browser      # 端口 8770
   node demo/record.js                    # 连 9333 的 CDP，录一遍真操作
   ```

   `record.js` 用 Chrome DevTools Protocol 的 `Page.startScreencast` 逐帧抓图，同时注入一个可见光标和点击涟漪，所以画面里是真的在拖滑条、真的在按住楼拖动。每一章的开始时刻和每一次点击的时刻都记在 `_rec/meta.json`。

2. 合成（从零重做，需要 `_rec/`）：

   ```
   python demo/build.py
   ```

   `build.py` 按 `meta.json` 的时间轴把帧重排成 25fps 序列，把 `vo/*.mp3` 逐章补齐到章长后拼成音轨，再叠上点击与转场的音效、左下角的章节角标、首尾淡入淡出。

3. 只重做音轨与字幕（不需要 `_rec/`，拿现成的成片当画面）：

   ```
   python demo/build2.py
   ```

   `build2.py` 重新合成十段旁白（带逐句时间戳），按章节起点摆成音轨、过一遍 loudnorm，再把字幕、章节标题卡、压黑转场一起写成一份 ASS 烧进画面，视频轨重编码。章节起点写死在脚本里的 `MARKS`，来自录制时的 `meta.json`。改旁白只需改 `vo/texts.json` 后重跑。

## 配音与字幕

`vo/texts.json` 是十段旁白的原文。音色 `zh-CN-YunxiNeural`，语速 `+4%`，由 `edge-tts` 合成：

```
python -m edge_tts --voice zh-CN-YunxiNeural --rate=+4%     --text "……" --write-media out.mp3 --write-subtitles out.srt
```

`--write-subtitles` 给出的逐句时间戳就是字幕的来源，`build2.py` 把它们按每行 18 字切开、按字数分配时长，再整体加上章节起点写成 ASS。字幕样式在 `build2.py` 的 `[V4+ Styles]` 里，白字黑描边、距底 104 像素，正好在左下角章节角标上方。

`build.py` 那条老路还需要 `vo/durs.json`（每段时长，毫秒，`ffprobe` 读），`record.js` 按它给每一章排期；`build2.py` 不需要。

## 注意

`record.js` 依赖一个已经打开的浏览器调试端口 9333 和本地服务 8770，两者都不在仓库里。帧序列（`_rec/`）已 gitignore。
