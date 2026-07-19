import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  console.log("Fetching a task...");
  const { data: tasks, error: fetchErr } = await supabase.from("tasks").select("*").limit(1);
  if (!tasks || tasks.length === 0) return console.log("No tasks");
  const task = tasks[0];
  console.log("Updating task:", task.id);
  const { data, error } = await supabase.from("tasks").update({ title: task.title + " (updated)" }).eq("id", task.id).select().single();
  console.log("Update result:", error ? error : data.title);
}
run();
