package handler

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/service"
)

func registerCanvasPromptRoutes(r *gin.RouterGroup, svc *service.Service) {
	base := "/canvas-projects/:id/prompt-drafts"
	r.GET(base, func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, err := svc.GetCanvasPrompt(user.ID, c.Param("id"), service.CanvasPromptTargetRequest{ProjectID: c.Query("projectId"), NodeID: c.Query("nodeId"), RowID: c.Query("rowId"), Kind: c.Query("kind")})
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.POST(base, func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "canvas-write:"+user.ID, policy.Request.CanvasWritePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
		var req service.SaveCanvasPromptRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := svc.SaveCanvasPrompt(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.GET(base+"/history", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, err := svc.GetCanvasPromptHistory(user.ID, c.Param("id"), c.Query("nodeId"), c.Query("rowId"), c.Query("kind"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.GET(base+"/history/:revision", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		revision, err := strconv.ParseInt(c.Param("revision"), 10, 64)
		if err != nil || revision < 0 {
			fail(c, http.StatusBadRequest, service.BadAuthRequest("提示词修订号无效"))
			return
		}
		result, err := svc.GetCanvasPromptRevision(user.ID, c.Param("id"), c.Query("nodeId"), c.Query("rowId"), c.Query("kind"), revision)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.GET(base+"/requests/:requestId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, err := svc.GetCanvasPromptReceipt(user.ID, c.Param("id"), c.Param("requestId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
}
