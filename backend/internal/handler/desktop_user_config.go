package handler

import (
	"net/http"

	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
)

func RegisterDesktopUserConfigRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/desktop/user-config", func(c *gin.Context) {
		if !requestIsExplicitLoopback(c.Request) {
			fail(c, http.StatusForbidden, service.Forbidden("本地用户配置只允许从桌面回环接口读取"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		document, err := svc.ReadDesktopUserConfig(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		c.Header("Cache-Control", "no-store")
		ok(c, document)
	})
	r.PUT("/desktop/user-config", func(c *gin.Context) {
		if !requestIsExplicitLoopback(c.Request) {
			fail(c, http.StatusForbidden, service.Forbidden("本地用户配置只允许从桌面回环接口保存"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var input service.DesktopUserConfigWrite
		if err := c.ShouldBindJSON(&input); err != nil {
			fail(c, http.StatusBadRequest, service.NewAppError(http.StatusBadRequest, "本地用户配置请求无效"))
			return
		}
		document, err := svc.WriteDesktopUserConfig(user.ID, input)
		if err != nil {
			failService(c, err)
			return
		}
		c.Header("Cache-Control", "no-store")
		ok(c, document)
	})
}
