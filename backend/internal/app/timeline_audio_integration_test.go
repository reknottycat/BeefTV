package app

import (
	"context"
	"encoding/binary"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestTimelineRenderIdempotencyAndConflict(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	req := TimelineRenderCreateRequest{ClientKey: "production-export-1", Timeline: renderTestProject("resource:fixture")}
	first, err := svc.CreateTimelineRenderTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	again, err := svc.CreateTimelineRenderTask("user", req)
	if err != nil || again.ID != first.ID {
		t.Fatalf("replay: %v, %v", again, err)
	}
	req.Timeline.Clips[0].DurationMs = 1000
	if _, err := svc.CreateTimelineRenderTask("user", req); err == nil {
		t.Fatal("changed snapshot accepted under an existing key")
	}
	other, err := svc.CreateTimelineRenderTask("other", req)
	if err != nil || other.ID == first.ID {
		t.Fatalf("owner isolation: %v", err)
	}
}

func TestTimelineRenderRejectsOverlapAndRespectsTracks(t *testing.T) {
	project := renderTestProject("resource:a")
	project.Clips = append(project.Clips, renderClipFixture("b", "video", "track-v1", 1000, 1000, "resource:b"))
	if buildRenderPlan(project).Error == "" {
		t.Fatal("overlap accepted")
	}
	project.Clips = project.Clips[:1]
	zero := 0.0
	project.Clips[0].Volume = &zero
	project.Tracks = append(project.Tracks, renderTrack{ID: "muted", Kind: "audio", Muted: true})
	project.Clips = append(project.Clips, renderClipFixture("sound", "audio", "muted", 0, 2000, "resource:sound"))
	plan := buildRenderPlan(project)
	if len(plan.Audio) != 0 {
		t.Fatal("muted track mixed")
	}
	plan.Segments[0].Source = &renderSource{Path: "video.mp4", HasAudio: true}
	if !strings.Contains(strings.Join(buildRenderFFmpegArgs(plan, "out.mp4"), " "), "volume=0.000") {
		t.Fatal("explicit zero restored source audio")
	}
}

func TestTimelineRenderRejectsInvalidSourceAndTruncatedAudio(t *testing.T) {
	project := renderTestProject("resource:video")
	project.Clips[0].SourceStartMs = -1
	if buildRenderPlan(project).Error == "" {
		t.Fatal("negative source offset accepted")
	}
	project.Clips[0].SourceStartMs = 100
	project.Clips[0].SourceDurationMs = 2000
	if buildRenderPlan(project).Error == "" {
		t.Fatal("source overrun accepted")
	}
	project.Clips[0].SourceStartMs = 0
	project.Clips = append(project.Clips, renderClipFixture("audio", "audio", "a", 1500, 1500, "resource:audio"))
	if buildRenderPlan(project).Error == "" {
		t.Fatal("audio tail truncated by timeline duration")
	}
	project.DurationMs = 0
	plan := buildRenderPlan(project)
	if plan.Error != "" || len(plan.Segments) != 2 || plan.Segments[1].DurationMs != 1000 {
		t.Fatalf("unspecified duration must include the audio tail: %#v", plan)
	}
}

// Opt-in real-media check. It tests FFmpeg output and decoded audio, not provider generation.
func TestTimelineRenderRealAudioTrimGapAndQC(t *testing.T) {
	configured := os.Getenv("BEEFTV_TEST_FFMPEG")
	if configured == "" {
		t.Skip("set BEEFTV_TEST_FFMPEG for the real-media check")
	}
	t.Setenv(renderFfmpegEnv, configured)
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command(configured, args...)
		cmd.Dir = dir
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg: %v\n%s", err, output)
		}
	}
	video, sound, output := filepath.Join(dir, "video.mp4"), filepath.Join(dir, "sound.wav"), filepath.Join(dir, "output.mp4")
	run("-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", video)
	run("-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=3", sound)
	zero := 0.0
	clip := renderClipFixture("picture", "video", "v", 500, 1000, "resource:v")
	clip.SourceStartMs, clip.Volume = 700, &zero
	audio := renderClipFixture("voice", "audio", "a", 1800, 1000, "resource:a")
	audio.SourceStartMs, audio.FadeInMs, audio.FadeOutMs = 500, 100, 100
	plan := buildRenderPlan(renderProject{Version: 2, DurationMs: 3500, Tracks: []renderTrack{{ID: "v", Kind: "video"}, {ID: "a", Kind: "audio"}}, Clips: []renderClip{clip, audio}})
	plan.Segments[1].Source = &renderSource{Path: video, HasAudio: true}
	plan.Audio[0].Source = &renderSource{Path: sound, HasAudio: true}
	plan.SubtitleSRT = "1\n00:00:00,500 --> 00:00:01,500\nControlled subtitle\n"
	plan.BurnSubtitles = true
	if err := os.WriteFile(filepath.Join(dir, "timeline.srt"), []byte(plan.SubtitleSRT), 0600); err != nil {
		t.Fatal(err)
	}
	run(buildRenderFFmpegArgs(plan, output)...)
	if err := verifyRenderedMedia(context.Background(), output, 3500); err != nil {
		t.Fatal(err)
	}
	if err := verifyRenderedMedia(context.Background(), output, 1000); err == nil {
		t.Fatal("QC accepted the wrong duration")
	}
	pcm, err := exec.Command(configured, "-v", "error", "-i", output, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-").Output()
	if err != nil {
		t.Fatal(err)
	}
	rms := func(start, end float64) float64 {
		sum := 0.0
		count := 0
		for i := int(start*8000) * 2; i < int(end*8000)*2 && i+1 < len(pcm); i += 2 {
			v := float64(int16(binary.LittleEndian.Uint16(pcm[i:i+2]))) / 32768
			sum += v * v
			count++
		}
		return math.Sqrt(sum / float64(count))
	}
	if rms(.7, 1.3) > 0.002 {
		t.Fatal("muted video remains audible")
	}
	if rms(2, 2.5) < 0.03 {
		t.Fatal("delayed independent audio missing")
	}
	if rms(3, 3.4) > 0.002 {
		t.Fatal("audio trim extends beyond clip")
	}
}
