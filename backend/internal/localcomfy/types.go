// Package localcomfy owns the trusted adapter protocol and recoverable job state.
// Native authorization, task leases and asset persistence enter through ports.
package localcomfy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"regexp"
)

const ModelPrefix = "local-comfy:"

var idPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var recipePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)
var versionPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func ValidID(value string) bool { return idPattern.MatchString(value) }

type Selection struct {
	RecipeID   string  `json:"recipeId"`
	Seed       uint32  `json:"seed"`
	Version    string  `json:"recipeVersion"`
	Recipe     *Recipe `json:"recipeSpec,omitempty"`
	RetryJobID string  `json:"_retryJobId,omitempty"`
	RetryKey   string  `json:"_retryKey,omitempty"`
}
type Config struct {
	Configured        bool  `json:"configured"`
	GenerationEnabled bool  `json:"generation_enabled"`
	RecipeCount       int   `json:"recipe_count"`
	MaxReferenceBytes int64 `json:"max_reference_bytes"`
}
type Constraint struct {
	Width     int      `json:"width"`
	Height    int      `json:"height"`
	MimeTypes []string `json:"mime_types"`
}
type Output struct {
	MimeType        string  `json:"mime_type,omitempty"`
	Width           int     `json:"width"`
	Height          int     `json:"height"`
	FPS             float64 `json:"fps,omitempty"`
	DurationSeconds float64 `json:"duration_seconds,omitempty"`
}
type Recipe struct {
	ID             string       `json:"id"`
	Version        string       `json:"recipe_version"`
	Name           string       `json:"name,omitempty"`
	Mode           string       `json:"mode"`
	Ready          bool         `json:"ready"`
	ReferenceSlots int          `json:"reference_slots"`
	Constraints    []Constraint `json:"reference_constraints"`
	Output         Output       `json:"output"`
}

func (r Recipe) NativeMode() string {
	switch r.Mode {
	case "t2i", "i2i":
		return "image"
	case "t2v", "i2v":
		return "video"
	}
	return ""
}
func (r Recipe) NativeReady() bool {
	if !r.Ready || !versionPattern.MatchString(r.Version) || r.Output.Width <= 0 || r.Output.Height <= 0 || r.Output.Width > 8192 || r.Output.Height > 8192 || int64(r.Output.Width)*int64(r.Output.Height) > 33554432 || r.ReferenceSlots < 0 || r.ReferenceSlots > 8 {
		return false
	}
	return r.NativeMode() == "image" || (r.NativeMode() == "video" && r.Output.MimeType == "video/mp4" && r.Output.FPS > 0 && r.Output.FPS <= 120 && r.Output.DurationSeconds > 0 && r.Output.DurationSeconds <= 600)
}

// CheckOutput compares probed media with the approved recipe. Video containers
// may round the final frame duration; allow at most one frame or 100ms.
func (o Output) CheckMedia(mode string, width, height int, durationMs int64) error {
	if width != o.Width || height != o.Height || width <= 0 || height <= 0 {
		return fail(502, "output_spec_mismatch", "生成结果尺寸与批准的配方规范不一致")
	}
	if mode == "video" && (o.FPS <= 0 || durationMs <= 0 || math.Abs(float64(durationMs)-o.DurationSeconds*1000) > math.Max(100, 1000/o.FPS)) {
		return fail(502, "output_spec_mismatch", "生成结果时长与批准的配方规范不一致")
	}
	return nil
}

type Project struct {
	ID       string `json:"id"`
	Upstream string `json:"upstream_project_id"`
	CanvasID string `json:"canvas_project_id"`
}
type Shot struct {
	ID         string   `json:"id"`
	ProjectID  string   `json:"project_id"`
	Upstream   string   `json:"upstream_shot_id"`
	References []string `json:"reference_asset_ids"`
}
type Job struct {
	ID        string   `json:"id"`
	ProjectID string   `json:"project_id"`
	ShotID    string   `json:"shot_id"`
	RecipeID  string   `json:"recipe_id"`
	Version   string   `json:"recipe_version"`
	PromptID  string   `json:"prompt_id"`
	Status    string   `json:"status"`
	Key       string   `json:"request_key"`
	Assets    []string `json:"archived_asset_ids"`
}
type Asset struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	JobID     string `json:"job_id"`
	Upstream  string `json:"upstream_asset_id"`
	MimeType  string `json:"mime_type"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}
type Resource struct {
	ID, MimeType  string
	Size          int64
	Width, Height int
}
type Media struct {
	ResourceID string `json:"resourceId"`
	StorageKey string `json:"storageKey"`
	URL        string `json:"url"`
	MimeType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	DurationMs int64  `json:"durationMs"`
}
type Resources interface {
	Describe(owner, id string) (Resource, error)
	Read(owner, id string, limit int64) ([]byte, error)
	Import(ctx context.Context, owner, identity, mode string, asset Asset, output Output, load func() ([]byte, error)) (Media, error)
}
type Ledger interface {
	Save(ctx context.Context, jobID, status string) error
}
type Request struct {
	OwnerID, ProjectID, TaskID, Mode, Prompt string
	Selection                                Selection
	References                               []Resource
	JobID                                    string
	ResumeOnly                               bool
}

func ProjectIdentity(owner, project string) string {
	sum := sha256.Sum256([]byte("native-local-comfy\x00" + owner + "\x00" + project))
	return "native:" + hex.EncodeToString(sum[:16])
}
func RequestKey(taskID string, selection Selection) string {
	if selection.RetryKey != "" {
		return selection.RetryKey
	}
	return "native:" + taskID
}

type Error struct {
	Status          int
	Reason, Message string
}

func (e *Error) Error() string                      { return e.Message }
func fail(status int, reason, message string) error { return &Error{status, reason, message} }

type UnknownError struct{ Cause error }

func (e UnknownError) Error() string {
	return "本地作业提交结果未知，请查询原作业；未重新提交"
}
func (e UnknownError) Unwrap() error { return e.Cause }

type PendingError struct{ JobID string }

func (e PendingError) Error() string { return "本地作业仍在运行或结果尚待取回" }
