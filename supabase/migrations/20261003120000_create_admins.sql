-- Migration: Create admins table for secure database-backed authentication
CREATE TABLE IF NOT EXISTS public.admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'Administrator',
    reset_token_hash TEXT,
    reset_token_expires TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Index for fast lookup on login
CREATE INDEX IF NOT EXISTS idx_admins_email ON public.admins (email);
