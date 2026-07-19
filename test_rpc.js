import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
supabase.rpc('exec_sql', { sql: 'SELECT 1' }).then(console.log).catch(console.error);
