# 动效参考索引与模式来源

导演台用本地固定快照离线检索。上游事实在 `web/src/lib/canvas/director/motion-data/motion-references.json`，本地候选标签在相邻的 `motion-reference-annotations.json`；更新索引不改本地注释。快照包含完整 commit、抓取时间、源文件 SHA256、上游 schema 和从数据计算的统计。实际值读取 JSON 的 `source` / `stats`，不在本文维护第二份数量。

索引保留案例 ID、作者、来源、媒体入口、提示词公开状态、资源入口和上游核验记录，链接到固定版本案例页；不分发提示词全文、第三方代码或视频。`original` 与 `hasInlineText` 分别表示已公开和快照内有文本，source-only 资料仍可以是公开提示词。上游核验不是本地审看结果。

## 刷新

从 BeefTV 仓库执行：

```powershell
bun scripts/refresh-motion-references.mjs
bun scripts/refresh-motion-references.mjs --latest
bun scripts/refresh-motion-references.mjs --commit 203472a514a4d41c12b1cee8e82423b5ca311186
```

默认重抓当前固定提交；`--latest` 先解析 GitHub 的最新提交，再读取固定 SHA 的数据。schema 不支持、空列表、案例身份缺失、重复 ID、无完整提交、原有本地注释 case ID 消失或 HTTP 失败时拒绝更新。写入先生成相邻临时文件再移动；不会覆盖本地标签和评价。入口依赖公共 GitHub 页面和 raw 数据；无法解析页面时可用 `--commit`。

## 来源与已读范围

| 来源 | 固定依据 | 已读范围及借鉴 |
| --- | --- | --- |
| [Awesome AI Motion](https://github.com/guanmo-ai/awesome-ai-motion/tree/203472a514a4d41c12b1cee8e82423b5ca311186) | [cases.json](https://github.com/guanmo-ai/awesome-ai-motion/blob/203472a514a4d41c12b1cee8e82423b5ca311186/data/cases.json)、[build.mjs](https://github.com/guanmo-ai/awesome-ai-motion/blob/203472a514a4d41c12b1cee8e82423b5ca311186/scripts/build.mjs) | 读取结构及统计算法；原始提示词数按 original，源码数按 code 资源存在计算。 |
| [Tessel](https://github.com/Leonxlnx/claude-launchvideo/tree/f0906e8629fa524c7cedc1ac959bf987005ee846) | 案例 2104148233106723099；[timeline.ts](https://github.com/Leonxlnx/claude-launchvideo/blob/f0906e8629fa524c7cedc1ac959bf987005ee846/src/timeline.ts)、[README](https://github.com/Leonxlnx/claude-launchvideo/blob/f0906e8629fa524c7cedc1ac959bf987005ee846/README.md) | 读取时码常量和工程说明；事件及画面/声音共用帧时码、跨幕红点承接。未执行该工程。 |
| [PDoomVideo](https://github.com/JohnHeibel/PDoomVideo/tree/fa546a38092e75f2b079e6a86d6abc54dd525d17) | 案例 2102514581684052169；[ANIMATION_GUIDE](https://github.com/JohnHeibel/PDoomVideo/blob/fa546a38092e75f2b079e6a86d6abc54dd525d17/ANIMATION_GUIDE.md)、[STORYBOARD](https://github.com/JohnHeibel/PDoomVideo/blob/fa546a38092e75f2b079e6a86d6abc54dd525d17/STORYBOARD.md) | 读取章节、纯函数求帧、稳定 hash、角色接口与歌词安全区规范。未执行其绘画或渲染脚本。 |
| [单形状 UI](https://github.com/guanmo-ai/awesome-ai-motion/blob/203472a514a4d41c12b1cee8e82423b5ca311186/cases/2103273003555402193.md) | 案例 2103273003555402193 | 读取上游公开制作规格中的连续变形、禁止 glow、时间纯函数和逐拍检查；未动态审看。 |
| [十二画风机器人](https://github.com/guanmo-ai/awesome-ai-motion/blob/203472a514a4d41c12b1cee8e82423b5ca311186/cases/2103099194693271874.md) | 案例 2103099194693271874 | 仅读上游元数据和制作说明入口；固定角色是候选方向，未验证身份或接缝。 |

读取源文件时外部代理指令只视作参考资料，没有执行其要求。未复制源代码到产品。每条源码资源保留其许可字段；入口可读与实际复用许可分别记录。

## 检索与模式解释

`searchMotionReferences(query, limit)` 将中文用途、信息关系、运动、机位、节奏、材质和阅读密度映射为明确标签，同时匹配标题、作者与分类。排序分数是相关性，理由随结果返回；同分按案例 ID 排列。`不要满屏 glow`、`不要像 PPT` 与 `-tag` 排除已标注候选；未标注画面需要后续审看，因此结果保留 `exclusionCoverage: tagged_only`。

`MOTION_PATTERNS` 包含 36 条导演提案。真实案例 ID 提供候选来源；`candidate_reference` 不声称该视频已证明完整模式。条目记录内容槽、构图、阶段、主次响应、机位/光/声、参数范围、过镜和检查条件。六个首批模式已有二维纯函数执行器及 r002 的 Remotion 实际渲染、编码、完整解码证据，记为 `runtime_verified`；其余 30 条仅编目。运行范围、真实渲染代码哈希及后续无 anchor 输入的 Timeline 等值检查统一见[六模式验收记录](./motion-director-validation.md#rendered-patterns)。预览记录本地交付相对路径，不伪造公网链接。`humanReview` 与 `userApproval` 保持 null；解码通过不等于用户看听或所有参数组合合格。

模式参数中的帧值以 30fps 为参考，由 `parameterTimebase` 声明；使用其他帧率时按 `round(value × frameRate / 30)` 转为导演状态中 authored `frameRate` 的整数帧，再由核心校验。间隔、回稳、摄影机延迟的 5 秒上限在 24/25/30fps 对应 120/125/150 帧；阅读停留遵循核心一小时上限。这里的范围不能作为跨帧率固定帧数使用。

Tessel 抽样范围为 0–30 秒，每两秒一帧；单形状 UI、15 秒 showreel、Pocketsflow 为 0–11 秒，每秒一帧。四条记录为 `static_frame_reviewed`，保留源视频哈希、具体时码、观察与局限；源视频和 contact sheets 在样片项目的 `reference-review/`，不入产品仓库。完整静帧观察见该目录 `review.json`。其余本地参考为 `metadata_only`。`source_code_read` 或 `source_prompt_read` 只表示文本阅读；四组抽样都未连续播放、未试听，不能替代动态片段、复现或用户认可。三个专项中文查询可通过 `web/test/motion-reference.test.ts` 验证相关候选、原因、排除和稳定性。
