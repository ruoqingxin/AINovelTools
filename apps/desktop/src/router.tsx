import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell } from "./shell/app-shell";
import { EmptyProjectView } from "./views/empty-project-view";

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: EmptyProjectView,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: EmptyProjectView,
});

const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
