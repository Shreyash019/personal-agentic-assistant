package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"regexp"
	"strings"
)

var userIDRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

func normalizeUserID(raw string, fallback string) string {
	userID := strings.TrimSpace(raw)
	if userID == "" {
		return fallback
	}
	return userID
}

func isValidUserID(userID string) bool {
	if userID == "admin" || userID == "default" {
		return true
	}
	return userIDRegex.MatchString(userID)
}

func decodeJSONStrict(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	// Ensure there is only one JSON object in body.
	if dec.More() {
		return errors.New("unexpected extra JSON data")
	}
	return nil
}

func adminAuthEnabled() bool {
	return strings.TrimSpace(os.Getenv("ADMIN_API_KEY")) != ""
}

func adminAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := strings.TrimSpace(os.Getenv("ADMIN_API_KEY"))
		if expected == "" {
			next.ServeHTTP(w, r)
			return
		}

		provided := strings.TrimSpace(r.Header.Get("X-Admin-Token"))
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	})
}
