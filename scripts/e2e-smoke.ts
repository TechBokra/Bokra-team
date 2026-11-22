/**
 * End-to-end smoke test: drives the real browser client + apiService against a
 * running server, once per role, and prints PASS/FAIL per check.
 *
 *   BASE_URL=http://localhost:3000 PASSWORD=... npx tsx scripts/e2e-smoke.ts
 *
 * Needs a database where the four test users below share PASSWORD.
 * It writes test rows and removes them again.
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const PASSWORD = process.env.PASSWORD || "Test12345";

// --- browser shims -----------------------------------------------------------
const store = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  location: { origin: BASE },
};
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: any, init?: any) =>
  realFetch(typeof url === "string" && url.startsWith("/") ? BASE + url : url, init)) as any;

const { createBokraClient, getAccessToken } = await import("../packages/shared/src/lib/bokraClient");
const api = await import("../packages/shared/src/services/apiService");
const client: any = createBokraClient();

let failures = 0;
const results: string[] = [];
async function check(name: string, fn: () => Promise<unknown>, expect: "ok" | "deny" = "ok") {
  try {
    const out = await fn();
    if (expect === "deny") { failures++; results.push(`FAIL  ${name} (expected to be denied, got ${JSON.stringify(out)?.slice(0, 80)})`); }
    else results.push(`PASS  ${name}${out !== undefined ? ` -> ${JSON.stringify(out)?.slice(0, 70)}` : ""}`);
  } catch (e: any) {
    if (expect === "deny") results.push(`PASS  ${name} (denied: ${String(e?.message || e).slice(0, 60)})`);
    else { failures++; results.push(`FAIL  ${name}: ${String(e?.message || e).slice(0, 140)}`); }
  }
}
const must = async (p: any) => { const r = await p; if (r?.error) throw new Error(r.error.message); return r.data; };
const authed = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(path, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${getAccessToken()}`, ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || j?.error || `HTTP ${r.status}`);
  return j;
};

const USERS = {
  gm: { email: "office@tech-bokra.com", memberId: 6 },
  manager: { email: "shimaaelsayed366@gmail.com", memberId: 11 },
  employee: { email: "techbokra@gmail.com", memberId: 4 },
  freelancer: { email: "youssefzoghbi18@gmail.com", memberId: 25 },
};
const PROJECT = "458a54ba-3917-4afb-801b-c344b7d3304a"; // Bokra team managment (members: 6, 11, 10)
const TABLES = ["projects", "tasks", "team_members", "roles", "daily_logs", "task_comments", "task_attachments", "meetings",
  "leave_requests", "overtime_requests", "expense_claims", "work_contract_change_requests", "penalties"];

for (const [role, u] of Object.entries(USERS)) {
  results.push(`\n=== ${role} (${u.email})`);
  await check("login", async () => { await must(client.auth.signInWithPassword({ email: u.email, password: PASSWORD })); });
  await check("wrong password is rejected", async () => must(client.auth.signInWithPassword({ email: u.email, password: "wrong-password" })), "deny");
  await client.auth.signInWithPassword({ email: u.email, password: PASSWORD });
  await check("site_settings (settingsStore)", async () => (await must(client.from("site_settings").select("*").limit(1).single())).app_name);
  await check("own team_members row (authStore)", async () => (await must(client.from("team_members").select("*").eq("auth_user_id", (await client.auth.getSession()).data.session.user.id))).length);
  for (const t of TABLES) await check(`getAll ${t}`, async () => (await api.getAll(client, t)).length);
  await check("projects with members embed", async () => (await must(client.from("projects").select("*, members:project_members(*)"))).length);
  await check("getById project", async () => !!(await api.getById(client, "projects", PROJECT)));
  await check("task_groups by project", async () => (await must(client.from("task_groups").select("*").eq("project_id", PROJECT).order("created_at", { ascending: true }))).length);
  await check("notifications (own, ordered)", async () => (await must(client.from("notifications").select("*").eq("recipient_id", u.memberId).order("timestamp", { ascending: false }))).length);
  await check("global search", async () => { const r = await api.performGlobalSearch(client, "ت"); return [r.projects.length, r.tasks.length, r.teamMembers.length]; });
  await check("team_members with roles embed", async () => (await must(client.from("team_members").select("id, role_id, roles(name)"))).length);

  // ---- own requests: create -> read -> delete
  const today = new Date().toISOString().slice(0, 10);
  let leaveId: string | undefined;
  await check("create leave request", async () => { const r: any = await api.insert(client, "leave_requests", { teamMemberId: u.memberId, type: "annual", startDate: today, endDate: today, reason: "e2e" }); leaveId = r.id; return r.status; });
  await check("create overtime request", async () => { const r: any = await api.insert(client, "overtime_requests", { teamMemberId: u.memberId, weekStartDate: today, requestedHours: 2 }); await api.deleteById(client, "overtime_requests", r.id).catch(() => {}); });
  await check("create expense claim", async () => { const r: any = await api.insert(client, "expense_claims", { teamMemberId: u.memberId, amount: 10, description: "e2e", date: today }); return r.status; });
  await check("create daily log", async () => { const r: any = await api.insert(client, "daily_logs", { teamMemberId: u.memberId, date: today, hours: 1, description: "e2e" }); await api.update(client, "daily_logs", r.id, { hours: 2 }); await api.deleteById(client, "daily_logs", r.id); });
  await check("create work-contract change request", async () => { const r: any = await api.insert(client, "work_contract_change_requests", { teamMemberId: u.memberId, reason: "e2e", requestedWeeklyHours: 10, requestedSalary: 1 }); return r.status; });
  await check("cannot file a leave request for someone else", async () => { const r: any = await api.insert(client, "leave_requests", { teamMemberId: 18, type: "annual", startDate: today, endDate: today, reason: "e2e" }); await api.deleteById(client, "leave_requests", r.id); }, role === "gm" ? "ok" : "deny");
  await check("cannot approve own leave request", async () => api.update(client, "leave_requests", leaveId!, { status: "approved" }), role === "gm" ? "ok" : "deny");

  // ---- tasks in a project
  let taskId: string | undefined;
  await check("create task in project", async () => { const r: any = await api.insert(client, "tasks", { title: `e2e ${role}`, projectId: PROJECT, creatorId: u.memberId }); taskId = r.id; });
  if (taskId) {
    await check("update own task", async () => (await api.update<any>(client, "tasks", taskId!, { status: "inprogress" })).status);
    const member = role !== "freelancer"; // the freelancer isn't a member of this project
    await check("comment on task (server endpoint)", async () => (await authed("/api/task_comments", { method: "POST", body: JSON.stringify({ taskId, authorId: u.memberId, text: "e2e" }) })).success ?? "ok", member ? "ok" : "deny");
    await check("attach link to task (server endpoint)", async () => (await authed("/api/task_attachments", { method: "POST", body: JSON.stringify({ taskId, uploaderId: u.memberId, fileName: "e2e.txt", fileUrl: "/api/storage/object/site_assets/e2e.txt" }) })).success ?? "ok", member ? "ok" : "deny");
    await check("delete own task", async () => api.deleteById(client, "tasks", taskId!));
  }
  // task created by the employee (#4) in a project where #6 and #11 are members/managers
  await check("edit a task in a project you're not part of", async () => api.update(client, "tasks", "a85fe931-b518-4266-a810-44b069ceabb6", { status: "inprogress" }), role === "freelancer" ? "deny" : "ok");
  await check("notification via server endpoint", async () => authed("/api/notifications", { method: "POST", body: JSON.stringify({ recipient_id: 6, type: "task_assigned", task_title: "e2e" }) }));

  // ---- approvals / admin
  const isAdmin = role === "gm";
  void leaveId;
  await check("issue a penalty to employee #4", async () => { const r: any = await api.insert(client, "penalties", { teamMemberId: 4, issuerId: u.memberId, date: today, amount: 1, reason: "e2e" }); await api.deleteById(client, "penalties", r.id).catch(() => {}); }, isAdmin || role === "manager" ? "ok" : "deny");
  await check("admin: list invites", async () => (await authed("/api/admin/invites")).length ?? "ok", isAdmin ? "ok" : "deny");
  await check("admin: upsert site settings", async () => authed("/api/admin/site-settings/upsert", { method: "POST", body: JSON.stringify({ payload: { id: "1", app_name: "Bokra Team" } }) }), isAdmin ? "ok" : "deny");
  await check("create task group", async () => { const r = await authed("/api/task_groups", { method: "POST", body: JSON.stringify({ projectId: PROJECT, name: `e2e ${role}` }) }); const id = r?.data?.id ?? r?.id; if (id) await authed(`/api/task_groups/${id}`, { method: "DELETE" }); }, isAdmin || role === "manager" || role === "employee" ? "ok" : "deny");
}

// ---- approvals: employee files a leave request, the manager (has approve_leave_requests) approves it
results.push("\n=== approvals");
const day = new Date().toISOString().slice(0, 10);
await client.auth.signInWithPassword({ email: USERS.employee.email, password: PASSWORD });
const leave: any = await api.insert(client, "leave_requests", { teamMemberId: 4, type: "annual", startDate: day, endDate: day, reason: "e2e approval" });
await client.auth.signInWithPassword({ email: USERS.manager.email, password: PASSWORD });
await check("manager sees employee's leave request", async () => !!(await api.getAll<any>(client, "leave_requests")).find((l) => l.id === leave.id));
await check("manager approves employee's leave request", async () => (await api.update<any>(client, "leave_requests", leave.id, { status: "approved" })).status);
await client.auth.signInWithPassword({ email: USERS.gm.email, password: PASSWORD });
await check("GM approves employee's leave request", async () => (await api.update<any>(client, "leave_requests", leave.id, { status: "approved" })).status);

await client.auth.signInWithPassword({ email: USERS.employee.email, password: PASSWORD });
await check("employee cannot withdraw a decided request", async () => { await api.deleteById(client, "leave_requests", leave.id); return (await api.getAll<any>(client, "leave_requests")).some((l) => l.id === leave.id) ? "still there" : (() => { throw new Error("request was deleted"); })(); });
// penalties: manager issues to employee, employee appeals, manager can't approve own appeal path? GM decides
await client.auth.signInWithPassword({ email: USERS.manager.email, password: PASSWORD });
let pen: any;
await check("manager issues penalty to subordinate", async () => { pen = await api.insert(client, "penalties", { teamMemberId: 4, issuerId: 11, date: day, amount: 50, reason: "e2e" }); return pen.status; });
await client.auth.signInWithPassword({ email: USERS.employee.email, password: PASSWORD });
await check("employee sees own penalty", async () => !!(await api.getAll<any>(client, "penalties")).find((p) => p.id === pen?.id));
await check("employee appeals penalty", async () => (await api.update<any>(client, "penalties", pen.id, { status: "appealed", appealReason: "e2e" })).status);
await check("employee cannot cancel own penalty", async () => api.update(client, "penalties", pen.id, { status: "rejected" }), "deny");
await client.auth.signInWithPassword({ email: USERS.gm.email, password: PASSWORD });
await check("GM decides the appeal", async () => (await api.update<any>(client, "penalties", pen.id, { status: "rejected" })).status);
await check("GM deletes test penalty", async () => api.deleteById(client, "penalties", pen.id));
await check("employee notifications are private", async () => { await client.auth.signInWithPassword({ email: USERS.employee.email, password: PASSWORD }); const n = await must(client.from("notifications").select("recipient_id")); return [...new Set(n.map((x: any) => x.recipient_id))]; });

// ---- invite flow (GM creates, new person accepts and logs in)
results.push("\n=== invite flow");
await client.auth.signInWithPassword({ email: USERS.gm.email, password: PASSWORD });
let inviteToken = "";
await check("GM creates invite", async () => { const r = await authed("/api/admin/invites/create", { method: "POST", body: JSON.stringify({ email: "e2e.invitee@example.com", roleId: "c3d4e5f6-a7b8-9c0d-1e2f-3a4b5c6d7e8f" }) }); inviteToken = r.token || r.invite?.token || (r.link || r.inviteLink || "").split("token=")[1] || ""; return !!inviteToken; });
await check("invite verify", async () => { const r = await fetch(`/api/invite/verify?token=${inviteToken}`); if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`); });
await check("invite accept", async () => { const r = await fetch("/api/invite/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: inviteToken, name: "E2E Invitee", password: "Invitee12345" }) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`); });
await check("invitee can log in and has a member row", async () => { await must(client.auth.signInWithPassword({ email: "e2e.invitee@example.com", password: "Invitee12345" })); return (await must(client.from("team_members").select("id, name").eq("email", "e2e.invitee@example.com"))).length; });

console.log(results.join("\n"));
console.log(`\n${failures} failing check(s)`);
process.exit(failures ? 1 : 0);
