# Supabase setup for Invoice Maker

1. Create a Supabase project.
2. Open SQL Editor and run `supabase/schema.sql`.
3. In Authentication > Users, create these confirmed users:
   - `amer@invoice.local` / `12345678`
   - `amro@invoice.local` / `12345678`
4. Copy `data/supabase_config.example.json` to `data/supabase_config.json`.
5. Fill in your project URL and anon or publishable key:

```json
{
  "url": "https://YOUR-PROJECT-REF.supabase.co",
  "anon_key": "YOUR-SUPABASE-ANON-OR-PUBLISHABLE-KEY"
}
```

The app lets the user type `amer` or `amro`; it maps those names to
`amer@invoice.local` and `amro@invoice.local` for Supabase Auth.

Do not put a Supabase service-role key in `supabase_config.json`. That file is
served through the local Flask app and is intentionally only for the public
browser key.
