package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/localcomfy"
	"infinite-canvas/backend/internal/model"
)

// Exercise the native HTTP recovery and resource store with an encoded MP4,
// rather than a handcrafted box fixture. The adapter remains a loopback mock.
func TestNativeComfyFFmpegMP4RecoveryAndImport(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required for the real MP4 integration test")
	}
	path := filepath.Join(t.TempDir(), "generated.mp4")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=1", "-an",
		"-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate real MP4: %v\n%s", err, output)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name          string
		width, height int
		duration      float64
		mismatch      bool
	}{
		{"matching", 320, 180, 1, false},
		{"dimensions-mismatch", 2, 1, 1, true},
		{"duration-mismatch", 320, 180, 3, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := nativeComfyTestFixture(t)
			f.recipe.Mode = "t2v"
			f.recipe.Output = localcomfy.Output{Width: tc.width, Height: tc.height, FPS: 24, DurationSeconds: tc.duration, MimeType: "video/mp4"}
			f.data = data
			// The fixture advertises 2x1 asset dimensions. Import must use the
			// actual MP4 track, not accept the adapter's unverified dimensions.
			f.running(nativeJobID)
			f.committed("completed")
			if _, err := f.s.CancelTask(context.Background(), "owner", f.task.ID); err != nil {
				t.Fatal(err)
			}
			f.enabled = false
			result, recoveryErr := f.s.QueryFailedVideoTask(context.Background(), "owner", f.task.ID)
			if f.jobPosts != 0 || f.contentLoads != 1 {
				t.Fatalf("recovery must fetch the original media once without generating: jobs=%d content=%d", f.jobPosts, f.contentLoads)
			}
			var resources []model.Resource
			if err := f.db.Find(&resources).Error; err != nil {
				t.Fatal(err)
			}
			stored, err := f.latest()
			if err != nil {
				t.Fatal(err)
			}
			if tc.mismatch {
				var appErr *AppError
				if !errors.As(recoveryErr, &appErr) || appErr.Reason != "output_spec_mismatch" {
					t.Fatalf("expected media metadata rejection, got %v", recoveryErr)
				}
				if len(resources) != 0 || stored.Status != model.TaskStatusCancelled || stored.ProviderRequestID != nativeJobID {
					t.Fatalf("invalid media was imported or original job lost: resources=%#v task=%#v", resources, stored)
				}
				return
			}
			if recoveryErr != nil || result == nil || !result.Recovered || stored.Status != model.TaskStatusSucceeded || stored.ProviderRequestID != nativeJobID {
				t.Fatalf("real MP4 recovery failed: result=%#v task=%#v err=%v", result, stored, recoveryErr)
			}
			if len(resources) != 1 {
				t.Fatalf("expected one imported resource, got %#v", resources)
			}
			resource := resources[0]
			if resource.UserID != "owner" || resource.Provider != "local" || resource.Status != model.ResourceStatusReady || resource.Kind != "video" || resource.MimeType != "video/mp4" || resource.Size != int64(len(data)) || resource.Width != 320 || resource.Height != 180 || resource.DurationMs != 1000 {
				t.Fatalf("incorrect real MP4 resource metadata: %#v", resource)
			}
			var output struct {
				Video localcomfy.Media `json:"video"`
			}
			if err := json.Unmarshal([]byte(stored.ResultJSON), &output); err != nil {
				t.Fatal(err)
			}
			if output.Video.ResourceID != resource.ID || output.Video.StorageKey != "resource:"+resource.ID || output.Video.Width != 320 || output.Video.Height != 180 || output.Video.DurationMs != 1000 {
				t.Fatalf("task result does not reference the imported MP4: %#v", output)
			}
			_, body, err := f.s.OpenResource("owner", resource.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer body.Close()
			imported, err := io.ReadAll(body)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(imported, data) {
				t.Fatal("native resource bytes differ from the archived MP4")
			}
			decodeCtx, decodeCancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer decodeCancel()
			decode := exec.CommandContext(decodeCtx, ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-i", "pipe:0", "-map", "0:v:0", "-f", "null", "-")
			decode.Stdin = bytes.NewReader(imported)
			if output, err := decode.CombinedOutput(); err != nil {
				t.Fatalf("decode imported MP4: %v\n%s", err, output)
			}
		})
	}
}
