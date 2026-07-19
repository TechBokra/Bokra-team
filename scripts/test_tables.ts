import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.log("Missing credentials.");
  process.exit(1);
}

const supabase = createClient(url, key);

async function checkTable(name: string) {
  try {
    const { data, error } = await supabase.from(name).select("*").limit(1);
    if (error) {
      console.log(`Table ${name} has error:`, error.message);
    } else {
      console.log(`Table ${name} is accessible! Data count:`, data?.length);
    }
  } catch (err: any) {
    console.log(`Table ${name} failed:`, err.message);
  }
}

async function run() {
  const tables = [
    "team_members",
    "projects",
    "tasks",
    "task_comments",
    "task_attachments",
    "invites",
    "notifications",
    "audit_logs",
    "work_contract_change_requests",
    "user_preferences",
    "tags",
    "stages",
    "teams",
    "leads",
    "sales",
    "order_lines",
    "invoices",
    "partners",
    "activities",
    "tickets",
    "products",
    "metadata"
  ];

  for (const table of tables) {
    await checkTable(table);
  }
}

run();
