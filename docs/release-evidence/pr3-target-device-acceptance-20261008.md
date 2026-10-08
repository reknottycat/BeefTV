# PR #3：主线集成后的目标设备验收记录

这是评审与验收证据，不是功能发布声明。PR #3 保持 Draft。

## 范围与基准

- 本轮运行与静态核对的产品代码：`16538957ac42a26ad38effb20bf6e85022d1ea63`。
- PR #2 已合入 main：`97c9d7088bc731f1b525d51352c77ccfbd0c2dad`，保留其原 HEAD `c8956171e61a19663206f6a4e7591f3bd3cb57b9` 的提交身份。PR #3 目标分支已改为 main。
- `git merge-tree --write-tree 1653895 97c9d708` 无冲突，结果为 `7fbcd19ab7b257294044867c5ed841b2895fc04a`，与原 PR #3 文件树相同。同步 main 本身不改变产品代码；本次合并提交只额外加入这份验收记录和证据 JSON。原 118 文件（+7538/-195）功能差异不变。
- 合并提交必须重新运行 Quality checks 和 Director browser checks；最新结果以 PR #3 当前 HEAD 的 Checks 为准，不能把旧 HEAD 的绿色检查当作新提交的检查。
- 不重复 PR #1 审查，不合入旧功能分支。
- 新产品路由仅为现有画布的 `/canvas/:id/production`；制作记录复用 creation runs、原生 tasks/resources 与现有 timeline render API。adapter 的 project/shot/asset 是内部映射，没有新建第二套项目工作台。
- 本轮差异没有修改 `web/package.json`、`web/bun.lock`、`backend/go.mod`、`backend/go.sum`、`agent-host/` 或原 provider 实现；没有恢复旧 `/agent/*` 路由或另建模型会话循环。现有 RunningHub 可选能力仍由原配置选择；本地 Comfy 不要求它。

## 2026-10-08 实际可验证结果

复用了同一 `1653895`、干净工作区的既有依赖缓存，未重做已有全套 CI。当前环境为 Linux x86_64、Python 3.12.14、Go 1.25.1、Bun 1.3.9、FFmpeg/ffprobe 6.1.1；Playwright 与 playwright-core 均为锁文件中的 1.63.0。

| 检查 | 本轮结果 | 实际覆盖与边界 |
| --- | --- | --- |
| Python adapter 合同 | PASS，44 tests，26.308s | 临时 SQLite、loopback mock；含提交回包丢失、重启后 unknown、部分归档重启续传、身份/幂等与权限。不使用真实 Comfy/GPU。 |
| `TestNativeComfyFFmpegMP4RecoveryAndImport` | PASS，3 个子场景 | FFmpeg 编码真实 H.264 MP4，经 Go 原任务恢复与资源入库，逐字节比对并解码；错误尺寸/时长拒绝入库。adapter 是 HTTP fixture，不是 GPU。 |
| 逐镜选版到编码结果 | PASS，1 test / 48 assertions | 实际 ProductionPage/Coordinator、源选择与 native FFmpeg lowerer/executor；先验证蓝版，再选红版，画布改蓝并刷新后预览和成片仍为红版。业务 API、持久化与单片段语义计划是 fixture。 |
| 默认 Playwright browser 启动 | 环境阻断 | 匹配锁文件的 headless-shell revision 1243 未安装；没有把默认命令记为通过。上行选版通过使用显式 `CHROME_PATH` 指向既有 Chromium 134.0.6998.35 / revision 1161，属于补充验证，不能替代 CI 的匹配浏览器。 |
| H.264/MP4 浏览器输入预览 | 未验证，已尝试 | Google Chrome 155.0.8059.39 在启动时遭宿主 `socket() failed: Operation not permitted`，尚未进入页面断言。WebM 浏览器预览通过不等于 H.264 浏览器预览通过。 |
| 真实 Comfy/GPU、目标机持久化、Windows/macOS | 未验证 | 本环境没有已提供的 adapter 地址、私有配方或 GPU 设备；不探测猜测的主机、不安装模型、不编造生成结果。 |

本轮原始日志与生成媒体在本地忽略目录 `.local/acceptance/pr3-20261008/`；可公开的环境、测试边界与哈希索引见同目录文档的 `pr3-target-device-evidence-20261008.json`。旧任务留下的 WebM/native FFmpeg 通过记录与 Chrome 启动失败记录已读取，没有升级为目标设备通过。

## PR #2 补充运行证据

最终 Review 已固定在 `c8956171`，远端 Quality checks `37573197574` 的后端、前端与发布脚本均成功。随后找到既有工具链，对同一 HEAD 复跑连接专项：outbound/generation/app 共 29 个顶层测试通过，0 失败。命令为：

```sh
(cd backend && go test ./internal/outbound ./internal/generation ./internal/app \
  -run 'Test(ChannelConnection|FetchChannelModelCatalog|ResolveProviderConfigNormalizesCustomConnection|ResolveProviderConfigRejectsSystemConnectionOverrides|ResolveManagedSecretsRejectsConnectionOverrides)' -count=1 -v)
```

先前更宽的筛选还包含两项旧测试：`TestResolveProviderConfigMapsSKUToProviderModel` 与 `TestResolveProviderConfigRejectsHostileUpstreamKey`；当前容器无法解析它们使用的供应商域名。两项均已在原始 main `36c9f6781c4df4e5bf9f3d8d3837a5442509f331` 独立复跑，复现同样的域名解析失败，确认不是 #2 引入；未修改测试或出站安全策略。合并后的 main 仍由自己的 push CI 检验。

## 复现命令

以下命令从仓库根目录运行，使用准备好的开发工具链。保留退出码；不能用没有 `pipefail` 的 `tee` 掩盖失败。

```sh
mkdir -p .local/acceptance/pr3-target
python3 -m unittest discover -s tools/comfy_adapter -p test_adapter.py -v
(cd backend && go test ./internal/app -run '^TestNativeComfyFFmpegMP4RecoveryAndImport$' -count=1 -v)
(cd web && bun install --frozen-lockfile)
(cd web && bunx playwright install chromium)
(cd web && BEEFTV_PRODUCTION_MEDIA_TEST=1 \
  PRODUCTION_MEDIA_EVIDENCE_DIR="$PWD/../.local/acceptance/pr3-target/webm" \
  bun test test/production-selected-version.browser.test.ts)
```

H.264 输入预览专项：先把 `CHROME_PATH` 设置为目标机已有的、支持 H.264 的 Chrome 可执行文件，不以 headless-shell/WebM 结果替代。

```sh
: "${CHROME_PATH:?请先设置目标机 Chrome 可执行文件路径}"
(cd web && CHROME_PATH="$CHROME_PATH" BEEFTV_PRODUCTION_MEDIA_TEST=1 BEEFTV_PRODUCTION_MEDIA_FORMAT=mp4 \
  PRODUCTION_MEDIA_EVIDENCE_DIR="$PWD/../.local/acceptance/pr3-target/h264" \
  bun test test/production-selected-version.browser.test.ts)
```

## 最小目标设备路径：一个现有作品、两镜、三个明确提交

先取得可访问的目标设备及其已经实测可用的私有 Comfy API workflow/recipe。按[本地生成配置](../content/docs/backend/local-comfy.mdx)设置精确私网许可、服务 token 与两个持久目录。记录操作系统、GPU/驱动、Comfy/custom-node 版本、BeefTV commit、recipe version/output 与浏览器版本；不记录密钥或私有磁盘路径。

配方必须显式声明 `video/mp4`，尺寸、时长与真实 workflow 一致；使用它实际支持的最短时长，不为凑测试数值更改输出声明。两镜即可，第一镜再显式生成一版，预计最多三个 GPU 作业。输入是可明显区分的测试场景，避免无法判断选版。若使用 I2V，先把符合配方约束的首帧入库，再引用原资源 ID。没有可运行配方则停在配置待补齐。

| 顺序 | 操作 | 必须保留的证据与通过条件 | 当前目标机状态 |
| --- | --- | --- | --- |
| 1. 配置与审批 | 在现有作品设置两镜，原画布保存成功后进入“自动制作”，选择本地配方，检查模型、提示词和参考图后确认 | config/recipes 只含公开元数据；审批绑定 recipe version；记录 run/canvas/node/attempt/submission/task/job/prompt/resource 的对应关系。无另建项目、无隐式云供应商回退 | 未验证 |
| 2. 原作业断线与重启 | 第一镜已收到且保存 `prompt_id` 后关闭页面、短暂断开 adapter 连接，再以原持久目录重启 adapter 和 BeefTV；恢复原制作记录 | 首次 prompt 仍是同一 ID；恢复只 query/poll/archive，不新增 GPU prompt；第二镜不因页面重开自动重复提交；SQLite 和媒体路径恢复正常 | 未验证 |
| 3. 取回与资源入库 | 原 GPU 作业完成后先关闭“新生成”开关，再取回原结果；连续取回两次；之后恢复开关完成第二镜 | 原 task/job 未变，资源归属正确，`resource:<id>` 与画布引用对应；取回不重新生成、不重复入库；保存原媒体和入库媒体 SHA-256、ffprobe 尺寸/时长与可解码结果 | 未验证 |
| 4. 显式新版本与选旧版 | 对已完成第一镜明确批准一次“生成新版本”，保留 A/B 两版，选 A；重新组装后保存，刷新并重启应用 | 新版本是唯一额外 GPU 提交；采用版本 A、第二镜版本及镜头顺序保持；画布当前节点即使为 B，预览仍播放 A；修改选版必须取消原成片审批 | 未验证 |
| 5. 声音、审批与导出 | 加一条短配音/音乐，核对音量/静音及可见字幕，实际播放 H.264 预览；明确确认后导出 | 未审批不能导出；使用冻结的 timeline/selection/clientOperationId；导出完成或恢复回包丢失时不换操作身份；最终 MP4 镜头顺序、版本、时长、声音、字幕均与审批一致 | 未验证 |
| 6. 持久化终检 | 退出目标应用并重开；从原作品下载历史成片 | run/selection/task/resource 与成片可恢复；原文件和下载文件 hash 一致；浏览器/桌面 WebView 可播放，不只 FFmpeg 可解码 | 未验证 |

“已保存 prompt_id 后的恢复”和“上游 `/prompt` 回包丢失”必须分开。后者可能进入 `submission_unknown` 且没有 prompt_id；当前实现会保留未知状态并禁止自动重投，**不承诺自动找回未知 prompt**。现有 fixture 已验证防重投；若目标机做该故障演练，使用隔离测试作业和可观察的受控故障点，保留设备队列证据，不能点击重试直到原作业已人工核清。不能把“停止跟踪”记为 GPU 已取消，也不能清空共享队列。

成片检查命令（下载后将变量指向本次文件）：

```sh
: "${BEEFTV_ACCEPTANCE_FILM:?请设置本次下载的成片文件}"
ffprobe -v error -show_entries \
  format=duration:stream=codec_name,codec_type,width,height,r_frame_rate,duration \
  -of json "$BEEFTV_ACCEPTANCE_FILM"
ffmpeg -nostdin -v error -xerror -i "$BEEFTV_ACCEPTANCE_FILM" -f null -
```

Go 目前验证实际尺寸和时长，fps 仍是冻结的配方声明；目标验收必须另比对 ffprobe 的实际帧率，不能把声明当实测。

## 合并后与发布门槛

- PR #3 调整到最新 main 后，检查 diff 仍为本地 Comfy/制作流程及验收文档，重跑 Quality checks 和 Director browser checks；保持 Draft。
- 普通 PR CI 的选版真实媒体测试默认跳过；Director 的 83 项通过覆盖其脚本场景，不等于上述完整制作链路通过。必须运行上面的 opt-in 命令并标注 fixture 边界。
- Windows/macOS 的 SQLite/runtime 矩阵只在 `.github/workflows/quality.yml` 的 `workflow_dispatch` 执行；可先触发收集持久化基础证据，但它没有代替目标桌面 WebView、Comfy GPU 与整个制作链路。
- 目标设备表中任一关键项未验证，或重复提交/错资源归属/选版漂移/未经审批导出任一失败，都不能声明满足发布条件。现阶段不发布，不扩大生成供应商与旧 Agent 运行面。
