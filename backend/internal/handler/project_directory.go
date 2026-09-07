package handler

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/service"
)

func projectDirectoryLocalRequest(c *gin.Context, svc *service.Service) bool {
	if !svc.DesktopLocalAuthEnabled() {
		return false
	}
	ip, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil || ip != "127.0.0.1" {
		return false
	}
	host := c.Request.Host
	if parsed, _, e := net.SplitHostPort(host); e == nil {
		host = parsed
	}
	if host != "127.0.0.1" && host != "localhost" {
		return false
	}
	origin := c.GetHeader("Origin")
	u, e := url.Parse(origin)
	if e != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	allowed := origin == "http://"+c.Request.Host
	for _, entry := range strings.Split(os.Getenv("CANVAS_CORS_ORIGINS"), ",") {
		allowed = allowed || origin == strings.TrimSpace(entry)
	}
	return allowed && c.GetHeader("X-FilmOS-Project-Directory") == "1" && strings.HasPrefix(c.GetHeader("Content-Type"), "application/json")
}

func registerProjectDirectoryRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/project-locations", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		location, err := svc.ProjectDirectoryLocation(c.Request.Context(), user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, location)
	})
	write := func(action func(*gin.Context, string) (any, error)) gin.HandlerFunc {
		return func(c *gin.Context) {
			if !projectDirectoryLocalRequest(c, svc) {
				failService(c, service.NewAppError(403, "作品目录操作只允许可信本机工作台发起"))
				return
			}
			user, err := currentUser(c, svc)
			if err != nil {
				failService(c, err)
				return
			}
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
			value, err := action(c, user.ID)
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, value)
		}
	}
	r.POST("/project-locations/choose", write(func(c *gin.Context, userID string) (any, error) {
		return svc.ChooseProjectDirectory(c.Request.Context(), userID)
	}))
	r.POST("/projects/:id/directory/relocate", write(func(c *gin.Context, userID string) (any, error) {
		return svc.RelocateProjectDirectory(c.Request.Context(), userID, c.Param("id"))
	}))
	r.PUT("/project-locations/default", write(func(c *gin.Context, userID string) (any, error) {
		var req struct {
			LocationToken string `json:"locationToken"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			return nil, service.BadAuthRequest("目录选择信息无效")
		}
		return svc.SetDefaultProjectDirectory(c.Request.Context(), userID, req.LocationToken)
	}))
	r.GET("/projects/:id/directory", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		status, err := svc.ProjectDirectoryStatus(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, status)
	})
	r.POST("/projects/:id/directory/open", write(func(c *gin.Context, userID string) (any, error) {
		err := svc.OpenProjectDirectory(c.Request.Context(), userID, c.Param("id"))
		return gin.H{"opened": err == nil}, err
	}))
	r.POST("/projects/:id/directory/export", write(func(c *gin.Context, userID string) (any, error) {
		return svc.ExportProjectDirectory(userID, c.Param("id"))
	}))
	r.POST("/projects/:id/directory/sync", write(func(c *gin.Context, userID string) (any, error) {
		if err := svc.SyncProjectDirectory(userID, c.Param("id")); err != nil {
			return nil, err
		}
		return svc.ProjectDirectoryStatus(userID, c.Param("id"))
	}))
}
