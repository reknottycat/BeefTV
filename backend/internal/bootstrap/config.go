package bootstrap

import (
	"os"
	"time"

	"github.com/gin-gonic/gin"
)

type Profile string

const (
	ProfileServer  Profile = "server"
	ProfileDesktop Profile = "desktop"
)

type Config struct {
	Profile                Profile
	DataDir                string
	DatabaseDriver         string
	DatabaseURL            string
	ListenAddr             string
	LaunchToken            string
	AutoMigrate            bool
	ShutdownTimeout        time.Duration
	RouterMiddleware       []gin.HandlerFunc
	LocalComfyAdapterURL   string
	LocalComfyAdapterToken string
}

func (c Config) withDefaults() Config {
	if c.LocalComfyAdapterURL == "" {
		c.LocalComfyAdapterURL = os.Getenv("CANVAS_LOCAL_COMFY_ADAPTER_URL")
	}
	if c.LocalComfyAdapterToken == "" {
		c.LocalComfyAdapterToken = os.Getenv("CANVAS_LOCAL_COMFY_ADAPTER_TOKEN")
	}
	if c.Profile == "" {
		c.Profile = ProfileServer
	}
	if c.DatabaseDriver == "" {
		c.DatabaseDriver = "sqlite"
	}
	if c.ListenAddr == "" {
		if c.Profile == ProfileDesktop {
			c.ListenAddr = "127.0.0.1:0"
		} else {
			c.ListenAddr = ":8080"
		}
	}
	if c.ShutdownTimeout <= 0 {
		c.ShutdownTimeout = 10 * time.Minute
	}
	return c
}
