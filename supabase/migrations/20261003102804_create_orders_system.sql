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
    10485760,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'text/plain']
)
ON CONFLICT (id) DO NOTHING;
