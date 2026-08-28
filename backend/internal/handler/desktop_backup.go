package handler

import (
	"net"
	"net/http"
	"os"
	"strings"

	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
)

func RegisterDesktopBackupRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/desktop/backup", func(c *gin.Context) {
		if !requestIsExplicitLoopback(c.Request) {
			fail(c, http.StatusForbidden, service.Forbidden("本地备份只允许从桌面回环接口导出"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		artifact, err := svc.CreateDesktopBackup(user.ID, strings.TrimSpace(c.Query("app_version")))
		if err != nil {
			failService(c, err)
			return
		}
		defer os.Remove(artifact.Path)
		c.Header("Cache-Control", "no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-FilmOS-Backup-Format", service.DesktopBackupFormat)
		c.Header("X-FilmOS-Backup-SHA256", artifact.SHA256)
		c.FileAttachment(artifact.Path, artifact.Filename)
	})
}

func requestIsExplicitLoopback(request *http.Request) bool {
	if request == nil {
		return false
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(request.RemoteAddr))
	return err == nil && host == "127.0.0.1"
}
