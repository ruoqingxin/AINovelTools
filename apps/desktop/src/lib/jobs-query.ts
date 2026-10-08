import { useQuery } from "@tanstack/react-query";
import { listJobs } from "./tauri-client";

export function taskPollingInterval(tasks: ReadonlyArray<{ status: string }> | undefined) {
  return tasks?.some((task) => task.status === "QUEUED" || task.status === "RUNNING") ? 1_200 : 15_000;
}

// The shell owns polling; feature views subscribe to the same task cache.
export function useJobs({ enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {}) {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: listJobs,
    enabled,
    refetchInterval: poll ? (query) => taskPollingInterval(query.state.data) : false,
  });
}
