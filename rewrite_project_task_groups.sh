sed -i 's/await api.update(supabaseClient, "task_groups", editingId, data);/const res = await fetch(\`\/api\/task_groups\/${editingId}\`, { method: "PUT", headers: { "Content-Type": "application\/json" }, body: JSON.stringify(data) }); if(!res.ok) throw new Error((await res.json()).error);/g' components/project/ProjectTaskGroups.tsx

sed -i 's/await api.insert(supabaseClient, "task_groups", { ...data, projectId: project.id });/const res = await fetch(\"\/api\/task_groups\", { method: "POST", headers: { "Content-Type": "application\/json" }, body: JSON.stringify({ ...data, projectId: project.id }) }); if(!res.ok) throw new Error((await res.json()).error);/g' components/project/ProjectTaskGroups.tsx

sed -i 's/await api.deleteById(supabaseClient, "task_groups", id);/const res = await fetch(\`\/api\/task_groups\/${id}\`, { method: "DELETE" }); if(!res.ok) throw new Error((await res.json()).error);/g' components/project/ProjectTaskGroups.tsx
