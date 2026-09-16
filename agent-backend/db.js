import pg from 'pg'

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgresql://assistant:assistant@postgres:5432/assistant',
})
