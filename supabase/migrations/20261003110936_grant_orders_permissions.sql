-- Grant table permissions to service_role, anon, authenticated roles
GRANT ALL ON TABLE public.orders TO postgres, service_role, anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role, anon, authenticated;

-- Ensure RLS is enabled
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Allow service_role full bypass/access
CREATE POLICY "Allow service_role full access to orders"
ON public.orders
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Allow anon and authenticated full access for order placement
CREATE POLICY "Allow anon insert and select on orders"
ON public.orders
FOR ALL
TO anon, authenticated
USING (true)
WITH CHECK (true);
