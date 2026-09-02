import { AppMark } from "@ainoveltools/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import {
  BookOpenText,
  Bot,
  Clock3,
  FileSearch,
  LibraryBig,
  ListTree,
  Settings,
  ShieldCheck,
  ListChecks,
} from "lucide-react";
import { getBootstrapStatus, getCurrentProject, getHealth, listAllRecoveryLogs } from "../lib/tauri-client";

const navigation = [
  { label: "项目", icon: LibraryBig, path: "/" as const },
  { label: "规划", icon: ListTree },
  { label: "正文", icon: BookOpenText },
  { label: "知识", icon: FileSearch, path: "/knowledge" as const },
  { label: "AI", icon: Bot },
  { label: "审核", icon: ShieldCheck, path: "/knowledge/review" as const },
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

  const serviceLabel = health.isSuccess
    ? `SQLite ${health.data.sqliteVersion} · Schema ${health.data.schemaVersion}`
    : health.isError
      ? "数据库不可用"
      : "正在连接核心服务";

  return (
    <div className="app-shell">
      <header className="title-bar">
        <div className="brand-lockup">
          <AppMark className="app-mark" />
          <span>AI Novel Tools</span>
        </div>
        <nav className="top-nav" aria-label="工作区导航">
          {navigation.map(({ label, icon: Icon, path }) => path ? (
            <Link key={label} to={path} className="top-nav-button top-nav-link" activeProps={{ "data-active": true }}>
              <Icon size={15} strokeWidth={1.8} />{label}
            </Link>
          ) : (
            <button key={label} type="button" className="top-nav-button" disabled>
              <Icon size={15} strokeWidth={1.8} />{label}
            </button>
          ))}
        </nav>
        <div className="title-actions">
          <span className="project-context">{currentProject.data?.name ?? "未打开项目"}</span>
          <button type="button" className="title-action" disabled title="请在项目主页创建或打开项目">＋ 新建小说</button>
          <Link to="/settings" className="title-icon" aria-label="设置" title="设置"><Settings size={16} /></Link>
        </div>
      </header>

      <aside className="activity-bar" aria-label="主要导航">
        <nav>
          {navigation.map(({ label, icon: Icon, path }) => path ? (
            <Link key={label} to={path} className="activity-button" activeProps={{ "data-active": true }} aria-label={label} title={label}>
              <Icon size={19} strokeWidth={1.8} />
            </Link>
          ) : (
            <button key={label} type="button" className="activity-button" aria-label={label} title={label} disabled>
              <Icon size={19} strokeWidth={1.8} />
            </button>
          ))}
        </nav>
        <Link
          to="/settings"
          className="activity-button activity-settings"
          aria-label="设置"
          title="设置"
        >
          <Settings size={19} strokeWidth={1.8} />
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
          {serviceLabel}
        </span>
        <span className="status-item">
          <Clock3 size={13} /> 本地优先
        </span>
      </footer>
    </div>
  );
}
