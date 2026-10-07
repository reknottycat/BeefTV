package handler

import (
	"time"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

// Only deployment capability metadata is public. Jobs and internal mappings
// stay behind native task ownership and approval; this is not an HTTP proxy.
func RegisterLocalComfyRoutes(r *gin.RouterGroup, svc *app.Service) {
	for _, path := range []string{"config", "recipes"} {
		r.GET("/local-comfy/v1/"+path, func(c *gin.Context) {
			user, err := currentUser(c, svc)
			if err != nil {
				failService(c, err)
				return
			}
			if !enforceRateLimit(c, "local-comfy-catalog:"+user.ID, 60, time.Minute) {
				return
			}
			var data any
			if path == "config" {
				data, err = svc.LocalComfyConfig(c.Request.Context())
			} else {
				data, err = svc.LocalComfyRecipes(c.Request.Context())
			}
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, data)
		})
	}
}
