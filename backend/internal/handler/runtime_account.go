package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/service"
)

func registerRuntimeAccountRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.POST("/auth/runtime-account/proof", func(c *gin.Context) {
		var challenge service.RuntimeAccountChallenge
		if !readRuntimeAccountJSON(c, &challenge) {
			return
		}
		if c.GetHeader("Origin") != challenge.Origin {
			failService(c, service.Forbidden("本机账号证明来源不符"))
			return
		}
		proof, err := svc.IssueRuntimeAccountProof(sessionCookie(c), challenge)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, proof)
	})
	r.POST("/auth/runtime-account/verify", func(c *gin.Context) {
		var req struct {
			Proof string `json:"proof"`
		}
		if !readRuntimeAccountJSON(c, &req) {
			return
		}
		identity, err := svc.VerifyRuntimeAccountProof(req.Proof)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, identity)
	})
}

func readRuntimeAccountJSON(c *gin.Context, target any) bool {
	c.Header("Cache-Control", "no-store")
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8<<10)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		failService(c, service.BadAuthRequest("本机账号证明参数无效"))
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		failService(c, service.BadAuthRequest("本机账号证明参数无效"))
		return false
	}
	return true
}
