import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data, error } = await supabase.rpc("exec_sql", { sql: "SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE event_object_table = 'tasks';" });
  console.log("Triggers:", data, error);
}
run();
