package app

import (
	"fmt"
	"sort"
	"strings"
)

// 时间线渲染：把前端 TimelineProject 快照（tracks/clips 平铺，见
// web/src/types/timeline.ts TimelineProject v2）展开为可执行的 ffmpeg 步骤。
// 与前端 timeline-to-ffmpeg.ts 保持同一数据流：trim（按 sourceStartMs 裁切）
// → 空隙补黑场静音 → concat → 独立音轨混音。字幕产出 SRT，可选烧录。
//
// 输入布局统一为「每个片段两个输入：视频源 + 音频源」，空隙展开为独立
// 黑场片段，因此第 i 个片段的视频输入为 2i、音频输入为 2i+1。

type renderClip struct {
	ID               string   `json:"id"`
	Kind             string   `json:"kind"`
	TrackID          string   `json:"trackId"`
	StartMs          int64    `json:"startMs"`
	DurationMs       int64    `json:"durationMs"`
	SourceStartMs    int64    `json:"sourceStartMs"`
	SourceDurationMs int64    `json:"sourceDurationMs"`
	Volume           *float64 `json:"volume"`
	FadeInMs         int64    `json:"fadeInMs"`
	FadeOutMs        int64    `json:"fadeOutMs"`
	Text             string   `json:"text"`
	DirectMedia      *struct {
		ID         string `json:"id"`
		Kind       string `json:"kind"`
		StorageKey string `json:"storageKey"`
	} `json:"directMedia"`
}

type renderTrack struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Visible *bool  `json:"visible"`
	Muted   bool   `json:"muted"`
}

type renderProject struct {
	Version    int           `json:"version"`
	Tracks     []renderTrack `json:"tracks"`
	Clips      []renderClip  `json:"clips"`
	DurationMs int64         `json:"durationMs"`
}

type renderSource struct {
	ResourceID string
	Clip       renderClip
	Path       string
	Ext        string
	// HasAudio 由 ffprobe 探测得到；无音轨的媒体改为静音源，避免 map 失败。
	HasAudio bool
}

// renderSegment 是渲染序列中的一段；Kind 为 video/image 表示媒体片段，
// gap 表示补黑场静音的空隙段（无 Source）。
type renderSegment struct {
	Kind       string
	DurationMs int64
	GapMs      int64
	Clip       renderClip
	Source     *renderSource
	Muted      bool
}

type renderPlan struct {
	Segments      []renderSegment
	SubtitleSRT   string
	HasMedia      bool
	Audio         []renderSegment
	Error         string
	BurnSubtitles bool
}

// buildRenderPlan 挑选可见视频/图片轨片段按 startMs 排序，并把片段之间的
// 空隙展开为黑场段，使渲染序列在时间轴上连续。
func buildRenderPlan(project renderProject) renderPlan {
	visible := map[string]bool{}
	muted := map[string]bool{}
	for _, track := range project.Tracks {
		visible[track.ID] = track.Visible == nil || *track.Visible
		muted[track.ID] = track.Muted
	}
	plan := renderPlan{SubtitleSRT: buildRenderSubtitleSRT(project)}
	timelineEnd := int64(0)
	clips := make([]renderClip, 0, len(project.Clips))
	for _, clip := range project.Clips {
		if shown, exists := visible[clip.TrackID]; exists && !shown {
			continue
		}
		if clip.StartMs < 0 || clip.DurationMs <= 0 {
			plan.Error = "片段起点或时长无效"
			return plan
		}
		if clip.SourceStartMs < 0 || ((clip.Kind == "video" || clip.Kind == "audio") && clip.SourceDurationMs > 0 && clip.SourceStartMs+clip.DurationMs > clip.SourceDurationMs+1) {
			plan.Error = "裁剪超出源素材时长"
			return plan
		}
		if end := clip.StartMs + clip.DurationMs; end > timelineEnd {
			timelineEnd = end
		}
		if clip.Kind == "audio" {
			if !muted[clip.TrackID] {
				plan.Audio = append(plan.Audio, renderSegment{Kind: "audio", DurationMs: clip.DurationMs, Clip: clip})
			}
			continue
		}
		if clip.Kind != "video" && clip.Kind != "image" {
			continue
		}
		if clip.DurationMs <= 0 {
			continue
		}
		clips = append(clips, clip)
	}
	if project.DurationMs < 0 || (project.DurationMs > 0 && project.DurationMs < timelineEnd) {
		plan.Error = "时间线总时长小于片段范围"
		return plan
	}
	if project.DurationMs == 0 {
		project.DurationMs = timelineEnd
	}
	sort.SliceStable(clips, func(i, j int) bool {
		if clips[i].StartMs == clips[j].StartMs {
			return clips[i].ID < clips[j].ID
		}
		return clips[i].StartMs < clips[j].StartMs
	})

	cursor := int64(0)
	for _, clip := range clips {
		if clip.StartMs < cursor {
			plan.Error = "画面片段存在重叠，请先在时间线调整为连续剪辑"
			return plan
		}
		if gap := clip.StartMs - cursor; gap > 0 {
			plan.Segments = append(plan.Segments, renderSegment{Kind: "gap", DurationMs: gap, GapMs: gap})
		}
		plan.Segments = append(plan.Segments, renderSegment{Kind: clip.Kind, DurationMs: clip.DurationMs, Clip: clip, Muted: muted[clip.TrackID]})
		cursor = clip.StartMs + clip.DurationMs
	}
	if len(plan.Segments) > 0 && project.DurationMs > cursor {
		plan.Segments = append(plan.Segments, renderSegment{Kind: "gap", DurationMs: project.DurationMs - cursor})
	}
	for _, seg := range plan.Segments {
		if _, ok := mediaResourceID(seg.Clip); ok {
			plan.HasMedia = true
			break
		}
	}
	return plan
}

// mediaResourceID 从片段的 directMedia.storageKey（resource:<id>）还原资源 ID。
func mediaResourceID(clip renderClip) (string, bool) {
	if clip.DirectMedia == nil {
		return "", false
	}
	key := strings.TrimSpace(clip.DirectMedia.StorageKey)
	if !strings.HasPrefix(key, "resource:") {
		return "", false
	}
	id := strings.TrimSpace(strings.TrimPrefix(key, "resource:"))
	return id, id != ""
}

func buildRenderSubtitleSRT(project renderProject) string {
	visible := map[string]bool{}
	for _, track := range project.Tracks {
		visible[track.ID] = track.Visible == nil || *track.Visible
	}
	subtitle := make([]renderClip, 0, len(project.Clips))
	for _, clip := range project.Clips {
		if shown, exists := visible[clip.TrackID]; exists && !shown {
			continue
		}
		if clip.Kind != "subtitle" || strings.TrimSpace(clip.Text) == "" || clip.DurationMs <= 0 {
			continue
		}
		subtitle = append(subtitle, clip)
	}
	sort.SliceStable(subtitle, func(i, j int) bool {
		if subtitle[i].StartMs == subtitle[j].StartMs {
			return subtitle[i].ID < subtitle[j].ID
		}
		return subtitle[i].StartMs < subtitle[j].StartMs
	})
	if len(subtitle) == 0 {
		return ""
	}
	var out strings.Builder
	for i, clip := range subtitle {
		fmt.Fprintf(&out, "%d\n%s --> %s\n%s\n\n",
			i+1,
			formatSRTTimestamp(clip.StartMs),
			formatSRTTimestamp(clip.StartMs+clip.DurationMs),
			strings.TrimSpace(clip.Text))
	}
	return out.String()
}

const (
	renderWidth      = 1920
	renderHeight     = 1080
	renderFPS        = 30
	renderSampleRate = 44100
)

// buildRenderFFmpegArgs 依据渲染计划生成 ffmpeg 参数（工作目录内相对路径）。
// 每段固定两个输入：视频源与音频源，末尾 concat 为单路输出。
func buildRenderFFmpegArgs(plan renderPlan, target string) []string {
	if len(plan.Segments) == 0 {
		return nil
	}
	scale := fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2",
		renderWidth, renderHeight, renderWidth, renderHeight)
	args := []string{"-nostdin", "-y"}
	for _, seg := range plan.Segments {
		seconds := fmt.Sprintf("%.3f", float64(seg.DurationMs)/1000)
		switch seg.Kind {
		case "gap":
			args = append(args,
				"-f", "lavfi", "-t", seconds,
				"-i", fmt.Sprintf("color=c=black:s=%dx%d:r=%d", renderWidth, renderHeight, renderFPS),
				"-f", "lavfi", "-t", seconds,
				"-i", fmt.Sprintf("anullsrc=r=%d:cl=stereo", renderSampleRate),
			)
		case "image":
			if seg.Source == nil {
				args = append(args,
					"-f", "lavfi", "-t", seconds,
					"-i", fmt.Sprintf("color=c=black:s=%dx%d:r=%d", renderWidth, renderHeight, renderFPS),
					"-f", "lavfi", "-t", seconds,
					"-i", fmt.Sprintf("anullsrc=r=%d:cl=stereo", renderSampleRate),
				)
				continue
			}
			args = append(args,
				"-loop", "1", "-t", seconds, "-i", seg.Source.Path,
				"-f", "lavfi", "-t", seconds,
				"-i", fmt.Sprintf("anullsrc=r=%d:cl=stereo", renderSampleRate),
			)
		default:
			if seg.Source == nil {
				args = append(args,
					"-f", "lavfi", "-t", seconds,
					"-i", fmt.Sprintf("color=c=black:s=%dx%d:r=%d", renderWidth, renderHeight, renderFPS),
					"-f", "lavfi", "-t", seconds,
					"-i", fmt.Sprintf("anullsrc=r=%d:cl=stereo", renderSampleRate),
				)
				continue
			}
			if seg.Clip.SourceStartMs > 0 {
				args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.Clip.SourceStartMs)/1000))
			}
			args = append(args, "-t", seconds, "-i", seg.Source.Path)
			// 音频输入复用同一媒体文件；无音轨时 ffmpeg 会因 map 失败，
			// 由调用方探测后回退为静音源（见 renderAudioFallback）。
			if seg.Clip.SourceStartMs > 0 {
				args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.Clip.SourceStartMs)/1000))
			}
			args = append(args, "-t", seconds, "-i", seg.Source.Path)
		}
	}
	for _, seg := range plan.Audio {
		if seg.Source == nil {
			return nil
		}
		args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.Clip.SourceStartMs)/1000), "-t", fmt.Sprintf("%.3f", float64(seg.DurationMs)/1000), "-i", seg.Source.Path)
	}

	filters := make([]string, 0, len(plan.Segments)*2+1)
	labels := make([]string, 0, len(plan.Segments)*2)
	for i, seg := range plan.Segments {
		videoIn := 2 * i
		audioIn := 2*i + 1
		videoLabel := fmt.Sprintf("v%d", i)
		audioLabel := fmt.Sprintf("a%d", i)
		if seg.Source != nil && seg.Kind != "image" && !seg.Source.HasAudio {
			// 无音轨媒体：改用静音源，避免 map 失败。
			audioIn = videoIn
			filters = append(filters,
				fmt.Sprintf("[%d:v]setpts=PTS-STARTPTS,fps=%d,%s,setsar=1[%s]", videoIn, renderFPS, scale, videoLabel))
			silentLabel := fmt.Sprintf("silent%d", i)
			filters = append(filters,
				fmt.Sprintf("anullsrc=r=%d:cl=stereo[%s]", renderSampleRate, silentLabel))
			filters = append(filters,
				fmt.Sprintf("[%s]atrim=0:%.3f,asetpts=N/SR/TB[%s]", silentLabel, float64(seg.DurationMs)/1000, audioLabel))
		} else {
			filters = append(filters,
				fmt.Sprintf("[%d:v]setpts=PTS-STARTPTS,fps=%d,%s,setsar=1[%s]", videoIn, renderFPS, scale, videoLabel))
			filters = append(filters,
				fmt.Sprintf("[%d:a]%s[%s]", audioIn, renderAudioFilter(seg), audioLabel))
		}
		labels = append(labels, videoLabel, audioLabel)
	}
	var concatInputs strings.Builder
	for _, label := range labels {
		fmt.Fprintf(&concatInputs, "[%s]", label)
	}
	filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=1:a=1[vout][aout]", concatInputs.String(), len(plan.Segments)))
	audioOutput := "[aout]"
	videoOutput := "[vout]"
	if plan.BurnSubtitles && plan.SubtitleSRT != "" {
		filters = append(filters, "[vout]subtitles=timeline.srt[vsub]")
		videoOutput = "[vsub]"
	}
	if len(plan.Audio) > 0 {
		mixInputs := "[aout]"
		for i, seg := range plan.Audio {
			label := fmt.Sprintf("mix%d", i)
			filters = append(filters, fmt.Sprintf("[%d:a]%s,adelay=%d:all=1[%s]", 2*len(plan.Segments)+i, renderAudioFilter(seg), seg.Clip.StartMs, label))
			mixInputs += "[" + label + "]"
		}
		filters = append(filters, fmt.Sprintf("%samix=inputs=%d:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95:level=0[amixed]", mixInputs, len(plan.Audio)+1))
		audioOutput = "[amixed]"
	}

	args = append(args,
		"-filter_complex", strings.Join(filters, ";"),
		"-map", videoOutput, "-map", audioOutput,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
		"-t", fmt.Sprintf("%.3f", planTotalSeconds(plan)),
		target,
	)
	return args
}

func renderAudioFilter(seg renderSegment) string {
	volume := 1.0
	if seg.Clip.Volume != nil {
		volume = max(0, min(1, *seg.Clip.Volume))
	}
	if seg.Muted {
		volume = 0
	}
	duration := float64(seg.DurationMs) / 1000
	filter := fmt.Sprintf("asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo,volume=%.3f,apad,atrim=duration=%.3f", renderSampleRate, volume, duration)
	if seg.Clip.FadeInMs > 0 {
		filter += fmt.Sprintf(",afade=t=in:st=0:d=%.3f", min(duration, float64(seg.Clip.FadeInMs)/1000))
	}
	if seg.Clip.FadeOutMs > 0 {
		fade := min(duration, float64(seg.Clip.FadeOutMs)/1000)
		filter += fmt.Sprintf(",afade=t=out:st=%.3f:d=%.3f", duration-fade, fade)
	}
	return filter
}

func planTotalSeconds(plan renderPlan) float64 {
	var total int64
	for _, seg := range plan.Segments {
		total += seg.DurationMs
	}
	return float64(total) / 1000
}
