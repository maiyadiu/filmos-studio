package model

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
)

var ErrCanvasContentConflict = errors.New("canvas content changed since read")

// Hash the exact persisted JSON, not a client-side reserialization.
func CanvasContentHash(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
