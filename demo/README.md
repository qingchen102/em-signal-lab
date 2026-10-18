# demo 视频是怎么做出来的

成片在 `../submission/信号实验室-demo.mp4`。这一目录只放可重跑的制作流程，不放中间产物。

## 两步

1. 起本地服务并打开一个可被远程调试的浏览器，然后在 `app/` 同级跑：

   ```
   python app/server.py --no-browser      # 端口 8770
   node demo/record.js                    # 连 9333 的 CDP，录一遍真操作
   ```

   `record.js` 用 Chrome DevTools Protocol 的 `Page.startScreencast` 逐帧抓图，同时注入一个可见光标和点击涟漪，所以画面里是真的在拖滑条、真的在按住楼拖动。每一章的开始时刻和每一次点击的时刻都记在 `_rec/meta.json`。

2. 合成：

   ```
   python demo/build.py
   ```

   `build.py` 按 `meta.json` 的时间轴把帧重排成 25fps 序列，把 `vo/*.mp3` 逐章补齐到章长后拼成音轨，再叠上点击与转场的音效、左下角的章节角标、首尾淡入淡出。

## 配音

`vo/00.mp3` … `vo/09.mp3` 是十段旁白，`vo/texts.json` 是原文，`vo/durs.json` 是每段时长（毫秒）。重新生成旁白用 `edge-tts`，音色 `zh-CN-YunxiNeural`：

```
edge-tts --voice zh-CN-YunxiNeural --rate=+4% --text "……" --write-media vo/00.mp3
```

改完旁白要重新算 `vo/durs.json`（`ffprobe` 读时长），`record.js` 按它给每一章排期。

## 注意

`record.js` 依赖一个已经打开的浏览器调试端口 9333 和本地服务 8770，两者都不在仓库里。帧序列（`_rec/`）已 gitignore。
