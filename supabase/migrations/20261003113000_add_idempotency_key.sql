-- Add idempotency_key to orders table to prevent duplicate submissions
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_orders_idempotency_key
ON public.orders (idempotency_key);
