package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/repository"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestLocalComfyMetadataRoutesAreReadOnlyAndKeepOfflineDistinct(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	svc := app.NewLocal(repository.New(db), t.TempDir())
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(defaultRuntimeDependencies(svc)))
	RegisterLocalComfyRoutes(router.Group("/api"), svc)
	read := func(path string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/local-comfy/v1/"+path, nil))
		return response
	}
	response := read("config")
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"configured":false`) {
		t.Fatalf("unconfigured: %d %s", response.Code, response.Body.String())
	}
	for _, path := range []string{"projects", "shots", "assets", "jobs", "config/../jobs"} {
		if result := read(path); result.Code != 404 {
			t.Fatalf("internal path %s exposed: %d", path, result.Code)
		}
	}
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer test-service-only-token" {
			t.Errorf("invalid metadata request")
		}
		if r.URL.Path == "/config" {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"generation_enabled": false, "recipe_count": 0, "max_reference_bytes": 10485760, "private_url": "must-not-leak"}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": []any{}})
	}))
	if err := svc.ConfigureLocalComfy(upstream.URL, "test-service-only-token"); err != nil {
		t.Fatal(err)
	}
	response = read("config")
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"configured":true`) || strings.Contains(response.Body.String(), "must-not-leak") {
		t.Fatalf("configured disabled: %d %s", response.Code, response.Body.String())
	}
	if response = read("recipes"); response.Code != 200 || !strings.Contains(response.Body.String(), `"data":[]`) {
		t.Fatalf("empty recipes: %d %s", response.Code, response.Body.String())
	}
	upstream.Close()
	response = read("config")
	if response.Code != 503 || !strings.Contains(response.Body.String(), `"reason":"adapter_unavailable"`) || strings.Contains(response.Body.String(), upstream.URL) {
		t.Fatalf("offline must not become disabled: %d %s", response.Code, response.Body.String())
	}
}
