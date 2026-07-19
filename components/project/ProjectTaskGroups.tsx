import React, { useState } from "react";
import { Project, TaskGroup } from "@shared/types";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "@shared/contexts/SupabaseContext";
import { PlusIcon, TrashIcon, PencilIcon } from "../ui/Icons";
import { useToast } from "@shared/contexts/ToastContext";
import * as api from "@shared/services/apiService";

export const ProjectTaskGroups: React.FC<{ project: Project; canManage: boolean }> = ({ project, canManage }) => {
  const { supabaseClient } = useSupabase();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({ name: "", description: "" });

  const { data: groups = [], isLoading } = useQuery<TaskGroup[]>({
    queryKey: ["task_groups", project.id],
    queryFn: async () => {
      if (!supabaseClient) return [];
      const res = await supabaseClient
        .from("task_groups")
        .select("*")
        .eq("project_id", project.id)
        .order("created_at", { ascending: true });
      if (res.error) throw res.error;
      return api.keysToCamel(res.data) as TaskGroup[];
    },
    enabled: !!supabaseClient,
  });

  const saveMutation = useMutation({
    mutationFn: async (data: any) => {
      if (!supabaseClient) return;
      const { data: { session } } = await supabaseClient.auth.getSession();
      const token = session?.access_token || "";
      if (editingId) {
        const res = await fetch(`/api/task_groups/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify(data) }); if(!res.ok) { let err="Error"; try{ err=(await res.json()).error; }catch(e){ err=await res.text(); } throw new Error(err); }
      } else {
        const res = await fetch("/api/task_groups", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ ...data, projectId: project.id }) }); if(!res.ok) { let err="Error"; try{ err=(await res.json()).error; }catch(e){ err=await res.text(); } throw new Error(err); }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task_groups", project.id] });
      addToast("تم حفظ مجموعة المهام بنجاح", "success");
      setIsAdding(false);
      setEditingId(null);
      setFormData({ name: "", description: "" });
    },
    onError: (err: any) => addToast(err.message || "حدث خطأ", "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!supabaseClient) return;
      const { data: { session } } = await supabaseClient.auth.getSession();
      const token = session?.access_token || "";
      const res = await fetch(`/api/task_groups/${id}`, { method: "DELETE", headers: { "Authorization": `Bearer ${token}` } }); if(!res.ok) { let err="Error"; try{ err=(await res.json()).error; }catch(e){ err=await res.text(); } throw new Error(err); }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task_groups", project.id] });
      addToast("تم حذف المجموعة بنجاح", "success");
    },
    onError: (err: any) => addToast(err.message || "حدث خطأ", "error"),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) return;
    saveMutation.mutate(formData);
  };

  if (isLoading) return <div className="p-4 text-slate-500">جاري التحميل...</div>;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">
          مجموعات المهام (مراحل العمل / التخصصات)
        </h3>
        {canManage && !isAdding && (
          <button
            onClick={() => {
              setFormData({ name: "", description: "" });
              setIsAdding(true);
              setEditingId(null);
            }}
            className="flex items-center gap-2 bg-sky-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-sky-700 transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
            مجموعة جديدة
          </button>
        )}
      </div>

      {(isAdding || editingId) && (
        <form onSubmit={handleSubmit} className="mb-6 bg-slate-50 dark:bg-slate-900/50 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">اسم المجموعة</label>
              <input
                type="text"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                required
                className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md text-sm dark:bg-slate-800"
                placeholder="مثال: التطوير والبرمجة"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">الوصف (اختياري)</label>
              <input
                type="text"
                value={formData.description}
                onChange={e => setFormData({ ...formData, description: e.target.value })}
                className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md text-sm dark:bg-slate-800"
              />
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <button
              type="submit"
              disabled={saveMutation.isPending}
              className="bg-emerald-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-emerald-700"
            >
              {saveMutation.isPending ? "جاري الحفظ..." : "حفظ"}
            </button>
            <button
              type="button"
              onClick={() => { setIsAdding(false); setEditingId(null); }}
              className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 px-4 py-2 rounded text-sm hover:bg-slate-50"
            >
              إلغاء
            </button>
          </div>
        </form>
      )}

      {groups.length === 0 && !isAdding && (
        <div className="text-center py-8 text-slate-500">لا توجد مجموعات مهام حالياً.</div>
      )}

      <div className="space-y-3">
        {groups.map(group => (
          <div key={group.id} className="flex justify-between items-center p-4 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800">
            <div>
              <h4 className="font-semibold text-slate-800 dark:text-slate-100">{group.name}</h4>
              {group.description && <p className="text-sm text-slate-500 mt-1">{group.description}</p>}
            </div>
            {canManage && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setEditingId(group.id);
                    setFormData({ name: group.name, description: group.description || "" });
                    setIsAdding(false);
                  }}
                  className="p-2 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded"
                >
                  <PencilIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => {
                    if (window.confirm("هل أنت متأكد من حذف هذه المجموعة؟")) {
                      deleteMutation.mutate(group.id);
                    }
                  }}
                  className="p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded"
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
