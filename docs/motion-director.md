# 动效导演台

在画布打开已有导演台，选择左侧“动效导演”。从观看意图和口播原句开始，选择模式、预览候选，再“应用候选到本镜”。候选保留已有文案、参数与资产绑定；编辑场景后候选自动失效。应用与手动修改沿用已有撤销、重做和保存链路。

六个模式可逐帧执行：对象交接、镜头聚焦、语义文字、关系变形、冲击揭示、形状连续转场。完整编目及各模式证据见 [模式库](../web/src/lib/canvas/director/motion-pattern-catalog.ts)；参考刷新与审看状态见 [参考来源](motion-reference-sources.md)。

## 一条镜头怎么做

1. 填写本镜观看意图、原句、焦点和情绪。动作初态、主体行动、终态及可见变化说明画面需要发生什么。
2. 写准确标题和内容标签；图解关系通过 `1>2` 等明确指定，留空不添加连线。文字由合成层绘制。
3. 主体引用现有场景对象及资产。初态、终态使用 `paper.holder=teacher.right_hand` 等稳定键记录跨镜事实。
4. 调整运动幅度、主次间隔、回稳、相机推进和延迟、色彩及阅读停留。用真实声音对齐后再标为“真实声音锁时”；选择该标记本身不建立声音证据。
5. 必要时添加主事件音效。锚定 cue 随本镜长度及 fps 重编译；手动编辑位置后变为固定帧。音效增益不是实际混音验收。
6. 播放或拖动时间轴检查画面，运行“检查整条导演时间线”，修复阻断项后导出整条制作包。任何场景编辑都会使旧检查证据失效。

连续形状镜用相同共享元素 ID，编译时下一镜入口继承上一镜出口。改变身份时使用不同 ID；角色、持物等状态改变仍须明确动作或过镜理由。入口、出口控件保留创作者原决定，派生时间线负责接缝对齐。

## 数据与实际消费者

唯一编辑事实是项目中的 `DirectorScene.shots[].direction`，没有另一份导演文案存储。类型见 [director-motion.ts](../web/src/types/director-motion.ts)，字段校验及六模式执行器见 [领域实现](../web/src/lib/canvas/director/director-motion.ts)。

| 决定 | 保存字段 | 实际消费者 |
| --- | --- | --- |
| 意图、原句、焦点、动作 | intent / sourceAnchor / focus / emotion / action | 编辑面板、逐镜 Prompt |
| 准确内容与关系 | content.title / labels / relations | 同一 SVG 预演、Remotion |
| 主次运动与回稳 | motion / frameRate | 绝对时间求帧、内容完成检查 |
| 摄影机与色彩 | camera / light | 二维合成相机、SVG；原三维机位和灯光仍由已有 Scene 管理 |
| 主体、身份及状态 | subjectBindings / continuity | 既有对象引用、跨镜合同检查、制作包 |
| 参考 | references | 可追溯制作包与 Prompt；元数据、抽帧、动态审看、复现分别标记 |
| 接缝与声音 | transition / audioCues | 时间线共享锚点、全局 cue、音频 sample 换算 |
| 时码与停留 | timingStatus / readableHoldFrames | 固定 fps 编译及 Frame Critic |

时间线在 [director-timeline.ts](../web/src/lib/canvas/director/director-timeline.ts) 编译。整条交付固定 24、25 或 30 fps，镜头区间采用 `[startFrame,endFrame)`；作者参数按 `frameRate` 转为交付帧率。编辑状态不会被编译器修改。Scene 和 Timeline 分别记录 canonical SHA-256，修改任一输入需重新检查。

同一求帧器和 SVG 同时用于 UI、截图回写和 [Remotion 消费器](../tools/motion_director/README.md)。任意帧可独立求值，不消费上一帧、墙钟或运行时随机状态。导出包括原场景、编译时间线、逐镜 Prompt、相机、资产引用、顺序、全局音效及能力声明。

RunningHub/ComfyUI 通过已有“应用到镜头”入口交接 Prompt 与当前构图图像；精确轨迹属于提示约束，制作包明确 `exactTrajectoryControl:false`。本功能没有自动提交收费任务，也没有证明供应商生成后的真实主体动作。HyperFrames 保留未验证状态。

## 检查与返修

[Frame Critic](../web/src/lib/canvas/director/director-frame-critic.ts) 检查时间范围、逐帧安全区、必要内容是否来得及完成、阅读停留、主体绑定和跨镜声明。问题附 shot ID、局部与全局帧、可编辑字段和原因。字数容量是启发式；几何通过不代表审美、叙事、字体阅读或听感通过。

只修改出问题的字段与受影响镜头，再重编译和重新渲染该片段及接缝。旧报告不能用于新状态。实际运行结果、样片哈希和检查范围见 [验证记录](motion-director-validation.md)。本地完整样片项目保留制作包、音频测量、HTML 帧浏览及新旧同位置比较；个人声轨和第三方视频不随产品源码上传。

开发复现入口是 `/dev/director-repro`，只在 DEV 注册。它渲染真实工作台，保存和回写使用本页的本地回调；可看实际回写 PNG、测试明暗主题与故意保存失败。这证明 UI/保存协调器调用链，不能替代原生桌面、真实项目后台持久化或供应商生成验收。
