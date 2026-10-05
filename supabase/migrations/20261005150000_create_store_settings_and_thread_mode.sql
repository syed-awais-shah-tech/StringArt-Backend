-- ==============================================================================
-- Migration: Add store_settings table and thread_mode to orders
-- Database: PostgreSQL (Supabase)
-- ==============================================================================

-- 1. Create store_settings table
CREATE TABLE IF NOT EXISTS public.store_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    eight_color_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Ensure there is a single default settings row
INSERT INTO public.store_settings (id, eight_color_enabled)
VALUES ('00000000-0000-0000-0000-000000000001', false)
ON CONFLICT (id) DO NOTHING;

-- Trigger for store_settings automatic updated_at timestamp
DROP TRIGGER IF EXISTS trigger_store_settings_updated_at ON public.store_settings;
CREATE TRIGGER trigger_store_settings_updated_at
    BEFORE UPDATE ON public.store_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Grant table permissions to service_role, anon, authenticated roles
GRANT ALL ON TABLE public.store_settings TO postgres, service_role, anon, authenticated;

-- Ensure RLS is enabled
ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;

-- Allow service_role full bypass/access
CREATE POLICY "Allow service_role full access to store_settings"
ON public.store_settings
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Allow public read access to store_settings
CREATE POLICY "Allow public read access to store_settings"
ON public.store_settings
FOR SELECT
TO anon, authenticated
USING (true);

-- 2. Add thread_mode to orders table
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS thread_mode TEXT NOT NULL DEFAULT 'black_only'
CHECK (thread_mode IN ('black_only', 'eight_color'));

CREATE INDEX IF NOT EXISTS idx_orders_thread_mode
ON public.orders (thread_mode);
