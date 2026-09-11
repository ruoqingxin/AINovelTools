import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import {
  BookOpenText,
  Clock3,
  FileSearch,
  LibraryBig,
  ListTree,
  Search,
  Settings,
  ListChecks,
} from "lucide-react";
import { getBootstrapStatus, getCurrentProject, getHealth, listAllRecoveryLogs, listJobs } from "../lib/tauri-client";
import { UnsavedChangesProvider } from "./unsaved-changes-provider";

const navigation = [
  { label: "项目", icon: LibraryBig, path: "/" as const },
  { label: "规划", icon: ListTree, path: "/planning" as const },
  { label: "正文", icon: BookOpenText, path: "/writing" as const },
  { label: "知识", icon: FileSearch, path: "/knowledge" as const },
  { label: "搜索", icon: Search, path: "/search" as const },
  { label: "任务", icon: ListChecks, path: "/jobs" as const },
];

export function AppShell() {
  useQuery({
    queryKey: ["bootstrap-status"],
    queryFn: getBootstrapStatus,
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
  });
  const currentProject = useQuery({
    queryKey: ["current-project"],
    queryFn: getCurrentProject,
  });
  const recovery = useQuery({ queryKey: ["recovery-all"], queryFn: listAllRecoveryLogs, enabled: Boolean(currentProject.data) });
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: listJobs,
    enabled: Boolean(currentProject.data),
    refetchInterval: 3_000,
  });

  const serviceLabel = health.isSuccess
    ? "本地数据正常"
    : health.isError
      ? "本地数据不可用"
      : "正在连接核心服务";
  const activeJobCount = (jobs.data ?? []).filter((job) => job.status === "QUEUED" || job.status === "RUNNING").length;
  const failedJobCount = (jobs.data ?? []).filter((job) => job.status === "FAILED" && !job.acknowledgedAt).length;
  const taskBadge = activeJobCount
    ? { count: activeJobCount, tone: "active", label: `${activeJobCount} 项任务正在进行` }
    : failedJobCount
      ? { count: failedJobCount, tone: "failed", label: `${failedJobCount} 项任务失败` }
      : null;

  return (
    <UnsavedChangesProvider>
      <div className="app-shell">
        <aside className="activity-bar" aria-label="主要导航">
          <nav>
            {navigation.map(({ label, icon: Icon, path }) => (
              <Link
                key={label}
                to={path}
                className="activity-button"
                activeOptions={{ exact: true }}
                activeProps={{ "data-active": true }}
                aria-label={label}
                title={label}
              >
                <Icon size={20} strokeWidth={1.8} />
                <span>{label}</span>
                {label === "任务" && taskBadge ? <span className="activity-badge" data-tone={taskBadge.tone} aria-label={taskBadge.label}>{taskBadge.count > 99 ? "99+" : taskBadge.count}</span> : null}
              </Link>
            ))}
          </nav>
          <Link
            to="/settings"
            className="activity-button activity-settings"
            activeOptions={{ exact: true }}
            activeProps={{ "data-active": true }}
            aria-label="设置"
            title="设置"
          >
            <Settings size={20} strokeWidth={1.8} />
            <span>设置</span>
          </Link>
        </aside>

        <main className="workspace">
          {recovery.data?.length ? <div className="global-recovery-banner" role="status">发现 {recovery.data.length} 条可恢复草稿，请进入对应章节处理。</div> : null}
          <Outlet />
        </main>

        <footer className="status-bar">
          <span className="status-item">
            <span
              className="status-dot"
              data-state={health.status}
              aria-hidden="true"
            />
            <span title={health.data ? `SQLite ${health.data.sqliteVersion} · Schema ${health.data.schemaVersion}` : undefined}>{serviceLabel}</span>
          </span>
          <span className="status-item">
            <Clock3 size={13} /> 本地优先
          </span>
        </footer>
      </div>
    </UnsavedChangesProvider>
  );
}
