import { lookupMotionReference, MOTION_REFERENCE_ANNOTATIONS, MOTION_REFERENCE_SOURCE, type MotionReferenceReviewState } from "./motion-reference";

export type MotionPatternStatus = "catalogued" | "implemented" | "runtime_verified" | "user_approved";
export type MotionPatternFamily = "causality" | "camera" | "typography" | "diagram" | "response" | "continuity";

export interface MotionPatternReference {
    caseId: string;
    title: string;
    url: string;
    mediaUrl: string | null;
    sourceCommit: string;
    reviewState: MotionReferenceReviewState;
    segment: { fromSeconds: number; toSeconds: number } | null;
    relationship: "candidate_reference";
    reason: string;
}

export interface MotionPattern {
    id: string;
    name: string;
    nameZh: string;
    version: string;
    family: MotionPatternFamily;
    status: MotionPatternStatus;
    purpose: string;
    suitableFor: string[];
    unsuitableFor: string[];
    references: MotionPatternReference[];
    slots: Array<{ id: string; label: string; required: boolean }>;
    composition: string;
    phases: Array<{ id: string; from: number; to: number; instruction: string }>;
    secondaryResponse: string;
    camera: string;
    light: string;
    audio: string;
    parameterTimebase: { referenceFps: 30; description: string };
    parameters: Array<{ id: string; label: string; unit: string; min: number; max: number; defaultValue: number }>;
    transition: { input: string; output: string; conflicts: string[] };
    qa: string[];
    executor: { id: string | null; capabilities: string[]; limitations: string[] };
    preview: { state: "pending" | "local-delivery"; url: null; artifactRelativePath?: string };
    evidence: { implementation: string | null; runtime: string | null; humanReview: null; userApproval: null };
}

export const FIRST_MOTION_PATTERN_IDS = [
    "object-relay", "camera-push", "kinetic-type", "diagram-morph", "impact-reveal", "continuous-shape-transition",
] as const;

interface PatternProposal {
    id: string;
    name: string;
    nameZh: string;
    family: MotionPatternFamily;
    purpose: string;
    action: string;
    references: string[];
    unsuitable: string;
    qa: string;
}

const PROPOSALS: PatternProposal[] = [
    { id: "object-relay", name: "Object Relay", nameZh: "对象交接", family: "causality", purpose: "解释任务、数据或权限从谁交给谁。", action: "保持同一标记，发送端启动后沿因果方向移动，接触时接收端响应。", references: ["2104148233106723099", "2103918792845963545"], unsuitable: "没有交接关系时不要制造传递。", qa: "标记只有一个；接收端不能早于接触响应。" },
    { id: "state-propagation", name: "State Propagation", nameZh: "状态传播", family: "causality", purpose: "展示一次状态改变如何逐步影响依赖对象。", action: "源节点先变，沿真实依赖边逐级触发后继，每步停留可读。", references: ["2102737776219168939", "2106208810604081208"], unsuitable: "平行但无依赖的关系。", qa: "响应顺序必须与内容依赖图一致。" },
    { id: "token-routing", name: "Token Routing", nameZh: "令牌路由", family: "causality", purpose: "解释数据经过条件路由到目标。", action: "令牌按既有连线进入决策节点，只有被选择的出口激活。", references: ["2106208810604081208", "2102737776219168939"], unsuitable: "无法确认路由条件和方向。", qa: "不新增分支；令牌数量符合原句。" },
    { id: "queue-release", name: "Queue Release", nameZh: "队列释放", family: "causality", purpose: "说明等待、资源约束与释放顺序。", action: "对象排列等待，门控事件后逐个释放，间隔代表处理节奏。", references: ["2104148233106723099"], unsuitable: "内容要求并发且不保证顺序。", qa: "队列保持次序；等待与放行时刻明确。" },
    { id: "branch-decision", name: "Branch Decision", nameZh: "分支决策", family: "causality", purpose: "聚焦条件如何改变路径。", action: "保留全部可选分支，条件出现后强调选择分支，再沿它传递状态。", references: ["2106208810604081208", "2103683057689522564"], unsuitable: "条件未知、没有真实分支或暗示确定结果不成立。", qa: "条件文本和被选出口一一对应。" },
    { id: "feedback-loop", name: "Feedback Loop", nameZh: "反馈回路", family: "causality", purpose: "解释结果如何反馈给下一次更新。", action: "结果沿反馈边回到输入，参数变化可见，下一轮继承更新状态。", references: ["2102737776219168939"], unsuitable: "仅一次单向因果过程。", qa: "反馈闭环保持方向；变化量来自内容。" },
    { id: "camera-push", name: "Camera Push", nameZh: "摄影机推进", family: "camera", purpose: "把观看焦点从整体带到关键对象。", action: "对象先明确焦点，摄影机缓慢推进；结束时保持足够阅读停留。", references: ["2104148233106723099", "2102591147927654847", "2103273003555402193"], unsuitable: "需要同时比较全部对象或推进导致字被裁切。", qa: "焦点稳定；关键内容在安全区。" },
    { id: "camera-pull", name: "Camera Pull", nameZh: "摄影机拉远", family: "camera", purpose: "把局部发现放回整体关系。", action: "从关键对象拉远逐步露出相邻对象，最终构图展示尺度关系。", references: ["2104148233106723099"], unsuitable: "外部空间无解释作用。", qa: "拉远过程主体不丢失；层级变化可读。" },
    { id: "orbit-reveal", name: "Orbit Reveal", nameZh: "环绕揭示", family: "camera", purpose: "通过观察角度变化揭示遮挡面或空间结构。", action: "围绕同一目标转动有限角度，解释新增可见面，再稳定机位。", references: ["2106060741732147653", "2102591147927654847"], unsuitable: "平面文字或没有背面信息的图。", qa: "注视目标与轴线连续；方向标识保持。" },
    { id: "parallax-depth", name: "Parallax Depth", nameZh: "视差纵深", family: "camera", purpose: "让前中后景层级服务空间理解。", action: "相机平移时分层产生对应视差，前景不能持续遮住证据。", references: ["2103099194693271874", "2102591147927654847"], unsuitable: "层间关系仅是装饰。", qa: "视差方向与相机方向一致；文字可读。" },
    { id: "focus-shift", name: "Focus Shift", nameZh: "焦点转移", family: "camera", purpose: "把注意从原因切到结果。", action: "先保持源对象清晰，动作触发后转向目标并完成清晰停留。", references: ["2102591147927654847"], unsuitable: "模糊将遮掉必要的对照证据。", qa: "焦点时序与动作一致；不会只有装饰性虚化。" },
    { id: "scale-journey", name: "Scale Journey", nameZh: "尺度旅程", family: "camera", purpose: "解释跨数量级的尺度关系。", action: "沿明确尺度锚点推进或拉远，每层标出单位与对应对象。", references: ["2106060741732147653", "2103683057689522564"], unsuitable: "尺度数值未知或无连续比较关系。", qa: "尺度锚点、单位和相对大小一致。" },
    { id: "kinetic-type", name: "Kinetic Type", nameZh: "动态文字", family: "typography", purpose: "用一句关键结论配合真实声音锚点。", action: "完整中文分组出现，关键词在语音锚点加强，末段保持阅读。", references: ["2104148233106723099", "2102514581684052169"], unsuitable: "密集长段或无真实语音时间却宣称声画锁时。", qa: "中文完整；不重叠、不越界；真实声音锚点有来源。" },
    { id: "semantic-highlight", name: "Semantic Highlight", nameZh: "语义强调", family: "typography", purpose: "保持上下文时强调单个概念。", action: "保留原句，只改变关键词强调状态，其他词保持可读。", references: ["2106208810604081208", "2104148233106723099"], unsuitable: "同时强调多个同等权重词。", qa: "强调不改变原句语义与断句。" },
    { id: "phrase-build", name: "Phrase Build", nameZh: "短句建立", family: "typography", purpose: "逐步建立一句可读结论。", action: "按语义块出现，保留已出现内容，再做完整句停留。", references: ["2104148233106723099", "2103288413969621231"], unsuitable: "逐字速度超过观看者可读速度。", qa: "末帧完整；块序符合中文阅读顺序。" },
    { id: "contrast-type", name: "Contrast Type", nameZh: "文字对照", family: "typography", purpose: "让两个概念差异一眼可比。", action: "两列保持相同基线和出现规则，只强调真实差异。", references: ["2104148233106723099", "2106060741732147653"], unsuitable: "两者并非同一维度且缺单位。", qa: "对照轴一致；不以面积暗示错误比例。" },
    { id: "number-resolve", name: "Number Resolve", nameZh: "数值落定", family: "typography", purpose: "使一个确定数值成为结论焦点。", action: "先出现数值标签和单位，变化只表示已知过程，最后落定并停留。", references: ["2106060741732147653", "2102737776219168939"], unsuitable: "计数滚动造成虚假精度或与来源不符。", qa: "最终数值和单位来自原稿；中间数值不冒充数据。" },
    { id: "type-to-object", name: "Type-to-Object", nameZh: "文字到对象", family: "typography", purpose: "把命名术语与对应实体关联。", action: "术语靠近对象锚点，再收敛成标注；语义身份保持。", references: ["2104148233106723099", "2103273003555402193"], unsuitable: "文字形状不对应对象身份。", qa: "标签与实体映射唯一；对象变形不篡改意思。" },
    { id: "diagram-morph", name: "Diagram Morph", nameZh: "关系图变形", family: "diagram", purpose: "解释同一组实体的状态变化。", action: "节点 ID 保持，现有关系渐变到明示的新状态，最后给出关系阅读停留。", references: ["2103273003555402193", "2103683057689522564", "2102737776219168939"], unsuitable: "节点身份或关系变化无法追溯。", qa: "不凭空新增箭头；实体 ID 在入口出口一致。" },
    { id: "layer-peel", name: "Layer Peel", nameZh: "逐层揭示", family: "diagram", purpose: "让观众逐层理解结构。", action: "表层退开露出当前层，标出层间关系，再保持全部必要上下文。", references: ["2104837895773417649", "2106060741732147653"], unsuitable: "层级只是装饰或真实结构非嵌套。", qa: "层级及遮挡关系符合内容。" },
    { id: "before-after-match", name: "Before-After Match", nameZh: "前后匹配", family: "diagram", purpose: "比较一次改变前后的同一对象。", action: "保留对象锚点、机位与标签，只改变被解释字段。", references: ["2104148233106723099", "2106060741732147653"], unsuitable: "比较同时改变多个无关变量。", qa: "对应实体对齐；变化来自同一比较基准。" },
    { id: "group-to-hierarchy", name: "Group-to-Hierarchy", nameZh: "分组到层级", family: "diagram", purpose: "将平铺元素组织成明确层级。", action: "元素沿真实归属进入分组，父层出现时子元素仍可追踪。", references: ["2103683057689522564", "2106208810604081208"], unsuitable: "归属未知或元素可多属却被画成独属。", qa: "每个归属有内容来源；层级标签可读。" },
    { id: "flow-to-map", name: "Flow-to-Map", nameZh: "流程到关系图", family: "diagram", purpose: "把顺序流程放回整体结构。", action: "保留流程节点，再展开支路或层级，不丢失原始箭头方向。", references: ["2103683057689522564", "2106208810604081208"], unsuitable: "新结构会把时间顺序误画为包含关系。", qa: "顺序边与结构边有明确区分。" },
    { id: "constraint-reveal", name: "Constraint Reveal", nameZh: "约束揭示", family: "diagram", purpose: "说明为什么某个选项不可行。", action: "展示候选位置，约束边界出现后保留可行域与被挡路径。", references: ["2104148233106723099", "2103683057689522564"], unsuitable: "约束没有实际来源或想把偏好画成硬限制。", qa: "约束条件与可行区域一致。" },
    { id: "impact-reveal", name: "Impact Reveal", nameZh: "冲击揭示", family: "response", purpose: "让可解释的事件触发结果出现。", action: "触发物接触，短暂压缩或闪变，结果随后出现并回稳。", references: ["2104148233106723099", "2102514581684052169"], unsuitable: "没有触发事件或口播需平静长读。", qa: "结果不能早于触发；声音峰与接触同帧。" },
    { id: "spring-settle", name: "Spring Settle", nameZh: "弹簧回稳", family: "response", purpose: "让目标切换有惯性并稳定。", action: "目标改变后有限过冲，响应幅度衰减，进入可读停留。", references: ["2103273003555402193", "2104200939095904322"], unsuitable: "真实刚性无弹性或禁止过冲的关键指标。", qa: "过冲有界；尾部误差满足阈值。" },
    { id: "momentum-carry", name: "Momentum Carry", nameZh: "惯性承接", family: "response", purpose: "把前一个动作的速度自然传到下一步。", action: "保持出场和入场运动方向，解释受力后再减速到目标。", references: ["2104200939095904322", "2104148233106723099"], unsuitable: "方向改变但没有受力或叙事原因。", qa: "接缝位置与速度方向连续。" },
    { id: "elastic-contact", name: "Elastic Contact", nameZh: "弹性接触", family: "response", purpose: "表现有材质依据的接触形变。", action: "接触时局部压缩，体积或轮廓守恒后恢复；刚体不软化。", references: ["2104200939095904322", "2103273003555402193"], unsuitable: "刚体、人物关节或不允许变形的文字。", qa: "接触有空间证据；材质与形变幅度一致。" },
    { id: "ripple-response", name: "Ripple Response", nameZh: "涟漪响应", family: "response", purpose: "解释局部影响向外传播。", action: "从真实接触位置产生有限波纹，沿传播速度扩散并衰减。", references: ["2102786378282987591"], unsuitable: "没有传播介质或把波纹误作物理量。", qa: "波源与接触点一致；传播不早于触发。" },
    { id: "particle-convergence", name: "Particle Convergence", nameZh: "粒子汇聚", family: "response", purpose: "以稳定对象汇聚表现整体形成。", action: "固定 seed 的元素向目标槽位汇聚，最后构成明确实体。", references: ["2102514581684052169", "2103288413969621231"], unsuitable: "元素身份需要逐个读清或汇聚会误示统计数量。", qa: "乱序求帧一致；实体轮廓可识别。" },
    { id: "continuous-shape-transition", name: "Continuous Shape Transition", nameZh: "连续形状过镜", family: "continuity", purpose: "把前后镜共同形状作为连续锚点。", action: "保留共享对象中心及身份，出口形状平滑过渡到下镜入口。", references: ["2103273003555402193", "2104148233106723099"], unsuitable: "两镜实体不同却无叙事转换依据。", qa: "入口出口锚点一致；无身份偷换和遮挡跳变。" },
    { id: "match-cut", name: "Match Cut", nameZh: "匹配剪切", family: "continuity", purpose: "用一致构图或动作接续两镜。", action: "对齐主体位置、轮廓或动作相位，再明确新镜语义。", references: ["2103099194693271874", "2104148233106723099"], unsuitable: "表面相似会把不同对象误认为同一物。", qa: "匹配点与身份变化理由都有记录。" },
    { id: "object-wipe", name: "Object Wipe", nameZh: "对象遮挡过镜", family: "continuity", purpose: "利用画内对象遮挡建立自然切换。", action: "对象横过镜头形成短遮挡，下镜在对应遮挡位置露出。", references: ["2104837895773417649", "2102514581684052169"], unsuitable: "遮挡掩盖解释关键证据。", qa: "遮挡时长有界；露出后的焦点明确。" },
    { id: "portal-passage", name: "Portal Passage", nameZh: "通道穿越", family: "continuity", purpose: "用明确空间入口连接不同世界。", action: "先建立入口及目标方向，主体穿越后保持身份、朝向和动作阶段。", references: ["2103099194693271874"], unsuitable: "纯抽象机制被画成不存在的物理空间。", qa: "入口出口轴线、持物和身份连续。" },
    { id: "material-shift", name: "Material Shift", nameZh: "材质切换", family: "continuity", purpose: "换画风时保留实体身份。", action: "同一轮廓、骨架与颜色角色保持，只渐变表面表达。", references: ["2103099194693271874", "2104837895773417649"], unsuitable: "材质变化使对象读成新身份。", qa: "轮廓和不变量保持；变色含义有依据。" },
    { id: "light-bridge", name: "Light Bridge", nameZh: "光向承接", family: "continuity", purpose: "让过镜光向和情绪连续。", action: "保留主光方向与强弱关系，在叙事转换时渐变到下一镜光场。", references: ["2103099194693271874", "2103288413969621231"], unsuitable: "无动机的全屏光效或隐藏主体。", qa: "主光向、曝光与主体可见性跨镜可追溯。" },
];

const FAMILY_GUIDES: Record<MotionPatternFamily, {
    slots: string[]; composition: string; camera: string; light: string; audio: string; secondary: string; suitable: string[];
}> = {
    causality: { slots: ["source", "target", "payload", "trigger"], composition: "原因位于阅读起点，结果位于阅读终点；连线只表达原句中的真实方向。", camera: "先稳定全局关系；只在交接结束后按观看需求推进。", light: "主光和对比突出当前响应对象，不对所有节点同时加亮。", audio: "可选接触 cue 与事件同帧；人声期间避让，静默也是有效决定。", secondary: "接收端或依赖节点在触发事件后响应，滞后可编辑。", suitable: ["信息流与任务交接", "明确因果与状态依赖"] },
    camera: { slots: ["focusSubject", "context", "entryAnchor", "exitAnchor"], composition: "先建立主体与上下文关系，机位改变后主体仍处于安全区。", camera: "机位轨迹与主体动作分别编辑；固定注视锚点，禁止无动机跳变。", light: "机位改变保持光向及材质读法；避免曝光变化替代构图。", audio: "运镜无需自动加 whoosh；仅明显速度事件可配可选低电平 cue。", secondary: "背景视差由相机与空间产生，不随意给阴影增加延迟。", suitable: ["观看焦点与尺度变化", "需要解释的空间结构"] },
    typography: { slots: ["text", "emphasis", "voiceAnchor", "readingHold"], composition: "完整中文与明确层级位于安全区，文字占用由实际测量决定。", camera: "阅读期间固定机位；文字跟随主体时仍保持字号和稳定基线。", light: "以对比和字体层级服务阅读，避免辉光抹掉笔画。", audio: "优先真实口播锚点；额外打字/强调音由用户决定且不得盖过人声。", secondary: "次级词组在主语义块建立后进入，不把每字同时启动当默认。", suitable: ["一句结论与术语", "中文阅读与语音对应"] },
    diagram: { slots: ["nodes", "edges", "beforeState", "afterState"], composition: "节点身份与阅读顺序稳定；现有关系保留到变化原因可见。", camera: "变化期间保持图解可比；重排结束后可对关键关系推进。", light: "状态强调只落在变化字段，其他节点保持上下文可见。", audio: "状态切换 cue 可选；真实语音解释优先，避免每节点打音效。", secondary: "先展示变化原因，再改变节点状态和关系；等待观众读完。", suitable: ["实体关系与层级", "明确前后状态比较"] },
    response: { slots: ["trigger", "subject", "response", "material"], composition: "触发、接触和结果同时可追踪，结果停留后再退出。", camera: "冲击幅度与相机响应独立；文字阅读期间限制震动。", light: "接触可局部强调；不把闪白当所有事件的固定响应。", audio: "impact 对应真实接触帧，强度与材质对应；局部检查并避让口播。", secondary: "只有有受力解释的对象才跟随响应，回稳幅度逐步衰减。", suitable: ["接触和受力结果", "有解释用途的惯性或软体响应"] },
    continuity: { slots: ["sharedIdentity", "outState", "inState", "narrativeReason"], composition: "出口/入口共享锚点，持物、方向和尺度保持，身份变化需叙事原因。", camera: "接缝两端位置、视线与轴线明确；不把跳机位隐藏在转场里。", light: "跨镜主光和曝光需要对应；改变必须有环境或叙事理由。", audio: "过镜声音有对应事件才使用，保持口播和音乐的尾部覆盖。", secondary: "新镜信息在共享锚点建立后露出，避免一瞬替换所有内容。", suitable: ["前后镜共享对象", "跨镜身份或动作延续"] },
};

function referenceFor(caseId: string): MotionPatternReference {
    const reference = lookupMotionReference(caseId);
    if (!reference) throw new Error(`模式参考缺失：${caseId}`);
    const annotation = MOTION_REFERENCE_ANNOTATIONS[caseId];
    return {
        caseId, title: reference.title, url: reference.source.url, mediaUrl: reference.media?.url ?? null,
        sourceCommit: MOTION_REFERENCE_SOURCE.commit,
        reviewState: annotation?.reviewState ?? "metadata_only",
        segment: annotation?.segment ?? null,
        relationship: "candidate_reference",
        reason: annotation?.reason ?? "上游元数据候选；尚未确认该片段具备本模式机制。",
    };
}

export const MOTION_PATTERNS: MotionPattern[] = PROPOSALS.map((proposal) => {
    const guide = FAMILY_GUIDES[proposal.family];
    const firstExecutor = FIRST_MOTION_PATTERN_IDS.some((id) => id === proposal.id);
    return {
        id: proposal.id, name: proposal.name, nameZh: proposal.nameZh, version: "1.0.0", family: proposal.family,
        status: firstExecutor ? "runtime_verified" : "catalogued", purpose: proposal.purpose, suitableFor: guide.suitable, unsuitableFor: [proposal.unsuitable],
        references: proposal.references.map(referenceFor),
        slots: guide.slots.map((id) => ({ id, label: id, required: true })),
        composition: guide.composition,
        phases: [
            { id: "establish", from: 0, to: 0.2, instruction: "建立原句、主体和初态；先让观众识别焦点。" },
            { id: "primary", from: 0.2, to: 0.65, instruction: proposal.action },
            { id: "secondary", from: 0.65, to: 0.8, instruction: guide.secondary },
            { id: "reading-hold", from: 0.8, to: 1, instruction: "终态稳定可读，满足真实声音与过镜条件后退出。" },
        ],
        secondaryResponse: guide.secondary, camera: guide.camera, light: guide.light, audio: guide.audio,
        parameterTimebase: { referenceFps: 30, description: "帧参数是 30fps 参考值；按 round(value × frameRate / 30) 转为 authored frameRate 的整数帧，再由 director-motion 校验。5秒上限随 24/25/30fps 分别为 120/125/150帧，不是所有帧率固定150。" },
        parameters: [
            { id: "durationFrames", label: "镜长", unit: "frames", min: 24, max: 600, defaultValue: 120 },
            { id: "motion.amplitude", label: "运动幅度", unit: "normalized", min: 0, max: 2, defaultValue: 1 },
            { id: "motion.staggerFrames", label: "次级响应间隔", unit: "frames", min: 0, max: 150, defaultValue: 8 },
            { id: "motion.settleFrames", label: "回稳", unit: "frames", min: 1, max: 150, defaultValue: 14 },
            { id: "camera.push", label: "摄影机推进", unit: "normalized", min: 0, max: 0.5, defaultValue: 0.12 },
            { id: "camera.delayFrames", label: "摄影机延迟", unit: "frames", min: 0, max: 150, defaultValue: 8 },
            { id: "readableHoldFrames", label: "阅读停留", unit: "frames", min: 0, max: 108000, defaultValue: 24 },
        ],
        transition: { input: "稳定对象 ID、初态、入口锚点和原句来源", output: "相同 ID 的终态、出口锚点及接触/结束事件", conflicts: ["相邻镜共享对象身份不一致", "已手调参数被静默覆盖", "阅读停留与语音锁时冲突"] },
        qa: [proposal.qa, "时段半开且无重叠；从任意帧独立求值", "参考尚无动态审看时保留缺口，不自动宣称审美合格"],
        executor: { id: firstExecutor ? proposal.id : null, capabilities: firstExecutor ? ["deterministic-frame", "svg-preview", "timeline-input", "remotion-render"] : [], limitations: [firstExecutor ? "r002 六模式已实际渲染并完整解码；运行验收覆盖对应样片与参数，不等于所有参数组合、人物生成或用户审美验收。" : "仅编目；未实现执行器。", "抽样静帧不证明候选参考完整动态机制。", "帧参数按参考帧率换算后遵循 director-motion 合同；本模式构图仍需逐镜编辑。", "未进行用户动态看听；新增音频锚点等后续改动的覆盖范围见独立验收记录。"] },
        preview: firstExecutor ? { state: "local-delivery", url: null, artifactRelativePath: `disposable/motion-director-demo/output/${proposal.id}-v1.0.1.mp4` } : { state: "pending", url: null },
        evidence: { implementation: firstExecutor ? "web/src/lib/canvas/director/director-motion.ts#evaluateDirectorMotion" : null, runtime: firstExecutor ? "docs/motion-director-validation.md#rendered-patterns" : null, humanReview: null, userApproval: null },
    };
});

export function lookupMotionPattern(id: string): MotionPattern | undefined {
    return MOTION_PATTERNS.find((pattern) => pattern.id === id);
}

export function motionPatternStatusCounts(): Record<MotionPatternStatus, number> {
    const counts: Record<MotionPatternStatus, number> = { catalogued: 0, implemented: 0, runtime_verified: 0, user_approved: 0 };
    MOTION_PATTERNS.forEach((pattern) => counts[pattern.status]++);
    return counts;
}
