# 动效导演台的 Remotion 消费器

这个适配器消费 `compileDirectorTimeline()` 生成的 `DirectorTimeline`，逐帧调用与导演台相同的 `renderDirectorMotionSvg()`。保存的导演决定、字幕和声音 cue 共用整数帧时钟。它是独立的本地工具，不改变 BeefTV 前端依赖或后台服务。

使用已安装且版本一致的 Remotion 项目作为 `--stack`；其 `node_modules` 必须包含 `@remotion/bundler`、`@remotion/renderer`、`remotion`、React 和 `@remotion/captions`。可以使用现有 Chrome Headless Shell，或传入 `--browser`。Windows 默认解析 Remotion 的 Headless Shell 缓存位置。

```powershell
node tools/motion_director/render.mjs --stack <Remotion项目> --input <制作包.json> --out <项目/output/demo-v1.0.0.mp4> --work-dir <项目/qa/render-v1.0.0> --audio <48k混音.wav>
```

制作包 JSON 是 `{ "timeline": <DirectorTimeline>, "captions": <Caption[]>, "width": 1280, "height": 720 }`。字幕采用 `@remotion/captions` 的毫秒字段。所有镜头必须带可执行 `direction`，镜头范围采用 `[startFrame,endFrame)`；未覆盖的帧阻断渲染。工具拒绝覆盖已有成片及工作目录。

`audio.py` 将时间线 cue 合成为稀疏音效，并通过真实人声的平滑局部电平避让。输入人声需为 48 kHz、16-bit PCM WAV，采样数必须与锁定时间线一致。单声道人声按 FFmpeg 的等功率中央声像转为立体声，实际增益记录在声音 QA 中。运行环境需要 NumPy。

```powershell
python tools/motion_director/audio.py --input <制作包.json> --voice <锁时人声.wav> --out-dir <新音频目录>
```

编码强制要求 `h264_nvenc`：先实际冒烟，再由 Remotion 使用 `hardwareAcceleration: required`，记录最终 FFmpeg 命令并核对实际编码器；不可用时失败，不静默降级。画面布局由 Chromium 渲染，图形后端记录为 SwiftShader，编码使用 NVIDIA GPU。默认 workers 为 2，最终值写入回执。

输出回执包含输入 SHA-256、实际 Remotion 版本、逐镜静帧、编码命令、成片 SHA-256、帧数和完整解码结果。声音 QA 分别记录人声、cue 和混音的 1 秒局部 RMS，以及采样级 cue 时间。技术检查不产生人工试听或动态内容审看结论。

本轮 10 个实际小样的规格、成片 SHA-256、执行时源码指纹及最后兼容性复核见 [validation-summary.json](validation-summary.json)。其中包括六个 4 秒模式小样、一个 21.6 秒获准原声解释片段、一个 12 秒三镜灰模、一个 8 秒跨两镜共享形状样例和一个 7 秒实际 UI 制作包交接；个人声音与媒体不存入此工具目录。

`presentation: "continuity-greybox"` 是三镜连续性预演绘制方式。它读取共享求值器的 `actionProgress`、token 轨迹及 `continuity.statesIn/statesOut["paper.holder"]`，绘制手臂和持物状态。支持 `table.left`、`teacher.right_hand`、`student.left_hand`、`table.right`。该预演只验证可见手臂动作、道具交接与跨镜状态，不验证真人身份或生成视频的角色一致性。
