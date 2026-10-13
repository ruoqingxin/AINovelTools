import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Clock3, ListChecks, Menu, PanelLeftClose, PanelLeftOpen, Search, Settings, X } from "lucide-react";
import { getBootstrapStatus, getCurrentProject, getHealth, listAllRecoveryLogs } from "../lib/tauri-client";
import { useJobs } from "../lib/jobs-query";
import { useAuthorTodos } from "../lib/author-todos-query";
import { UnsavedChangesProvider } from "./unsaved-changes-provider";
import { primaryDestination, primaryNavigation, workspaceLabel } from "./navigation";
import { ProjectActionsProvider, useProjectActions } from "./project-actions-provider";
import { ProjectPicker } from "./project-picker";

export function AppShell() {
  return <UnsavedChangesProvider><ProjectActionsProvider><ShellLayout /></ProjectActionsProvider></UnsavedChangesProvider>;
}

function ShellLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mobileNavigation) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavigation(false);
        navigationTrigger.current?.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavigation]);
  const actions = useProjectActions();
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
    enabled: !actions.transitioning,
  });
  const recovery = useQuery({ queryKey: ["recovery-all"], queryFn: listAllRecoveryLogs, enabled: Boolean(currentProject.data) && !actions.transitioning });
  const jobs = useJobs({ enabled: Boolean(currentProject.data) && !actions.transitioning, poll: true });
  const todos = useAuthorTodos({ enabled: Boolean(currentProject.data) && !actions.transitioning, poll: true });

  const serviceLabel = health.isSuccess
    ? "本地数据正常"
    : health.isError
      ? "本地数据不可用"
      : "正在连接核心服务";
  const activeJobCount = currentProject.data ? (jobs.data ?? []).filter((job) => job.status === "QUEUED" || job.status === "RUNNING").length : 0;
  const failedJobCount = currentProject.data ? (jobs.data ?? []).filter((job) => job.status === "FAILED" && !job.acknowledgedAt).length : 0;
  const taskBadge = activeJobCount
    ? { count: activeJobCount, tone: "active", label: `${activeJobCount} 项任务正在进行` }
    : failedJobCount
      ? { count: failedJobCount, tone: "failed", label: `${failedJobCount} 项任务失败` }
      : null;

  return (
      <div className="app-shell" data-nav-collapsed={collapsed || undefined} data-mobile-nav={mobileNavigation || undefined}>
        <header className="global-toolbar">
          <button ref={navigationTrigger} type="button" className="shell-icon mobile-navigation-toggle" aria-label={mobileNavigation ? "关闭导航" : "打开导航"}
            title="主要导航" aria-expanded={mobileNavigation} aria-controls="primary-navigation" onClick={() => setMobileNavigation((value) => !value)}>
            {mobileNavigation ? <X size={19} /> : <Menu size={19} />}
          </button>
          <ProjectPicker />
          <span className="global-location">{workspaceLabel(pathname)}</span>
          <div className="global-tools" aria-label="全局工具">
            <Link to="/search" className="shell-icon" aria-label="搜索" title="搜索" aria-current={pathname === "/search" ? "page" : undefined}
              data-active={pathname === "/search" || undefined} aria-disabled={!currentProject.data || actions.busy !== null}
              onClick={(event) => { if (!currentProject.data || actions.busy !== null) event.preventDefault(); }}>
              <Search size={19} />
            </Link>
            <Link to="/jobs" className="shell-icon global-activity" aria-label="后台活动"
              title={`后台活动 · ${activeJobCount} 项进行中 · ${failedJobCount} 项失败`}
              aria-current={pathname === "/jobs" ? "page" : undefined} data-active={pathname === "/jobs" || undefined}
              aria-disabled={!currentProject.data || actions.busy !== null}
              onClick={(event) => { if (!currentProject.data || actions.busy !== null) event.preventDefault(); }}>
              <ListChecks size={19} />
              {taskBadge ? <span className="activity-badge" data-tone={taskBadge.tone} aria-label={taskBadge.label}>{taskBadge.count > 99 ? "99+" : taskBadge.count}</span> : null}
              {activeJobCount && failedJobCount ? <span className="activity-failure-dot" aria-label={`${failedJobCount} 项任务失败`} /> : null}
            </Link>
          </div>
        </header>
        {mobileNavigation ? <button type="button" className="mobile-navigation-backdrop" aria-label="关闭导航遮罩"
          onClick={() => setMobileNavigation(false)} /> : null}
        <aside className="activity-bar" aria-label="主要导航">
          <div className="navigation-heading">
            <span>工作区</span>
            <button type="button" className="shell-icon navigation-collapse" aria-label={collapsed ? "展开导航" : "收起导航"}
              title={collapsed ? "展开导航" : "收起导航"} aria-expanded={!collapsed} aria-controls="primary-navigation"
              onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
          </div>
          <nav id="primary-navigation">
            {primaryNavigation.map(({ label, icon: Icon, path }) => currentProject.data ? (
              <Link
                key={label}
                to={path}
                className="activity-button"
                data-active={primaryDestination(pathname) === path || undefined}
                aria-current={primaryDestination(pathname) === path ? "page" : undefined}
                aria-disabled={actions.busy !== null}
                aria-label={label}
                title={label}
                onClick={(event) => { if (actions.busy !== null) event.preventDefault(); else setMobileNavigation(false); }}
              >
                <Icon size={20} strokeWidth={1.8} />
                <span>{label}</span>
                {path === "/review" && todos.data?.pendingCount ? <span className="nav-todo-count" aria-label={`${todos.data.pendingCount} 项待办`}>{todos.data.pendingCount > 99 ? "99+" : todos.data.pendingCount}</span> : null}
              </Link>
            ) : <button type="button" key={label} className="activity-button" aria-label={label} title={label} disabled>
              <Icon size={20} strokeWidth={1.8} /><span>{label}</span>
            </button>)}
          </nav>
          <Link
            to="/settings"
            className="activity-button activity-settings"
            data-active={pathname === "/settings" || undefined}
            aria-current={pathname === "/settings" ? "page" : undefined}
            aria-disabled={actions.busy !== null}
            aria-label="设置"
            title="设置"
            onClick={(event) => { if (actions.busy !== null) event.preventDefault(); else setMobileNavigation(false); }}
          >
            <Settings size={20} strokeWidth={1.8} />
            <span>设置</span>
          </Link>
        </aside>

        <main className="workspace">
          {actions.error ? <div className="global-action-error" role="alert"><span>{actions.error}</span>
            <button type="button" className="shell-icon" title="关闭提示" aria-label="关闭作品操作错误" onClick={actions.clearError}><X size={16} /></button></div> : null}
          {currentProject.isError ? <div className="global-action-error" role="alert"><span>无法读取当前作品</span>
            <button type="button" onClick={() => void currentProject.refetch()}>重试</button></div> : null}
          {!actions.transitioning && currentProject.data && recovery.data?.length && pathname !== "/writing" && pathname !== "/chapters" && pathname !== "/review" ? <div className="global-recovery-banner" role="status"><span>有 {recovery.data.length} 份异常退出草稿尚未确认</span><Link to="/review">处理异常草稿</Link></div> : null}
          {actions.transitioning ? <p className="route-loading" role="status">正在切换作品…</p> : null}
          <div className="workspace-page" hidden={actions.transitioning}
            key={currentProject.data?.projectId ?? "no-project"}><Outlet /></div>
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
  );
}
