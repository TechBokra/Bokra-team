import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();
const dbUrl = process.env.DATABASE_URL;
const client = new Client({ connectionString: dbUrl });
async function run() {
  await client.connect();
  console.log("Connected");
  await client.query(`
    DROP POLICY IF EXISTS "Allow ALL for authenticated users" ON public.task_groups;
    CREATE POLICY "Allow ALL for authenticated users" ON public.task_groups FOR ALL USING (auth.role() = 'authenticated');
    DROP POLICY IF EXISTS "Allow ALL for authenticated users" ON public.task_group_members;
    CREATE POLICY "Allow ALL for authenticated users" ON public.task_group_members FOR ALL USING (auth.role() = 'authenticated');
  `);
  console.log("Done");
  await client.end();
}
run();
