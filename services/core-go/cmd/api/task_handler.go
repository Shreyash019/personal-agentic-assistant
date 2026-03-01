package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"core-go/internal/db"
)

// validStatuses is the allowed set for PATCH /api/v1/tasks/{id}.
var validStatuses = map[string]bool{
	"pending":     true,
	"in_progress": true,
	"done":        true,
}

// ── List tasks ────────────────────────────────────────────────────────────────

// listTasksHandler handles GET /api/v1/tasks?user_id=<uuid>
// Returns all tasks for the given user ordered newest-first.
func listTasksHandler(repo db.TaskRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
		if userID == "" {
			http.Error(w, `"user_id" query parameter is required`, http.StatusBadRequest)
			return
		}

		tasks, err := repo.ListTasks(r.Context(), userID)
		if err != nil {
			http.Error(w, "failed to list tasks: "+err.Error(), http.StatusInternalServerError)
			return
		}

		// Return an empty array rather than null when the user has no tasks.
		if tasks == nil {
			tasks = []db.Task{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(tasks)
	}
}

// ── Update task status ────────────────────────────────────────────────────────

// updateTaskStatusRequest is the body for PATCH /api/v1/tasks/{id}.
type updateTaskStatusRequest struct {
	Status string `json:"status"`
	UserID string `json:"user_id"`
}

// updateTaskHandler handles PATCH /api/v1/tasks/{id}
// Updates the status of a task owned by the requesting user.
func updateTaskHandler(repo db.TaskRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := parseTaskID(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		var req updateTaskStatusRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		req.Status = strings.TrimSpace(req.Status)
		if !validStatuses[req.Status] {
			http.Error(w, `"status" must be one of: pending, in_progress, done`, http.StatusBadRequest)
			return
		}

		userID := strings.TrimSpace(req.UserID)
		if userID == "" {
			http.Error(w, `"user_id" is required`, http.StatusBadRequest)
			return
		}

		if err := repo.UpdateTaskStatus(r.Context(), id, userID, req.Status); err != nil {
			http.Error(w, "failed to update task: "+err.Error(), http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": id, "status": req.Status})
	}
}

// ── Delete task ───────────────────────────────────────────────────────────────

// deleteTaskHandler handles DELETE /api/v1/tasks/{id}?user_id=<uuid>
func deleteTaskHandler(repo db.TaskRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := parseTaskID(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
		if userID == "" {
			http.Error(w, `"user_id" query parameter is required`, http.StatusBadRequest)
			return
		}

		if err := repo.DeleteTask(r.Context(), id, userID); err != nil {
			http.Error(w, "failed to delete task: "+err.Error(), http.StatusNotFound)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func parseTaskID(r *http.Request) (db.TaskID, error) {
	raw := r.PathValue("id")
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid task id %q", raw)
	}
	return db.TaskID(n), nil
}
