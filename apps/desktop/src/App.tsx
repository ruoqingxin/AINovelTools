import { Component, type ErrorInfo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./App.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 30_000 },
  },
});

type ErrorBoundaryState = { failed: boolean };

class AppErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application render failed", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      const goBack = () => {
        this.setState({ failed: false });
        if (window.history.length > 1) {
          window.history.back();
        } else {
          window.location.assign("/");
        }
      };

      return (
        <main className="fatal-error" role="alert">
          <h1>工作台无法显示</h1>
          <p>请返回上一页重试。</p>
          <button type="button" className="secondary-action" onClick={goBack}>返回</button>
        </main>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
