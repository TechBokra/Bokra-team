import { create } from "zustand";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBokraClient } from "../lib/bokraClient";

// The app talks to its own API (Neon backend) through a client that keeps the
// supabase-js surface, so existing code and types keep working.
interface SupabaseState {
  supabaseClient: SupabaseClient | null;
}

const globalSupabaseClient = createBokraClient() as unknown as SupabaseClient;

export const useSupabaseStore = create<SupabaseState>()(() => ({
  supabaseClient: globalSupabaseClient,
}));

export const getSupabaseClient = () => globalSupabaseClient;
