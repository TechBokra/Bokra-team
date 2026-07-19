sed -i '/\/\/ \-\-\- END OF EXISTING ROUTES \-\-\-/i \
  app.post("/api/task_groups", verifyToken, async (req, res) => {\
    try {\
      const { projectId, name, description } = req.body;\
      const supabaseUrl = process.env.VITE_SUPABASE_URL;\
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;\
      if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: "Missing config" });\
      const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);\
      const { data, error } = await supabaseAdmin.from("task_groups").insert([{ project_id: projectId, name, description }]).select().single();\
      if (error) throw error;\
      res.status(201).json(data);\
    } catch (err: any) {\
      res.status(500).json({ error: err.message });\
    }\
  });\
\
  app.put("/api/task_groups/:id", verifyToken, async (req, res) => {\
    try {\
      const { id } = req.params;\
      const { name, description } = req.body;\
      const supabaseUrl = process.env.VITE_SUPABASE_URL;\
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;\
      if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: "Missing config" });\
      const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);\
      const { data, error } = await supabaseAdmin.from("task_groups").update({ name, description }).eq("id", id).select().single();\
      if (error) throw error;\
      res.status(200).json(data);\
    } catch (err: any) {\
      res.status(500).json({ error: err.message });\
    }\
  });\
\
  app.delete("/api/task_groups/:id", verifyToken, async (req, res) => {\
    try {\
      const { id } = req.params;\
      const supabaseUrl = process.env.VITE_SUPABASE_URL;\
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;\
      if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: "Missing config" });\
      const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);\
      const { error } = await supabaseAdmin.from("task_groups").delete().eq("id", id);\
      if (error) throw error;\
      res.status(200).json({ success: true });\
    } catch (err: any) {\
      res.status(500).json({ error: err.message });\
    }\
  });\
' server.ts
