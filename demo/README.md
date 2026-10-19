# demo 视频是怎么做出来的

成片在 `../submission/信号实验室-demo.mp4`（不入库，见文末），4 分 33 秒，1440×900，十章，中文旁白、逐句字幕、章节标题卡，开头一张目录卡把每段的时间点列出来。这一目录只放可重跑的制作流程，不放中间产物。

## 四步

1. 起本地服务和一个能被远程调试的浏览器：

   ```
   python app/server.py --no-browser          # 端口 8770
   msedge.exe --user-data-dir=<临时目录> --remote-debugging-port=9333 --headless=new about:blank
   ```

2. 生成旁白：

   ```
   python demo/vo_make.py
   ```

   读 `vo/texts.json` 里的十段文稿，用 `edge-tts` 合成 `vo2/NN.mp3` 和逐句时间戳 `vo2/NN.srt`，再把每段时长写进 `vo/durs.json`（毫秒）。`record.js` 按这份时长给每一章排期。

3. 录一遍真操作：

   ```
   node demo/record.js
   ```

   `record.js` 通过 Chrome DevTools Protocol 的 `Page.startScreencast` 逐帧抓图，同时往页面里注入一个可见光标和点击涟漪，所以画面里是真的在拖滑条、真的在按住楼拖。每一章的开始时刻、每一次点击的时刻都记在 `_rec/meta.json`。每章的动作是手写的，改内容就改那十段 `chapter(...)`。

4. 合成：

   ```
   python demo/render.py
   ```

   `render.py` 按 `meta.json` 的时间轴把帧重排成 25fps 序列，把旁白逐章摆到章节起点、叠一声很轻的过渡音、整轨过一遍 loudnorm，再把字幕、标题卡、目录卡、章节之间的黑场转场写成 ASS 一起烧进画面。

## 时间轴是算出来的，不是手写的

目录卡上的十个时间点、标题卡出现的时刻、字幕的每一句，全部由 `meta.json` 里的 `marks` 推出来。录多长就写多长，不会出现「视频里说 2:17，实际 2:31」这种事。所以重录之后不需要改任何文档里的时间，重跑 `render.py` 就行。

## 配音与字幕

音色 `zh-CN-YunxiNeural`，语速 `+4%`。`--write-subtitles` 返回的逐句时间戳就是字幕的来源；一句话超过 18 字时，`render.py` 按标点切开并按字数分配时长。字幕白字黑描边、距底 104 像素，正好在左下角章节角标上方。

改旁白只需要动 `vo/texts.json`，然后重跑 `vo_make.py` 和 `render.py`；如果改动让某一段变长到超过录制时的章长，才需要重录。

## 注意

`record.js` 依赖一个已经打开的浏览器调试端口 9333 和本地服务 8770，两者都不在仓库里。帧序列（`_rec/`）、中间 wav、以及成片本身都已 gitignore。

成片不入库的原因很实际：十八兆的 mp4 走 `api.github.com` 传不上去（这台机器到 github.com 的 443 不通，只能走 API，大 body 会被掐断）。视频是随提交材料单独上传的，代码这边按上面四步随时能重做出来。
