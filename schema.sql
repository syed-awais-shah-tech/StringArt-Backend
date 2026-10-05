-- ==============================================================================
-- StringArt Orders Schema & Storage Configuration
-- Database: PostgreSQL (Supabase)
-- ==============================================================================

-- 1. Create orders table
CREATE TABLE IF NOT EXISTS public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    product_name TEXT NOT NULL DEFAULT 'Custom Handcrafted String Art (50 cm)',
    price NUMERIC(10, 2) NOT NULL DEFAULT 175.00,
    payment_method TEXT NOT NULL DEFAULT 'COD',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    order_status TEXT NOT NULL DEFAULT 'new',
    original_file_path TEXT,
    preview_file_path TEXT,
    sequence_file_path TEXT,
    thread_mode TEXT NOT NULL DEFAULT 'black_only' CHECK (thread_mode IN ('black_only', 'eight_color')),
    idempotency_key TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2. Indexes for search, status filtering, and sorting
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON public.orders (order_number);
CREATE INDEX IF NOT EXISTS idx_orders_order_status ON public.orders (order_status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON public.orders (payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders (created_at DESC);

-- 3. Automatic updated_at timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_orders_updated_at ON public.orders;
CREATE TRIGGER trigger_orders_updated_at
    BEFORE UPDATE ON public.orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 4. Storage Bucket Configuration (Private Bucket)
-- Bucket Name: stringart-orders
-- Path format: orders/SA-1001/original.jpg, orders/SA-1001/preview.png, orders/SA-1001/sequence.txt
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'stringart-orders',
    'stringart-orders',
    false,
    52428800, -- 50 MB
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'text/plain']
)
ON CONFLICT (id) DO NOTHING;

-- 5. Admins table for secure database-backed authentication
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

CREATE INDEX IF NOT EXISTS idx_admins_email ON public.admins (email);

DROP TRIGGER IF EXISTS trigger_admins_updated_at ON public.admins;
CREATE TRIGGER trigger_admins_updated_at
    BEFORE UPDATE ON public.admins
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 6. Store Settings table (admin-controlled generation settings)
CREATE TABLE IF NOT EXISTS public.store_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    eight_color_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Seed default single settings row
INSERT INTO public.store_settings (id, eight_color_enabled)
VALUES ('00000000-0000-0000-0000-000000000001', false)
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trigger_store_settings_updated_at ON public.store_settings;
CREATE TRIGGER trigger_store_settings_updated_at
    BEFORE UPDATE ON public.store_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

GRANT ALL ON TABLE public.store_settings TO postgres, service_role, anon, authenticated;
ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service_role full access to store_settings"
ON public.store_settings
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow public read access to store_settings"
ON public.store_settings
FOR SELECT
TO anon, authenticated
USING (true);

-- 7. Add thread_mode to orders table
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS thread_mode TEXT NOT NULL DEFAULT 'black_only'
CHECK (thread_mode IN ('black_only', 'eight_color'));

CREATE INDEX IF NOT EXISTS idx_orders_thread_mode ON public.orders (thread_mode);
