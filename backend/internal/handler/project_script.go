package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/service"
)

func registerProjectScriptRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/projects/:id/units/:unitId/script-revisions", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		rows, err := svc.GetProjectScriptRevisions(user.ID, c.Param("id"), c.Param("unitId"))
		if err != nil {
			failProjectScript(c, err)
			return
		}
		ok(c, gin.H{"revisions": rows})
	})
	r.GET("/projects/:id/units/:unitId/script-revisions/:revision", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		version, err := strconv.ParseInt(c.Param("revision"), 10, 64)
		if err != nil || version < 1 {
			failService(c, service.BadAuthRequest("无效的剧本修订号"))
			return
		}
		row, err := svc.GetProjectScriptRevision(user.ID, c.Param("id"), c.Param("unitId"), version)
		if err != nil {
			failProjectScript(c, err)
			return
		}
		ok(c, gin.H{"revision": row})
	})
	r.POST("/projects/:id/units/:unitId/script-revisions", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 3<<20)
		var req service.UpdateProjectUnitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			failService(c, service.BadAuthRequest("剧本修订参数无效或超限"))
			return
		}
		result, err := svc.ReviseProjectScript(user.ID, c.Param("id"), c.Param("unitId"), req)
		if err != nil {
			failProjectScript(c, err)
			return
		}
		ok(c, result)
	})
}

func failProjectScript(c *gin.Context, err error) {
	if service.IsProjectNotFound(err) {
		fail(c, http.StatusNotFound, service.BadAuthRequest("项目、章节或修订不存在"))
		return
	}
	failService(c, err)
}
