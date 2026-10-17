# 把这个项目单独推成一个 GitHub 仓库

本地仓库已经建好了：`em-signal-lab/` 自己就是一个独立的 git 仓库，两次提交都在本地，跟外面的 `EM-benchmark` 仓库没有关系（父仓库没有跟踪这个目录）。

差的只有一步：远端地址和一次 `push`。

---

## 1. 在 GitHub 上建一个空仓库

打开 <https://github.com/new>，填：

| 字段 | 填什么 |
| --- | --- |
| Repository name | `em-signal-lab` |
| Description | 浏览器里的电子实验室：仿真仪器 + AI 助教 + 分层练习 |
| 可见性 | Public |
| Initialize this repository with | **三个都不要勾**（不勾 README、不勾 .gitignore、不选 license） |

勾了的话远端会先有一个提交，`push` 会被拒（non-fast-forward），还得多一步 `--allow-unrelated-histories`。空仓库最省事。

---

## 2. 配好远端并推上去

在 PowerShell 或 Git Bash 里：

```bash
cd D:/srtp/EM-benchmark/em-signal-lab

git remote add origin https://github.com/qingchen102/em-signal-lab.git
git push -u origin main
```

第一次推会弹出 Git Credential Manager 让你登录 GitHub 或授权，登一次以后就记住了。

如果习惯用 SSH：

```bash
git remote add origin git@github.com:qingchen102/em-signal-lab.git
git push -u origin main
```

---

## 3. 推上去之后建议做的两件事

**改仓库描述和话题。** GitHub 仓库页右上角 ⚙️ → Description 填一句话，Topics 建议填：

```
signal-processing  oscilloscope  dsp  education  hackathon  vanilla-js  canvas
```

**给 README 顶部加一行在线体验说明。** 这个项目是纯前端、零依赖，理论上把 `app/` 目录丢到 GitHub Pages 上就能直接在线打开：

```bash
# 仓库 Settings → Pages → Source 选 Deploy from a branch → main / 根目录
# 然后把访问地址加进 README
```

注意要放 `app/` 下的文件，或者把 Pages 的目录指到 `app/`。页面里 AI 助教需要本机转发服务（上游中转站不响应 CORS 预检），放到 Pages 上之后助教会连不上 —— 这是已知的、写进 README 里的限制；五台仪器本身完全离线可用。

---

## 4. 以后每次改完怎么推

```bash
cd D:/srtp/EM-benchmark/em-signal-lab
git add -A
git commit -m "改了什么"
git push
```

---

## 现在仓库里有什么

| | |
| --- | --- |
| 文件数 | 135 |
| 仓库体积 | 约 2.1 MB（含 7 张界面截图） |
| 提交 | 2 次 |
| 被 gitignore 的 | `shots/`（本机截图草稿）、`llm.local.json`（含 API Key）、`__pycache__` |

进仓库的截图在 `docs/img/`，README 开头引的就是这几张。
