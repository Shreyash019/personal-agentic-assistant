package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TaskID is the primary key type for the tasks table.
type TaskID int64

// TaskRepository defines write operations on the tasks table.
type TaskRepository interface {
	CreateTask(ctx context.Context, title, description string, priority int) (TaskID, error)
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
func (r *pgxTaskRepository) CreateTask(ctx context.Context, title, description string, priority int) (TaskID, error) {
	const query = `
		INSERT INTO tasks (title, description, priority)
		VALUES ($1, $2, $3)
		RETURNING id`

	var id TaskID
	if err := r.pool.QueryRow(ctx, query, title, description, priority).Scan(&id); err != nil {
		return 0, fmt.Errorf("task_repository: create: %w", err)
	}
	return id, nil
}
