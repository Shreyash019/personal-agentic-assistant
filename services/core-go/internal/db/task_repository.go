package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TaskID is the primary key type for the tasks table.
type TaskID int64

// Task is a full row from the tasks table, returned by ListTasks.
type Task struct {
	ID          TaskID    `json:"id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Priority    string    `json:"priority"`
	Status      string    `json:"status"`
	UserID      string    `json:"user_id"`
	CreatedAt   time.Time `json:"created_at"`
}

// TaskRepository defines all operations on the tasks table.
// priority is a VARCHAR string ("low", "medium", "high") matching init.sql.
// status is a VARCHAR string ("pending", "in_progress", "done").
type TaskRepository interface {
	// CreateTask inserts a new task row for userID and returns its generated ID.
	CreateTask(ctx context.Context, title, description, priority, userID string) (TaskID, error)

	// ListTasks returns all tasks owned by userID, ordered newest-first.
	ListTasks(ctx context.Context, userID string) ([]Task, error)

	// UpdateTaskStatus changes the status of task id, scoped to userID.
	// Returns an error if the task does not exist or userID does not match.
	UpdateTaskStatus(ctx context.Context, id TaskID, userID, status string) error

	// DeleteTask removes task id owned by userID.
	// Returns an error if the task does not exist or userID does not match.
	DeleteTask(ctx context.Context, id TaskID, userID string) error
}

type pgxTaskRepository struct {
	pool *pgxpool.Pool
}

// NewTaskRepository returns a TaskRepository backed by a pgxpool connection pool.
func NewTaskRepository(pool *pgxpool.Pool) TaskRepository {
	return &pgxTaskRepository{pool: pool}
}

// CreateTask inserts a new task row and returns its generated ID.
// Uses a parameterized query with RETURNING to avoid a separate SELECT round-trip.
func (r *pgxTaskRepository) CreateTask(ctx context.Context, title, description, priority, userID string) (TaskID, error) {
	const query = `
		INSERT INTO tasks (title, description, priority, user_id)
		VALUES ($1, $2, $3, $4)
		RETURNING id`

	var id TaskID
	if err := r.pool.QueryRow(ctx, query, title, description, priority, userID).Scan(&id); err != nil {
		return 0, fmt.Errorf("task_repository: create: %w", err)
	}
	return id, nil
}

// ListTasks returns all tasks for userID ordered by created_at descending
// so the most recently created tasks appear first.
func (r *pgxTaskRepository) ListTasks(ctx context.Context, userID string) ([]Task, error) {
	const query = `
		SELECT id, title, description, priority, status, user_id, created_at
		FROM tasks
		WHERE user_id = $1
		ORDER BY created_at DESC`

	rows, err := r.pool.Query(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("task_repository: list: %w", err)
	}
	defer rows.Close()

	var tasks []Task
	for rows.Next() {
		var t Task
		if err := rows.Scan(&t.ID, &t.Title, &t.Description, &t.Priority, &t.Status, &t.UserID, &t.CreatedAt); err != nil {
			return nil, fmt.Errorf("task_repository: list scan: %w", err)
		}
		tasks = append(tasks, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("task_repository: list rows: %w", err)
	}
	return tasks, nil
}

// UpdateTaskStatus updates the status column for the task identified by id,
// scoped to userID so users can only modify their own tasks.
// Returns an error if no row was affected (wrong id or userID mismatch).
func (r *pgxTaskRepository) UpdateTaskStatus(ctx context.Context, id TaskID, userID, status string) error {
	const query = `
		UPDATE tasks
		SET    status = $1
		WHERE  id = $2 AND user_id = $3`

	tag, err := r.pool.Exec(ctx, query, status, id, userID)
	if err != nil {
		return fmt.Errorf("task_repository: update_status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("task_repository: update_status: task %d not found for user", id)
	}
	return nil
}

// DeleteTask removes the task identified by id, scoped to userID so users
// can only delete their own tasks.
// Returns an error if no row was affected (wrong id or userID mismatch).
func (r *pgxTaskRepository) DeleteTask(ctx context.Context, id TaskID, userID string) error {
	const query = `DELETE FROM tasks WHERE id = $1 AND user_id = $2`

	tag, err := r.pool.Exec(ctx, query, id, userID)
	if err != nil {
		return fmt.Errorf("task_repository: delete: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("task_repository: delete: task %d not found for user", id)
	}
	return nil
}
